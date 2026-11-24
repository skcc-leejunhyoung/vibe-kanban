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
use tokio_util::{
    compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt},
    sync::CancellationToken,
};
use ts_rs::TS;
use workspace_utils::msg_store::MsgStore;

use super::{
    AppendPrompt, AvailabilityInfo, BaseCodingAgent, ExecutorError, SpawnedChild,
    StandardCodingAgentExecutor,
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

#[derive(Derivative, Clone, Serialize, Deserialize, TS, JsonSchema)]
#[derivative(Debug, PartialEq)]
pub struct Pi {
    #[serde(default)]
    pub append_prompt: AppendPrompt,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default)]
    pub auto_approve: bool,
    #[serde(flatten)]
    pub cmd: CmdOverrides,
    #[serde(skip)]
    #[ts(skip)]
    #[derivative(Debug = "ignore", PartialEq = "ignore")]
    pub approvals: Option<Arc<dyn ExecutorApprovalService>>,
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
        let command = self.checked_command(env).await?;
        let mut harness = AcpAgentHarness::new().with_native_sessions();
        if let Some(model) = &self.model {
            harness = harness.with_model(model);
        }
        let approvals = if self.auto_approve {
            None
        } else {
            Some(
                self.approvals
                    .clone()
                    .ok_or(crate::approvals::ExecutorApprovalError::ServiceUnavailable)?,
            )
        };
        let prompt = self.append_prompt.combine_prompt(prompt);
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

    async fn discover(&self, cwd: PathBuf) -> Result<proto::SessionModelState, ExecutorError> {
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
                let (events, _receiver) = tokio::sync::mpsc::unbounded_channel();
                let client = AcpClient::new(events, None, CancellationToken::new());
                let (conn, io) = proto::ClientSideConnection::new(client, stdin.compat_write(), stdout.compat(), |task| {
                    tokio::task::spawn_local(task);
                });
                let driver = tokio::task::spawn_local(io);
                let result = tokio::time::timeout(Duration::from_secs(15), async {
                    conn.initialize(proto::InitializeRequest::new(proto::ProtocolVersion::V1))
                        .await.map_err(|e| pi_error("initialization", e))?;
                    conn.new_session(proto::NewSessionRequest::new(cwd)).await
                        .map_err(|e| pi_error("model discovery", e))?
                        .models.ok_or_else(|| utils::agent_error("Pi ACP did not return a model list. Install pi-acp@0.0.35."))
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
                Ok(models) => {
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
