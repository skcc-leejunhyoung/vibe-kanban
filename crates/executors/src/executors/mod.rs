use std::{path::Path, sync::Arc};

use async_trait::async_trait;
use command_group::AsyncGroupChild;
use enum_dispatch::enum_dispatch;
use futures::stream::BoxStream;
use futures_io::Error as FuturesIoError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sqlx::Type;
use strum_macros::{Display, EnumDiscriminants, EnumString, VariantNames};
use thiserror::Error;
use tokio::task::JoinHandle;
use ts_rs::TS;
use workspace_utils::msg_store::MsgStore;

#[cfg(feature = "qa-mode")]
use crate::executors::qa_mock::QaMockExecutor;
use crate::{
    actions::{ExecutorAction, review::RepoReviewContext},
    approvals::ExecutorApprovalService,
    command::CommandBuildError,
    env::ExecutionEnv,
    executors::{
        amp::Amp, claude::ClaudeCode, codex::Codex, copilot::Copilot, cursor::CursorAgent,
        droid::Droid, gemini::Gemini, opencode::Opencode, opencode_v2::OpencodeV2, pi::Pi,
        qwen::QwenCode, zcode::ZCode,
    },
    logs::utils::patch,
    mcp_config::McpConfig,
    profile::ExecutorConfig,
};

pub mod acp;
pub mod amp;
pub mod claude;
pub mod codex;
pub mod copilot;
pub mod cursor;
pub mod droid;
pub mod gemini;
pub mod opencode;
pub mod opencode_v2;
pub mod pi;
#[cfg(feature = "qa-mode")]
pub mod qa_mock;
pub mod qwen;
pub mod utils;
pub mod zcode;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct SlashCommandDescription {
    /// Command name without the leading slash, e.g. `help` for `/help`.
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[ts(use_ts_enum)]
pub enum BaseAgentCapability {
    SessionFork,
    /// Agent requires a setup script before it can run (e.g., login, installation)
    SetupHelper,
    /// Agent reports context/token usage information
    ContextUsage,
}

impl BaseCodingAgent {
    /// Agents that cannot carry the uncommitted-changes reminder inside their
    /// own turn: their process ends with the turn, so the reminder is sent as a
    /// follow-up turn of the same session after a normal exit.
    pub fn commit_reminder_is_a_follow_up_turn(self) -> bool {
        matches!(self, Self::Amp | Self::CursorAgent | Self::Droid)
    }
}

#[derive(Debug, Error)]
pub enum ExecutorError {
    #[error("Follow-up is not supported: {0}")]
    FollowUpNotSupported(String),
    #[error(transparent)]
    SpawnError(#[from] FuturesIoError),
    #[error("Unknown executor type: {0}")]
    UnknownExecutorType(String),
    #[error("I/O error: {0}")]
    Io(std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    TomlSerialize(#[from] toml::ser::Error),
    #[error(transparent)]
    TomlDeserialize(#[from] toml::de::Error),
    #[error(transparent)]
    ExecutorApprovalError(#[from] crate::approvals::ExecutorApprovalError),
    #[error(transparent)]
    CommandBuild(#[from] CommandBuildError),
    #[error("Executable `{program}` not found in PATH")]
    ExecutableNotFound { program: String },
    #[error("Setup helper not supported")]
    SetupHelperNotSupported,
    #[error("Auth required: {0}")]
    AuthRequired(String),
}

#[enum_dispatch]
#[derive(
    Debug, Clone, Serialize, Deserialize, PartialEq, TS, Display, EnumDiscriminants, VariantNames,
)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[strum(serialize_all = "SCREAMING_SNAKE_CASE")]
#[strum_discriminants(
    name(BaseCodingAgent),
    // Only add Hash; Eq/PartialEq are already provided by EnumDiscriminants.
    derive(EnumString, Hash, strum_macros::Display, Serialize, Deserialize, TS, Type),
    strum(serialize_all = "SCREAMING_SNAKE_CASE"),
    ts(use_ts_enum),
    serde(rename_all = "SCREAMING_SNAKE_CASE"),
    sqlx(type_name = "TEXT", rename_all = "SCREAMING_SNAKE_CASE")
)]
pub enum CodingAgent {
    ClaudeCode,
    Amp,
    Gemini,
    Codex,
    Opencode,
    #[serde(rename = "OPENCODE_V2")]
    #[strum(serialize = "OPENCODE_V2")]
    #[strum_discriminants(serde(rename = "OPENCODE_V2"))]
    #[strum_discriminants(strum(serialize = "OPENCODE_V2"))]
    #[strum_discriminants(sqlx(rename = "OPENCODE_V2"))]
    OpencodeV2,
    Pi,
    #[serde(rename = "ZCODE")]
    #[strum(serialize = "ZCODE")]
    #[strum_discriminants(serde(rename = "ZCODE"))]
    #[strum_discriminants(strum(serialize = "ZCODE"))]
    #[strum_discriminants(sqlx(rename = "ZCODE"))]
    ZCode,
    #[serde(alias = "CURSOR")]
    #[strum_discriminants(serde(alias = "CURSOR"))]
    #[strum_discriminants(strum(serialize = "CURSOR", serialize = "CURSOR_AGENT"))]
    CursorAgent,
    QwenCode,
    Copilot,
    Droid,
    #[cfg(feature = "qa-mode")]
    QaMock(QaMockExecutor),
}

impl CodingAgent {
    /// Whether this agent's config opts into usage-based auto-resume by
    /// default. Used to seed a new session's per-session toggle. Only Claude
    /// Code and Codex expose this setting; all others default to `false`.
    pub fn auto_resume_on_limit(&self) -> bool {
        match self {
            Self::ClaudeCode(c) => c.auto_resume_on_limit.unwrap_or(false),
            Self::Codex(c) => c.auto_resume_on_limit.unwrap_or(false),
            _ => false,
        }
    }

    pub fn get_mcp_config(&self) -> McpConfig {
        match self {
            Self::Codex(_) => McpConfig::new(
                vec!["mcp_servers".to_string()],
                serde_json::json!({
                    "mcp_servers": {}
                }),
                self.preconfigured_mcp(),
                true,
            ),
            Self::Amp(_) => McpConfig::new(
                vec!["amp.mcpServers".to_string()],
                serde_json::json!({
                    "amp.mcpServers": {}
                }),
                self.preconfigured_mcp(),
                false,
            ),
            Self::Opencode(_) => McpConfig::new(
                vec!["mcp".to_string()],
                serde_json::json!({
                    "mcp": {},
                    "$schema": "https://opencode.ai/config.json"
                }),
                self.preconfigured_mcp(),
                false,
            ),
            Self::Droid(_) => McpConfig::new(
                vec!["mcpServers".to_string()],
                serde_json::json!({
                    "mcpServers": {}
                }),
                self.preconfigured_mcp(),
                false,
            ),
            _ => McpConfig::new(
                vec!["mcpServers".to_string()],
                serde_json::json!({
                    "mcpServers": {}
                }),
                self.preconfigured_mcp(),
                false,
            ),
        }
    }

    pub fn supports_mcp(&self) -> bool {
        self.default_mcp_config_path().is_some()
    }

    pub fn capabilities(&self) -> Vec<BaseAgentCapability> {
        match self {
            Self::ClaudeCode(_) => vec![
                BaseAgentCapability::SessionFork,
                BaseAgentCapability::ContextUsage,
            ],
            Self::Opencode(_) => vec![
                BaseAgentCapability::SessionFork,
                BaseAgentCapability::ContextUsage,
            ],
            Self::Codex(_) => vec![
                BaseAgentCapability::SessionFork,
                BaseAgentCapability::SetupHelper,
                BaseAgentCapability::ContextUsage,
            ],
            Self::Gemini(_) | Self::QwenCode(_) => {
                vec![BaseAgentCapability::SessionFork]
            }
            // Executors whose official events carry both the context in use and
            // the selected model's window. The others stay off the gauge rather
            // than show cumulative, per-turn or guessed numbers.
            Self::OpencodeV2(_) | Self::Pi(_) | Self::ZCode(_) => {
                vec![BaseAgentCapability::ContextUsage]
            }
            Self::CursorAgent(_) => vec![BaseAgentCapability::SetupHelper],
            Self::Amp(_) | Self::Copilot(_) | Self::Droid(_) => vec![],
            #[cfg(feature = "qa-mode")]
            Self::QaMock(_) => vec![], // QA mock doesn't need special capabilities
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AvailabilityInfo {
    LoginDetected { last_auth_timestamp: i64 },
    InstallationFound,
    NotFound,
}

impl AvailabilityInfo {
    pub fn is_available(&self) -> bool {
        matches!(
            self,
            AvailabilityInfo::LoginDetected { .. } | AvailabilityInfo::InstallationFound
        )
    }
}

#[async_trait]
#[enum_dispatch(CodingAgent)]
pub trait StandardCodingAgentExecutor {
    fn apply_overrides(&mut self, _executor_config: &ExecutorConfig) {}

    fn use_approvals(&mut self, _approvals: Arc<dyn ExecutorApprovalService>) {}

    /// Dropped turns wrote into the session about to be continued, starting
    /// at this message. Agents that keep one native session across turns
    /// continue from just before it.
    fn discard_from_message(&mut self, _message_id: &str) {}

    async fn spawn(
        &self,
        current_dir: &Path,
        prompt: &str,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError>;

    /// Continue a session, optionally resetting to a specific message.
    async fn spawn_follow_up(
        &self,
        current_dir: &Path,
        prompt: &str,
        session_id: &str,
        reset_to_message_id: Option<&str>,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError>;

    async fn spawn_review(
        &self,
        current_dir: &Path,
        prompt: &str,
        session_id: Option<&str>,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        match session_id {
            Some(id) => {
                self.spawn_follow_up(current_dir, prompt, id, None, env)
                    .await
            }
            None => self.spawn(current_dir, prompt, env).await,
        }
    }

    /// Drafts a commit message for changes a finished turn left uncommitted,
    /// without adding to the session's conversation. `instructions` already
    /// carry the changes; an agent may also use the session's own context, or
    /// answer in a one-shot run with no tools and no saved session. `Ok(None)`
    /// when the agent has no way to generate text like that.
    async fn generate_commit_message(
        &self,
        _current_dir: &Path,
        _session_id: &str,
        _instructions: &str,
        _env: &ExecutionEnv,
    ) -> Result<Option<String>, ExecutorError> {
        Ok(None)
    }

    fn normalize_logs(
        &self,
        _raw_logs_event_store: Arc<MsgStore>,
        _worktree_path: &Path,
    ) -> Vec<JoinHandle<()>> {
        vec![]
    }

    // MCP configuration methods
    fn default_mcp_config_path(&self) -> Option<std::path::PathBuf>;

    async fn get_setup_helper_action(&self) -> Result<ExecutorAction, ExecutorError> {
        Err(ExecutorError::SetupHelperNotSupported)
    }

    fn get_availability_info(&self) -> AvailabilityInfo {
        let config_files_found = self
            .default_mcp_config_path()
            .map(|path| path.exists())
            .unwrap_or(false);

        if config_files_found {
            AvailabilityInfo::InstallationFound
        } else {
            AvailabilityInfo::NotFound
        }
    }

    /// Returns a stream of executor discovered options updates.
    async fn discover_options(
        &self,
        _workdir: Option<&Path>,
        _repo_path: Option<&Path>,
    ) -> Result<BoxStream<'static, json_patch::Patch>, ExecutorError> {
        let options = crate::executor_discovery::ExecutorDiscoveredOptions::default();
        Ok(Box::pin(futures::stream::once(async move {
            patch::executor_discovered_options(options)
        })))
    }

    /// Returns the default overrides defined by this preset/variant.
    fn get_preset_options(&self) -> ExecutorConfig;
}

/// Result communicated through the exit signal
#[derive(Debug, Clone, Copy)]
pub enum ExecutorExitResult {
    /// Process completed successfully (exit code 0)
    Success,
    /// Process should be marked as failed (non-zero exit)
    Failure,
}

/// Optional exit notification from an executor.
/// When this receiver resolves, the container should gracefully stop the process
/// and mark it according to the result.
pub type ExecutorExitSignal = tokio::sync::oneshot::Receiver<ExecutorExitResult>;

/// Cancellation token for requesting graceful shutdown of an executor.
/// When cancelled, the executor should attempt to cancel gracefully before being killed.
pub type CancellationToken = tokio_util::sync::CancellationToken;

/// Live per-process client handle for individual subagent control (transcript
/// reads, `turn/interrupt` / `stop_task`). Valid only while the executor
/// process runs; the container drops it alongside the child handle.
///
/// The handle must not own the executor's stdout pipe writer: the container
/// keeps it until finalization ends, after the output drain that waits for EOF.
/// Codex's client owns that writer, so the handle is weak: the JSON-RPC reader
/// owns the client for as long as it reads the app server's output.
#[derive(Clone)]
pub enum SubagentLiveHandle {
    ClaudeCode(claude::protocol::ProtocolPeer),
    Codex(std::sync::Weak<codex::client::AppServerClient>),
}

pub struct SpawnedChild {
    pub child: AsyncGroupChild,
    /// Executor → Container: signals when executor wants to exit
    pub exit_signal: Option<ExecutorExitSignal>,
    /// Container → Executor: signals when container wants to cancel the execution
    pub cancel: Option<CancellationToken>,
    /// Executor → Container: live client for individual subagent control.
    pub subagent_handle: Option<SubagentLiveHandle>,
}

impl From<AsyncGroupChild> for SpawnedChild {
    fn from(child: AsyncGroupChild) -> Self {
        Self {
            child,
            exit_signal: None,
            cancel: None,
            subagent_handle: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, JsonSchema)]
#[serde(transparent)]
#[schemars(
    title = "Append Prompt",
    description = "Extra text appended to the prompt",
    extend("format" = "textarea")
)]
#[derive(Default)]
pub struct AppendPrompt(pub Option<String>);

impl AppendPrompt {
    pub fn get(&self) -> Option<String> {
        self.0.clone()
    }

    pub fn combine_prompt(&self, prompt: &str) -> String {
        match self {
            AppendPrompt(Some(value)) if !value.is_empty() => {
                // Always separate the appended prompt from the user's prompt
                // with a line break so the two remain distinguishable. Avoid a
                // redundant newline when the prompt already ends with one.
                let separator = if prompt.ends_with('\n') { "" } else { "\n" };
                format!("{prompt}{separator}{value}")
            }
            _ => prompt.to_string(),
        }
    }
}

#[cfg(test)]
mod append_prompt_tests {
    use super::AppendPrompt;

    #[test]
    fn inserts_line_break_before_appended_prompt() {
        let append = AppendPrompt(Some("appended".to_string()));
        assert_eq!(append.combine_prompt("user input"), "user input\nappended");
    }

    #[test]
    fn does_not_double_line_break_when_prompt_ends_with_newline() {
        let append = AppendPrompt(Some("appended".to_string()));
        assert_eq!(
            append.combine_prompt("user input\n"),
            "user input\nappended"
        );
    }

    #[test]
    fn no_append_returns_prompt_unchanged() {
        assert_eq!(
            AppendPrompt(None).combine_prompt("user input"),
            "user input"
        );
        assert_eq!(
            AppendPrompt(Some(String::new())).combine_prompt("user input"),
            "user input"
        );
    }
}

pub fn build_review_prompt(
    context: Option<&[RepoReviewContext]>,
    additional_prompt: Option<&str>,
) -> String {
    let mut prompt = String::from("Please review the code changes.\n\n");

    if let Some(repos) = context {
        for repo in repos {
            prompt.push_str(&format!("Repository: {}\n", repo.repo_name));
            prompt.push_str(&format!(
                "Review all changes from base commit {} to HEAD.\n",
                repo.base_commit
            ));
            prompt.push_str(&format!(
                "Use `git diff {}..HEAD` to see the changes.\n",
                repo.base_commit
            ));
            prompt.push('\n');
        }
    }

    if let Some(additional) = additional_prompt {
        prompt.push_str(additional);
    }

    prompt
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use super::*;

    #[test]
    fn test_cursor_agent_deserialization() {
        // Test that CURSOR_AGENT is accepted
        let result = BaseCodingAgent::from_str("CURSOR_AGENT");
        assert!(result.is_ok(), "CURSOR_AGENT should be valid");
        assert_eq!(result.unwrap(), BaseCodingAgent::CursorAgent);

        // Test that legacy CURSOR is still accepted for backwards compatibility
        let result = BaseCodingAgent::from_str("CURSOR");
        assert!(
            result.is_ok(),
            "CURSOR should be valid for backwards compatibility"
        );
        assert_eq!(result.unwrap(), BaseCodingAgent::CursorAgent);

        // Test serde deserialization for CURSOR_AGENT
        let result: Result<BaseCodingAgent, _> = serde_json::from_str(r#""CURSOR_AGENT""#);
        assert!(result.is_ok(), "CURSOR_AGENT should deserialize via serde");
        assert_eq!(result.unwrap(), BaseCodingAgent::CursorAgent);

        // Test serde deserialization for legacy CURSOR
        let result: Result<BaseCodingAgent, _> = serde_json::from_str(r#""CURSOR""#);
        assert!(result.is_ok(), "CURSOR should deserialize via serde");
        assert_eq!(result.unwrap(), BaseCodingAgent::CursorAgent);
    }

    /// A policy an agent does not implement is refused with a message that
    /// names it, before any process is started, instead of running as another
    /// policy. Only refused combinations are spawned here; the accepted ones
    /// are covered by each executor's own tests.
    #[tokio::test]
    async fn unsupported_permission_policies_are_refused_not_substituted() {
        use crate::{
            model_selector::PermissionPolicy::{Plan, Supervised},
            profile::{ExecutorConfig, ExecutorConfigs, ExecutorProfileId},
        };
        let refused = [
            (BaseCodingAgent::Gemini, vec![Plan]),
            (BaseCodingAgent::QwenCode, vec![Plan]),
            (BaseCodingAgent::Copilot, vec![Plan]),
            (BaseCodingAgent::Opencode, vec![Plan]),
            (BaseCodingAgent::OpencodeV2, vec![Plan]),
            (BaseCodingAgent::Pi, vec![Plan]),
            (BaseCodingAgent::ZCode, vec![Plan]),
            (BaseCodingAgent::Amp, vec![Supervised, Plan]),
            (BaseCodingAgent::Droid, vec![Supervised, Plan]),
            (BaseCodingAgent::CursorAgent, vec![Supervised]),
        ];
        let env = ExecutionEnv::new(Default::default(), false, String::new());
        let cwd = std::env::temp_dir();
        let profiles = ExecutorConfigs::from_defaults();
        for (executor, policies) in refused {
            for policy in policies {
                let mut agent = profiles
                    .get_coding_agent(&ExecutorProfileId::new(executor))
                    .unwrap();
                let mut config = ExecutorConfig::new(executor);
                config.permission_policy = Some(policy.clone());
                agent.apply_overrides(&config);
                for follow_up in [false, true] {
                    let result = if follow_up {
                        agent
                            .spawn_follow_up(&cwd, "work", "session", None, &env)
                            .await
                    } else {
                        agent.spawn(&cwd, "work", &env).await
                    };
                    let message = match result {
                        Ok(_) => panic!("{executor} ran under {policy:?}"),
                        Err(err) => err.to_string(),
                    };
                    assert!(
                        message.contains("permission polic")
                            && message.contains(&format!("{policy:?}")),
                        "{executor} under {policy:?}: {message}"
                    );
                }
            }
        }
    }
}

/// Commit message generation: each agent writes the message in a one-shot,
/// tool-less run that leaves its conversation alone. The agents here are
/// replaced by small scripts that record how they were called.
#[cfg(all(test, unix))]
mod commit_message_generation_tests {
    use std::path::{Path, PathBuf};

    use serde_json::{Value, json};

    use super::*;
    use crate::profile::{ExecutorConfigs, ExecutorProfileId};

    struct Fixture {
        dir: tempfile::TempDir,
        script: PathBuf,
        log: PathBuf,
    }

    impl Fixture {
        fn new(script: &str) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("agent.py");
            std::fs::write(&path, script).unwrap();
            let log = dir.path().join("log.json");
            Self {
                dir,
                script: path,
                log,
            }
        }

        fn command(&self) -> String {
            format!("python3 {} {}", self.script.display(), self.log.display())
        }

        fn log(&self) -> Value {
            serde_json::from_str(&std::fs::read_to_string(&self.log).unwrap()).unwrap()
        }

        fn cwd(&self) -> &Path {
            self.dir.path()
        }
    }

    fn agent(executor: BaseCodingAgent, fields: Value) -> CodingAgent {
        let mut agent = ExecutorConfigs::from_defaults()
            .get_coding_agent(&ExecutorProfileId::new(executor))
            .unwrap();
        let mut value = serde_json::to_value(&agent).unwrap();
        value[executor.to_string()]
            .as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        agent = serde_json::from_value(value).unwrap();
        agent
    }

    fn env() -> ExecutionEnv {
        ExecutionEnv::new(Default::default(), false, String::new())
    }

    /// Records its arguments and what it was sent on stdin, then answers.
    const PRINTING_CLI: &str = r#"
import json, sys
args = sys.argv[2:]
out = args[args.index("--output-last-message") + 1] if "--output-last-message" in args else None
stdin = sys.stdin.read()
json.dump({"args": args, "stdin": stdin}, open(sys.argv[1], "w"))
if out:
    open(out, "w").write("fix(codex): 최종 메시지\n")
    print("progress noise that is not the message")
else:
    print("feat(claude): 생성된 메시지")
"#;

    #[tokio::test]
    #[ignore = "runs python3 stand-ins for the agent CLIs"]
    async fn claude_runs_print_mode_without_tools_or_a_saved_session() {
        let fixture = Fixture::new(PRINTING_CLI);
        let claude = agent(
            BaseCodingAgent::ClaudeCode,
            json!({"base_command_override": fixture.command(), "model": "sonnet"}),
        );
        let message = claude
            .generate_commit_message(fixture.cwd(), "session", "Write it.", &env())
            .await
            .unwrap();
        assert_eq!(
            message.as_deref().map(str::trim),
            Some("feat(claude): 생성된 메시지")
        );
        let log = fixture.log();
        let args: Vec<&str> = log["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(|arg| arg.as_str().unwrap())
            .collect();
        assert_eq!(
            &args[..3],
            ["-p", "--output-format=text", "--no-session-persistence"]
        );
        assert_eq!(args[3..5], ["--tools", ""]);
        assert!(args.windows(2).any(|pair| pair == ["--model", "sonnet"]));
        assert_eq!(log["stdin"], "Write it.");
        // The router's command line is not a plain print-mode run.
        let routed = agent(
            BaseCodingAgent::ClaudeCode,
            json!({"base_command_override": fixture.command(), "claude_code_router": true}),
        );
        assert!(
            routed
                .generate_commit_message(fixture.cwd(), "session", "Write it.", &env())
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    #[ignore = "runs python3 stand-ins for the agent CLIs"]
    async fn codex_runs_exec_read_only_without_a_saved_session_and_reads_the_last_message() {
        let fixture = Fixture::new(PRINTING_CLI);
        let codex = agent(
            BaseCodingAgent::Codex,
            json!({"base_command_override": fixture.command(), "model": "gpt-5.5"}),
        );
        let message = codex
            .generate_commit_message(fixture.cwd(), "thread", "Write it.", &env())
            .await
            .unwrap();
        assert_eq!(
            message.as_deref().map(str::trim),
            Some("fix(codex): 최종 메시지")
        );
        let log = fixture.log();
        let args: Vec<&str> = log["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(|arg| arg.as_str().unwrap())
            .collect();
        assert_eq!(args[0], "exec");
        for flag in ["--ephemeral", "--skip-git-repo-check"] {
            assert!(args.contains(&flag), "{flag}");
        }
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--sandbox", "read-only"])
        );
        assert!(args.windows(2).any(|pair| pair == ["--model", "gpt-5.5"]));
        assert_eq!(args.last(), Some(&"-"));
        assert_eq!(log["stdin"], "Write it.");
    }

    /// An ACP agent that answers once. Before answering it asks to run a
    /// tool and records which option the client chose.
    const ACP_AGENT: &str = r#"
import json, sys
state = {"args": sys.argv[2:], "set_model": None, "config_option": None, "permission": None}
def save(): json.dump(state, open(sys.argv[1], "w"))
def send(m): sys.stdout.write(json.dumps({"jsonrpc": "2.0", **m}) + "\n"); sys.stdout.flush()
for line in sys.stdin:
    msg = json.loads(line); method, rid, p = msg.get("method"), msg.get("id"), msg.get("params", {})
    if method == "initialize":
        send({"id": rid, "result": {"protocolVersion": 1, "agentCapabilities": {}}})
    elif method == "session/new":
        send({"id": rid, "result": {"sessionId": "one-shot"}})
    elif method == "session/set_model":
        state["set_model"] = p["modelId"]; save(); send({"id": rid, "result": {}})
    elif method == "session/set_config_option":
        state["config_option"] = [p["configId"], p["value"]]; save(); send({"id": rid, "result": {"configOptions": []}})
    elif method == "session/prompt":
        state["prompt"] = p["prompt"][0]["text"]
        send({"id": 900, "method": "session/request_permission", "params": {
            "sessionId": "one-shot", "toolCall": {"toolCallId": "t1", "title": "Run a command"},
            "options": [{"optionId": "yes", "name": "Allow", "kind": "allow_once"},
                        {"optionId": "no", "name": "Reject", "kind": "reject_once"}]}})
        for reply in sys.stdin:
            reply = json.loads(reply)
            if reply.get("id") == 900:
                state["permission"] = reply["result"]["outcome"]; break
        save()
        for part in ("docs(acp): ", "한 줄 메시지"):
            send({"method": "session/update", "params": {"sessionId": "one-shot", "update": {
                "sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": part}}}})
        send({"id": rid, "result": {"stopReason": "end_turn"}})
    elif rid is not None:
        send({"id": rid, "result": None})
"#;

    async fn acp_generation(executor: BaseCodingAgent, fields: Value) -> (Option<String>, Value) {
        let fixture = Fixture::new(ACP_AGENT);
        let mut fields = fields;
        fields["base_command_override"] = json!(fixture.command());
        let agent = agent(executor, fields);
        let message = agent
            .generate_commit_message(fixture.cwd(), "session", "Write it.", &env())
            .await
            .unwrap();
        let log = fixture.log();
        (message, log)
    }

    #[tokio::test]
    #[ignore = "runs a python3 ACP agent"]
    async fn acp_agents_answer_once_and_every_tool_request_is_refused() {
        // Gemini: the profile's yolo flag is not passed, so tools are not pre-approved.
        let (message, log) = acp_generation(
            BaseCodingAgent::Gemini,
            json!({"yolo": true, "model": "m1"}),
        )
        .await;
        assert_eq!(message.as_deref(), Some("docs(acp): 한 줄 메시지"));
        assert_eq!(
            log["permission"],
            json!({"outcome": "selected", "optionId": "no"})
        );
        assert_eq!(log["prompt"], "Write it.");
        let args = log["args"].as_array().unwrap();
        assert!(!args.iter().any(|arg| arg == "--yolo") && args.iter().any(|arg| arg == "--model"));
        // Qwen selects its model over the protocol.
        let (message, log) = acp_generation(
            BaseCodingAgent::QwenCode,
            json!({"yolo": true, "model": "q1"}),
        )
        .await;
        assert!(message.is_some());
        assert_eq!(log["set_model"], "q1");
        assert!(
            !log["args"]
                .as_array()
                .unwrap()
                .iter()
                .any(|arg| arg == "--yolo")
        );
        // Copilot: allow-all is not passed.
        let (message, log) =
            acp_generation(BaseCodingAgent::Copilot, json!({"allow_all_tools": true})).await;
        assert!(message.is_some());
        assert!(
            !log["args"]
                .as_array()
                .unwrap()
                .iter()
                .any(|arg| arg == "--allow-all-tools")
        );
        // Pi selects its model through a config option.
        let (message, log) = acp_generation(
            BaseCodingAgent::Pi,
            json!({"model": "p1", "env": {"PI_ACP_PI_COMMAND": "python3"}}),
        )
        .await;
        assert!(message.is_some());
        assert_eq!(log["config_option"], json!(["model", "p1"]));
    }

    #[test]
    fn agents_that_commit_through_a_follow_up_turn_write_no_message_themselves() {
        for executor in [
            BaseCodingAgent::Amp,
            BaseCodingAgent::CursorAgent,
            BaseCodingAgent::Droid,
        ] {
            assert!(executor.commit_reminder_is_a_follow_up_turn());
            let agent = agent(executor, json!({}));
            let generated = futures::executor::block_on(agent.generate_commit_message(
                &std::env::temp_dir(),
                "session",
                "Write it.",
                &env(),
            ))
            .unwrap();
            assert_eq!(generated, None, "{executor}");
        }
        assert!(!BaseCodingAgent::ClaudeCode.commit_reminder_is_a_follow_up_turn());
    }

    /// An OpenCode v1 server that records what it is asked.
    const OPENCODE_SERVER: &str = r#"
import json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
log = {"calls": [], "permission": os.environ.get("OPENCODE_PERMISSION")}
def save(): json.dump(log, open(sys.argv[1], "w"))
class Handler(BaseHTTPRequestHandler):
    def reply(self, body):
        data = json.dumps(body).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        if self.path.startswith("/global/health"): self.reply({"healthy": True, "version": "fixture"})
        else: self.reply({})
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)) or 0)
        path = self.path.split("?")[0]
        log["calls"].append({"method": "POST", "path": path, "body": json.loads(body or "null")}); save()
        if path.endswith("/fork"): self.reply({"id": "copy-1"})
        else: self.reply({"info": {}, "parts": [{"type": "step-start"}, {"type": "text", "text": "feat(opencode): 메시지"}]})
    def do_DELETE(self):
        log["calls"].append({"method": "DELETE", "path": self.path.split("?")[0]}); save(); self.reply(True)
    def log_message(self, *args): pass
server = HTTPServer(("127.0.0.1", 0), Handler)
print("opencode server listening on http://127.0.0.1:%d" % server.server_address[1], flush=True)
server.serve_forever()
"#;

    #[tokio::test]
    #[ignore = "runs a python3 OpenCode server"]
    async fn opencode_asks_a_copy_of_the_session_with_every_tool_refused_and_deletes_it() {
        let fixture = Fixture::new(OPENCODE_SERVER);
        let opencode = agent(
            BaseCodingAgent::Opencode,
            json!({"base_command_override": fixture.command(), "model": "prov/m1", "variant": "high"}),
        );
        let message = opencode
            .generate_commit_message(fixture.cwd(), "session-1", "Write it.", &env())
            .await
            .unwrap();
        assert_eq!(message.as_deref(), Some("feat(opencode): 메시지"));
        let log = fixture.log();
        let calls = log["calls"].as_array().unwrap();
        assert_eq!(calls[0]["path"], "/session/session-1/fork");
        assert_eq!(calls[1]["path"], "/session/copy-1/message");
        assert_eq!(calls[1]["body"]["parts"][0]["text"], "Write it.");
        assert_eq!(
            calls[1]["body"]["model"],
            json!({"providerID": "prov", "modelID": "m1"})
        );
        assert_eq!(calls[1]["body"]["variant"], "high");
        assert_eq!(
            calls[2],
            json!({"method": "DELETE", "path": "/session/copy-1"})
        );
        let permission: Value = serde_json::from_str(log["permission"].as_str().unwrap()).unwrap();
        for tool in ["edit", "bash", "webfetch", "external_directory", "question"] {
            assert_eq!(permission[tool], "deny", "{tool}");
        }
    }
}
