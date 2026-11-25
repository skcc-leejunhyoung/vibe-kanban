//! Reverse proxy to the standalone automation worker (`packages/automation-worker`).
//!
//! The worker is a small Node service (default `http://127.0.0.1:8787`) that owns
//! connectors, JavaScript rules, logs and the retry queue. It is gated by an
//! admin token. Rather than exposing that token (or the worker port) to the
//! browser, the Vibe Kanban settings page calls `/api/automation/*` and this
//! handler forwards the request to the worker, injecting the token server-side.
//!
//! Because the route lives under the relay-signed router (see `routes::mod`), it
//! is reachable from both the local web app and the remote web app (the latter
//! tunnels through the host relay), with no direct browser-to-worker traffic.

use std::{sync::OnceLock, time::Duration};

use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path, RawQuery},
    http::{HeaderMap, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{any, get, post},
};
use db::models::{execution_process::ExecutionProcess, session::Session, workspace::Workspace};
use deployment::Deployment;
use executors::{actions::AutomationOrigin, executors::BaseCodingAgent, profile::ExecutorConfig};
use reqwest::Client;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use services::services::container::ContainerService;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

static HTTP_CLIENT: OnceLock<Client> = OnceLock::new();
static AUTOPILOT_POLICY_RUNNING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn client() -> &'static Client {
    HTTP_CLIENT.get_or_init(|| {
        Client::builder()
            .build()
            .expect("failed to build automation worker HTTP client")
    })
}

/// Base URL of the worker. Overridable so the worker can run on another
/// host/port (e.g. a container address); defaults to the local worker.
fn worker_base_url() -> String {
    std::env::var("AUTOMATION_WORKER_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "http://127.0.0.1:8787".to_string())
}

/// Admin token the worker requires. Falls back to `ADMIN_TOKEN` so a single
/// shared value can configure both the worker and this proxy.
fn worker_token() -> Option<String> {
    std::env::var("AUTOMATION_WORKER_TOKEN")
        .or_else(|_| std::env::var("ADMIN_TOKEN"))
        .ok()
        .filter(|s| !s.trim().is_empty())
}

/// Only registered artifact operations cross this bridge; never a caller-supplied URL.
pub(super) async fn artifact_channel<T: DeserializeOwned>(
    channel: &str,
    operation: &str,
    payload: serde_json::Value,
) -> Result<T, ApiError> {
    if !services::services::artifact_interactions::valid_channel_id(channel)
        || ![
            "describe",
            "snapshot",
            "request",
            "configure",
            "lifecycle",
            "inspect",
        ]
        .contains(&operation)
    {
        return Err(ApiError::BadRequest(
            "Invalid artifact automation operation".into(),
        ));
    }
    let unavailable = || {
        ApiError::BadGateway("Artifact automation unavailable; check status before retrying".into())
    };
    let token = worker_token().ok_or_else(unavailable)?;
    let path = if operation == "lifecycle" {
        "artifact-lifecycle".to_string()
    } else if operation == "configure" {
        "artifact-channels".to_string()
    } else {
        format!("artifact-channels/{channel}/{operation}")
    };
    let mut response = client()
        .post(format!(
            "{}/api/{path}",
            worker_base_url().trim_end_matches('/')
        ))
        .bearer_auth(token)
        .timeout(std::time::Duration::from_secs(20))
        .json(&payload)
        .send()
        .await
        .map_err(|_| unavailable())?;
    let status = response.status();
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| unavailable())? {
        if body.len() + chunk.len() > 128 * 1024 {
            return Err(unavailable());
        }
        body.extend_from_slice(&chunk);
    }
    if !status.is_success() {
        let message = serde_json::from_slice::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| {
                v.get("error")
                    .and_then(|e| e.as_str())
                    .map(|e| e.chars().take(500).collect())
            })
            .unwrap_or_else(|| "Artifact automation request failed".to_string());
        return Err(match status.as_u16() {
            400 | 413 | 422 => ApiError::BadRequest(message),
            403 | 404 => ApiError::Forbidden(message),
            409 | 429 => ApiError::Conflict(message),
            _ => unavailable(),
        });
    }
    serde_json::from_slice(&body).map_err(|_| unavailable())
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/automation/{*tail}", any(proxy))
        .route("/automation-actions/status", get(host_status))
        .route(
            "/automation-actions/autopilot-snapshot",
            get(autopilot_snapshot),
        )
        .route(
            "/automation-actions/triage-facts/{execution}",
            get(triage_facts),
        )
        .route(
            "/automation-actions/autopilot-sessions",
            get(autopilot_sessions),
        )
        .route(
            "/automation-actions/autopilot-executor/{session_id}",
            get(autopilot_executor),
        )
        .route("/automation-actions/receipts/{key}", get(action_receipt))
        .route("/automation-actions/notification", post(notification))
}

async fn action_receipt(
    axum::extract::State(deployment): axum::extract::State<DeploymentImpl>,
    Path(key): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    services::services::automation::action_receipt(&deployment.db().pool, &key)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn host_status(
    axum::extract::State(deployment): axum::extract::State<DeploymentImpl>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let running = ExecutionProcess::find_running(&deployment.db().pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({
        "hostId": deployment.user_id(),
        "busy": !running.is_empty(),
        "notificationProtocol": 2,
        "autopilotExecutorPolicy": autopilot_policy_command().is_some(),
    })))
}

const AUTOPILOT_POLICY_TIMEOUT: Duration = Duration::from_secs(45);

fn autopilot_policy_command() -> Option<std::path::PathBuf> {
    std::env::var_os("VIBE_AUTOPILOT_EXECUTOR_POLICY")
        .filter(|path| !path.is_empty())
        .map(Into::into)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AutopilotExecutorSelection {
    executor: BaseCodingAgent,
    model_id: String,
    reasoning_id: Option<String>,
}

#[derive(Serialize)]
struct AutopilotExecutorDecision {
    executor_config: ExecutorConfig,
    handoff: bool,
}

fn apply_autopilot_selection(
    mut current: ExecutorConfig,
    selection: AutopilotExecutorSelection,
) -> ExecutorConfig {
    // The policy cannot replace the user's permission, sandbox, or agent mode.
    // A non-default preset or an implicit permission default cannot be
    // translated safely to a different executor.
    if current.executor != selection.executor
        && (current.permission_policy.is_none()
            || current.sandbox_policy.is_some()
            || current.agent_id.is_some()
            || !matches!(current.variant.as_deref(), None | Some("DEFAULT")))
    {
        return current;
    }
    if current.executor != selection.executor {
        current.variant = None;
    }
    current.executor = selection.executor;
    current.model_id = Some(selection.model_id);
    current.reasoning_id = selection.reasoning_id.or(current.reasoning_id);
    current
}

/// An opt-in host policy supplies a choice, not a prompt or a session action.
/// Only the active Autopilot's own session is eligible.
async fn autopilot_executor(
    axum::extract::State(deployment): axum::extract::State<DeploymentImpl>,
    Path(session_id): Path<Uuid>,
) -> Result<Response, ApiError> {
    let unavailable = || ApiError::BadGateway("Autopilot executor policy unavailable".into());
    let command = autopilot_policy_command()
        .filter(|path| path.is_absolute())
        .ok_or_else(unavailable)?;
    let pool = &deployment.db().pool;
    let read_current = || async {
        let conflict = || ApiError::Conflict("Active Autopilot session changed".into());
        let workspace = Workspace::find_active_autopilot(pool)
            .await?
            .ok_or_else(conflict)?;
        let session = Session::find_latest_by_workspace_id(pool, workspace.id)
            .await?
            .filter(|session| session.id == session_id)
            .ok_or_else(conflict)?;
        ExecutionProcess::latest_executor_config_for_session(pool, session.id)
            .await?
            .ok_or_else(conflict)
    };
    let _running = AUTOPILOT_POLICY_RUNNING
        .try_lock()
        .map_err(|_| unavailable())?;
    let current = read_current().await?;
    let mut stops = deployment.container().watch_session_stops(session_id);
    let config = serde_json::to_string(&current).map_err(|_| unavailable())?;
    // The executable is configured by the host operator, never by the request.
    // No prompt, event, or caller-controlled command line is passed through.
    let mut command = tokio::process::Command::new(command);
    command
        .arg(session_id.to_string())
        .arg(config)
        .kill_on_drop(true);
    let probe = tokio::time::timeout(AUTOPILOT_POLICY_TIMEOUT, command.output());
    let output = tokio::select! {
        Ok(()) = stops.changed() => return Ok(StatusCode::NO_CONTENT.into_response()),
        result = probe => result.map_err(|_| unavailable())?.map_err(|_| unavailable())?,
    };
    if !output.status.success() || output.stdout.len() > 4096 {
        return Err(unavailable());
    }
    let selection: Option<AutopilotExecutorSelection> =
        serde_json::from_slice(&output.stdout).map_err(|_| unavailable())?;
    let fresh = read_current().await;
    if stops.has_changed().unwrap_or(false) {
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    if fresh? != current {
        return Err(ApiError::Conflict(
            "Autopilot executor config changed".into(),
        ));
    }
    let source = current.executor;
    let executor_config = match selection {
        Some(selection) if !selection.model_id.trim().is_empty() => {
            apply_autopilot_selection(current, selection)
        }
        Some(_) => return Err(unavailable()),
        None => current,
    };
    Ok(Json(AutopilotExecutorDecision {
        handoff: executor_config.executor != source,
        executor_config,
    })
    .into_response())
}

#[cfg(test)]
mod autopilot_executor_tests {
    use super::*;

    #[test]
    fn selection_preserves_permission_and_does_not_replace_a_custom_preset() {
        let mut current: ExecutorConfig = serde_json::from_value(serde_json::json!({
            "executor": "OPENCODE_V2", "model_id": "example/sol",
            "permission_policy": "SUPERVISED", "reasoning_id": "low",
        }))
        .unwrap();
        let recovered = || AutopilotExecutorSelection {
            executor: BaseCodingAgent::Codex,
            model_id: "gpt-5.6-sol-fast".into(),
            reasoning_id: None,
        };
        let next = apply_autopilot_selection(current.clone(), recovered());
        assert_eq!(next.executor, BaseCodingAgent::Codex);
        assert_eq!(next.permission_policy, current.permission_policy);
        assert_eq!(next.reasoning_id, current.reasoning_id);
        current.variant = Some("CUSTOM".into());
        assert_eq!(
            apply_autopilot_selection(current.clone(), recovered()),
            current
        );
    }
}

async fn autopilot_snapshot(
    axum::extract::State(deployment): axum::extract::State<DeploymentImpl>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let mut snapshot =
        services::services::autopilot::reconciliation_snapshot(&deployment.db().pool).await?;
    snapshot["hostId"] = serde_json::json!(deployment.user_id());
    Ok(Json(snapshot))
}

async fn triage_facts(
    axum::extract::State(deployment): axum::extract::State<DeploymentImpl>,
    Path(execution): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let mut facts =
        services::services::autopilot::triage_facts(&deployment.db().pool, execution).await?;
    facts["hostId"] = serde_json::json!(deployment.user_id());
    Ok(Json(facts))
}

async fn autopilot_sessions(
    axum::extract::State(deployment): axum::extract::State<DeploymentImpl>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let sessions = services::services::autopilot::autopilot_sessions(&deployment.db().pool).await?;
    Ok(Json(serde_json::json!({
        "hostId": deployment.user_id(),
        "sessions": sessions,
    })))
}

/// The agent session behind a vk CLI / MCP request, if it named one.
pub(crate) fn agent_session(headers: &HeaderMap) -> Option<Uuid> {
    headers
        .get(crate::middleware::agent_access::AGENT_SESSION_HEADER)?
        .to_str()
        .ok()?
        .parse()
        .ok()
}

/// Remembers which agent asked for `execution`. Best effort: a failure here
/// must not fail a prompt that already started, so it is only logged.
pub(crate) async fn record_agent_origin(
    pool: &SqlitePool,
    execution: Uuid,
    agent_session: Option<Uuid>,
) {
    let Some(agent_session) = agent_session else {
        return;
    };
    if let Err(error) =
        services::services::autopilot::record_agent_origin(pool, execution, agent_session).await
    {
        tracing::warn!(%execution, ?error, "failed to record the agent origin of an execution");
    }
}

#[derive(Deserialize)]
struct NotificationAction {
    title: String,
    message: String,
    workspace_id: Option<Uuid>,
}

async fn notification(
    axum::extract::State(deployment): axum::extract::State<DeploymentImpl>,
    headers: HeaderMap,
    Json(action): Json<NotificationAction>,
) -> Result<StatusCode, ApiError> {
    let key = match claim_action::<()>(&deployment.db().pool, &headers, "notification").await? {
        ActionClaim::Execute(key) => key,
        ActionClaim::Replay(()) => return Ok(StatusCode::NO_CONTENT),
    };
    deployment
        .container()
        .notification_service()
        .notify(&action.title, &action.message, action.workspace_id)
        .await?;
    complete_action(&deployment.db().pool, key.as_deref(), &()).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[allow(clippy::result_large_err)]
pub(crate) fn idempotency_key(headers: &HeaderMap) -> Result<Option<String>, ApiError> {
    let Some(value) = headers.get("idempotency-key") else {
        return Ok(None);
    };
    let value = value
        .to_str()
        .map_err(|_| ApiError::BadRequest("invalid idempotency-key header".to_string()))?
        .trim();
    if value.is_empty() || value.len() > 200 {
        return Err(ApiError::BadRequest(
            "idempotency-key must contain 1-200 characters".to_string(),
        ));
    }
    Ok(Some(value.to_string()))
}

#[allow(clippy::result_large_err)]
pub(crate) fn automation_origin(headers: &HeaderMap) -> Result<Option<AutomationOrigin>, ApiError> {
    let Some(routine_id) = headers.get("x-vibe-routine-id") else {
        return Ok(None);
    };
    let routine_id = routine_id
        .to_str()
        .map_err(|_| ApiError::BadRequest("invalid x-vibe-routine-id header".to_string()))?
        .trim();
    if routine_id.is_empty() || routine_id.len() > 200 {
        return Err(ApiError::BadRequest(
            "x-vibe-routine-id must contain 1-200 characters".to_string(),
        ));
    }
    let routine_chain = headers
        .get("x-vibe-routine-chain")
        .map(|value| {
            let value = value.to_str().map_err(|_| {
                ApiError::BadRequest("invalid x-vibe-routine-chain header".to_string())
            })?;
            serde_json::from_str::<Vec<String>>(value).map_err(|_| {
                ApiError::BadRequest("x-vibe-routine-chain must be a JSON string array".to_string())
            })
        })
        .transpose()?
        .unwrap_or_default();
    if routine_chain.len() > 32 || routine_chain.iter().any(|item| item.len() > 200) {
        return Err(ApiError::BadRequest(
            "x-vibe-routine-chain exceeds its size limit".to_string(),
        ));
    }
    Ok(Some(AutomationOrigin {
        routine_id: routine_id.to_string(),
        routine_chain,
    }))
}

pub(crate) enum ActionClaim<T> {
    Execute(Option<String>),
    Replay(T),
}

pub(crate) async fn claim_action<T: DeserializeOwned>(
    pool: &SqlitePool,
    headers: &HeaderMap,
    action: &str,
) -> Result<ActionClaim<T>, ApiError> {
    let key = idempotency_key(headers)?;
    let Some(key) = key else {
        return Ok(ActionClaim::Execute(None));
    };
    match services::services::automation::begin_action(pool, &key, action).await? {
        services::services::automation::ActionReceipt::Claimed => {
            Ok(ActionClaim::Execute(Some(key)))
        }
        services::services::automation::ActionReceipt::Running => Err(ApiError::Conflict(
            "automation action is already running".to_string(),
        )),
        services::services::automation::ActionReceipt::Succeeded(response) => {
            serde_json::from_value(response)
                .map(ActionClaim::Replay)
                .map_err(|error| {
                    ApiError::BadGateway(format!("invalid automation receipt: {error}"))
                })
        }
    }
}

pub(crate) async fn complete_action<T: Serialize>(
    pool: &SqlitePool,
    key: Option<&str>,
    response: &T,
) -> Result<(), ApiError> {
    if let Some(key) = key {
        services::services::automation::complete_action(pool, key, response).await?;
    }
    Ok(())
}

/// Forward `/api/automation/<tail>` to `<worker>/api/<tail>`, preserving method,
/// query string and JSON body, and adding the worker's bearer token.
async fn proxy(
    method: Method,
    Path(tail): Path<String>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let base = worker_base_url();
    let mut url = format!("{}/api/{}", base.trim_end_matches('/'), tail);
    if let Some(q) = query.as_deref().filter(|q| !q.is_empty()) {
        url.push('?');
        url.push_str(q);
    }
    // Only the Drawer route may move scopes, after checking both cloud notes.
    let parsed = match reqwest::Url::parse(&url) {
        Ok(url) => url,
        Err(error) => return bad_gateway(error),
    };
    if parsed.path().starts_with("/api/artifact-channels/")
        && parsed
            .path()
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .is_some_and(|operation| ["move-drawer", "transfer", "inspect"].contains(&operation))
    {
        return (
            StatusCode::FORBIDDEN,
            "Use the checked Drawer artifact move endpoint",
        )
            .into_response();
    }

    let mut request = client().request(method, &url);
    if let Some(token) = worker_token() {
        request = request.bearer_auth(token);
    }
    if let Some(content_type) = headers.get(header::CONTENT_TYPE) {
        request = request.header(header::CONTENT_TYPE, content_type);
    }
    if !body.is_empty() {
        request = request.body(body);
    }

    match request.send().await {
        Ok(resp) => {
            let status = resp.status();
            let content_type = resp.headers().get(header::CONTENT_TYPE).cloned();
            match resp.bytes().await {
                Ok(bytes) => {
                    let mut response = (status, bytes).into_response();
                    if let Some(ct) = content_type {
                        response.headers_mut().insert(header::CONTENT_TYPE, ct);
                    }
                    response
                }
                Err(err) => bad_gateway(err),
            }
        }
        Err(err) => bad_gateway(err),
    }
}

/// The worker being down (or unconfigured) must surface as a clear gateway error
/// rather than a 500, so the settings page can tell the user it is unreachable.
fn bad_gateway(err: impl std::fmt::Display) -> Response {
    (
        StatusCode::BAD_GATEWAY,
        format!("automation worker unavailable: {err}"),
    )
        .into_response()
}

#[cfg(test)]
mod drawer_move_tests {
    use super::*;

    #[tokio::test]
    async fn generic_proxy_cannot_bypass_drawer_ownership_checks() {
        for tail in [
            "artifact-channels/synthetic/move-drawer",
            "artifact-channels/synthetic/transfer",
            "artifact-channels/synthetic/transfer/",
            "artifact-channels/synthetic/extra/%2e%2e/transfer/",
            "artifact-channels/synthetic/inspect",
            "artifact-channels/synthetic/move-drawer/",
            "artifact-channels//synthetic//move-drawer//",
            "artifact-channels/synthetic/extra/../move-drawer",
            "artifact-channels/synthetic/extra/%2e%2e/move-drawer",
        ] {
            assert_eq!(
                proxy(
                    Method::POST,
                    Path(tail.into()),
                    RawQuery(None),
                    HeaderMap::new(),
                    Bytes::new()
                )
                .await
                .status(),
                StatusCode::FORBIDDEN
            );
        }
    }
}
