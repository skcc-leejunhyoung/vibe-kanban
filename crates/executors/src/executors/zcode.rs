use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use agent_client_protocol::{ToolCall, ToolCallStatus};
use async_trait::async_trait;
use command_group::AsyncGroupChild;
use derivative::Derivative;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader, Lines},
    process::{ChildStdin, ChildStdout, Command},
    sync::oneshot,
};
use tokio_util::sync::CancellationToken;
use ts_rs::TS;
use workspace_utils::{
    approvals::ApprovalStatus, command_ext::GroupSpawnNoWindowExt, msg_store::MsgStore,
};

use super::{
    AppendPrompt, AvailabilityInfo, BaseCodingAgent, ExecutorError, ExecutorExitResult,
    SpawnedChild, StandardCodingAgentExecutor,
    acp::{self, AcpEvent, ApprovalResponse},
    utils,
};
use crate::{
    approvals::ExecutorApprovalService,
    command::CmdOverrides,
    env::ExecutionEnv,
    executor_discovery::ExecutorDiscoveredOptions,
    logs::utils::patch,
    model_selector::{
        ModelInfo, ModelProvider, ModelSelectorConfig, PermissionPolicy, ReasoningOption,
    },
    profile::ExecutorConfig,
    stdout_dup::create_stdout_pipe_writer,
};

const INSTALL: &str = "Install the Z.ai ZCode 0.17.0 CLI from the FrontierHarness source build and put zcode on PATH, or set the absolute CLI command in the executor profile.";
const LOGIN: &str = "Run zcode login on the execution host, or configure a provider and model in ZCode's personal provider configuration.";
const RPC_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Derivative, Clone, Serialize, Deserialize, TS, JsonSchema)]
#[derivative(Debug, PartialEq)]
pub struct ZCode {
    #[serde(default)]
    pub append_prompt: AppendPrompt,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    #[serde(default)]
    pub auto_approve: bool,
    #[serde(flatten)]
    pub cmd: CmdOverrides,
    #[serde(skip)]
    #[ts(skip)]
    #[derivative(Debug = "ignore", PartialEq = "ignore")]
    pub approvals: Option<Arc<dyn ExecutorApprovalService>>,
}

struct Connection {
    input: ChildStdin,
    output: Lines<BufReader<ChildStdout>>,
    next_id: u32,
}

impl Connection {
    fn new(child: &mut AsyncGroupChild) -> Self {
        Self {
            input: child.inner().stdin.take().expect("piped stdin"),
            output: BufReader::new(child.inner().stdout.take().expect("piped stdout")).lines(),
            next_id: 0,
        }
    }

    async fn read(&mut self) -> Result<Value, ExecutorError> {
        let line = self
            .output
            .next_line()
            .await
            .map_err(ExecutorError::Io)?
            .ok_or_else(|| {
                utils::agent_error(format!("ZCode closed its stdio protocol. {INSTALL}"))
            })?;
        serde_json::from_str(&line).map_err(|_| {
            utils::agent_error(format!(
                "ZCode returned a malformed protocol frame. {INSTALL}"
            ))
        })
    }

    async fn write(&mut self, message: Value) -> Result<(), ExecutorError> {
        self.input
            .write_all(format!("{message}\n").as_bytes())
            .await
            .map_err(ExecutorError::Io)?;
        self.input.flush().await.map_err(ExecutorError::Io)
    }

    async fn send(&mut self, method: &str, params: Value) -> Result<u32, ExecutorError> {
        self.next_id += 1;
        let id = self.next_id;
        self.write(json!({"id":id,"method":method,"params":params}))
            .await?;
        Ok(id)
    }

    async fn reply(&mut self, frame: &Value, result: Value) -> Result<(), ExecutorError> {
        self.write(json!({"id":frame["id"],"result":result})).await
    }

    async fn handle_request(&mut self, frame: &Value) -> Result<(), ExecutorError> {
        if frame.get("id").is_none() {
            return Ok(());
        }
        match frame["method"].as_str() {
            Some("session/requestRuntimePreferences") => {
                self.reply(frame, json!({"nativeSearchEnhancementsEnabled":false,"askUserQuestionAutoResolutionEnabled":false})).await
            }
            Some("interaction/requestPermission") => self.reply(frame, json!({"decision":"deny"})).await,
            Some(_) => self.write(json!({"id":frame["id"],"error":{"code":-32601,"message":"This client does not provide this interaction."}})).await,
            None => Ok(()),
        }
    }

    async fn call(&mut self, method: &str, params: Value) -> Result<Value, ExecutorError> {
        tokio::time::timeout(RPC_TIMEOUT, async {
            let id = self.send(method, params).await?;
            loop {
                let frame = self.read().await?;
                if frame["id"].as_u64() == Some(u64::from(id)) && frame.get("method").is_none() {
                    return response(method, frame);
                }
                self.handle_request(&frame).await?;
            }
        })
        .await
        .map_err(|_| utils::agent_error(format!("ZCode {method} timed out. {INSTALL}")))?
    }
}

fn response(method: &str, mut frame: Value) -> Result<Value, ExecutorError> {
    if let Some(result) = frame.get_mut("result") {
        return Ok(result.take());
    }
    let code = frame["error"]["code"].as_i64().unwrap_or_default();
    let provider_error = frame["error"]["data"]["code"].as_str();
    let hint = match (code, provider_error) {
        (-32601, _) => INSTALL,
        (_, Some("invalid_model_request")) => {
            "Check the selected provider, model ID, and reasoning level."
        }
        _ => LOGIN,
    };
    Err(utils::agent_error(format!(
        "ZCode {method} failed (code {code}). {hint}"
    )))
}

impl ZCode {
    async fn start_server(
        &self,
        cwd: &Path,
        env: &ExecutionEnv,
    ) -> Result<AsyncGroupChild, ExecutorError> {
        let (program, args) = utils::agent_command("zcode", &self.cmd)?
            .into_resolved()
            .await
            .map_err(|err| utils::installation_error(err, INSTALL))?;
        let mut command = Command::new(program);
        command
            .args(args)
            .args(["app-server", "--stdio"])
            .current_dir(cwd)
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        env.clone()
            .with_profile(&self.cmd)
            .apply_to_command(&mut command);
        command.group_spawn_no_window().map_err(ExecutorError::Io)
    }

    async fn discover(&self, cwd: PathBuf) -> Result<ModelSelectorConfig, ExecutorError> {
        let env = ExecutionEnv::new(Default::default(), false, String::new());
        let mut child = self.start_server(&cwd, &env).await?;
        let mut conn = Connection::new(&mut child);
        let result = async {
            let snapshot = conn.call("session/create", json!({
                "workspace": workspace(&cwd), "persistence":"deferred", "titleGenerationEnabled":false
            })).await?;
            let config = model_config(&snapshot["settings"]["model"])?;
            Ok(config)
        }.await;
        drop(conn);
        let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
        let _ = child.kill().await;
        result
    }

    async fn run(
        &self,
        cwd: &Path,
        prompt: &str,
        id: Option<&str>,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        let mut child = self.start_server(cwd, env).await?;
        let mut conn = Connection::new(&mut child);
        let mut writer = create_stdout_pipe_writer(&mut child)?;
        let (exit_tx, exit_signal) = oneshot::channel();
        let cancel = CancellationToken::new();
        let turn_cancel = cancel.clone();
        let executor = self.clone();
        let cwd = cwd.to_path_buf();
        let id = id.map(str::to_owned);
        let prompt = self.append_prompt.combine_prompt(prompt);
        tokio::spawn(async move {
            let result = executor
                .run_turn(&mut conn, &cwd, prompt, id, &turn_cancel, &mut writer)
                .await;
            let status = match result {
                Ok(()) => ExecutorExitResult::Success,
                Err(err) => {
                    let _ = AcpEvent::Error(err.to_string()).write_to(&mut writer).await;
                    ExecutorExitResult::Failure
                }
            };
            drop(conn);
            let _ = exit_tx.send(status);
        });
        Ok(SpawnedChild {
            child,
            exit_signal: Some(exit_signal),
            cancel: Some(cancel),
            subagent_handle: None,
        })
    }

    async fn run_turn(
        &self,
        conn: &mut Connection,
        cwd: &Path,
        prompt: String,
        id: Option<String>,
        cancel: &CancellationToken,
        writer: &mut (impl AsyncWrite + Unpin),
    ) -> Result<(), ExecutorError> {
        let setup = async {
            let mode = if self.auto_approve { "yolo" } else { "build" };
            let snapshot = if let Some(id) = id {
                conn.call(
                    "session/resume",
                    json!({"sessionId":id,"workspace":workspace(cwd)}),
                )
                .await?
            } else {
                conn.call("session/create", json!({
                    "workspace":workspace(cwd), "mode":mode, "persistence":"deferred", "titleGenerationEnabled":false
                })).await?
            };
            let id = snapshot["session"]["sessionId"].as_str().ok_or_else(|| {
                utils::agent_error(format!(
                    "ZCode did not return a native session ID. {INSTALL}"
                ))
            })?;
            let catalog = &snapshot["settings"]["model"];
            if let Some(model) = &self.model {
                let model = model_ref(catalog, model, self.reasoning.as_deref())?;
                conn.call(
                    "session/setModel",
                    json!({"sessionId":id,"model":model,"persistAsWorkspaceLastUsed":false}),
                )
                .await?;
            } else if catalog["current"].is_null() {
                return Err(ExecutorError::AuthRequired(LOGIN.into()));
            }
            if snapshot["projection"]["mode"].as_str() != Some(mode) {
                conn.call("session/setMode", json!({"sessionId":id,"mode":mode}))
                    .await?;
            }
            conn.call(
                "session/subscribe",
                json!({"sessionId":id,"deliveryKind":"desktop-continuous"}),
            )
            .await?;
            Ok::<_, ExecutorError>(id.to_owned())
        };
        let id = tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            result = setup => result?,
        };
        AcpEvent::SessionStart(id.clone()).write_to(writer).await?;
        AcpEvent::User(prompt.clone()).write_to(writer).await?;
        let input_id = uuid::Uuid::new_v4().to_string();
        let request_id = conn
            .send(
                "session/send",
                json!({"sessionId":id,"inputId":input_id,"content":prompt}),
            )
            .await?;
        let result = tokio::select! {
            _ = cancel.cancelled() => {
                let _ = tokio::time::timeout(Duration::from_secs(2), conn.call("session/stop", json!({"sessionId":id}))).await;
                return Ok(());
            }
            result = self.stream_turn(conn, writer, request_id, &id, &input_id, cancel) => result,
        };
        result
    }

    async fn stream_turn(
        &self,
        conn: &mut Connection,
        writer: &mut (impl AsyncWrite + Unpin),
        request_id: u32,
        id: &str,
        input_id: &str,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutorError> {
        let mut emitted_text = false;
        let mut accepted = false;
        loop {
            let frame = if accepted {
                conn.read().await?
            } else {
                tokio::time::timeout(RPC_TIMEOUT, conn.read())
                    .await
                    .map_err(|_| {
                        utils::agent_error(format!("ZCode did not accept the prompt. {LOGIN}"))
                    })??
            };
            let params = &frame["params"];
            match frame["method"].as_str() {
                None if frame["id"].as_u64() == Some(u64::from(request_id)) => {
                    response("session/send", frame)?;
                    accepted = true;
                }
                Some("interaction/requestPermission")
                    if params["sessionId"].as_str() == Some(id) =>
                {
                    self.permission(conn, writer, &frame, cancel).await?;
                }
                Some("session/event") if params["sessionId"].as_str() == Some(id) => {
                    let payload = &params["payload"];
                    match params["type"].as_str() {
                        Some("model.streaming") => {
                            if let Some(delta) = payload["delta"].as_str() {
                                match payload["kind"].as_str() {
                                    Some("text_delta") => {
                                        AcpEvent::text(delta).write_to(writer).await?;
                                        emitted_text = true;
                                    }
                                    Some("reasoning_delta") => {
                                        AcpEvent::thought(delta).write_to(writer).await?
                                    }
                                    _ => {}
                                }
                            }
                        }
                        Some("turn.completed" | "turn.failed")
                            if payload["inputId"]
                                .as_str()
                                .is_none_or(|value| value == input_id) =>
                        {
                            if payload["resultType"] != "success" {
                                return Err(utils::agent_error(format!(
                                    "ZCode could not complete the turn. Check the provider credentials and selected model. {LOGIN}"
                                )));
                            }
                            if !emitted_text && let Some(text) = payload["response"].as_str() {
                                AcpEvent::text(text).write_to(writer).await?;
                            }
                            return AcpEvent::Done("end_turn".into()).write_to(writer).await;
                        }
                        _ => {}
                    }
                }
                _ => conn.handle_request(&frame).await?,
            }
        }
    }

    async fn permission(
        &self,
        conn: &mut Connection,
        writer: &mut (impl AsyncWrite + Unpin),
        frame: &Value,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutorError> {
        let params = &frame["params"];
        let Some(id) = params["toolCallId"].as_str() else {
            return conn.reply(frame, json!({"decision":"deny"})).await;
        };
        let name = params["toolName"].as_str().unwrap_or("tool");
        let status = if self.auto_approve {
            ApprovalStatus::Approved
        } else if let Some(approvals) = &self.approvals {
            let title = params["reason"]
                .as_str()
                .filter(|text| !text.is_empty())
                .map_or_else(|| name.to_owned(), |reason| format!("{name}: {reason}"));
            AcpEvent::ToolCall(
                ToolCall::new(id.to_owned(), title.clone()).status(ToolCallStatus::Pending),
            )
            .write_to(writer)
            .await?;
            let approval_id = approvals.create_tool_approval(&title).await?;
            AcpEvent::ApprovalRequested {
                tool_call_id: id.into(),
                approval_id: approval_id.clone(),
            }
            .write_to(writer)
            .await?;
            approvals
                .wait_tool_approval(&approval_id, cancel.clone())
                .await?
        } else {
            ApprovalStatus::Denied { reason: None }
        };
        let result = match &status {
            ApprovalStatus::Approved => json!({"decision":"allow"}),
            ApprovalStatus::Denied {
                reason: Some(reason),
            } => json!({"decision":"deny","reason":reason}),
            _ => json!({"decision":"deny"}),
        };
        conn.reply(frame, result).await?;
        if !self.auto_approve {
            AcpEvent::ApprovalResponse(ApprovalResponse {
                tool_call_id: id.into(),
                status,
            })
            .write_to(writer)
            .await?;
        }
        Ok(())
    }
}

fn workspace(cwd: &Path) -> Value {
    json!({"workspacePath":cwd,"workspaceKey":cwd})
}

fn model_ref(
    catalog: &Value,
    value: &str,
    reasoning: Option<&str>,
) -> Result<Value, ExecutorError> {
    let (provider, model) = value
        .split_once('/')
        .filter(|(provider, model)| !provider.is_empty() && !model.is_empty())
        .ok_or_else(|| utils::agent_error("Select a ZCode model in provider/model format."))?;
    let option = catalog["available"]
        .as_array()
        .and_then(|options| {
            options.iter().find(|entry| {
                entry["ref"]["providerId"] == provider
                    && entry["ref"]["modelId"] == model
                    && entry["disabledReason"].is_null()
            })
        })
        .ok_or_else(|| {
            utils::agent_error(format!("The selected ZCode model is unavailable. {LOGIN}"))
        })?;
    let mut selection = option["ref"].clone();
    if let Some(level) = reasoning.or_else(|| option["reasoning"]["defaultLevel"].as_str()) {
        selection["options"] = json!({"reasoningLevel":level});
    }
    Ok(selection)
}

fn model_config(catalog: &Value) -> Result<ModelSelectorConfig, ExecutorError> {
    let mut config = ModelSelectorConfig {
        permissions: vec![PermissionPolicy::Supervised, PermissionPolicy::Auto],
        ..Default::default()
    };
    if let (Some(provider), Some(id)) = (
        catalog["current"]["providerId"].as_str(),
        catalog["current"]["modelId"].as_str(),
    ) {
        config.default_model = Some(format!("{provider}/{id}"));
    }
    for entry in catalog["available"].as_array().into_iter().flatten() {
        if !entry["disabledReason"].is_null() {
            continue;
        }
        let (Some(provider), Some(id)) = (
            entry["ref"]["providerId"].as_str(),
            entry["ref"]["modelId"].as_str(),
        ) else {
            continue;
        };
        if !config.providers.iter().any(|item| item.id == provider) {
            config.providers.push(ModelProvider {
                id: provider.into(),
                name: entry["providerLabel"].as_str().unwrap_or(provider).into(),
            });
        }
        let reasoning = &entry["reasoning"];
        config.models.push(ModelInfo {
            id: id.into(),
            name: entry["label"].as_str().unwrap_or(id).into(),
            provider_id: Some(provider.into()),
            reasoning_options: reasoning["levels"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|level| {
                    let value = level["value"].as_str()?;
                    Some(ReasoningOption {
                        id: value.into(),
                        label: level["label"].as_str().unwrap_or(value).into(),
                        is_default: reasoning["defaultLevel"].as_str() == Some(value),
                    })
                })
                .collect(),
            supports_fast: false,
        });
    }
    if config.models.is_empty() {
        return Err(ExecutorError::AuthRequired(LOGIN.into()));
    }
    Ok(config)
}

#[async_trait]
impl StandardCodingAgentExecutor for ZCode {
    fn apply_overrides(&mut self, config: &ExecutorConfig) {
        if let Some(model) = &config.model_id {
            if self.model.as_ref() != Some(model) {
                self.reasoning = None;
            }
            self.model = Some(model.clone());
        }
        if let Some(reasoning) = &config.reasoning_id {
            self.reasoning = Some(reasoning.clone());
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
            return Err(ExecutorError::FollowUpNotSupported("ZCode supports native resume. Message-level rewind is unavailable in this executor.".into()));
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
        utils::agent_availability("zcode", &self.cmd)
    }

    fn get_preset_options(&self) -> ExecutorConfig {
        let mut config = ExecutorConfig::new(BaseCodingAgent::ZCode);
        config.model_id = self.model.clone();
        config.reasoning_id = self.reasoning.clone();
        config.permission_policy = Some(if self.auto_approve {
            PermissionPolicy::Auto
        } else {
            PermissionPolicy::Supervised
        });
        config
    }

    async fn discover_options(
        &self,
        workdir: Option<&Path>,
        repo_path: Option<&Path>,
    ) -> Result<futures::stream::BoxStream<'static, json_patch::Patch>, ExecutorError> {
        let cwd = utils::discovery_dir(workdir, repo_path);
        let executor = self.clone();
        Ok(Box::pin(futures::stream::once(async move {
            let mut options = ExecutorDiscoveredOptions::default();
            match executor.discover(cwd).await {
                Ok(config) => options.model_selector = config,
                Err(err) => options.error = Some(err.to_string()),
            }
            patch::executor_discovered_options(options)
        })))
    }
}
