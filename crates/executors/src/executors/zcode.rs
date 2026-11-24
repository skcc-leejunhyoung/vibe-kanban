use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use agent_client_protocol::{
    ToolCall, ToolCallStatus, ToolCallUpdate, ToolCallUpdateFields, ToolKind,
};
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
    approvals::{ApprovalStatus, QuestionStatus},
    command_ext::GroupSpawnNoWindowExt,
    msg_store::MsgStore,
};

use super::{
    AppendPrompt, AvailabilityInfo, BaseCodingAgent, ExecutorError, ExecutorExitResult,
    SlashCommandDescription, SpawnedChild, StandardCodingAgentExecutor,
    acp::{self, AcpEvent, ApprovalResponse},
    utils,
};
use crate::{
    approvals::ExecutorApprovalService,
    command::CmdOverrides,
    env::{CommitReminder, ExecutionEnv},
    executor_discovery::ExecutorDiscoveredOptions,
    logs::{
        AnsweredQuestion, AskUserQuestionItem, AskUserQuestionOption, TokenUsageInfo, utils::patch,
    },
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
    /// Approve every permission request without asking. ZCode still applies
    /// the user's deny rules first, which its `yolo` mode would skip.
    #[serde(default)]
    pub auto_approve: bool,
    /// Decline the agent's questions (unattended runs).
    #[serde(default)]
    pub dont_ask: bool,
    #[serde(flatten)]
    pub cmd: CmdOverrides,
    #[serde(skip)]
    #[ts(skip)]
    #[derivative(Debug = "ignore", PartialEq = "ignore")]
    pub approvals: Option<Arc<dyn ExecutorApprovalService>>,
    /// A requested policy this executor cannot honour; the turn is refused.
    #[serde(skip)]
    #[ts(skip)]
    #[derivative(PartialEq = "ignore")]
    pub unsupported_policy: Option<PermissionPolicy>,
}

const NO_ANSWER: &str = "The user cannot answer questions in this run. Continue with your best judgment and state the assumptions you make.";

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
                utils::agent_error("ZCode's app server exited unexpectedly. Check that the configured command runs `app-server --stdio` on this host and has a writable temporary directory.")
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
            Some("interaction/requestUserInput") => {
                self.reply(frame, json!({"action":"decline","reason":NO_ANSWER})).await
            }
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
        let env = env.clone().with_profile(&self.cmd);
        env.apply_to_command(&mut command);
        #[cfg(unix)]
        if zcode_needs_short_tmpdir(&env) {
            command.env("TMPDIR", "/tmp");
        }
        command.group_spawn_no_window().map_err(ExecutorError::Io)
    }

    async fn discover(
        &self,
        cwd: PathBuf,
    ) -> Result<(ModelSelectorConfig, Vec<SlashCommandDescription>), ExecutorError> {
        let env = ExecutionEnv::new(Default::default(), false, String::new());
        let mut child = self.start_server(&cwd, &env).await?;
        let mut conn = Connection::new(&mut child);
        let result = async {
            let snapshot = conn.call("session/create", json!({
                "workspace": workspace(&cwd), "persistence":"deferred", "titleGenerationEnabled":false
            })).await?;
            let config = model_config(&snapshot["settings"]["model"])?;
            Ok((config, slash_commands(&snapshot)))
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
        utils::refuse_unsupported(
            "ZCode",
            &self.unsupported_policy,
            "Supervised, Auto or Don't Ask",
        )?;
        let mut child = self.start_server(cwd, env).await?;
        let mut conn = Connection::new(&mut child);
        let mut writer = create_stdout_pipe_writer(&mut child)?;
        let (exit_tx, exit_signal) = oneshot::channel();
        let cancel = CancellationToken::new();
        let turn_cancel = cancel.clone();
        let executor = self.clone();
        let cwd = cwd.to_path_buf();
        let id = id.map(str::to_owned);
        // ZCode runs `/name args` as a command; the text must stay exact.
        let prompt = if utils::parse_slash_command::<utils::SlashCommandCall<'_>>(prompt).is_some()
        {
            prompt.to_owned()
        } else {
            self.append_prompt.combine_prompt(prompt)
        };
        let reminder = CommitReminder::from_env(env);
        tokio::spawn(async move {
            let result = executor
                .run_turn(
                    &mut conn,
                    &cwd,
                    prompt,
                    id,
                    reminder,
                    &turn_cancel,
                    &mut writer,
                )
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

    #[allow(clippy::too_many_arguments)]
    async fn run_turn(
        &self,
        conn: &mut Connection,
        cwd: &Path,
        prompt: String,
        id: Option<String>,
        mut reminder: Option<CommitReminder>,
        cancel: &CancellationToken,
        writer: &mut (impl AsyncWrite + Unpin),
    ) -> Result<(), ExecutorError> {
        let setup = async {
            // Auto approves each request in build mode instead of using yolo,
            // which allows a tool before the user's deny rules are checked.
            let mode = "build";
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
            let mut usage = ContextUsage::from_snapshot(&snapshot);
            if let Some(model) =
                selected_model(catalog, self.model.as_deref(), self.reasoning.as_deref())?
            {
                if model["providerId"] != catalog["current"]["providerId"]
                    || model["modelId"] != catalog["current"]["modelId"]
                {
                    // The measured context belongs to the previous model.
                    usage = ContextUsage::default();
                }
                conn.call(
                    "session/setModel",
                    json!({"sessionId":id,"model":model,"persistAsWorkspaceLastUsed":false}),
                )
                .await?;
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
            Ok::<_, ExecutorError>((id.to_owned(), usage))
        };
        let (id, mut usage) = tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            result = setup => result?,
        };
        AcpEvent::SessionStart(id.clone()).write_to(writer).await?;
        AcpEvent::User(prompt.clone()).write_to(writer).await?;
        AcpEvent::TokenUsage(usage.info()).write_to(writer).await?;
        let mut prompt = prompt;
        loop {
            let compacting = utils::parse_slash_command::<utils::SlashCommandCall<'_>>(&prompt)
                .is_some_and(|command| command.name == "compact");
            let input_id = uuid::Uuid::new_v4().to_string();
            let request_id = conn
                .send(
                    "session/send",
                    json!({"sessionId":id,"inputId":input_id,"content":prompt}),
                )
                .await?;
            tokio::select! {
                _ = cancel.cancelled() => {
                    let _ = tokio::time::timeout(Duration::from_secs(2), conn.call("session/stop", json!({"sessionId":id}))).await;
                    return Ok(());
                }
                result = self.stream_turn(conn, writer, request_id, &id, &input_id, &mut usage, cancel) => result?,
            }
            if compacting {
                // The summary replaces the context; its size is known after the next reply.
                usage.used = 0;
                AcpEvent::TokenUsage(usage.info()).write_to(writer).await?;
            }
            let next = match reminder.take() {
                Some(reminder) if !compacting => reminder.prompt().await,
                _ => None,
            };
            let Some(next) = next else {
                return AcpEvent::Done("end_turn".into()).write_to(writer).await;
            };
            AcpEvent::System(next.clone()).write_to(writer).await?;
            prompt = next;
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn stream_turn(
        &self,
        conn: &mut Connection,
        writer: &mut (impl AsyncWrite + Unpin),
        request_id: u32,
        id: &str,
        input_id: &str,
        usage: &mut ContextUsage,
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
                Some("interaction/requestUserInput")
                    if params["sessionId"].as_str() == Some(id) =>
                {
                    self.user_input(conn, writer, &frame, cancel).await?;
                }
                Some("session/event") if params["sessionId"].as_str() == Some(id) => {
                    let payload = &params["payload"];
                    match params["type"].as_str() {
                        Some("model.streaming") => {
                            if payload["kind"] == "tool_call"
                                && let Some(event) = tool_event(payload)
                            {
                                event.write_to(writer).await?;
                            }
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
                                let error = &payload["error"];
                                let status =
                                    error["attribution"]["statusCode"].as_i64().or_else(|| {
                                        (error["attribution"]["reason"] == "auth_failed")
                                            .then_some(401)
                                    });
                                return Err(utils::provider_request_error(
                                    "ZCode",
                                    status,
                                    LOGIN,
                                    "ZCode could not complete the turn. Check the selected model and provider configuration.",
                                ));
                            }
                            if !emitted_text && let Some(text) = payload["response"].as_str() {
                                AcpEvent::text(text).write_to(writer).await?;
                            }
                            return Ok(());
                        }
                        Some("session.updated") => {
                            if let Some(info) = usage.observe(payload) {
                                AcpEvent::TokenUsage(info).write_to(writer).await?;
                            }
                        }
                        Some("tool.updated") => {
                            if let Some(event) = tool_event(payload) {
                                event.write_to(writer).await?;
                            }
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
            AcpEvent::ToolUpdate(ToolCallUpdate::new(
                id.to_owned(),
                ToolCallUpdateFields::new()
                    .title(name)
                    .status(ToolCallStatus::Pending),
            ))
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

impl ZCode {
    /// ZCode's AskUserQuestion. Under Don't Ask, or for anything but a list
    /// of choice questions (such as a plan approval), it is declined with a
    /// reason the agent can act on.
    async fn user_input(
        &self,
        conn: &mut Connection,
        writer: &mut (impl AsyncWrite + Unpin),
        frame: &Value,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutorError> {
        let params = &frame["params"];
        let decline = json!({"action":"decline","reason":NO_ANSWER});
        let approvals = match &self.approvals {
            Some(approvals) if !self.dont_ask => approvals,
            _ => return conn.reply(frame, decline).await,
        };
        let Some(questions) = user_questions(params) else {
            return conn.reply(frame, decline).await;
        };
        let tool_id = params["toolCallId"]
            .as_str()
            .or(params["requestId"].as_str())
            .unwrap_or("question")
            .to_owned();
        let title = params["toolName"].as_str().unwrap_or("AskUserQuestion");
        AcpEvent::ToolUpdate(ToolCallUpdate::new(
            tool_id.clone(),
            ToolCallUpdateFields::new()
                .title(title)
                .status(ToolCallStatus::Pending)
                .raw_input(Value::Object(serde_json::Map::from_iter([(
                    acp::QUESTIONS_KEY.to_owned(),
                    json!(questions),
                )]))),
        ))
        .write_to(writer)
        .await?;
        let approval_id = approvals
            .create_question_approval(title, questions.len())
            .await?;
        AcpEvent::ApprovalRequested {
            tool_call_id: tool_id.clone(),
            approval_id: approval_id.clone(),
        }
        .write_to(writer)
        .await?;
        let answers = match approvals
            .wait_question_answer(&approval_id, cancel.clone())
            .await?
        {
            QuestionStatus::Answered { answers } => answers,
            QuestionStatus::TimedOut => return conn.reply(frame, decline).await,
        };
        let content: serde_json::Map<String, Value> = answers
            .iter()
            .map(|answer| {
                let value = match answer.answer.as_slice() {
                    [single] => json!(single),
                    many => json!(many),
                };
                (answer.question.clone(), value)
            })
            .collect();
        conn.reply(
            frame,
            json!({"action":"accept","content":{"answers":content}}),
        )
        .await?;
        AcpEvent::QuestionAnswered {
            tool_call_id: tool_id,
            answers: answers
                .into_iter()
                .map(|answer| AnsweredQuestion {
                    question: answer.question,
                    answer: answer.answer,
                })
                .collect(),
        }
        .write_to(writer)
        .await
    }
}

/// AskUserQuestion's questions in the chat's form; `None` for any other
/// interaction that arrives this way, such as a plan approval.
fn user_questions(params: &Value) -> Option<Vec<AskUserQuestionItem>> {
    if !params["schema"]["interaction"].is_null() {
        return None;
    }
    let questions = params["questions"].as_array()?;
    let items: Vec<_> = questions
        .iter()
        .map(|question| {
            Some(AskUserQuestionItem {
                question: question["question"].as_str()?.to_owned(),
                header: question["header"].as_str().unwrap_or("Question").to_owned(),
                options: question["options"]
                    .as_array()?
                    .iter()
                    .filter_map(|option| {
                        Some(AskUserQuestionOption {
                            label: option["label"].as_str()?.to_owned(),
                            description: option["description"]
                                .as_str()
                                .unwrap_or_default()
                                .to_owned(),
                        })
                    })
                    .collect(),
                multi_select: question["multiSelect"] == true,
                allow_custom_answer: Some(true),
            })
        })
        .collect::<Option<_>>()?;
    (!items.is_empty()).then_some(items)
}

/// The commands a session's snapshot lists for its `/` menu.
fn slash_commands(snapshot: &Value) -> Vec<SlashCommandDescription> {
    utils::reorder_slash_commands(
        snapshot["slashCommands"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|command| {
                let name = command["name"].as_str()?.trim_start_matches('/');
                let description = command["description"].as_str().unwrap_or_default();
                let description = match command["inputHint"].as_str() {
                    Some(hint) if !description.is_empty() => format!("{description} ({hint})"),
                    Some(hint) => hint.to_owned(),
                    None => description.to_owned(),
                };
                Some(SlashCommandDescription {
                    name: name.to_owned(),
                    description: (!description.is_empty()).then_some(description),
                })
            }),
    )
}

/// The context gauge: ZCode's own meter at session start, then each main
/// model call's context (input window plus output) against the session
/// model's window.
#[derive(Default)]
struct ContextUsage {
    used: u64,
    window: u64,
}

impl ContextUsage {
    fn from_snapshot(snapshot: &Value) -> Self {
        let usage = &snapshot["runtime"]["contextUsage"];
        let window = usage["size"]
            .as_u64()
            .or(snapshot["projection"]["contextWindow"].as_u64())
            .unwrap_or_default();
        Self {
            used: usage["used"].as_u64().unwrap_or_default(),
            window,
        }
    }

    fn info(&self) -> TokenUsageInfo {
        match (u32::try_from(self.used), u32::try_from(self.window)) {
            (Ok(used), Ok(window)) if used > 0 && window > 0 => TokenUsageInfo {
                total_tokens: used,
                model_context_window: window,
            },
            _ => TokenUsageInfo {
                total_tokens: 0,
                model_context_window: 0,
            },
        }
    }

    /// `session.updated` carries internal events ZCode has no legacy name
    /// for: a model call's completion, and a model selection with its window.
    fn observe(&mut self, payload: &Value) -> Option<TokenUsageInfo> {
        if payload["modelSelection"].is_object() {
            self.window = payload["contextWindow"].as_u64().unwrap_or_default();
            self.used = 0;
            return Some(self.info());
        }
        let usage = &payload["usage"];
        if !usage.is_object() || payload["stopReason"].is_null() {
            return None;
        }
        if payload["querySource"]
            .as_str()
            .is_some_and(|source| source != "main_turn")
        {
            return None;
        }
        let count = |key: &str| usage[key].as_u64().unwrap_or_default();
        let used = count("inputTokens") + count("outputTokens");
        self.used = if used > 0 { used } else { count("totalTokens") };
        if let Some(window) = payload["contextWindow"].as_u64() {
            self.window = window;
        }
        Some(self.info())
    }
}

#[cfg(unix)]
fn zcode_needs_short_tmpdir(env: &ExecutionEnv) -> bool {
    let path = ["TMPDIR", "TMP", "TEMP"].into_iter().find_map(|key| {
        env.get(key)
            .map(std::ffi::OsString::from)
            .or_else(|| std::env::var_os(key))
            .filter(|value| !value.is_empty())
    });
    // The broker appends /znr-<36-byte UUID>.sock to Node's temp directory.
    path.is_some_and(|path| path.as_encoded_bytes().len() + 46 > 103)
}

fn tool_event(payload: &Value) -> Option<AcpEvent> {
    let id = payload["toolCallId"].as_str()?;
    let mut update = ToolCallUpdateFields::new();
    let status = match payload["kind"].as_str()? {
        "scheduled" | "tool_call" => {
            let name = payload["toolName"].as_str().unwrap_or("tool");
            let mut call = ToolCall::new(id.to_owned(), name).status(ToolCallStatus::Pending);
            if let Some(command) = payload["input"]["command"].as_str() {
                call = call
                    .kind(ToolKind::Execute)
                    .raw_input(json!({"command": command}));
            }
            return Some(AcpEvent::ToolCall(call));
        }
        "started" => ToolCallStatus::InProgress,
        "result" => {
            let result = &payload["result"];
            let exit_code = result["perf"]["detail"]["command"]["exitCode"].as_i64();
            if let Some(code) = exit_code {
                update = update.content(vec![format!("Exit code: {code}").into()]);
            }
            if !result["success"].as_bool()? || exit_code.is_some_and(|code| code != 0) {
                ToolCallStatus::Failed
            } else {
                ToolCallStatus::Completed
            }
        }
        "error" => ToolCallStatus::Failed,
        _ => return None,
    };
    Some(AcpEvent::ToolUpdate(ToolCallUpdate::new(
        id.to_owned(),
        update.status(status),
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn socket_path_limit_uses_effective_tempdir_in_bytes() {
        let mut env = ExecutionEnv::new(Default::default(), false, String::new());
        env.insert("TMPDIR", format!("/{}", "x".repeat(56)));
        assert!(!zcode_needs_short_tmpdir(&env));
        env.insert("TMPDIR", format!("/{}", "한".repeat(19)));
        assert!(zcode_needs_short_tmpdir(&env));
    }

    #[test]
    fn context_usage_follows_snapshot_model_calls_and_model_switches() {
        let mut usage = ContextUsage::from_snapshot(&json!({
            "runtime": {"contextUsage": {"used": 1200, "size": 200000, "cost": null}},
            "projection": {"contextWindow": 200000}
        }));
        assert_eq!(
            (usage.info().total_tokens, usage.info().model_context_window),
            (1200, 200000)
        );
        let call = |source: &str, input: u64| {
            json!({"usage": {"inputTokens": input, "outputTokens": 300}, "stopReason": "stop",
                   "querySource": source, "content": ""})
        };
        assert_eq!(usage.observe(&call("title", 9999)), None);
        let info = usage.observe(&call("main_turn", 5000)).unwrap();
        assert_eq!(
            (info.total_tokens, info.model_context_window),
            (5300, 200000)
        );
        let switched = usage
            .observe(&json!({"modelSelection": {"providerId": "p", "modelId": "m"}, "contextWindow": 64000}))
            .unwrap();
        assert_eq!(
            (switched.total_tokens, switched.model_context_window),
            (0, 0)
        );
        let info = usage.observe(&call("main_turn", 100)).unwrap();
        assert_eq!((info.total_tokens, info.model_context_window), (400, 64000));
        assert_eq!(usage.observe(&json!({"title": "renamed"})), None);
        assert_eq!(
            ContextUsage::from_snapshot(&json!({}))
                .info()
                .model_context_window,
            0
        );
    }

    #[test]
    fn lists_snapshot_commands_and_questions() {
        let commands = slash_commands(&json!({"slashCommands": [
            {"name": "init", "description": "Create AGENTS.md", "source": "builtin"},
            {"name": "compact", "description": "Compact", "inputHint": "focus", "source": "builtin"}
        ]}));
        assert_eq!(commands[0].name, "compact");
        assert_eq!(commands[0].description.as_deref(), Some("Compact (focus)"));
        let questions = user_questions(&json!({"requestId": "r", "sessionId": "s", "questions": [
            {"question": "Which?", "header": "Pick", "multiSelect": true,
             "options": [{"value": "a", "label": "A"}, {"value": "b", "label": "B"}]}
        ]}))
        .unwrap();
        assert!(questions[0].multi_select && questions[0].options[1].label == "B");
        assert!(
            user_questions(&json!({"schema": {"interaction": "plan_approval"}, "questions": []}))
                .is_none()
        );
    }

    #[test]
    fn policies_map_to_build_mode_flags_and_plan_is_refused() {
        let mut zcode: ZCode = serde_json::from_value(json!({})).unwrap();
        let mut config = ExecutorConfig::new(BaseCodingAgent::ZCode);
        for (policy, auto, dont_ask, refused) in [
            (PermissionPolicy::Auto, true, false, false),
            (PermissionPolicy::DontAsk, true, true, false),
            (PermissionPolicy::Supervised, false, false, false),
            (PermissionPolicy::Plan, false, false, true),
        ] {
            config.permission_policy = Some(policy.clone());
            zcode.apply_overrides(&config);
            assert_eq!(
                (
                    zcode.auto_approve,
                    zcode.dont_ask,
                    zcode.unsupported_policy.is_some()
                ),
                (auto, dont_ask, refused)
            );
            if !refused {
                assert_eq!(zcode.get_preset_options().permission_policy, Some(policy));
            }
        }
    }

    #[test]
    fn maps_tool_result_and_error_to_terminal_status() {
        for (kind, result, expected) in [
            ("result", json!({"success":true}), ToolCallStatus::Completed),
            ("result", json!({"success":false}), ToolCallStatus::Failed),
            ("error", Value::Null, ToolCallStatus::Failed),
        ] {
            let Some(AcpEvent::ToolUpdate(update)) = tool_event(&json!({
                "toolCallId": "call_fixture", "kind": kind, "result": result,
            })) else {
                panic!("expected a tool update");
            };
            assert_eq!(update.fields.status, Some(expected));
        }
    }
}

fn workspace(cwd: &Path) -> Value {
    json!({"workspacePath":cwd,"workspaceKey":cwd})
}

fn selected_model(
    catalog: &Value,
    model: Option<&str>,
    reasoning: Option<&str>,
) -> Result<Option<Value>, ExecutorError> {
    let current = &catalog["current"];
    if model.is_none() && reasoning.is_none() {
        return if current.is_null() {
            Err(ExecutorError::AuthRequired(LOGIN.into()))
        } else {
            Ok(None)
        };
    }
    let current_model = || {
        Some(format!(
            "{}/{}",
            current["providerId"].as_str()?,
            current["modelId"].as_str()?
        ))
    };
    let model = model
        .map(str::to_owned)
        .or_else(current_model)
        .ok_or_else(|| ExecutorError::AuthRequired(LOGIN.into()))?;
    model_ref(catalog, &model, reasoning).map(Some)
}

#[cfg(test)]
mod selected_model_tests {
    use super::*;

    #[test]
    fn reasoning_without_override_uses_the_current_model() {
        let catalog = json!({
            "current": {"providerId":"fixture", "modelId":"model"},
            "available": [{"ref":{"providerId":"fixture", "modelId":"model"}}]
        });
        assert_eq!(selected_model(&catalog, None, None).unwrap(), None);
        assert_eq!(
            selected_model(&catalog, None, Some("high")).unwrap(),
            Some(json!({
                "providerId":"fixture", "modelId":"model", "options":{"reasoningLevel":"high"}
            }))
        );
        assert!(selected_model(&json!({}), None, Some("high")).is_err());
    }
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
        permissions: vec![
            PermissionPolicy::Supervised,
            PermissionPolicy::Auto,
            PermissionPolicy::DontAsk,
        ],
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
        let executor = self.clone();
        Ok(Box::pin(futures::stream::once(async move {
            let mut options = ExecutorDiscoveredOptions::default();
            match executor.discover(cwd).await {
                Ok((config, commands)) => {
                    options.model_selector = config;
                    options.slash_commands = commands;
                }
                Err(err) => options.error = Some(err.to_string()),
            }
            patch::executor_discovered_options(options)
        })))
    }
}

#[cfg(all(test, unix))]
mod app_server_tests {
    use std::path::PathBuf;

    use async_trait::async_trait;
    use tokio::io::AsyncReadExt;

    use super::*;
    use crate::{approvals::ExecutorApprovalError, env::RepoContext};

    /// A minimal ZCode `app-server --stdio` in the legacy `session/*` protocol
    /// of ZCode 0.17.0 (frames follow its published schemas).
    const SERVER: &str = r#"
import json, os, sys
log_path, window_for = sys.argv[1], {"m1": 200000, "m2": 64000}
model, sends, replies = "m1", [], []
def out(frame):
    sys.stdout.write(json.dumps(frame) + "\n"); sys.stdout.flush()
def event(kind, payload):
    out({"jsonrpc": "2.0", "method": "session/event",
         "params": {"sessionId": "zc-sess", "type": kind, "payload": payload}})
def save():
    with open(log_path + ".tmp", "w") as log:
        json.dump({"sends": sends, "replies": replies, "model": model}, log)
    os.replace(log_path + ".tmp", log_path)
catalog = {"current": {"providerId": "p", "modelId": "m1"},
           "available": [{"ref": {"providerId": "p", "modelId": m}, "label": m, "providerLabel": "P",
                          "disabledReason": None, "reasoning": {"levels": [], "defaultLevel": None}}
                         for m in ("m1", "m2")]}
snapshot = {"session": {"sessionId": "zc-sess"}, "settings": {"model": catalog},
            "projection": {"mode": "build", "contextWindow": 200000, "contextUsed": 0},
            "runtime": {"contextUsage": {"used": 1200, "size": 200000, "cost": None}},
            "slashCommands": [
                {"name": "init", "description": "Create AGENTS.md", "source": "builtin"},
                {"name": "compact", "description": "Compact the context", "inputHint": "focus", "source": "builtin"}]}
for line in sys.stdin:
    message = json.loads(line)
    method, request = message.get("method"), message.get("id")
    if method in ("session/create", "session/resume"):
        out({"id": request, "result": snapshot})
    elif method == "session/setModel":
        model = message["params"]["model"]["modelId"]
        out({"id": request, "result": {}})
    elif method in ("session/setMode", "session/subscribe", "session/stop"):
        out({"id": request, "result": {}})
    elif method == "session/send":
        sends.append(message["params"]["content"])
        out({"id": request, "result": {}})
        if os.environ.get("ZCODE_FIXTURE_QUESTION") and len(sends) == 1:
            out({"id": "srv-q", "method": "interaction/requestUserInput",
                 "params": {"requestId": "r1", "sessionId": "zc-sess", "toolCallId": "call-q",
                            "toolName": "AskUserQuestion",
                            "questions": [{"question": "Which color?", "header": "Color",
                                           "options": [{"value": "red", "label": "red"},
                                                       {"value": "blue", "label": "blue"}]}]}})
            for answer_line in sys.stdin:
                answer = json.loads(answer_line)
                if answer.get("id") == "srv-q":
                    replies.append(answer["result"])
                    break
        count = len(sends)
        save()
        event("session.updated", {"content": "", "stopReason": "stop", "querySource": "main_turn",
                                  "contextWindow": window_for[model],
                                  "usage": {"inputTokens": 5000 * count, "outputTokens": 300}})
        event("model.streaming", {"kind": "text_delta", "delta": "reply %d" % count})
        event("turn.completed", {"resultType": "success", "response": "reply %d" % count})
"#;

    struct Approvals {
        question: Option<QuestionStatus>,
    }

    #[async_trait]
    impl ExecutorApprovalService for Approvals {
        async fn create_tool_approval(&self, _: &str) -> Result<String, ExecutorApprovalError> {
            Ok("tool".into())
        }
        async fn create_question_approval(
            &self,
            _: &str,
            _: usize,
        ) -> Result<String, ExecutorApprovalError> {
            Ok("question".into())
        }
        async fn wait_tool_approval(
            &self,
            _: &str,
            _: CancellationToken,
        ) -> Result<ApprovalStatus, ExecutorApprovalError> {
            Ok(ApprovalStatus::Approved)
        }
        async fn wait_question_answer(
            &self,
            _: &str,
            _: CancellationToken,
        ) -> Result<QuestionStatus, ExecutorApprovalError> {
            self.question
                .clone()
                .ok_or(ExecutorApprovalError::ServiceUnavailable)
        }
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        repo: PathBuf,
        log: PathBuf,
        zcode: ZCode,
        env: ExecutionEnv,
    }

    fn fixture(
        policy: PermissionPolicy,
        question: Option<QuestionStatus>,
        remind: bool,
        model: Option<&str>,
    ) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        assert!(
            std::process::Command::new("git")
                .args(["init", "-q"])
                .current_dir(&repo)
                .status()
                .unwrap()
                .success()
        );
        std::fs::write(repo.join("left-over.txt"), "fixture").unwrap();
        let script = dir.path().join("app_server.py");
        std::fs::write(&script, SERVER.replace("EOF_PLACEHOLDER\n", "")).unwrap();
        let log = dir.path().join("log.json");
        let mut zcode: ZCode = serde_json::from_value(json!({
            "base_command_override": format!("python3 {} {}", script.display(), log.display()),
            "env": {"ZCODE_FIXTURE_QUESTION": "1"},
        }))
        .unwrap();
        let mut config = ExecutorConfig::new(BaseCodingAgent::ZCode);
        config.permission_policy = Some(policy);
        config.model_id = model.map(str::to_owned);
        zcode.apply_overrides(&config);
        zcode.use_approvals(Arc::new(Approvals { question }));
        let env = ExecutionEnv::new(
            RepoContext::new(dir.path().to_path_buf(), vec!["repo".into()]),
            remind,
            "Commit the changes.".into(),
        );
        Fixture {
            _dir: dir,
            repo,
            log,
            zcode,
            env,
        }
    }

    async fn run(fixture: &Fixture, prompt: &str) -> (Value, Vec<AcpEvent>) {
        let mut spawned = fixture
            .zcode
            .spawn(&fixture.repo, prompt, &fixture.env)
            .await
            .unwrap();
        let mut stdout = spawned.child.inner().stdout.take().unwrap();
        let status =
            tokio::time::timeout(Duration::from_secs(30), spawned.exit_signal.take().unwrap())
                .await
                .unwrap()
                .unwrap();
        assert!(matches!(status, ExecutorExitResult::Success));
        let mut output = String::new();
        let _ =
            tokio::time::timeout(Duration::from_secs(2), stdout.read_to_string(&mut output)).await;
        let _ = spawned.child.kill().await;
        let log = serde_json::from_str(&std::fs::read_to_string(&fixture.log).unwrap()).unwrap();
        let events = output
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        (log, events)
    }

    fn usages(events: &[AcpEvent]) -> Vec<(u32, u32)> {
        events
            .iter()
            .filter_map(|event| match event {
                AcpEvent::TokenUsage(info) => Some((info.total_tokens, info.model_context_window)),
                _ => None,
            })
            .collect()
    }

    #[tokio::test]
    #[ignore = "runs a python3 ZCode app-server fixture"]
    async fn discovery_lists_session_commands_and_all_three_policies() {
        let fixture = fixture(PermissionPolicy::Auto, None, false, None);
        let (config, commands) = fixture.zcode.discover(fixture.repo.clone()).await.unwrap();
        assert_eq!(
            commands.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            ["compact", "init"]
        );
        assert_eq!(
            commands[0].description.as_deref(),
            Some("Compact the context (focus)")
        );
        assert_eq!(
            config.permissions,
            [
                PermissionPolicy::Supervised,
                PermissionPolicy::Auto,
                PermissionPolicy::DontAsk
            ]
        );
    }

    #[tokio::test]
    #[ignore = "runs a python3 ZCode app-server fixture"]
    async fn auto_shows_questions_reports_context_and_reminds_once() {
        let answers = QuestionStatus::Answered {
            answers: vec![workspace_utils::approvals::QuestionAnswer {
                question: "Which color?".into(),
                answer: vec!["blue".into()],
            }],
        };
        let fixture = fixture(PermissionPolicy::Auto, Some(answers), true, None);
        let (log, events) = run(&fixture, "Fix the fixture").await;
        assert_eq!(
            log["replies"],
            json!([{"action": "accept", "content": {"answers": {"Which color?": "blue"}}}])
        );
        let sends = log["sends"].as_array().unwrap();
        assert_eq!(sends.len(), 2, "the reminder is sent once: {sends:?}");
        assert!(
            sends[1]
                .as_str()
                .unwrap()
                .starts_with("Commit the changes.\n")
        );
        assert!(sends[1].as_str().unwrap().contains("left-over.txt"));
        // The snapshot's meter, then each main-turn model call.
        assert_eq!(
            usages(&events),
            [(1200, 200000), (5300, 200000), (10300, 200000)]
        );
        assert!(events.iter().any(|event| matches!(event,
            AcpEvent::QuestionAnswered { answers, .. } if answers[0].answer == ["blue"])));
        assert!(events.iter().any(
            |event| matches!(event, AcpEvent::System(text) if text == sends[1].as_str().unwrap())
        ));
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, AcpEvent::Done(_)))
                .count(),
            1
        );
    }

    #[tokio::test]
    #[ignore = "runs a python3 ZCode app-server fixture"]
    async fn dont_ask_declines_questions_and_a_model_switch_clears_the_old_window() {
        let fixture = fixture(PermissionPolicy::DontAsk, None, false, Some("p/m2"));
        let (log, events) = run(&fixture, "/compact focus").await;
        assert_eq!(log["replies"][0]["action"], "decline");
        assert_eq!(log["sends"], json!(["/compact focus"]));
        assert_eq!(log["model"], "m2");
        // Unknown for the switched model (not the old 200000 window), the new
        // model's window with its reply, then unknown again after compaction.
        assert_eq!(usages(&events), [(0, 0), (5300, 64000), (0, 0)]);
    }
}
