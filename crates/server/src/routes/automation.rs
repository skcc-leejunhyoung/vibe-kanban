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

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/automation/{*tail}", any(proxy))
        .route("/automation-actions/status", get(host_status))
        .route("/automation-actions/notification", post(notification))
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
