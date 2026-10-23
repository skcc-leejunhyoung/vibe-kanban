//! One HTTP client for everything that talks to the local Vibe Kanban server
//! on behalf of a coding agent: the MCP tools and the `vk` CLI both build on
//! it, so a workflow exists exactly once (listing workspaces with their live
//! status, sending or queueing a prompt, syncing a branch, linking an issue,
//! waiting for events, ...).
//!
//! Host routing: with `host_id` set, host-scoped paths go through the relay
//! proxy (`/api/host/{id}/...`); cloud-backed and relay paths always stay on
//! this machine (`local_*`). Every request carries `x-vibe-agent` so the
//! server applies the agent access policy and audits the call.

use std::{
    collections::{BTreeMap, HashMap},
    path::Path,
    str::FromStr,
    time::Duration,
};

use api_types::{
    CreateIssueRequest, Issue, IssuePriority, ListProjectStatusesResponse, MutationResponse,
    ProjectStatus, UpdateIssueRequest,
};
use chrono::{DateTime, Utc};
use db::models::{
    execution_process::{ExecutionProcess, ExecutionProcessRunReason},
    requests::{
        AutopilotWorkspaceResponse, ContainerQuery, CreateAndStartWorkspaceRequest,
        CreateAndStartWorkspaceResponse, LinkedIssueInfo, WorkingBranchInput, WorkspaceRepoInput,
    },
    session::Session,
    tag::Tag,
    workspace::{Workspace, WorkspaceContext},
};
use executors::{actions::ExecutorActionType, executors::BaseCodingAgent, profile::ExecutorConfig};
use regex::Regex;
use rmcp::schemars;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use thiserror::Error;
use uuid::Uuid;

pub const AGENT_HEADER: &str = "x-vibe-agent";
pub const AGENT_SESSION_HEADER: &str = "x-vibe-agent-session";
/// Which CLI command or MCP tool made the call, for the server's audit log.
pub const AGENT_COMMAND_HEADER: &str = "x-vibe-agent-command";

tokio::task_local! {
    /// Label of the MCP tool running in this task (set by the tool handler),
    /// sent as `x-vibe-agent-command` when the client has no explicit label.
    pub static CURRENT_COMMAND: String;
}

const HOST_ENV: &str = "MCP_HOST";
const PORT_ENV: &str = "MCP_PORT";

#[derive(Debug, Deserialize)]
struct Envelope<T> {
    success: bool,
    data: Option<T>,
    message: Option<String>,
    #[serde(default)]
    error_data: Option<Value>,
}

/// Failure text of a `success: false` envelope: its message, else the typed
/// `error_data` (git push/rebase/PR failures carry only that).
fn envelope_error(message: Option<String>, error_data: Option<&Value>) -> String {
    message
        .or_else(|| error_data.filter(|d| !d.is_null()).map(Value::to_string))
        .unwrap_or_else(|| "Vibe Kanban API returned an error".to_string())
}

#[derive(Debug, Error)]
pub enum VkError {
    #[error("Failed to connect to the Vibe Kanban API: {0}")]
    Connect(String),
    #[error("{message}")]
    Api { status: u16, message: String },
    #[error("Failed to parse the Vibe Kanban API response: {0}")]
    Parse(String),
    #[error("{0}")]
    Message(String),
}

impl VkError {
    pub fn message(message: impl Into<String>) -> Self {
        Self::Message(message.into())
    }

    pub fn status(&self) -> Option<u16> {
        match self {
            VkError::Api { status, .. } => Some(*status),
            _ => None,
        }
    }
}

/// Where the server is: `VIBE_BACKEND_URL`, else `MCP_HOST`/`HOST` +
/// `MCP_PORT`/`BACKEND_PORT`/`PORT`, else the port file the server writes.
pub async fn discover_base_url() -> anyhow::Result<String> {
    if let Ok(url) = std::env::var(utils::agent_cli::BACKEND_URL_ENV)
        && !url.trim().is_empty()
    {
        return Ok(url.trim().to_string());
    }
    let host = std::env::var(HOST_ENV)
        .or_else(|_| std::env::var("HOST"))
        .unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = match std::env::var(PORT_ENV)
        .or_else(|_| std::env::var("BACKEND_PORT"))
        .or_else(|_| std::env::var("PORT"))
    {
        Ok(port) => port
            .trim()
            .parse::<u16>()
            .map_err(|error| anyhow::anyhow!("Invalid port value '{port}': {error}"))?,
        Err(_) => utils::port_file::read_port_file("vibe-kanban")
            .await
            .map_err(|error| {
                anyhow::anyhow!(
                    "Vibe Kanban server not found (no VIBE_BACKEND_URL, BACKEND_PORT or port file): {error}"
                )
            })?,
    };
    Ok(format!("http://{host}:{port}"))
}

#[derive(Clone, Debug)]
pub struct VkClient {
    http: reqwest::Client,
    base_url: String,
    host_id: Option<Uuid>,
    agent: String,
    session_id: Option<Uuid>,
    command: Option<String>,
}

impl VkClient {
    /// `agent` names the caller for the server's audit log, e.g. `vk-cli/1.2`.
    pub fn new(base_url: &str, agent: &str) -> Self {
        let session_id = std::env::var(utils::agent_cli::SESSION_ID_ENV)
            .ok()
            .and_then(|value| value.parse().ok());
        Self {
            http: reqwest::Client::builder()
                .no_proxy()
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
            base_url: base_url.trim_end_matches('/').to_string(),
            host_id: None,
            agent: agent.to_string(),
            session_id,
            command: None,
        }
    }

    /// Label the calls of this client (e.g. `ws delete`) for the audit log.
    pub fn with_command(&self, command: &str) -> Self {
        Self {
            command: Some(command.to_string()),
            ..self.clone()
        }
    }

    /// The same client aimed at a paired host (`None` = this machine).
    pub fn host(&self, host_id: Option<Uuid>) -> Self {
        Self {
            host_id,
            ..self.clone()
        }
    }

    pub fn host_id(&self) -> Option<Uuid> {
        self.host_id
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn session_id(&self) -> Option<Uuid> {
        self.session_id
    }

    /// `path` starts after `/api`, e.g. `/workspaces/{id}`.
    pub fn api_url(&self, path: &str) -> String {
        let path = path.trim_start_matches('/');
        match self.host_id {
            Some(host_id) => format!("{}/api/host/{host_id}/{path}", self.base_url),
            None => format!("{}/api/{path}", self.base_url),
        }
    }

    /// Always this machine, whatever host is selected.
    pub fn local_url(&self, path: &str) -> String {
        format!("{}/api/{}", self.base_url, path.trim_start_matches('/'))
    }

    /// A request carrying the agent and audit headers, for calls the typed
    /// helpers don't cover (multipart uploads, SSE, binary downloads).
    pub fn request(&self, method: reqwest::Method, url: String) -> reqwest::RequestBuilder {
        let mut request = self
            .http
            .request(method, url)
            .header(AGENT_HEADER, &self.agent);
        if let Some(session_id) = self.session_id {
            request = request.header(AGENT_SESSION_HEADER, session_id.to_string());
        }
        let command = self
            .command
            .clone()
            .or_else(|| CURRENT_COMMAND.try_with(|name| name.clone()).ok());
        if let Some(command) = command {
            request = request.header(AGENT_COMMAND_HEADER, command);
        }
        request
    }

    async fn response_error(response: reqwest::Response) -> VkError {
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        let message = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|value| {
                value
                    .get("message")
                    .or_else(|| value.get("error"))
                    .and_then(|m| m.as_str())
                    .map(str::to_string)
            })
            .filter(|m| !m.is_empty())
            .unwrap_or_else(|| {
                if text.trim().is_empty() {
                    format!("Vibe Kanban API returned status {status}")
                } else {
                    format!("Vibe Kanban API returned status {status}: {}", text.trim())
                }
            });
        VkError::Api { status, message }
    }

    /// Send and unwrap the `ApiResponse` envelope.
    pub async fn send<T: DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<T, VkError> {
        let response = request
            .send()
            .await
            .map_err(|error| VkError::Connect(error.to_string()))?;
        if !response.status().is_success() {
            return Err(Self::response_error(response).await);
        }
        let envelope: Envelope<T> = response
            .json()
            .await
            .map_err(|error| VkError::Parse(error.to_string()))?;
        if !envelope.success {
            return Err(VkError::Api {
                status: 200,
                message: envelope_error(envelope.message, envelope.error_data.as_ref()),
            });
        }
        envelope
            .data
            .ok_or_else(|| VkError::Parse("response has no data".to_string()))
    }

    /// Send and return the payload as JSON: the envelope's `data` when the
    /// body is an `ApiResponse`, otherwise the body itself (cloud proxies and
    /// the automation worker answer unwrapped).
    pub async fn send_value(&self, request: reqwest::RequestBuilder) -> Result<Value, VkError> {
        let response = request
            .send()
            .await
            .map_err(|error| VkError::Connect(error.to_string()))?;
        if !response.status().is_success() {
            return Err(Self::response_error(response).await);
        }
        let text = response
            .text()
            .await
            .map_err(|error| VkError::Parse(error.to_string()))?;
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        // Raw bodies (artifact content, plain text) come back as a string.
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            return Ok(Value::String(text));
        };
        match value.get("success").and_then(Value::as_bool) {
            Some(true) => Ok(value.get("data").cloned().unwrap_or(Value::Null)),
            Some(false) => Err(VkError::Api {
                status: 200,
                message: envelope_error(
                    value
                        .get("message")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    value.get("error_data"),
                ),
            }),
            None => Ok(value),
        }
    }

    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T, VkError> {
        self.send(self.request(reqwest::Method::GET, self.api_url(path)))
            .await
    }

    pub async fn get_with<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<T, VkError> {
        self.send(
            self.request(reqwest::Method::GET, self.api_url(path))
                .query(query),
        )
        .await
    }

    pub async fn get_local<T: DeserializeOwned>(&self, path: &str) -> Result<T, VkError> {
        self.send(self.request(reqwest::Method::GET, self.local_url(path)))
            .await
    }

    pub async fn post<T: DeserializeOwned, B: Serialize + ?Sized>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<T, VkError> {
        self.send(
            self.request(reqwest::Method::POST, self.api_url(path))
                .json(body),
        )
        .await
    }

    pub async fn post_local<T: DeserializeOwned, B: Serialize + ?Sized>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<T, VkError> {
        self.send(
            self.request(reqwest::Method::POST, self.local_url(path))
                .json(body),
        )
        .await
    }

    pub async fn put<T: DeserializeOwned, B: Serialize + ?Sized>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<T, VkError> {
        self.send(
            self.request(reqwest::Method::PUT, self.api_url(path))
                .json(body),
        )
        .await
    }

    pub async fn patch_local<T: DeserializeOwned, B: Serialize + ?Sized>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<T, VkError> {
        self.send(
            self.request(reqwest::Method::PATCH, self.local_url(path))
                .json(body),
        )
        .await
    }

    pub async fn delete_with(&self, path: &str, query: &[(&str, String)]) -> Result<(), VkError> {
        self.send_empty(
            self.request(reqwest::Method::DELETE, self.api_url(path))
                .query(query),
        )
        .await
    }

    pub async fn delete_local(&self, path: &str) -> Result<(), VkError> {
        self.send_empty(self.request(reqwest::Method::DELETE, self.local_url(path)))
            .await
    }

    pub async fn post_empty<B: Serialize + ?Sized>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<(), VkError> {
        self.send_empty(
            self.request(reqwest::Method::POST, self.api_url(path))
                .json(body),
        )
        .await
    }

    async fn send_empty(&self, request: reqwest::RequestBuilder) -> Result<(), VkError> {
        self.send_value(request).await.map(|_| ())
    }

    /// Generic call for the CLI: `method` + `path` (after `/api`), optional
    /// query and JSON body; `local` keeps it on this machine.
    pub async fn exec(
        &self,
        method: &str,
        path: &str,
        local: bool,
        query: &[(String, String)],
        body: Option<&Value>,
        timeout: Option<Duration>,
    ) -> Result<Value, VkError> {
        let method = reqwest::Method::from_str(&method.to_ascii_uppercase())
            .map_err(|_| VkError::message(format!("Unknown HTTP method '{method}'")))?;
        let url = if local {
            self.local_url(path)
        } else {
            self.api_url(path)
        };
        let mut request = self.request(method, url);
        if !query.is_empty() {
            request = request.query(query);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        if let Some(timeout) = timeout {
            request = request.timeout(timeout);
        }
        self.send_value(request).await
    }
}

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct PairedHost {
    pub host_id: Uuid,
    pub host_name: Option<String>,
    /// `online`/`offline`; absent when the central host list is unreachable.
    #[serde(default)]
    pub status: Option<String>,
    /// `account`, `legacy_pairing` or `migrating`.
    #[serde(default)]
    pub auth_mode: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SelfHostResponse {
    host_id: Option<Uuid>,
}

impl VkClient {
    /// Other hosts reachable through the relay (this machine excluded).
    pub async fn list_hosts(&self) -> Result<Vec<PairedHost>, VkError> {
        self.get_local("/relay-auth/client/reachable-hosts").await
    }

    /// This machine's own cloud host id, when it is registered.
    pub async fn self_host_id(&self) -> Option<Uuid> {
        let response: SelfHostResponse = self
            .send(
                self.request(
                    reqwest::Method::GET,
                    self.local_url("/relay-auth/client/self-host"),
                )
                .timeout(Duration::from_secs(3)),
            )
            .await
            .ok()?;
        response.host_id
    }

    /// `self`/`local`/empty → this machine; a UUID as is; otherwise a known
    /// host whose name matches (case-insensitive, prefix allowed).
    pub async fn resolve_host(&self, name_or_id: &str) -> Result<Option<Uuid>, VkError> {
        let needle = name_or_id.trim();
        if needle.is_empty() || needle.eq_ignore_ascii_case("self") || needle == "local" {
            return Ok(None);
        }
        if let Ok(id) = needle.parse::<Uuid>() {
            return Ok(Some(id));
        }
        let hosts = self.list_hosts().await?;
        let lowered = needle.to_ascii_lowercase();
        let exact = hosts.iter().find(|h| {
            h.host_name
                .as_deref()
                .is_some_and(|n| n.eq_ignore_ascii_case(needle))
        });
        let prefix = hosts.iter().filter(|h| {
            h.host_name
                .as_deref()
                .is_some_and(|n| n.to_ascii_lowercase().starts_with(&lowered))
        });
        if let Some(host) = exact {
            return Ok(Some(host.host_id));
        }
        let mut candidates = prefix;
        match (candidates.next(), candidates.next()) {
            (Some(host), None) => Ok(Some(host.host_id)),
            (Some(_), Some(_)) => Err(VkError::message(format!(
                "Host '{needle}' is ambiguous; use the host id (vk hosts list)"
            ))),
            (None, _) => Err(VkError::message(format!(
                "Unknown host '{needle}'. Known hosts: {}",
                hosts
                    .iter()
                    .map(|h| format!(
                        "{} ({})",
                        h.host_name.as_deref().unwrap_or("unnamed"),
                        h.host_id
                    ))
                    .collect::<Vec<_>>()
                    .join(", ")
            ))),
        }
    }
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

/// Subset of the server's `WorkspaceSummary` that the list merges in.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct WorkspaceSummaryRow {
    pub workspace_id: Uuid,
    pub latest_session_id: Option<Uuid>,
    #[serde(default)]
    pub has_pending_approval: bool,
    pub latest_process_started_at: Option<DateTime<Utc>>,
    pub latest_process_completed_at: Option<DateTime<Utc>>,
    pub latest_process_status: Option<String>,
    #[serde(default)]
    pub is_waiting_on_blockers: bool,
    #[serde(default)]
    pub has_running_dev_server: bool,
    #[serde(default)]
    pub has_unseen_turns: bool,
    pub pr_status: Option<String>,
    pub pr_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WorkspaceSummariesResponse {
    summaries: Vec<WorkspaceSummaryRow>,
}

/// A workspace with its live status note and run state; the common shape
/// `list_workspaces` (MCP) and `vk ws list` return.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct WorkspaceListItem {
    pub id: Uuid,
    #[schemars(description = "Paired host the workspace lives on; null for this machine")]
    pub host_id: Option<Uuid>,
    pub name: Option<String>,
    pub branch: String,
    pub archived: bool,
    pub pinned: bool,
    #[schemars(description = "Quick chat run directly in an existing checkout")]
    pub in_place: bool,
    #[schemars(
        description = "The host's Autopilot: pinned single-session watcher driven by automation"
    )]
    pub autopilot: bool,
    #[schemars(description = "The agent's latest live summary of the workspace")]
    pub status_note: Option<String>,
    pub status_updated_at: Option<DateTime<Utc>>,
    #[schemars(description = "An agent turn is running right now")]
    pub is_running: bool,
    #[schemars(description = "running | completed | failed | killed of the latest process")]
    pub latest_process_status: Option<String>,
    pub latest_process_started_at: Option<DateTime<Utc>>,
    pub latest_process_completed_at: Option<DateTime<Utc>>,
    pub latest_session_id: Option<Uuid>,
    pub has_pending_approval: bool,
    #[schemars(description = "Start deferred until the linked issue's blockers close")]
    pub is_waiting_on_blockers: bool,
    pub has_running_dev_server: bool,
    pub has_unseen_turns: bool,
    pub pr_status: Option<String>,
    pub pr_url: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default)]
pub struct WorkspaceFilter {
    pub archived: Option<bool>,
    pub pinned: Option<bool>,
    pub running: Option<bool>,
    pub branch: Option<String>,
    pub name_search: Option<String>,
}

/// Minimal projection of the workspace repos endpoint.
#[derive(Debug, Clone, Deserialize)]
pub struct WorkspaceRepoRef {
    pub id: Uuid,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct SyncBranchOutcome {
    pub workspace_id: Uuid,
    pub repo_id: Uuid,
    pub mode: String,
    /// Human-readable result, e.g. "Fast-forwarded 2 commits" or "Already up to date".
    pub outcome: String,
}

/// Mirror of the server's `PullWorkspaceResponse`.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum PullOutcome {
    UpToDate,
    FastForwarded { commits: usize },
    Diverged { ahead: usize, behind: usize },
}

/// Mirror of the server's `GitOperationError`.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum GitOperationError {
    MergeConflicts {
        message: String,
        #[serde(default)]
        conflicted_files: Vec<String>,
    },
    RebaseInProgress,
}

#[derive(Debug, Deserialize)]
struct UpdateFromBaseEnvelope {
    success: bool,
    message: Option<String>,
    error_data: Option<GitOperationError>,
}

pub struct StartWorkspaceInput {
    pub name: String,
    pub prompt: Option<String>,
    pub executor: String,
    pub variant: Option<String>,
    pub repositories: Vec<(Uuid, String)>,
    pub issue_id: Option<Uuid>,
}

impl VkClient {
    /// The selected host's active Autopilot (`None` when there is none or it
    /// is paused): the `autopilot` alias of `<ws>`/`<session>` arguments.
    pub async fn autopilot(&self) -> Result<Option<AutopilotWorkspaceResponse>, VkError> {
        match self
            .get::<AutopilotWorkspaceResponse>("/workspaces/autopilot")
            .await
        {
            Ok(found) => Ok(Some(found)),
            Err(error) if error.status() == Some(404) => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// Workspaces on the selected host with the summaries merged in: status
    /// note, latest process state, pending approval, blocker wait, PR state.
    pub async fn list_workspaces(
        &self,
        filter: &WorkspaceFilter,
    ) -> Result<Vec<WorkspaceListItem>, VkError> {
        let mut query = Vec::new();
        if let Some(archived) = filter.archived {
            query.push(("archived", archived.to_string()));
        }
        let workspaces: Vec<Workspace> = self.get_with("/workspaces", &query).await?;
        let summaries: HashMap<Uuid, WorkspaceSummaryRow> = match self
            .post::<WorkspaceSummariesResponse, _>(
                "/workspaces/summaries",
                &json!({ "archived": filter.archived, "include_latest_prompt": false }),
            )
            .await
        {
            Ok(response) => response
                .summaries
                .into_iter()
                .map(|row| (row.workspace_id, row))
                .collect(),
            // Older hosts have no summaries; the list still works without status.
            Err(error) => {
                tracing::debug!(%error, "workspace summaries unavailable");
                HashMap::new()
            }
        };
        let mut items: Vec<WorkspaceListItem> = workspaces
            .into_iter()
            .map(|workspace| {
                let summary = summaries.get(&workspace.id).cloned().unwrap_or_default();
                let is_running = summary.latest_process_status.as_deref() == Some("running")
                    && !summary.is_waiting_on_blockers;
                WorkspaceListItem {
                    id: workspace.id,
                    host_id: self.host_id,
                    name: workspace.name,
                    branch: workspace.branch,
                    archived: workspace.archived,
                    pinned: workspace.pinned,
                    in_place: workspace.in_place,
                    autopilot: workspace.autopilot,
                    status_note: workspace.status_note,
                    status_updated_at: workspace.status_updated_at,
                    is_running,
                    latest_process_status: summary.latest_process_status,
                    latest_process_started_at: summary.latest_process_started_at,
                    latest_process_completed_at: summary.latest_process_completed_at,
                    latest_session_id: summary.latest_session_id,
                    has_pending_approval: summary.has_pending_approval,
                    is_waiting_on_blockers: summary.is_waiting_on_blockers,
                    has_running_dev_server: summary.has_running_dev_server,
                    has_unseen_turns: summary.has_unseen_turns,
                    pr_status: summary.pr_status,
                    pr_url: summary.pr_url,
                    created_at: workspace.created_at,
                    updated_at: workspace.updated_at,
                }
            })
            .collect();
        if let Some(pinned) = filter.pinned {
            items.retain(|w| w.pinned == pinned);
        }
        if let Some(running) = filter.running {
            items.retain(|w| w.is_running == running);
        }
        if let Some(branch) = filter.branch.as_deref() {
            items.retain(|w| w.branch.eq_ignore_ascii_case(branch));
        }
        if let Some(needle) = filter.name_search.as_deref() {
            let needle = needle.to_ascii_lowercase();
            items.retain(|w| {
                w.name
                    .as_deref()
                    .is_some_and(|name| name.to_ascii_lowercase().contains(&needle))
            });
        }
        // Newest activity first: a workspace that just ran or was just created.
        items.sort_by(|a, b| {
            let activity = |w: &WorkspaceListItem| {
                w.latest_process_completed_at
                    .max(w.latest_process_started_at)
                    .unwrap_or(w.created_at)
            };
            activity(b).cmp(&activity(a))
        });
        Ok(items)
    }

    pub async fn workspace_repos(
        &self,
        workspace_id: Uuid,
    ) -> Result<Vec<WorkspaceRepoRef>, VkError> {
        self.get(&format!("/workspaces/{workspace_id}/repos")).await
    }

    /// The explicit repo, or the only repo of a single-repo workspace.
    pub async fn resolve_repo_id(
        &self,
        workspace_id: Uuid,
        explicit: Option<Uuid>,
    ) -> Result<Uuid, VkError> {
        if let Some(id) = explicit {
            return Ok(id);
        }
        let repos = self.workspace_repos(workspace_id).await?;
        match repos.as_slice() {
            [single] => Ok(single.id),
            [] => Err(VkError::message("Workspace has no repositories.")),
            _ => Err(VkError::message(format!(
                "Workspace has multiple repositories; pass --repo <id>. Repos: {}",
                repos
                    .iter()
                    .map(|r| format!("{} ({})", r.name, r.id))
                    .collect::<Vec<_>>()
                    .join(", ")
            ))),
        }
    }

    /// Bring a workspace's work branch up to date. `mode`: `pull` fast-forwards
    /// to its own remote, `merge_base` merges the base branch in,
    /// `rebase_base` rebases onto it.
    pub async fn sync_workspace_branch(
        &self,
        workspace_id: Uuid,
        repo_id: Option<Uuid>,
        mode: &str,
    ) -> Result<SyncBranchOutcome, VkError> {
        let mode = mode.trim().to_ascii_lowercase();
        let strategy = match mode.as_str() {
            "pull" => None,
            "merge_base" | "merge" => Some("merge"),
            "rebase_base" | "rebase" => Some("rebase"),
            other => {
                return Err(VkError::message(format!(
                    "Unknown mode '{other}'. Use 'pull', 'merge_base', or 'rebase_base'."
                )));
            }
        };
        let repo_id = self.resolve_repo_id(workspace_id, repo_id).await?;
        let outcome = if let Some(strategy) = strategy {
            let response = self
                .request(
                    reqwest::Method::POST,
                    self.api_url(&format!("/workspaces/{workspace_id}/git/update-from-base")),
                )
                .json(&json!({ "repo_id": repo_id, "strategy": strategy }))
                .send()
                .await
                .map_err(|error| VkError::Connect(error.to_string()))?;
            if !response.status().is_success() {
                return Err(Self::response_error(response).await);
            }
            let envelope: UpdateFromBaseEnvelope = response
                .json()
                .await
                .map_err(|error| VkError::Parse(error.to_string()))?;
            if !envelope.success {
                let message = match envelope.error_data {
                    Some(GitOperationError::MergeConflicts {
                        message,
                        conflicted_files,
                    }) if !conflicted_files.is_empty() => {
                        format!(
                            "{message} Conflicted files: {}",
                            conflicted_files.join(", ")
                        )
                    }
                    Some(GitOperationError::MergeConflicts { message, .. }) => message,
                    Some(GitOperationError::RebaseInProgress) => {
                        "A rebase is already in progress; resolve or abort it first.".to_string()
                    }
                    None => envelope
                        .message
                        .unwrap_or_else(|| "Update from base failed.".to_string()),
                };
                return Err(VkError::message(message));
            }
            match strategy {
                "rebase" => format!("Rebased onto the base branch ({mode})"),
                _ => format!("Merged the base branch into the work branch ({mode})"),
            }
        } else {
            let pull: PullOutcome = self
                .post(
                    &format!("/workspaces/{workspace_id}/git/pull"),
                    &json!({ "repo_id": repo_id }),
                )
                .await?;
            match pull {
                PullOutcome::UpToDate => "Already up to date with remote".to_string(),
                PullOutcome::FastForwarded { commits } => {
                    format!("Fast-forwarded {commits} commit(s) from remote")
                }
                PullOutcome::Diverged { ahead, behind } => format!(
                    "Diverged from remote ({ahead} ahead, {behind} behind) — a fast-forward is impossible. Use mode 'merge_base' or 'rebase_base', or reconcile manually."
                ),
            }
        };
        Ok(SyncBranchOutcome {
            workspace_id,
            repo_id,
            mode,
            outcome,
        })
    }

    /// Link a workspace (on the selected host) to a cloud issue.
    pub async fn link_workspace_to_issue(
        &self,
        workspace_id: Uuid,
        issue_id: Uuid,
    ) -> Result<(), VkError> {
        let issue: Issue = self
            .get_local(&format!("/remote/issues/{issue_id}"))
            .await?;
        self.post_empty(
            &format!("/workspaces/{workspace_id}/links"),
            &json!({ "project_id": issue.project_id, "issue_id": issue_id }),
        )
        .await
    }

    /// Create a workspace and start its first session. Without a prompt the
    /// linked issue's title and description become the prompt.
    pub async fn start_workspace(&self, input: StartWorkspaceInput) -> Result<Uuid, VkError> {
        if input.repositories.is_empty() {
            return Err(VkError::message(
                "At least one repository must be specified.",
            ));
        }
        let executor = parse_executor_agent(&input.executor)?;
        let variant = input.variant.and_then(non_empty);
        let prompt = input.prompt.and_then(non_empty);
        let repos: Vec<WorkspaceRepoInput> = input
            .repositories
            .into_iter()
            .map(|(repo_id, branch)| WorkspaceRepoInput {
                repo_id,
                target_branch: branch,
                create_target_branch: false,
                github_linked_branch: None,
            })
            .collect();
        let (linked_issue, issue_prompt) = match input.issue_id {
            Some(issue_id) => {
                let issue: Issue = self
                    .get_local(&format!("/remote/issues/{issue_id}"))
                    .await?;
                (
                    Some(LinkedIssueInfo {
                        remote_project_id: issue.project_id,
                        issue_id,
                    }),
                    workspace_prompt_from_issue(&issue),
                )
            }
            None => (None, None),
        };
        let prompt = prompt.or(issue_prompt).ok_or_else(|| {
            VkError::message("Provide a prompt, or an issue with a non-empty title/description.")
        })?;
        let payload = CreateAndStartWorkspaceRequest {
            name: Some(input.name),
            repos,
            linked_issue,
            executor_config: ExecutorConfig {
                executor,
                variant,
                model_id: None,
                agent_id: None,
                reasoning_id: None,
                permission_policy: None,
                sandbox_policy: None,
            },
            prompt,
            attachment_ids: None,
            pr_review: None,
            working_branch: WorkingBranchInput::Auto,
        };
        let response: CreateAndStartWorkspaceResponse =
            self.post("/workspaces/start", &payload).await?;
        if let Some(issue_id) = input.issue_id {
            self.link_workspace_to_issue(response.workspace.id, issue_id)
                .await?;
        }
        Ok(response.workspace.id)
    }
}

pub fn workspace_prompt_from_issue(issue: &Issue) -> Option<String> {
    let title = issue.title.trim();
    let description = issue
        .description
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .unwrap_or_default();
    match (title.is_empty(), description.is_empty()) {
        (true, true) => None,
        (false, true) => Some(title.to_string()),
        (true, false) => Some(description.to_string()),
        (false, false) => Some(format!("{title}\n\n{description}")),
    }
}

fn non_empty(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

pub fn parse_executor_agent(executor: &str) -> Result<BaseCodingAgent, VkError> {
    let normalized = executor.trim().replace('-', "_").to_ascii_uppercase();
    BaseCodingAgent::from_str(&normalized)
        .map_err(|_| VkError::message(format!("Unknown executor '{executor}'.")))
}

/// Executor name for a session: the explicit one, the session's, or CODEX.
pub fn executor_name(explicit: Option<&str>, session: &Session) -> Result<String, VkError> {
    let name = explicit
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or(session.executor.as_deref().map(str::trim))
        .filter(|s| !s.is_empty());
    match name {
        Some(name) => parse_executor_agent(name).map(|agent| agent.to_string()),
        None => Ok("CODEX".to_string()),
    }
}

// ---------------------------------------------------------------------------
// Sessions and prompts
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct SendPromptOptions {
    /// Append behind the running turn instead of failing when busy.
    pub queue: bool,
    /// Interrupt the running turn and run this prompt next.
    pub steer: bool,
    pub executor: Option<String>,
    pub variant: Option<String>,
    pub model_id: Option<String>,
    pub agent_id: Option<String>,
    pub reasoning_id: Option<String>,
    pub permission_policy: Option<String>,
}

impl SendPromptOptions {
    fn has_overrides(&self) -> bool {
        self.variant.is_some()
            || self.model_id.is_some()
            || self.agent_id.is_some()
            || self.reasoning_id.is_some()
            || self.permission_policy.is_some()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum SendPromptOutcome {
    /// A turn started right away.
    Started {
        execution_id: Uuid,
        execution: Value,
    },
    /// Appended to the session queue; the queue status follows.
    Queued { queue: Value },
    /// The running turn is being interrupted; the queue status follows.
    Steered { queue: Value },
}

impl VkClient {
    pub async fn session(&self, session_id: Uuid) -> Result<Session, VkError> {
        self.get(&format!("/sessions/{session_id}")).await
    }

    /// Config of the session's latest coding turn: what a bare follow-up
    /// inherits on the server.
    async fn latest_executor_config(&self, session_id: Uuid) -> Option<ExecutorConfig> {
        let processes: Vec<ExecutionProcess> = self
            .get_with(
                "/execution-processes",
                &[("session_id", session_id.to_string())],
            )
            .await
            .ok()?;
        processes
            .iter()
            .rev()
            .filter(|p| !p.dropped && p.run_reason == ExecutionProcessRunReason::CodingAgent)
            .find_map(|p| match &p.executor_action().ok()?.typ {
                ExecutorActionType::CodingAgentInitialRequest(r) => Some(r.executor_config.clone()),
                ExecutorActionType::CodingAgentFollowUpRequest(r) => {
                    Some(r.executor_config.clone())
                }
                ExecutorActionType::ReviewRequest(r) => Some(r.executor_config.clone()),
                _ => None,
            })
    }

    /// Executor config for a follow-up. A bare config (identity only) makes
    /// the server inherit the session's last-used model and settings; given
    /// overrides land on top of those settings, so `--reasoning` alone keeps
    /// the model and variant.
    async fn executor_config_json(
        &self,
        session: &Session,
        options: &SendPromptOptions,
    ) -> Result<Value, VkError> {
        let executor = executor_name(options.executor.as_deref(), session)?;
        if !options.has_overrides() {
            return Ok(json!({ "executor": executor }));
        }
        let mut config = self
            .latest_executor_config(session.id)
            .await
            .and_then(|latest| serde_json::to_value(latest).ok())
            .filter(|latest| latest["executor"] == json!(executor))
            .unwrap_or_else(|| json!({ "executor": executor }));
        let permission_policy = options
            .permission_policy
            .as_deref()
            .map(|p| p.trim().replace('-', "_").to_ascii_uppercase());
        for (key, value) in [
            ("variant", &options.variant),
            ("model_id", &options.model_id),
            ("agent_id", &options.agent_id),
            ("reasoning_id", &options.reasoning_id),
            ("permission_policy", &permission_policy),
        ] {
            if let Some(value) = value {
                config[key] = json!(value);
            }
        }
        Ok(config)
    }

    /// Run, queue or steer a prompt in a session on the selected host.
    pub async fn send_prompt(
        &self,
        session_id: Uuid,
        prompt: &str,
        options: &SendPromptOptions,
    ) -> Result<SendPromptOutcome, VkError> {
        let prompt = prompt.trim();
        if prompt.is_empty() {
            return Err(VkError::message("prompt must not be empty"));
        }
        let session = self.session(session_id).await?;
        let executor_config = self.executor_config_json(&session, options).await?;
        if options.steer {
            let queue: Value = self
                .post(
                    &format!("/sessions/{session_id}/queue/steer"),
                    &json!({ "message": prompt, "executor_config": executor_config }),
                )
                .await?;
            return Ok(SendPromptOutcome::Steered { queue });
        }
        if options.queue {
            let queue: Value = self
                .post(
                    &format!("/sessions/{session_id}/queue"),
                    &json!({ "message": prompt, "executor_config": executor_config }),
                )
                .await?;
            return Ok(SendPromptOutcome::Queued { queue });
        }
        let execution: ExecutionProcess = self
            .post(
                &format!("/sessions/{session_id}/follow-up"),
                &json!({
                    "prompt": prompt,
                    "executor_config": executor_config,
                    "retry_process_id": null,
                    "force_when_dirty": null,
                    "perform_git_reset": null,
                }),
            )
            .await
            .map_err(|error| match error {
                VkError::Api { status: 409, message } => VkError::Api {
                    status: 409,
                    message: format!("{message} (the session is busy; pass queue=true to run it after the current turn, or steer=true to interrupt)"),
                },
                other => other,
            })?;
        Ok(SendPromptOutcome::Started {
            execution_id: execution.id,
            execution: serde_json::to_value(&execution)
                .map_err(|error| VkError::Parse(error.to_string()))?,
        })
    }

    /// A page of a process's normalized conversation.
    pub async fn normalized_logs(
        &self,
        execution_id: Uuid,
        offset: usize,
        limit: usize,
        tool_results: bool,
    ) -> Result<Value, VkError> {
        self.get_with(
            &format!("/execution-processes/{execution_id}/normalized-logs"),
            &[
                ("offset", offset.to_string()),
                ("limit", limit.to_string()),
                ("tool_results", tool_results.to_string()),
            ],
        )
        .await
    }
}

// ---------------------------------------------------------------------------
// Events and notifications
// ---------------------------------------------------------------------------

/// Mirror of the server's journal event.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct JournalEvent {
    pub cursor: u64,
    pub at: DateTime<Utc>,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_id: Option<Uuid>,
    pub data: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct JournalPage {
    pub events: Vec<JournalEvent>,
    /// Pass back as `since` to continue.
    pub cursor: u64,
    /// Oldest cursor still buffered; a smaller `since` lost events.
    pub oldest_cursor: u64,
}

impl VkClient {
    fn journal_query(since: u64, kinds: &[String], limit: usize) -> Vec<(&'static str, String)> {
        let mut query = vec![("since", since.to_string()), ("limit", limit.to_string())];
        if !kinds.is_empty() {
            query.push(("kinds", kinds.join(",")));
        }
        query
    }

    pub async fn events_list(
        &self,
        since: u64,
        kinds: &[String],
        limit: usize,
    ) -> Result<JournalPage, VkError> {
        let mut page: JournalPage = self
            .get_with("/events/journal", &Self::journal_query(since, kinds, limit))
            .await?;
        for event in &mut page.events {
            event.host_id = self.host_id;
        }
        Ok(page)
    }

    /// Long-poll for the next matching events (server cap 60s per call, 20s
    /// through the relay whose requests time out at 30s; this loops until
    /// `timeout` elapses).
    pub async fn events_wait(
        &self,
        since: u64,
        kinds: &[String],
        limit: usize,
        timeout: Duration,
    ) -> Result<JournalPage, VkError> {
        let deadline = tokio::time::Instant::now() + timeout;
        let max_slice = Duration::from_secs(if self.host_id.is_some() { 20 } else { 60 });
        let mut since = since;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let slice = remaining.min(max_slice).as_secs().max(1);
            let mut query = Self::journal_query(since, kinds, limit);
            query.push(("timeout", slice.to_string()));
            let mut page: JournalPage = self
                .send(
                    self.request(reqwest::Method::GET, self.api_url("/events/wait"))
                        .query(&query)
                        .timeout(Duration::from_secs(slice + 15)),
                )
                .await?;
            for event in &mut page.events {
                event.host_id = self.host_id;
            }
            if !page.events.is_empty() || remaining <= Duration::from_secs(slice) {
                return Ok(page);
            }
            since = page.cursor.max(since);
        }
    }

    pub async fn notify(
        &self,
        title: &str,
        message: &str,
        workspace_id: Option<Uuid>,
        local_only: bool,
    ) -> Result<(), VkError> {
        self.post_empty(
            "/notifications/send",
            &json!({
                "title": title,
                "message": message,
                "workspace_id": workspace_id,
                "local_only": local_only,
            }),
        )
        .await
    }
}

// ---------------------------------------------------------------------------
// Context (where am I running) and host configuration
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct RemoteWorkspaceRow {
    project_id: Uuid,
    issue_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
struct RemoteProjectRow {
    organization_id: Uuid,
}

#[derive(Debug, Clone, Default)]
pub struct RemoteWorkspaceLinks {
    pub project_id: Option<Uuid>,
    pub issue_id: Option<Uuid>,
    pub organization_id: Option<Uuid>,
}

impl VkClient {
    /// The workspace whose worktree contains `path`, if the server owns one.
    pub async fn workspace_context(
        &self,
        path: &Path,
    ) -> Result<Option<WorkspaceContext>, VkError> {
        let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        let normalized = utils::path::normalize_macos_private_alias(&canonical);
        let response = self
            .request(
                reqwest::Method::GET,
                self.local_url("/containers/attempt-context"),
            )
            .query(&ContainerQuery {
                container_ref: normalized.to_string_lossy().to_string(),
            })
            .timeout(Duration::from_millis(800))
            .send()
            .await
            .map_err(|error| VkError::Connect(error.to_string()))?;
        if !response.status().is_success() {
            return Ok(None);
        }
        let envelope: Envelope<WorkspaceContext> = response
            .json()
            .await
            .map_err(|error| VkError::Parse(error.to_string()))?;
        Ok(envelope.success.then_some(envelope.data).flatten())
    }

    /// Cloud project/issue/organization a local workspace is linked to.
    pub async fn remote_workspace_links(&self, workspace_id: Uuid) -> RemoteWorkspaceLinks {
        let row: Option<RemoteWorkspaceRow> = self
            .send(
                self.request(
                    reqwest::Method::GET,
                    self.local_url(&format!("/remote/workspaces/by-local-id/{workspace_id}")),
                )
                .timeout(Duration::from_secs(3)),
            )
            .await
            .ok();
        let Some(row) = row else {
            return RemoteWorkspaceLinks::default();
        };
        let organization_id = self
            .send::<RemoteProjectRow>(
                self.request(
                    reqwest::Method::GET,
                    self.local_url(&format!("/remote/projects/{}", row.project_id)),
                )
                .timeout(Duration::from_secs(3)),
            )
            .await
            .ok()
            .map(|project| project.organization_id);
        RemoteWorkspaceLinks {
            project_id: Some(row.project_id),
            issue_id: row.issue_id,
            organization_id,
        }
    }

    /// `GET /api/info` of the selected host (config is secret-masked for agents).
    pub async fn system_info(&self) -> Result<Value, VkError> {
        self.get("/info").await
    }

    /// The host's `agent_access` toggles, if the server exposes them.
    pub async fn agent_access(&self) -> Option<Value> {
        let info: Value = self
            .send(
                self.request(reqwest::Method::GET, self.api_url("/info"))
                    .timeout(Duration::from_secs(3)),
            )
            .await
            .ok()?;
        info.pointer("/config/agent_access").cloned()
    }
}

// ---------------------------------------------------------------------------
// Issues (cloud, always local)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct CreateIssueInput {
    pub project_id: Uuid,
    pub title: String,
    pub description: Option<String>,
    pub priority: Option<String>,
    pub parent_issue_id: Option<Uuid>,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct UpdateIssueInput {
    pub title: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    /// `Some(None)` un-nests from the parent.
    pub parent_issue_id: Option<Option<Uuid>>,
}

impl VkClient {
    pub async fn issue(&self, issue_id: Uuid) -> Result<Issue, VkError> {
        self.get_local(&format!("/remote/issues/{issue_id}")).await
    }

    pub async fn project_statuses(&self, project_id: Uuid) -> Result<Vec<ProjectStatus>, VkError> {
        let response: ListProjectStatusesResponse = self
            .get_local(&format!("/remote/project-statuses?project_id={project_id}"))
            .await?;
        Ok(response.project_statuses)
    }

    /// A status by name (case-insensitive) or id.
    pub async fn resolve_status_id(&self, project_id: Uuid, status: &str) -> Result<Uuid, VkError> {
        if let Ok(id) = status.trim().parse::<Uuid>() {
            return Ok(id);
        }
        let statuses = self.project_statuses(project_id).await?;
        statuses
            .iter()
            .find(|s| s.name.eq_ignore_ascii_case(status.trim()))
            .map(|s| s.id)
            .ok_or_else(|| {
                let available: Vec<&str> = statuses.iter().map(|s| s.name.as_str()).collect();
                VkError::message(format!(
                    "Unknown status '{status}'. Available statuses: {available:?}"
                ))
            })
    }

    /// First visible status by sort order.
    pub async fn default_status_id(&self, project_id: Uuid) -> Result<Uuid, VkError> {
        self.project_statuses(project_id)
            .await?
            .iter()
            .filter(|s| !s.hidden)
            .min_by_key(|s| s.sort_order)
            .map(|s| s.id)
            .ok_or_else(|| VkError::message("No visible statuses found for project"))
    }

    pub async fn status_name(&self, project_id: Uuid, status_id: Uuid) -> String {
        self.project_statuses(project_id)
            .await
            .ok()
            .and_then(|statuses| statuses.into_iter().find(|s| s.id == status_id))
            .map(|s| s.name)
            .unwrap_or_else(|| status_id.to_string())
    }

    /// Replace `@tagname` references with the local prompt tag's content.
    pub async fn expand_tags(&self, text: &str) -> String {
        let Ok(pattern) = Regex::new(r"@([^\s@]+)") else {
            return text.to_string();
        };
        if !pattern.is_match(text) {
            return text.to_string();
        }
        let tags: Vec<Tag> = match self.get_local("/tags").await {
            Ok(tags) => tags,
            Err(_) => return text.to_string(),
        };
        let by_name: HashMap<&str, &str> = tags
            .iter()
            .map(|t| (t.tag_name.as_str(), t.content.as_str()))
            .collect();
        pattern
            .replace_all(text, |caps: &regex::Captures| {
                let name = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                by_name
                    .get(name)
                    .map(|content| (*content).to_string())
                    .unwrap_or_else(|| caps.get(0).map(|m| m.as_str()).unwrap_or("").to_string())
            })
            .into_owned()
    }

    pub async fn create_issue(&self, input: CreateIssueInput) -> Result<Issue, VkError> {
        let description = match input.description {
            Some(description) => Some(self.expand_tags(&description).await),
            None => None,
        };
        let status_id = match input.status.as_deref() {
            Some(status) => self.resolve_status_id(input.project_id, status).await?,
            None => self.default_status_id(input.project_id).await?,
        };
        let priority = input
            .priority
            .as_deref()
            .map(parse_issue_priority)
            .transpose()?;
        let payload = CreateIssueRequest {
            id: None,
            project_id: input.project_id,
            status_id,
            title: input.title,
            description,
            priority,
            start_date: None,
            target_date: None,
            completed_at: None,
            sort_order: 0.0,
            parent_issue_id: input.parent_issue_id,
            parent_issue_sort_order: None,
            extension_metadata: json!({}),
        };
        let response: MutationResponse<Issue> = self.post_local("/remote/issues", &payload).await?;
        Ok(response.data)
    }

    pub async fn update_issue(
        &self,
        issue_id: Uuid,
        input: UpdateIssueInput,
    ) -> Result<Issue, VkError> {
        let existing = self.issue(issue_id).await?;
        let status_id = match input.status.as_deref() {
            Some(status) => Some(self.resolve_status_id(existing.project_id, status).await?),
            None => None,
        };
        let description = match input.description {
            Some(description) => Some(Some(self.expand_tags(&description).await)),
            None => None,
        };
        let priority = input
            .priority
            .as_deref()
            .map(parse_issue_priority)
            .transpose()?
            .map(Some);
        let payload = UpdateIssueRequest {
            status_id,
            title: input.title,
            description,
            priority,
            start_date: None,
            target_date: None,
            completed_at: None,
            sort_order: None,
            parent_issue_id: input.parent_issue_id,
            parent_issue_sort_order: None,
            extension_metadata: None,
        };
        let response: MutationResponse<Issue> = self
            .patch_local(&format!("/remote/issues/{issue_id}"), &payload)
            .await?;
        Ok(response.data)
    }
}

pub fn parse_issue_priority(priority: &str) -> Result<IssuePriority, VkError> {
    match priority.trim().to_ascii_lowercase().as_str() {
        "urgent" => Ok(IssuePriority::Urgent),
        "high" => Ok(IssuePriority::High),
        "medium" => Ok(IssuePriority::Medium),
        "low" => Ok(IssuePriority::Low),
        _ => Err(VkError::message(format!(
            "Unknown priority '{priority}'. Allowed values: ['urgent', 'high', 'medium', 'low']"
        ))),
    }
}

pub fn issue_priority_label(priority: IssuePriority) -> &'static str {
    match priority {
        IssuePriority::Urgent => "urgent",
        IssuePriority::High => "high",
        IssuePriority::Medium => "medium",
        IssuePriority::Low => "low",
    }
}

// ---------------------------------------------------------------------------
// Events across every paired host
// ---------------------------------------------------------------------------

/// Journal page merged across this machine and every paired host. `cursor`
/// is `self=<n>,<host-id>=<n>` and must be passed back verbatim.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct MultiHostJournalPage {
    pub events: Vec<JournalEvent>,
    pub cursor: String,
    /// Hosts left out of this page (offline or failing); their cursors are
    /// kept so a later call resumes them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub failed_hosts: Vec<FailedHost>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct FailedHost {
    pub host_id: Uuid,
    pub host_name: Option<String>,
    pub error: String,
}

/// `"12"` → this machine at 12; `"self=12,<uuid>=40"` → one cursor per host.
pub fn parse_multi_cursor(raw: &str) -> Result<BTreeMap<String, u64>, VkError> {
    let mut cursors = BTreeMap::new();
    for part in raw.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let (host, cursor) = part.split_once('=').unwrap_or(("self", part));
        let cursor = cursor
            .trim()
            .parse()
            .map_err(|_| VkError::message(format!("Bad journal cursor '{part}'")))?;
        cursors.insert(host.trim().to_string(), cursor);
    }
    Ok(cursors)
}

impl VkClient {
    pub async fn events_list_all_hosts(
        &self,
        since: &str,
        kinds: &[String],
        limit: usize,
    ) -> Result<MultiHostJournalPage, VkError> {
        self.events_all_hosts(since, kinds, limit, None).await
    }

    /// Polls every host until a matching event lands or `timeout` passes.
    pub async fn events_wait_all_hosts(
        &self,
        since: &str,
        kinds: &[String],
        limit: usize,
        timeout: Duration,
    ) -> Result<MultiHostJournalPage, VkError> {
        self.events_all_hosts(since, kinds, limit, Some(timeout))
            .await
    }

    async fn events_all_hosts(
        &self,
        since: &str,
        kinds: &[String],
        limit: usize,
        timeout: Option<Duration>,
    ) -> Result<MultiHostJournalPage, VkError> {
        let mut cursors = parse_multi_cursor(since)?;
        let mut targets: Vec<(String, Option<Uuid>, Option<String>)> =
            vec![("self".to_string(), None, None)];
        let mut failed_hosts = Vec::new();
        match self.host(None).list_hosts().await {
            Ok(hosts) => {
                for host in hosts {
                    // Opening an offline host would only fail after a central
                    // approval, on every poll.
                    if host.status.as_deref() == Some("offline") {
                        failed_hosts.push(FailedHost {
                            host_id: host.host_id,
                            host_name: host.host_name,
                            error: "offline".to_string(),
                        });
                    } else {
                        targets.push((
                            host.host_id.to_string(),
                            Some(host.host_id),
                            host.host_name,
                        ));
                    }
                }
            }
            // No relay (or it is down): this machine alone still works.
            Err(error) => {
                tracing::warn!(%error, "other hosts unavailable; watching this host only")
            }
        }
        let deadline = timeout.map(|timeout| tokio::time::Instant::now() + timeout);
        loop {
            let mut merged: Vec<JournalEvent> = Vec::new();
            let mut next: BTreeMap<String, u64> = BTreeMap::new();
            // Hosts that failed in an earlier round are not retried this call.
            targets.retain(|(_, host, _)| {
                host.is_none_or(|id| !failed_hosts.iter().any(|f| f.host_id == id))
            });
            for (label, host, name) in &targets {
                let client = self.host(*host);
                let page = match cursors.get(label) {
                    Some(since) => client.events_list(*since, kinds, limit).await,
                    // A host seen for the first time starts at its latest
                    // cursor so its backlog is not replayed.
                    None => client
                        .events_list(u64::MAX, kinds, 1)
                        .await
                        .map(|page| JournalPage {
                            events: Vec::new(),
                            ..page
                        }),
                };
                match page {
                    Ok(page) => {
                        next.insert(label.clone(), page.cursor);
                        merged.extend(page.events);
                    }
                    Err(error) => {
                        tracing::warn!(%error, host = %label, "journal unavailable on host");
                        match host {
                            Some(host_id) => failed_hosts.push(FailedHost {
                                host_id: *host_id,
                                host_name: name.clone(),
                                error: error.to_string(),
                            }),
                            None => return Err(error),
                        }
                    }
                }
            }
            merged.sort_by(|a, b| a.at.cmp(&b.at));
            // Events cut by `limit` must come back: rewind their hosts' cursors.
            if merged.len() > limit.max(1) {
                for dropped in merged.split_off(limit.max(1)) {
                    let label = dropped
                        .host_id
                        .map_or_else(|| "self".to_string(), |id| id.to_string());
                    let rewind = dropped.cursor - 1;
                    next.entry(label)
                        .and_modify(|cursor| *cursor = (*cursor).min(rewind))
                        .or_insert(rewind);
                }
            }
            // Skipped hosts keep the cursor they came with.
            for failed in &failed_hosts {
                let label = failed.host_id.to_string();
                if let Some(cursor) = cursors.get(&label) {
                    next.entry(label).or_insert(*cursor);
                }
            }
            let cursor = next
                .iter()
                .map(|(host, cursor)| format!("{host}={cursor}"))
                .collect::<Vec<_>>()
                .join(",");
            let timed_out = deadline.is_none_or(|deadline| tokio::time::Instant::now() >= deadline);
            if !merged.is_empty() || timed_out {
                return Ok(MultiHostJournalPage {
                    events: merged,
                    cursor,
                    failed_hosts,
                });
            }
            cursors = next;
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }
}

// ---------------------------------------------------------------------------
// Issue attachments (cloud blob upload)
// ---------------------------------------------------------------------------

impl VkClient {
    /// Upload a local file as an issue attachment the way the web app does:
    /// init (dedup by hash) → PUT the bytes to the blob store → confirm →
    /// commit to the issue. Returns the committed attachments.
    pub async fn upload_issue_attachment(
        &self,
        issue_id: Uuid,
        path: &Path,
    ) -> Result<Value, VkError> {
        use sha2::{Digest, Sha256};
        let issue = self.issue(issue_id).await?;
        let bytes = std::fs::read(path)
            .map_err(|e| VkError::message(format!("Cannot read {}: {e}", path.display())))?;
        let filename = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "upload".to_string());
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let content_type = mime_guess::from_path(path)
            .first_or_octet_stream()
            .to_string();
        let size_bytes = bytes.len() as i64;
        let init = self
            .exec(
                "POST",
                "/remote/cloud/attachments/init",
                true,
                &[],
                Some(&json!({
                    "project_id": issue.project_id,
                    "filename": filename,
                    "size_bytes": size_bytes,
                    "hash": hash,
                })),
                None,
            )
            .await?;
        let upload_id = init
            .get("upload_id")
            .cloned()
            .ok_or_else(|| VkError::Parse("attachment init returned no upload_id".to_string()))?;
        if !init
            .get("skip_upload")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            let upload_url = init
                .get("upload_url")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    VkError::Parse("attachment init returned no upload_url".to_string())
                })?;
            // The blob store is external, so the system proxy applies here.
            let response = reqwest::Client::new()
                .put(upload_url)
                .header("x-ms-blob-type", "BlockBlob")
                .header(reqwest::header::CONTENT_TYPE, &content_type)
                .body(bytes)
                .send()
                .await
                .map_err(|e| VkError::Connect(e.to_string()))?;
            if !response.status().is_success() {
                return Err(VkError::Api {
                    status: response.status().as_u16(),
                    message: format!(
                        "blob upload failed: {}",
                        response.text().await.unwrap_or_default()
                    ),
                });
            }
        }
        let confirmed = self
            .exec(
                "POST",
                "/remote/cloud/attachments/confirm",
                true,
                &[],
                Some(&json!({
                    "project_id": issue.project_id,
                    "upload_id": upload_id,
                    "filename": filename,
                    "content_type": content_type,
                    "size_bytes": size_bytes,
                    "hash": hash,
                    "issue_id": issue_id,
                })),
                None,
            )
            .await?;
        let attachment_id = confirmed
            .get("id")
            .cloned()
            .ok_or_else(|| VkError::Parse("attachment confirm returned no id".to_string()))?;
        self.exec(
            "POST",
            &format!("/remote/cloud/issues/{issue_id}/attachments/commit"),
            true,
            &[],
            Some(&json!({ "attachment_ids": [attachment_id] })),
            None,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_routing_prefixes_the_relay_proxy() {
        let client = VkClient::new("http://127.0.0.1:3000/", "test/1");
        assert_eq!(
            client.api_url("/workspaces"),
            "http://127.0.0.1:3000/api/workspaces"
        );
        let host = Uuid::new_v4();
        let routed = client.host(Some(host));
        assert_eq!(
            routed.api_url("workspaces/1"),
            format!("http://127.0.0.1:3000/api/host/{host}/workspaces/1")
        );
        assert_eq!(
            routed.local_url("/remote/issues"),
            "http://127.0.0.1:3000/api/remote/issues"
        );
    }

    #[test]
    fn executor_names_normalize() {
        let session = Session {
            id: Uuid::new_v4(),
            workspace_id: Uuid::new_v4(),
            name: None,
            executor: Some("claude-code".to_string()),
            agent_working_dir: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            auto_resume_enabled: false,
        };
        assert_eq!(executor_name(None, &session).unwrap(), "CLAUDE_CODE");
        assert_eq!(executor_name(Some("codex"), &session).unwrap(), "CODEX");
        assert!(executor_name(Some("nope"), &session).is_err());
    }

    #[test]
    fn multi_host_cursors_parse_bare_and_keyed_forms() {
        let bare = parse_multi_cursor("12").unwrap();
        assert_eq!(bare.get("self"), Some(&12));
        let host = Uuid::new_v4();
        let keyed = parse_multi_cursor(&format!("self=3, {host}=40")).unwrap();
        assert_eq!(keyed.get("self"), Some(&3));
        assert_eq!(keyed.get(&host.to_string()), Some(&40));
        assert!(parse_multi_cursor("self=x").is_err());
    }

    #[tokio::test]
    async fn all_hosts_reports_offline_and_failing_hosts() {
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        };

        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let (online, offline, failing) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let hosts = json!([
            {"host_id": online, "host_name": "i9-mbp", "status": "online", "auth_mode": "account"},
            {"host_id": offline, "host_name": "old", "status": "offline", "auth_mode": "account"},
            {"host_id": failing, "host_name": "flaky", "status": "online", "auth_mode": "account"},
        ]);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let offline_called = Arc::new(AtomicBool::new(false));
        let called = offline_called.clone();
        tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buf = vec![0; 8192];
                let n = socket.read(&mut buf).await.unwrap();
                let request = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = request.split_whitespace().nth(1).unwrap_or("");
                let path = path.split('?').next().unwrap_or("");
                let ok = |data: Value| json!({"success": true, "data": data}).to_string();
                let (status, body) = if path == "/api/relay-auth/client/reachable-hosts" {
                    ("200 OK", ok(hosts.clone()))
                } else if path == "/api/events/journal" {
                    let page = json!({"events": [], "cursor": 5, "oldest_cursor": 0});
                    ("200 OK", ok(page))
                } else if path == format!("/api/host/{online}/events/journal") {
                    let event = json!({"cursor": 3, "at": "2026-10-23T00:00:00Z",
                        "kind": "process.completed", "data": {}});
                    let page = json!({"events": [event], "cursor": 3, "oldest_cursor": 0});
                    ("200 OK", ok(page))
                } else {
                    if path.contains(&offline.to_string()) {
                        called.store(true, Ordering::SeqCst);
                    }
                    let error = json!({"success": false, "message": "Relay transport failed"});
                    ("502 Bad Gateway", error.to_string())
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });

        let client = VkClient::new(&base, "test/1");
        let page = client
            .events_list_all_hosts(&format!("self=1,{online}=2,{failing}=9"), &[], 50)
            .await
            .unwrap();
        assert_eq!(page.events.len(), 1);
        assert_eq!(page.events[0].host_id, Some(online));
        let cursors = parse_multi_cursor(&page.cursor).unwrap();
        assert_eq!(cursors.get("self"), Some(&5));
        assert_eq!(cursors.get(&online.to_string()), Some(&3));
        // A failing host keeps the cursor it came with.
        assert_eq!(cursors.get(&failing.to_string()), Some(&9));
        let failed: Vec<_> = page
            .failed_hosts
            .iter()
            .map(|f| (f.host_id, f.host_name.clone()))
            .collect();
        assert_eq!(
            failed,
            vec![
                (offline, Some("old".to_string())),
                (failing, Some("flaky".to_string()))
            ]
        );
        assert_eq!(page.failed_hosts[0].error, "offline");
        assert!(!offline_called.load(Ordering::SeqCst));
    }

    #[test]
    fn issue_prompt_joins_title_and_description() {
        let issue = Issue {
            id: Uuid::new_v4(),
            project_id: Uuid::new_v4(),
            issue_number: 1,
            simple_id: "T-1".to_string(),
            status_id: Uuid::new_v4(),
            title: " Title ".to_string(),
            description: Some("Body".to_string()),
            priority: None,
            start_date: None,
            target_date: None,
            completed_at: None,
            sort_order: 0.0,
            parent_issue_id: None,
            parent_issue_sort_order: None,
            extension_metadata: json!({}),
            creator_user_id: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        assert_eq!(
            workspace_prompt_from_issue(&issue).as_deref(),
            Some("Title\n\nBody")
        );
    }
}
