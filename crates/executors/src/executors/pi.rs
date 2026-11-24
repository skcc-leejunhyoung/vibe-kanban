use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use agent_client_protocol::{self as proto, Agent as _};
use async_trait::async_trait;
use derivative::Derivative;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
use tokio_util::{
    compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt},
    sync::CancellationToken,
};
use ts_rs::TS;
use workspace_utils::msg_store::MsgStore;

use super::{
    AppendPrompt, AvailabilityInfo, BaseCodingAgent, ExecutorError, SlashCommandDescription,
    SpawnedChild, StandardCodingAgentExecutor,
    acp::{self, AcpAgentHarness, AcpClient, harness::pi_error},
    utils,
};
use crate::{
    approvals::ExecutorApprovalService,
    command::{CmdOverrides, CommandParts},
    env::ExecutionEnv,
    executor_discovery::ExecutorDiscoveredOptions,
    logs::utils::patch,
    model_selector::{ModelInfo, PermissionPolicy},
    profile::ExecutorConfig,
};

const INSTALL: &str = "Install Pi and its ACP adapter on the execution host with npm install -g @earendil-works/pi-coding-agent@1.4.0 pi-acp@0.0.35.";
const LOGIN: &str = "Run Pi's /login command on the execution host or update the provider API key in the executor environment.";

pub(super) fn session_map(env: &ExecutionEnv) -> Option<PathBuf> {
    let home_key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    let home = env
        .get(home_key)
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
        .or_else(dirs::home_dir)?;
    Some(home.join(".pi").join("pi-acp").join("session-map.json"))
}

pub(super) async fn session_provider_error(
    map: &Path,
    id: &str,
    started_at: i64,
) -> Option<ExecutorError> {
    // pi-acp 0.0.35 may return end_turn for a provider error recorded by Pi.
    uuid::Uuid::parse_str(id).ok()?;
    let mut bytes = Vec::new();
    tokio::fs::File::open(map)
        .await
        .ok()?
        .take(4 * 1024 * 1024)
        .read_to_end(&mut bytes)
        .await
        .ok()?;
    let map: Value = serde_json::from_slice(&bytes).ok()?;
    let path = Path::new(map["sessions"].get(id)?["sessionFile"].as_str()?);
    if !path
        .file_name()?
        .to_str()?
        .ends_with(&format!("_{id}.jsonl"))
    {
        return None;
    }
    let metadata = tokio::fs::symlink_metadata(path).await.ok()?;
    if !metadata.is_file() {
        return None;
    }
    let mut file = tokio::fs::File::open(path).await.ok()?;
    const TAIL_BYTES: u64 = 64 * 1024;
    let offset = metadata.len().saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(offset)).await.ok()?;
    bytes.clear();
    file.take(TAIL_BYTES).read_to_end(&mut bytes).await.ok()?;
    if offset > 0 {
        let first_line_end = bytes.iter().position(|byte| *byte == b'\n')?;
        return pi_error_from_tail(&bytes[first_line_end + 1..], started_at);
    }
    pi_error_from_tail(&bytes, started_at)
}

fn pi_error_from_tail(bytes: &[u8], started_at: i64) -> Option<ExecutorError> {
    let entry = bytes.rsplit(|byte| *byte == b'\n').find_map(|line| {
        let entry: Value = serde_json::from_slice(line).ok()?;
        (entry["type"] == "message").then_some(entry)
    })?;
    let message = &entry["message"];
    if message["role"] != "assistant"
        || message["stopReason"] != "error"
        || message["timestamp"].as_i64()? < started_at
    {
        return None;
    }
    let status = message["statusCode"].as_i64().or_else(|| {
        let error = message["errorMessage"].as_str()?;
        let error = error.strip_prefix("HTTP ").unwrap_or(error);
        error
            .split_ascii_whitespace()
            .next()?
            .trim_end_matches(':')
            .parse()
            .ok()
    });
    Some(utils::provider_request_error(
        "Pi",
        status,
        LOGIN,
        "Pi's model provider returned an error. Check the selected model and provider configuration.",
    ))
}

#[derive(Derivative, Clone, Serialize, Deserialize, TS, JsonSchema)]
#[derivative(Debug, PartialEq)]
pub struct Pi {
    #[serde(default)]
    pub append_prompt: AppendPrompt,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Approve extension confirmations without asking.
    #[serde(default)]
    pub auto_approve: bool,
    /// Also cancel extension selections, which are Pi's questions to the user
    /// (unattended runs).
    #[serde(default)]
    pub dont_ask: bool,
    #[serde(flatten)]
    pub cmd: CmdOverrides,
    #[serde(skip)]
    #[ts(skip)]
    #[derivative(Debug = "ignore", PartialEq = "ignore")]
    pub approvals: Option<Arc<dyn ExecutorApprovalService>>,
    /// A requested policy Pi cannot honour; the turn is refused.
    #[serde(skip)]
    #[ts(skip)]
    #[derivative(PartialEq = "ignore")]
    pub unsupported_policy: Option<PermissionPolicy>,
}

impl Pi {
    fn command(&self) -> Result<CommandParts, ExecutorError> {
        utils::agent_command("pi-acp", &self.cmd)
    }

    async fn checked_command(&self, env: &ExecutionEnv) -> Result<CommandParts, ExecutorError> {
        let parts = self.command()?;
        let (program, args) = parts
            .into_resolved()
            .await
            .map_err(|e| utils::installation_error(e, INSTALL))?;
        let profile_env = env.clone().with_profile(&self.cmd);
        let pi = profile_env
            .get("PI_ACP_PI_COMMAND")
            .cloned()
            .or_else(|| std::env::var("PI_ACP_PI_COMMAND").ok())
            .unwrap_or_else(|| "pi".into());
        if workspace_utils::shell::resolve_executable_path(&pi)
            .await
            .is_none()
        {
            return Err(utils::agent_error(INSTALL));
        }
        Ok(CommandParts::new(
            program.to_string_lossy().into_owned(),
            args,
        ))
    }

    async fn run(
        &self,
        cwd: &Path,
        prompt: &str,
        id: Option<&str>,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        if let Some(policy) = &self.unsupported_policy {
            return Err(utils::agent_error(format!(
                "Pi has no {policy:?} mode. Choose Supervised, Auto or Don't Ask."
            )));
        }
        let command = self.checked_command(env).await?;
        let mut harness = AcpAgentHarness::new()
            .with_native_sessions()
            .with_auto_approved_tools(self.auto_approve);
        if let Some(model) = &self.model {
            harness = harness.with_model(model);
        }
        let approvals = if self.dont_ask {
            None
        } else {
            Some(
                self.approvals
                    .clone()
                    .ok_or(crate::approvals::ExecutorApprovalError::ServiceUnavailable)?,
            )
        };
        // Pi runs its commands from the prompt text, which must stay exact.
        let prompt = if utils::parse_slash_command::<utils::SlashCommandCall<'_>>(prompt).is_some()
        {
            prompt.to_owned()
        } else {
            self.append_prompt.combine_prompt(prompt)
        };
        match id {
            Some(id) => {
                harness
                    .spawn_follow_up_with_command(
                        cwd, prompt, id, command, env, &self.cmd, approvals,
                    )
                    .await
            }
            None => {
                harness
                    .spawn_with_command(cwd, prompt, command, env, &self.cmd, approvals)
                    .await
            }
        }
    }

    async fn discover(
        &self,
        cwd: PathBuf,
    ) -> Result<(proto::SessionModelState, Vec<SlashCommandDescription>), ExecutorError> {
        let env = ExecutionEnv::new(Default::default(), false, String::new());
        let (program, args) = self.checked_command(&env).await?.into_resolved().await?;
        let mut command = tokio::process::Command::new(program);
        command
            .args(args)
            .current_dir(&cwd)
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        env.with_profile(&self.cmd).apply_to_command(&mut command);
        let mut child = command.spawn().map_err(ExecutorError::Io)?;
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        tokio::task::spawn_blocking(move || {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(ExecutorError::Io)?;
            tokio::task::LocalSet::new().block_on(&rt, async move {
                let (events, mut receiver) = tokio::sync::mpsc::unbounded_channel();
                let client = AcpClient::new(events, None, CancellationToken::new());
                let (conn, io) = proto::ClientSideConnection::new(client, stdin.compat_write(), stdout.compat(), |task| {
                    tokio::task::spawn_local(task);
                });
                let driver = tokio::task::spawn_local(io);
                let result = tokio::time::timeout(Duration::from_secs(15), async {
                    conn.initialize(proto::InitializeRequest::new(proto::ProtocolVersion::V1))
                        .await.map_err(|e| pi_error("initialization", e))?;
                    let models = conn.new_session(proto::NewSessionRequest::new(cwd)).await
                        .map_err(|e| pi_error("model discovery", e))?
                        .models.ok_or_else(|| utils::agent_error("Pi ACP did not return a model list. Install pi-acp@0.0.35."))?;
                    // pi-acp announces the session's commands right after creating it.
                    let commands = tokio::time::timeout(Duration::from_secs(2), async {
                        while let Some(event) = receiver.recv().await {
                            if let acp::AcpEvent::Other(proto::SessionNotification {
                                update: proto::SessionUpdate::AvailableCommandsUpdate(update), ..
                            }) = event
                            {
                                return update.available_commands;
                            }
                        }
                        Vec::new()
                    }).await.unwrap_or_default();
                    Ok::<_, ExecutorError>((models, slash_commands(commands)))
                }).await;
                // Closing ACP stdin lets the adapter close its Pi child.
                driver.abort();
                let _ = driver.await;
                let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
                result.map_err(|_| utils::agent_error("Pi model discovery timed out. Check the Pi installation and provider login."))?
            })
        }).await.map_err(|_| utils::agent_error("Pi model discovery exited unexpectedly."))?
    }
}

#[async_trait]
impl StandardCodingAgentExecutor for Pi {
    fn apply_overrides(&mut self, config: &ExecutorConfig) {
        if let Some(model) = &config.model_id {
            self.model = Some(model.clone());
        }
        if let Some(policy) = &config.permission_policy {
            self.auto_approve =
                matches!(policy, PermissionPolicy::Auto | PermissionPolicy::DontAsk);
            self.dont_ask = matches!(policy, PermissionPolicy::DontAsk);
            self.unsupported_policy =
                matches!(policy, PermissionPolicy::Plan).then_some(PermissionPolicy::Plan);
        }
    }

    fn use_approvals(&mut self, approvals: Arc<dyn ExecutorApprovalService>) {
        self.approvals = Some(approvals);
    }

    async fn spawn(
        &self,
        cwd: &Path,
        prompt: &str,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        self.run(cwd, prompt, None, env).await
    }

    async fn spawn_follow_up(
        &self,
        cwd: &Path,
        prompt: &str,
        id: &str,
        reset: Option<&str>,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        if reset.is_some() {
            return Err(ExecutorError::FollowUpNotSupported(
                "Pi supports native resume, but ACP does not provide message-level rewind.".into(),
            ));
        }
        self.run(cwd, prompt, Some(id), env).await
    }

    fn normalize_logs(&self, store: Arc<MsgStore>, cwd: &Path) -> Vec<tokio::task::JoinHandle<()>> {
        acp::normalize_logs(store, cwd)
    }

    fn default_mcp_config_path(&self) -> Option<PathBuf> {
        None
    }

    fn get_availability_info(&self) -> AvailabilityInfo {
        let command = self
            .cmd
            .env
            .as_ref()
            .and_then(|env| env.get("PI_ACP_PI_COMMAND"))
            .cloned()
            .or_else(|| std::env::var("PI_ACP_PI_COMMAND").ok());
        if workspace_utils::shell::resolve_executable_path_blocking(
            command.as_deref().unwrap_or("pi"),
        )
        .is_none()
        {
            return AvailabilityInfo::NotFound;
        }
        utils::agent_availability("pi-acp", &self.cmd)
    }

    fn get_preset_options(&self) -> ExecutorConfig {
        let mut config = ExecutorConfig::new(BaseCodingAgent::Pi);
        config.model_id = self.model.clone();
        config.permission_policy = Some(match (self.auto_approve, self.dont_ask) {
            (true, true) => PermissionPolicy::DontAsk,
            (true, false) => PermissionPolicy::Auto,
            (false, _) => PermissionPolicy::Supervised,
        });
        config
    }

    async fn discover_options(
        &self,
        workdir: Option<&Path>,
        repo_path: Option<&Path>,
    ) -> Result<futures::stream::BoxStream<'static, json_patch::Patch>, ExecutorError> {
        let cwd = utils::discovery_dir(workdir, repo_path);
        let agent = self.clone();
        Ok(Box::pin(futures::stream::once(async move {
            let mut options = ExecutorDiscoveredOptions {
                ..Default::default()
            };
            match agent.discover(cwd).await {
                Ok((models, commands)) => {
                    options.slash_commands = commands;
                    options.model_selector.default_model =
                        Some(models.current_model_id.0.to_string());
                    options.model_selector.models = models
                        .available_models
                        .into_iter()
                        .map(|model| ModelInfo {
                            id: model.model_id.0.to_string(),
                            name: model.name,
                            provider_id: None,
                            reasoning_options: vec![],
                            supports_fast: false,
                        })
                        .collect();
                }
                Err(err) => options.error = Some(err.to_string()),
            }
            patch::executor_discovered_options(options)
        })))
    }
}

/// Commands Pi runs from a prompt, as the chat's `/` menu lists them.
fn slash_commands(commands: Vec<proto::AvailableCommand>) -> Vec<SlashCommandDescription> {
    utils::reorder_slash_commands(commands.into_iter().map(|command| {
        let hint = match command.input {
            Some(proto::AvailableCommandInput::Unstructured(input)) => Some(input.hint),
            _ => None,
        };
        SlashCommandDescription {
            name: command.name,
            description: match (command.description.trim(), hint) {
                ("", hint) => hint,
                (description, Some(hint)) => Some(format!("{description} ({hint})")),
                (description, None) => Some(description.to_owned()),
            },
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_announced_commands_with_input_hints() {
        let commands: Vec<proto::AvailableCommand> = serde_json::from_value(serde_json::json!([
            {"name": "name", "description": "Rename the session", "input": {"hint": "new name"}},
            {"name": "compact", "description": "Compact the context"},
            {"name": "skill:review", "description": ""}
        ]))
        .unwrap();
        assert_eq!(
            slash_commands(commands),
            [
                SlashCommandDescription {
                    name: "compact".into(),
                    description: Some("Compact the context".into()),
                },
                SlashCommandDescription {
                    name: "name".into(),
                    description: Some("Rename the session (new name)".into()),
                },
                SlashCommandDescription {
                    name: "skill:review".into(),
                    description: None,
                },
            ]
        );
    }

    #[test]
    fn auto_keeps_questions_and_dont_ask_blocks_them() {
        let mut pi: Pi = serde_json::from_value(serde_json::json!({})).unwrap();
        let mut config = ExecutorConfig::new(BaseCodingAgent::Pi);
        for (policy, auto, dont_ask, refused) in [
            (PermissionPolicy::Auto, true, false, false),
            (PermissionPolicy::DontAsk, true, true, false),
            (PermissionPolicy::Supervised, false, false, false),
            (PermissionPolicy::Plan, false, false, true),
        ] {
            config.permission_policy = Some(policy);
            pi.apply_overrides(&config);
            assert_eq!(
                (
                    pi.auto_approve,
                    pi.dont_ask,
                    pi.unsupported_policy.is_some()
                ),
                (auto, dont_ask, refused)
            );
        }
    }

    #[test]
    fn classifies_recent_pi_errors_without_exposing_provider_response() {
        let error = |code| {
            serde_json::json!({
                "type": "message",
                "message": {
                    "role": "assistant", "stopReason": "error", "timestamp": 400,
                    "errorMessage": format!("{code}: synthetic-secret")
                }
            })
            .to_string()
        };
        let rejected = error(401);
        let not_found = error(404);
        assert!(matches!(
            pi_error_from_tail(rejected.as_bytes(), 399),
            Some(ExecutorError::AuthRequired(_))
        ));
        let display = pi_error_from_tail(not_found.as_bytes(), 400)
            .unwrap()
            .to_string();
        assert!(display.contains("HTTP 404"));
        assert!(!display.contains("synthetic-secret"));
        assert!(pi_error_from_tail(rejected.as_bytes(), 401).is_none());
    }
}
