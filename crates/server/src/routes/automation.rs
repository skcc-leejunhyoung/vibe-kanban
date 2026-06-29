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
    Router,
    body::Bytes,
    extract::{Path, RawQuery},
    http::{HeaderMap, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::any,
};
use reqwest::Client;

use crate::DeploymentImpl;

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
    Router::new().route("/automation/{*tail}", any(proxy))
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
