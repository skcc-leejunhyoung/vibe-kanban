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

use std::sync::OnceLock;

use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path, RawQuery},
    http::{HeaderMap, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{any, get, post},
};
use db::models::execution_process::ExecutionProcess;
use deployment::Deployment;
use executors::actions::AutomationOrigin;
use reqwest::Client;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use services::services::container::ContainerService;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

static HTTP_CLIENT: OnceLock<Client> = OnceLock::new();

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
        || !["describe", "snapshot", "request", "configure"].contains(&operation)
    {
        return Err(ApiError::BadRequest(
            "Invalid artifact automation operation".into(),
        ));
    }
    let unavailable = || {
        ApiError::BadGateway("Artifact automation unavailable; check status before retrying".into())
    };
    let token = worker_token().ok_or_else(unavailable)?;
    let path = if operation == "configure" {
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
        .route("/automation-actions/receipts/{key}", get(action_receipt))
        .route("/automation-actions/notification", post(notification))
}

async fn action_receipt(
    axum::extract::State(deployment): axum::extract::State<DeploymentImpl>,
    Path(key): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let row = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT status,response FROM automation_action_receipts WHERE idempotency_key=?",
    )
    .bind(key)
    .fetch_optional(&deployment.db().pool)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(match row {
        Some((status, response)) => {
            serde_json::json!({"status":status,"response":response.and_then(|s|serde_json::from_str::<serde_json::Value>(&s).ok())})
        }
        None => serde_json::json!({"status":"missing"}),
    }))
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
        "notificationProtocol": 1,
    })))
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
        .await;
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
