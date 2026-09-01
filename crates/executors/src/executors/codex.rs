pub mod client;
pub mod jsonrpc;
pub mod normalize_logs;
pub mod review;
pub mod slash_commands;
pub mod transcript;
use std::{
    collections::HashMap,
    env,
    path::{Path, PathBuf},
    str::FromStr,
    sync::Arc,
};

/// Returns the Codex home directory.
///
/// Checks the `CODEX_HOME` environment variable first, then falls back to `~/.codex`.
/// This allows users to configure a custom location for Codex configuration and state.
pub fn codex_home() -> Option<PathBuf> {
    if let Ok(codex_home) = env::var("CODEX_HOME")
        && !codex_home.trim().is_empty()
    {
        return Some(PathBuf::from(codex_home));
    }
    dirs::home_dir().map(|home| home.join(".codex"))
}

pub(crate) fn resolve_model(model: Option<&str>) -> (Option<&str>, bool) {
    match model.and_then(|m| m.strip_suffix("-fast")) {
        Some(base) => (Some(base), true),
        None => (model, false),
    }
}

/// Reasoning-effort choices a given Codex model exposes. Kept per-model so the
/// dropdown reflects what each tier actually supports rather than one blanket
/// list. Adjust the groupings here when a model's supported efforts change.
fn codex_reasoning_options(model_id: &str) -> Vec<ReasoningOption> {
    use ReasoningEffort::*;
    let efforts: &[ReasoningEffort] = match model_id {
        "gpt-5.6-sol" | "gpt-5.6-terra" => &[Low, Medium, High, Xhigh, Max, Ultra],
        "gpt-5.6-luna" => &[Low, Medium, High, Xhigh, Max],
        // The v0.144.2 model catalog exposes the same base range for the
        // remaining picker-visible models.
        _ => &[Low, Medium, High, Xhigh],
    };
    ReasoningOption::from_names(efforts.iter().map(|e| e.as_ref().to_string()))
}

/// Whether a Codex model exposes the "fast" (high-throughput) service tier as a
/// toggle. Only the flagship general models support it today.
fn codex_supports_fast(model_id: &str) -> bool {
    matches!(
        model_id,
        "gpt-5.6-luna" | "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.5" | "gpt-5.4"
    )
}

/// Static fallback model catalog, shown until (or instead of, on probe
/// failure) the live `model/list` result from the app server.
fn static_model_selector() -> ModelSelectorConfig {
    let model = |id: &str, name: &str| ModelInfo {
        id: id.to_string(),
        name: name.to_string(),
        provider_id: None,
        reasoning_options: codex_reasoning_options(id),
        supports_fast: codex_supports_fast(id),
    };

    ModelSelectorConfig {
        models: vec![
            model("gpt-5.6-luna", "GPT-5.6 Luna"),
            model("gpt-5.6-sol", "GPT-5.6 Sol"),
            model("gpt-5.6-terra", "GPT-5.6 Terra"),
            model("gpt-5.5", "GPT-5.5"),
            model("gpt-5.4", "GPT-5.4"),
            model("gpt-5.4-mini", "GPT-5.4 Mini"),
            model("gpt-5.3-codex-spark", "GPT-5.3 Codex Spark"),
        ],
        permissions: vec![
            PermissionPolicy::Auto,
            PermissionPolicy::DontAsk,
            PermissionPolicy::Supervised,
            PermissionPolicy::Plan,
        ],
        ..Default::default()
    }
}

/// Convert the app server's live `model/list` catalog into the shared selector
/// config. Returns `None` when no picker-visible model is present so callers
/// keep the static fallback list.
fn model_selector_from_live(
    models: &[codex_app_server_protocol::Model],
) -> Option<ModelSelectorConfig> {
    let mut seen = std::collections::HashSet::new();
    let mut infos: Vec<ModelInfo> = Vec::new();
    let mut default_model = None;

    for model in models.iter().filter(|m| !m.hidden) {
        let id = model.model.clone();
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        if model.is_default && default_model.is_none() {
            default_model = Some(id.clone());
        }

        let mut reasoning_options = ReasoningOption::from_names(
            model
                .supported_reasoning_efforts
                .iter()
                .map(|option| option.reasoning_effort.as_str().to_string()),
        );
        let default_effort = model.default_reasoning_effort.as_str();
        for option in &mut reasoning_options {
            option.is_default = option.id == default_effort;
        }

        // `additional_speed_tiers` is the deprecated field but still the one
        // the current catalog populates; check `service_tiers` too for later
        // versions.
        let supports_fast = model.additional_speed_tiers.iter().any(|t| t == "fast")
            || model.service_tiers.iter().any(|t| t.id == "fast");

        infos.push(ModelInfo {
            id,
            name: model.display_name.clone(),
            provider_id: None,
            reasoning_options,
            supports_fast,
        });
    }

    if infos.is_empty() {
        return None;
    }

    Some(ModelSelectorConfig {
        models: infos,
        default_model,
        permissions: vec![
            PermissionPolicy::Auto,
            PermissionPolicy::DontAsk,
            PermissionPolicy::Supervised,
            PermissionPolicy::Plan,
        ],
        ..Default::default()
    })
}

async fn collect_model_pages<F, Fut>(
    mut fetch: F,
) -> Result<Vec<codex_app_server_protocol::Model>, ExecutorError>
where
    F: FnMut(Option<String>) -> Fut,
    Fut: std::future::Future<
            Output = Result<codex_app_server_protocol::ModelListResponse, ExecutorError>,
        >,
{
    let mut cursor = None;
    let mut models = Vec::new();
    loop {
        let response = fetch(cursor).await?;
        models.extend(response.data);
        cursor = response.next_cursor;
        if cursor.is_none() {
            return Ok(models);
        }
    }
}

pub(crate) fn fork_params_from(thread_id: String, params: ThreadStartParams) -> ThreadForkParams {
    ThreadForkParams {
        thread_id,
        model: params.model,
        model_provider: params.model_provider,
        cwd: params.cwd,
        approval_policy: params.approval_policy,
        sandbox: params.sandbox,
        config: params.config,
        base_instructions: params.base_instructions,
        developer_instructions: params.developer_instructions,
        service_tier: params.service_tier,
        ..Default::default()
    }
}

use async_trait::async_trait;
use codex_app_server_protocol::{
    AskForApproval as V2AskForApproval, ReviewTarget, SandboxMode as V2SandboxMode,
    ThreadForkParams, ThreadStartParams, UserInput,
};
use codex_protocol::config_types::ServiceTier;
use derivative::Derivative;
use futures::StreamExt;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use strum_macros::{AsRefStr, EnumString};
use tokio::process::Command;
use ts_rs::TS;
use workspace_utils::{command_ext::GroupSpawnNoWindowExt, msg_store::MsgStore};

use self::{
    client::{AppServerClient, LogWriter},
    jsonrpc::{ExitSignalSender, JsonRpcPeer},
    normalize_logs::{Error, normalize_logs},
};
use crate::{
    approvals::ExecutorApprovalService,
    command::{CmdOverrides, CommandBuildError, CommandBuilder, CommandParts, apply_overrides},
    env::ExecutionEnv,
    executor_discovery::ExecutorDiscoveredOptions,
    executors::{
        AppendPrompt, AvailabilityInfo, BaseCodingAgent, ExecutorError, ExecutorExitResult,
        SlashCommandDescription, SpawnedChild, StandardCodingAgentExecutor,
    },
    logs::utils::patch,
    model_selector::{ModelInfo, ModelSelectorConfig, PermissionPolicy, ReasoningOption},
    profile::ExecutorConfig,
    stdout_dup::create_stdout_pipe_writer,
};

/// Sandbox policy modes for Codex
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, JsonSchema, AsRefStr)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case")]
pub enum SandboxMode {
    Auto,
    ReadOnly,
    WorkspaceWrite,
    DangerFullAccess,
}

/// Determines when the user is consulted to approve Codex actions.
///
/// - `UnlessTrusted`: Read-only commands are auto-approved. Everything else will
///   ask the user to approve.
/// - `OnRequest`: The model decides when to ask the user for approval.
/// - `Never`: Commands never ask for approval. Commands that fail in the
///   restricted sandbox are not retried.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, JsonSchema, AsRefStr)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case")]
pub enum AskForApproval {
    UnlessTrusted,
    #[serde(alias = "on-failure")]
    OnRequest,
    Never,
}

/// Reasoning effort for the underlying model
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, JsonSchema, AsRefStr, EnumString)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case")]
pub enum ReasoningEffort {
    None,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
    Ultra,
}

/// Model reasoning summary style
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, JsonSchema, AsRefStr)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case")]
pub enum ReasoningSummary {
    Auto,
    Concise,
    Detailed,
    None,
}

/// Format for model reasoning summaries
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, JsonSchema, AsRefStr)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case")]
pub enum ReasoningSummaryFormat {
    None,
    Experimental,
}

enum CodexSessionAction {
    Chat { prompt: String },
    Review { target: ReviewTarget },
}

#[derive(Derivative, Clone, Serialize, Deserialize, TS, JsonSchema)]
#[derivative(Debug, PartialEq)]
pub struct Codex {
    #[serde(default)]
    pub append_prompt: AppendPrompt,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<SandboxMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ask_for_approval: Option<AskForApproval>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oss: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_reasoning_effort: Option<ReasoningEffort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_reasoning_summary: Option<ReasoningSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_reasoning_summary_format: Option<ReasoningSummaryFormat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_instructions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_apply_patch_tool: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compact_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub developer_instructions: Option<String>,
    #[serde(default)]
    pub plan: bool,
    /// Block the request_user_input tool entirely (unattended runs). Auto keeps
    /// questions available while approvals stay off.
    #[serde(default)]
    pub dont_ask: bool,
    /// When enabled, vibe-kanban automatically resumes this agent's session
    /// after its usage rate limit resets (sends a "continue" follow-up). This
    /// is the per-agent default for new sessions; it can be overridden per
    /// session from the workspace chat UI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_resume_on_limit: Option<bool>,
    #[serde(flatten)]
    pub cmd: CmdOverrides,

    #[serde(skip)]
    #[ts(skip)]
    #[derivative(Debug = "ignore", PartialEq = "ignore")]
    approvals: Option<Arc<dyn ExecutorApprovalService>>,
}

#[async_trait]
impl StandardCodingAgentExecutor for Codex {
    fn apply_overrides(&mut self, executor_config: &ExecutorConfig) {
        if let Some(model_id) = &executor_config.model_id {
            self.model = Some(model_id.clone());
        }
        if let Some(reasoning_id) = &executor_config.reasoning_id
            && let Ok(reasoning_effort) = ReasoningEffort::from_str(reasoning_id)
        {
            self.model_reasoning_effort = Some(reasoning_effort)
        }
        if let Some(permission_policy) = &executor_config.permission_policy {
            match permission_policy {
                crate::model_selector::PermissionPolicy::Auto => {
                    self.ask_for_approval = Some(AskForApproval::Never);
                    self.plan = false;
                    self.dont_ask = false;
                }
                crate::model_selector::PermissionPolicy::DontAsk => {
                    self.ask_for_approval = Some(AskForApproval::Never);
                    self.plan = false;
                    self.dont_ask = true;
                }
                crate::model_selector::PermissionPolicy::Supervised => {
                    if matches!(self.ask_for_approval, None | Some(AskForApproval::Never)) {
                        self.ask_for_approval = Some(AskForApproval::UnlessTrusted);
                    }
                    self.plan = false;
                    self.dont_ask = false;
                }
                crate::model_selector::PermissionPolicy::Plan => {
                    self.plan = true;
                    self.dont_ask = false;
                }
            }
        }
    }

    fn use_approvals(&mut self, approvals: Arc<dyn ExecutorApprovalService>) {
        self.approvals = Some(approvals);
    }

    async fn spawn(
        &self,
        current_dir: &Path,
        prompt: &str,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        self.spawn_slash_command(current_dir, prompt, None, env)
            .await
    }

    async fn spawn_follow_up(
        &self,
        current_dir: &Path,
        prompt: &str,
        session_id: &str,
        _reset_to_message_id: Option<&str>,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        self.spawn_slash_command(current_dir, prompt, Some(session_id), env)
            .await
    }

    fn normalize_logs(
        &self,
        msg_store: Arc<MsgStore>,
        worktree_path: &Path,
    ) -> Vec<tokio::task::JoinHandle<()>> {
        normalize_logs(msg_store, worktree_path)
    }

    fn default_mcp_config_path(&self) -> Option<PathBuf> {
        codex_home().map(|home| home.join("config.toml"))
    }

    fn get_availability_info(&self) -> AvailabilityInfo {
        if let Some(timestamp) = codex_home()
            .and_then(|home| std::fs::metadata(home.join("auth.json")).ok())
            .and_then(|m| m.modified().ok())
            .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
        {
            return AvailabilityInfo::LoginDetected {
                last_auth_timestamp: timestamp,
            };
        }

        let mcp_config_found = self
            .default_mcp_config_path()
            .map(|p| p.exists())
            .unwrap_or(false);

        let installation_indicator_found = codex_home()
            .map(|home| home.join("version.json").exists())
            .unwrap_or(false);

        if mcp_config_found || installation_indicator_found {
            AvailabilityInfo::InstallationFound
        } else {
            AvailabilityInfo::NotFound
        }
    }

    fn get_preset_options(&self) -> ExecutorConfig {
        use crate::model_selector::*;
        let permission_policy = if self.plan {
            PermissionPolicy::Plan
        } else if matches!(self.ask_for_approval, None | Some(AskForApproval::Never)) {
            if self.dont_ask {
                PermissionPolicy::DontAsk
            } else {
                PermissionPolicy::Auto
            }
        } else {
            PermissionPolicy::Supervised
        };

        ExecutorConfig {
            executor: BaseCodingAgent::Codex,
            variant: None,
            model_id: self.model.clone(),
            agent_id: None,
            reasoning_id: self
                .model_reasoning_effort
                .as_ref()
                .map(|e| e.as_ref().to_string()),
            permission_policy: Some(permission_policy),
        }
    }

    async fn discover_options(
        &self,
        _workdir: Option<&std::path::Path>,
        _repo_path: Option<&std::path::Path>,
    ) -> Result<futures::stream::BoxStream<'static, json_patch::Patch>, ExecutorError> {
        use crate::{
            executor_discovery::ExecutorConfigCacheKey, executors::utils::executor_options_cache,
        };

        // The model catalog is account-level, not workdir-specific: one global
        // cache entry per command override set.
        let cache = executor_options_cache();
        let cache_key = ExecutorConfigCacheKey::new(
            None,
            serde_json::to_string(&self.cmd).unwrap_or_default(),
            BaseCodingAgent::Codex,
        );
        let mut initial_options = cache
            .get(&cache_key)
            .map(|cached| cached.as_ref().clone())
            .unwrap_or_else(static_discovered_options);
        initial_options.loading_models = true;
        let initial_patch = patch::executor_discovered_options(initial_options);

        let this = self.clone();
        let discovery_stream = async_stream::stream! {
            match this.fetch_live_models().await {
                Ok(models) => {
                    if let Some(model_selector) = model_selector_from_live(&models) {
                        yield patch::update_models(model_selector.models.clone());
                        yield patch::update_default_model(model_selector.default_model.clone());
                        let mut final_options = static_discovered_options();
                        final_options.model_selector = model_selector;
                        executor_options_cache().put(cache_key, final_options);
                    }
                }
                Err(e) => {
                    // Keep the static fallback list; the selector stays usable.
                    tracing::warn!("Failed to discover Codex models: {e}");
                }
            }
            yield patch::models_loaded();
        };

        Ok(Box::pin(
            futures::stream::once(async move { initial_patch }).chain(discovery_stream),
        ))
    }

    async fn spawn_review(
        &self,
        current_dir: &Path,
        prompt: &str,
        session_id: Option<&str>,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        let command_parts = self.build_command_builder()?.build_initial()?;
        let review_target = ReviewTarget::Custom {
            instructions: prompt.to_string(),
        };
        let action = CodexSessionAction::Review {
            target: review_target,
        };
        self.spawn_inner(current_dir, command_parts, action, session_id, env)
            .await
    }
}

/// How long the short-lived `codex app-server` model probe may take before we
/// fall back to the static catalog.
const MODEL_DISCOVERY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
/// Offline thread-transcript probes read rollouts from disk; same order of
/// work as model discovery.
const THREAD_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

fn static_discovered_options() -> ExecutorDiscoveredOptions {
    ExecutorDiscoveredOptions {
        model_selector: static_model_selector(),
        slash_commands: vec![
                SlashCommandDescription {
                    name: "compact".to_string(),
                    description: Some(
                        "summarize conversation to prevent hitting the context limit".to_string(),
                    ),
                },
                SlashCommandDescription {
                    name: "init".to_string(),
                    description: Some(
                        "create an AGENTS.md file with instructions for Codex".to_string(),
                    ),
                },
                SlashCommandDescription {
                    name: "status".to_string(),
                    description: Some(
                        "show current session configuration and token usage".to_string(),
                    ),
                },
                SlashCommandDescription {
                    name: "mcp".to_string(),
                    description: Some("list configured MCP tools".to_string()),
                },
                SlashCommandDescription {
                    name: "model".to_string(),
                    description: Some("view or switch the active model".to_string()),
                },
                SlashCommandDescription {
                    name: "fast".to_string(),
                    description: Some(
                        "toggle fast mode for highest speed inference (2× plan usage). Use `/fast on` or `/fast off` to set explicitly".to_string(),
                    ),
                },
            ],
        ..Default::default()
    }
}

impl Codex {
    pub fn base_command() -> &'static str {
        "codex"
    }

    /// Ask a short-lived `codex app-server` for the model catalog visible to
    /// this installation/account.
    async fn fetch_live_models(
        &self,
    ) -> Result<Vec<codex_app_server_protocol::Model>, ExecutorError> {
        self.probe_app_server(MODEL_DISCOVERY_TIMEOUT, "discovering Codex models", {
            |client| async move { collect_model_pages(|cursor| client.model_list(cursor)).await }
        })
        .await
    }

    /// Read a (sub)thread's transcript from a short-lived `codex app-server`.
    /// Threads persist in CODEX_HOME rollouts, so this works after the session
    /// process that spawned the thread has exited.
    pub async fn read_thread_transcript(
        &self,
        thread_id: &str,
    ) -> Result<codex_app_server_protocol::Thread, ExecutorError> {
        let thread_id = thread_id.to_string();
        self.probe_app_server(THREAD_READ_TIMEOUT, "reading Codex thread", {
            |client| async move {
                client
                    .thread_read(thread_id, true)
                    .await
                    .map(|resp| resp.thread)
            }
        })
        .await
    }

    /// Spawn a short-lived `codex app-server`, initialize it, run `task`, then
    /// tear the process down again.
    async fn probe_app_server<T, F, Fut>(
        &self,
        timeout: std::time::Duration,
        what: &str,
        task: F,
    ) -> Result<T, ExecutorError>
    where
        F: FnOnce(Arc<AppServerClient>) -> Fut,
        Fut: std::future::Future<Output = Result<T, ExecutorError>>,
    {
        let command_parts = self.build_command_builder()?.build_initial()?;
        let (program_path, args) = command_parts.into_resolved().await?;

        let mut process = Command::new(program_path);
        process
            .kill_on_drop(true)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .env("NPM_CONFIG_LOGLEVEL", "error")
            .env("NODE_NO_WARNINGS", "1")
            .env("NO_COLOR", "1")
            .env("RUST_LOG", "error")
            .args(&args);

        ExecutionEnv::new(crate::env::RepoContext::default(), false, String::new())
            .with_profile(&self.cmd)
            .apply_to_command(&mut process);

        let mut child = process.group_spawn_no_window()?;
        let child_stdout = child.inner().stdout.take().ok_or_else(|| {
            ExecutorError::Io(std::io::Error::other("Codex app server missing stdout"))
        })?;
        let child_stdin = child.inner().stdin.take().ok_or_else(|| {
            ExecutorError::Io(std::io::Error::other("Codex app server missing stdin"))
        })?;

        let cancel = tokio_util::sync::CancellationToken::new();
        let (exit_signal_tx, _exit_signal_rx) = tokio::sync::oneshot::channel();
        let client = AppServerClient::new(
            LogWriter::new(tokio::io::sink()),
            None,
            false,
            false,
            crate::env::RepoContext::default(),
            false,
            String::new(),
            cancel.clone(),
        );
        let rpc_peer = JsonRpcPeer::spawn(
            child_stdin,
            child_stdout,
            client.clone(),
            ExitSignalSender::new(exit_signal_tx),
            cancel.clone(),
        );
        client.connect(rpc_peer);

        let result = tokio::time::timeout(timeout, async {
            client.initialize().await?;
            task(client.clone()).await
        })
        .await;

        cancel.cancel();
        let _ = child.kill().await;

        match result {
            Ok(inner) => inner,
            Err(_) => Err(ExecutorError::Io(std::io::Error::other(format!(
                "Timed out {what}"
            )))),
        }
    }

    fn build_command_builder(&self) -> Result<CommandBuilder, CommandBuildError> {
        let mut builder = CommandBuilder::new(Self::base_command());
        builder = builder.extend_params(["app-server"]);
        if self.oss.unwrap_or(false) {
            builder = builder.extend_params(["--oss"]);
        }

        apply_overrides(builder, &self.cmd)
    }

    fn build_thread_start_params(&self, cwd: &Path) -> ThreadStartParams {
        let sandbox = match self.sandbox.as_ref() {
            None | Some(SandboxMode::Auto) => Some(V2SandboxMode::WorkspaceWrite), // match the Auto preset in codex
            Some(SandboxMode::ReadOnly) => Some(V2SandboxMode::ReadOnly),
            Some(SandboxMode::WorkspaceWrite) => Some(V2SandboxMode::WorkspaceWrite),
            Some(SandboxMode::DangerFullAccess) => Some(V2SandboxMode::DangerFullAccess),
        };

        let approval_policy = match self.ask_for_approval.as_ref() {
            None if matches!(self.sandbox.as_ref(), None | Some(SandboxMode::Auto)) => {
                // match the Auto preset in codex
                Some(V2AskForApproval::OnRequest)
            }
            None => None,
            Some(AskForApproval::UnlessTrusted) => Some(V2AskForApproval::UnlessTrusted),
            Some(AskForApproval::OnRequest) => Some(V2AskForApproval::OnRequest),
            Some(AskForApproval::Never) => Some(V2AskForApproval::Never),
        };

        let mut config = self.build_config_overrides();
        // V1 top-level params that moved into config overrides in v2
        if let Some(profile) = &self.profile {
            config
                .get_or_insert_with(HashMap::new)
                .insert("profile".to_string(), Value::String(profile.clone()));
        }
        if let Some(include) = self.include_apply_patch_tool {
            config
                .get_or_insert_with(HashMap::new)
                .insert("include_apply_patch_tool".to_string(), Value::Bool(include));
        }
        if let Some(compact) = &self.compact_prompt {
            config
                .get_or_insert_with(HashMap::new)
                .insert("compact_prompt".to_string(), Value::String(compact.clone()));
        }
        // Questions are available in every policy except DontAsk; the flag is
        // independent of approval_policy (Never only disables approvals).
        if !self.dont_ask {
            let map = config.get_or_insert_with(HashMap::new);
            map.insert(
                "features.default_mode_request_user_input".to_string(),
                Value::Bool(true),
            );
            map.insert(
                "suppress_unstable_features_warning".to_string(),
                Value::Bool(true),
            );
        }

        let (model, is_fast) = resolve_model(self.model.as_deref());
        let service_tier = if is_fast {
            Some(Some(ServiceTier::Fast.request_value().to_string()))
        } else {
            None
        };

        ThreadStartParams {
            model: model.map(|m| m.to_string()),
            cwd: Some(cwd.to_string_lossy().to_string()),
            approval_policy,
            sandbox,
            config,
            base_instructions: self.base_instructions.clone(),
            model_provider: self.model_provider.clone(),
            developer_instructions: self.developer_instructions.clone(),
            service_tier,
            ..Default::default()
        }
    }

    fn build_config_overrides(&self) -> Option<HashMap<String, Value>> {
        let mut overrides = HashMap::new();

        if let Some(effort) = &self.model_reasoning_effort {
            overrides.insert(
                "model_reasoning_effort".to_string(),
                Value::String(effort.as_ref().to_string()),
            );
        }

        if let Some(summary) = &self.model_reasoning_summary {
            overrides.insert(
                "model_reasoning_summary".to_string(),
                Value::String(summary.as_ref().to_string()),
            );
        }

        if let Some(format) = &self.model_reasoning_summary_format
            && format != &ReasoningSummaryFormat::None
        {
            overrides.insert(
                "model_reasoning_summary_format".to_string(),
                Value::String(format.as_ref().to_string()),
            );
        }

        if overrides.is_empty() {
            None
        } else {
            Some(overrides)
        }
    }

    async fn spawn_inner(
        &self,
        current_dir: &Path,
        command_parts: CommandParts,
        action: CodexSessionAction,
        resume_session: Option<&str>,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        let params = self.build_thread_start_params(current_dir);
        let resume_session = resume_session.map(|s| s.to_string());

        self.spawn_app_server(
            current_dir,
            command_parts,
            env,
            move |client, _| async move {
                match action {
                    CodexSessionAction::Chat { prompt } => {
                        Self::launch_codex_agent(params, resume_session, prompt, client).await
                    }
                    CodexSessionAction::Review { target } => {
                        review::launch_codex_review(params, resume_session, target, client).await
                    }
                }
            },
        )
        .await
    }

    async fn launch_codex_agent(
        thread_start_params: ThreadStartParams,
        resume_session: Option<String>,
        combined_prompt: String,
        client: Arc<AppServerClient>,
    ) -> Result<(), ExecutorError> {
        let account = client.get_account().await?;
        if account.requires_openai_auth && account.account.is_none() {
            return Err(ExecutorError::AuthRequired(
                "Codex authentication required".to_string(),
            ));
        }

        let (thread_id, resolved_model) = match resume_session {
            None => {
                let response = client.thread_start(thread_start_params).await?;
                (response.thread.id, response.model)
            }
            Some(session_id) => {
                let response = client
                    .thread_fork(fork_params_from(session_id, thread_start_params))
                    .await?;
                tracing::debug!("forked thread, new thread_id={}", response.thread.id);
                (response.thread.id, response.model)
            }
        };

        client.set_resolved_model(resolved_model);
        client.register_session(&thread_id).await?;
        let collaboration_mode = client.initial_collaboration_mode()?;
        client
            .turn_start_with_mode(
                thread_id,
                vec![UserInput::Text {
                    text: combined_prompt,
                    text_elements: vec![],
                }],
                Some(collaboration_mode),
            )
            .await?;

        Ok(())
    }

    /// Common boilerplate for spawning a Codex app server process
    /// Handles process spawning, stdout/stderr piping, exit signal handling, client initialization, and error logging.
    /// Delegates the actual Codex session logic to the provided `task` closure.
    async fn spawn_app_server<F, Fut>(
        &self,
        current_dir: &Path,
        command_parts: CommandParts,
        env: &ExecutionEnv,
        task: F,
    ) -> Result<SpawnedChild, ExecutorError>
    where
        F: FnOnce(Arc<AppServerClient>, ExitSignalSender) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Result<(), ExecutorError>> + Send + 'static,
    {
        let (program_path, args) = command_parts.into_resolved().await?;

        let mut process = Command::new(program_path);
        process
            .kill_on_drop(true)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .current_dir(current_dir)
            .env("NPM_CONFIG_LOGLEVEL", "error")
            .env("NODE_NO_WARNINGS", "1")
            .env("NO_COLOR", "1")
            .env("RUST_LOG", "error")
            .args(&args);

        env.clone()
            .with_profile(&self.cmd)
            .apply_to_command(&mut process);

        let mut child = process.group_spawn_no_window()?;

        let child_stdout = child.inner().stdout.take().ok_or_else(|| {
            ExecutorError::Io(std::io::Error::other("Codex app server missing stdout"))
        })?;
        let child_stdin = child.inner().stdin.take().ok_or_else(|| {
            ExecutorError::Io(std::io::Error::other("Codex app server missing stdin"))
        })?;

        let new_stdout = create_stdout_pipe_writer(&mut child)?;
        let (exit_signal_tx, exit_signal_rx) = tokio::sync::oneshot::channel();
        let cancel = tokio_util::sync::CancellationToken::new();

        let auto_approve = matches!(
            (&self.sandbox, &self.ask_for_approval),
            (Some(SandboxMode::DangerFullAccess), None)
        );
        let plan_mode = self.plan;
        let approvals = self.approvals.clone();
        let repo_context = env.repo_context.clone();
        let commit_reminder = env.commit_reminder;
        let commit_reminder_prompt = env.commit_reminder_prompt.clone();
        let cancel_for_task = cancel.clone();

        // Initialize the AppServerClient outside the task so a clone can be
        // handed to the container for live subagent control.
        let exit_signal_tx = ExitSignalSender::new(exit_signal_tx);
        let log_writer = LogWriter::new(new_stdout);
        let client = AppServerClient::new(
            log_writer.clone(),
            approvals,
            auto_approve,
            plan_mode,
            repo_context,
            commit_reminder,
            commit_reminder_prompt,
            cancel_for_task.clone(),
        );
        let rpc_peer = JsonRpcPeer::spawn(
            child_stdin,
            child_stdout,
            client.clone(),
            exit_signal_tx.clone(),
            cancel_for_task,
        );
        client.connect(rpc_peer);
        let subagent_handle = Some(crate::executors::SubagentLiveHandle::Codex(client.clone()));

        tokio::spawn(async move {
            let result = async {
                client.initialize().await?;
                task(client, exit_signal_tx.clone()).await
            }
            .await;

            if let Err(err) = result {
                match &err {
                    ExecutorError::Io(io_err)
                        if io_err.kind() == std::io::ErrorKind::BrokenPipe =>
                    {
                        // Broken pipe likely means the parent process exited, so we can ignore it
                        return;
                    }
                    ExecutorError::AuthRequired(message) => {
                        log_writer
                            .log_raw(&Error::auth_required(message.clone()).raw())
                            .await
                            .ok();
                        exit_signal_tx
                            .send_exit_signal(ExecutorExitResult::Failure)
                            .await;
                        return;
                    }
                    _ => {
                        tracing::error!("Codex spawn error: {}", err);
                        log_writer
                            .log_raw(&Error::launch_error(err.to_string()).raw())
                            .await
                            .ok();
                    }
                }
                exit_signal_tx
                    .send_exit_signal(ExecutorExitResult::Failure)
                    .await;
            }
        });

        Ok(SpawnedChild {
            child,
            exit_signal: Some(exit_signal_rx),
            cancel: Some(cancel),
            subagent_handle,
        })
    }
}

#[cfg(test)]
mod tests {
    use futures::StreamExt;
    use serde_json::json;

    use super::{
        AskForApproval, Codex, ReasoningEffort, collect_model_pages, model_selector_from_live,
        resolve_model, static_model_selector,
    };
    use crate::executors::StandardCodingAgentExecutor;

    fn live_model(value: serde_json::Value) -> codex_app_server_protocol::Model {
        let mut base = json!({
            "id": "gpt-test",
            "model": "gpt-test",
            "upgrade": null,
            "upgradeInfo": null,
            "availabilityNux": null,
            "displayName": "GPT Test",
            "description": "",
            "hidden": false,
            "supportedReasoningEfforts": [
                {"reasoningEffort": "low", "description": ""},
                {"reasoningEffort": "high", "description": ""}
            ],
            "defaultReasoningEffort": "high",
            "isDefault": false
        });
        base.as_object_mut()
            .unwrap()
            .extend(value.as_object().unwrap().clone());
        serde_json::from_value(base).unwrap()
    }

    #[test]
    fn live_models_map_to_selector_config() {
        let models = vec![
            live_model(json!({
                "id": "gpt-5.6-sol",
                "model": "gpt-5.6-sol",
                "displayName": "GPT-5.6-Sol",
                "supportedReasoningEfforts": [
                    {"reasoningEffort": "low", "description": ""},
                    {"reasoningEffort": "medium", "description": ""},
                    {"reasoningEffort": "ultra", "description": ""}
                ],
                "defaultReasoningEffort": "low",
                "additionalSpeedTiers": ["fast"],
                "serviceTiers": [{"id": "priority", "name": "Priority", "description": ""}],
                "isDefault": true
            })),
            live_model(json!({
                "id": "gpt-5.4-mini",
                "model": "gpt-5.4-mini",
                "displayName": "GPT-5.4-Mini"
            })),
            live_model(json!({"id": "secret", "model": "secret", "hidden": true})),
        ];

        let config = model_selector_from_live(&models).unwrap();
        assert_eq!(config.default_model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(config.models.len(), 2, "hidden models are filtered out");
        assert!(
            config
                .permissions
                .contains(&crate::model_selector::PermissionPolicy::DontAsk)
        );

        let sol = &config.models[0];
        assert_eq!(sol.name, "GPT-5.6-Sol");
        assert!(sol.supports_fast, "additionalSpeedTiers fast is detected");
        assert_eq!(
            sol.reasoning_options
                .iter()
                .map(|o| o.id.as_str())
                .collect::<Vec<_>>(),
            vec!["low", "medium", "ultra"]
        );
        assert!(
            sol.reasoning_options
                .iter()
                .find(|o| o.id == "low")
                .unwrap()
                .is_default,
            "live default reasoning effort wins over the static 'high' default"
        );

        let mini = &config.models[1];
        assert!(!mini.supports_fast);
    }

    #[test]
    fn live_models_fall_back_when_empty_or_hidden() {
        assert!(model_selector_from_live(&[]).is_none());
        let hidden = vec![live_model(json!({"hidden": true}))];
        assert!(model_selector_from_live(&hidden).is_none());
    }

    #[tokio::test]
    async fn model_list_follows_pagination_cursor() {
        let mut cursors = Vec::new();
        let mut pages = std::collections::VecDeque::from([
            Ok(codex_app_server_protocol::ModelListResponse {
                data: vec![live_model(json!({"model": "first"}))],
                next_cursor: Some("page-2".to_string()),
            }),
            Ok(codex_app_server_protocol::ModelListResponse {
                data: vec![live_model(json!({"model": "second"}))],
                next_cursor: None,
            }),
        ]);

        let models = collect_model_pages(|cursor| {
            cursors.push(cursor);
            std::future::ready(pages.pop_front().unwrap())
        })
        .await
        .unwrap();

        assert_eq!(cursors, vec![None, Some("page-2".to_string())]);
        assert_eq!(
            models
                .iter()
                .map(|model| model.model.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "second"]
        );
    }

    #[tokio::test]
    async fn discover_options_falls_back_to_static_on_probe_failure() {
        // `false` exits immediately, so the app-server probe fails fast.
        let codex: Codex =
            serde_json::from_value(json!({"base_command_override": "false"})).unwrap();

        let stream = codex.discover_options(None, None).await.unwrap();
        let patches: Vec<serde_json::Value> = stream
            .map(|p| serde_json::to_value(&p).unwrap())
            .collect()
            .await;

        let initial = &patches[0][0];
        assert_eq!(initial["path"], "/options");
        let models = initial["value"]["model_selector"]["models"]
            .as_array()
            .unwrap();
        assert_eq!(models.len(), static_model_selector().models.len());
        assert_eq!(initial["value"]["loading_models"], true);

        let last = patches.last().unwrap();
        assert_eq!(last[0]["path"], "/options/loading_models");
        assert_eq!(last[0]["value"], false);
        assert!(
            !patches
                .iter()
                .any(|p| p[0]["path"] == "/options/model_selector/models"),
            "no live model patch on probe failure"
        );
    }

    #[tokio::test]
    async fn discover_options_preserves_cache_on_probe_failure() {
        use crate::{
            executor_discovery::ExecutorConfigCacheKey,
            executors::{BaseCodingAgent, utils::executor_options_cache},
        };

        let codex: Codex = serde_json::from_value(
            json!({"base_command_override": "missing-codex-cache-fallback-test"}),
        )
        .unwrap();
        let cache_key = ExecutorConfigCacheKey::new(
            None,
            serde_json::to_string(&codex.cmd).unwrap(),
            BaseCodingAgent::Codex,
        );
        let mut cached = super::static_discovered_options();
        cached.model_selector.models[0].id = "cached-model".to_string();
        executor_options_cache().put(cache_key, cached);

        let patches: Vec<serde_json::Value> = codex
            .discover_options(None, None)
            .await
            .unwrap()
            .map(|patch| serde_json::to_value(patch).unwrap())
            .collect()
            .await;

        assert_eq!(
            patches[0][0]["value"]["model_selector"]["models"][0]["id"],
            "cached-model"
        );
        assert!(
            !patches
                .iter()
                .any(|patch| patch[0]["path"] == "/options/model_selector/models")
        );
    }

    #[test]
    fn legacy_on_failure_approval_migrates_to_on_request() {
        assert_eq!(
            serde_json::from_str::<AskForApproval>("\"on-failure\"").unwrap(),
            AskForApproval::OnRequest
        );
    }

    #[test]
    fn decodes_sub_agent_activity_from_thread_history() {
        let item =
            serde_json::from_value::<codex_app_server_protocol::ThreadItem>(serde_json::json!({
                "type": "subAgentActivity",
                "id": "activity-1",
                "kind": "started",
                "agentThreadId": "thread-1",
                "agentPath": "/root/worker"
            }))
            .unwrap();

        assert!(matches!(
            item,
            codex_app_server_protocol::ThreadItem::SubAgentActivity { .. }
        ));
    }

    #[test]
    fn resolve_model_detects_fast_suffix() {
        assert_eq!(resolve_model(Some("gpt-5.5-fast")), (Some("gpt-5.5"), true));
        assert_eq!(resolve_model(Some("gpt-5.4-fast")), (Some("gpt-5.4"), true));
        assert_eq!(
            resolve_model(Some("gpt-5.6-luna-fast")),
            (Some("gpt-5.6-luna"), true)
        );
    }

    #[test]
    fn resolve_model_leaves_non_fast_models_unchanged() {
        assert_eq!(resolve_model(Some("gpt-5.5")), (Some("gpt-5.5"), false));
        assert_eq!(
            resolve_model(Some("gpt-5.4-mini")),
            (Some("gpt-5.4-mini"), false)
        );
        assert_eq!(resolve_model(None), (None, false));
    }

    #[test]
    fn reasoning_effort_parses_latest_codex_values() {
        assert_eq!("none".parse::<ReasoningEffort>(), Ok(ReasoningEffort::None));
        assert_eq!(
            "minimal".parse::<ReasoningEffort>(),
            Ok(ReasoningEffort::Minimal)
        );
        assert_eq!(
            "xhigh".parse::<ReasoningEffort>(),
            Ok(ReasoningEffort::Xhigh)
        );
        assert_eq!("max".parse::<ReasoningEffort>(), Ok(ReasoningEffort::Max));
        assert_eq!(
            "ultra".parse::<ReasoningEffort>(),
            Ok(ReasoningEffort::Ultra)
        );
    }
}
