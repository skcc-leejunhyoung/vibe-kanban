//! Preview subdomain dispatcher.
//!
//! Caddy terminates TLS for `*.<preview_host_suffix>` and reverse-proxies the
//! plain HTTP request to this server. We extract `{port}--{host_id}` from the
//! first label of the Host header, look up the host's open control tunnel, and
//! stream the request through it. Tailnet membership is the only access
//! boundary — no per-request signing.

use axum::{
    extract::{Request, State},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use relay_tunnel_core::server::proxy_request_over_control;
use uuid::Uuid;

use super::super::state::RelayAppState;

/// Parsed `{port}--{host_id}.{suffix}` Host header.
struct PreviewTarget {
    port: u16,
    host_id: Uuid,
}

fn parse_preview_target(host_header: &str, suffix: &str) -> Option<PreviewTarget> {
    let host_no_port = host_header.split(':').next()?;
    let host_lower = host_no_port.to_ascii_lowercase();
    let label = host_lower.strip_suffix(&format!(".{suffix}"))?;
    if label.is_empty() || label.contains('.') {
        return None;
    }
    let (port_str, host_id_str) = label.split_once("--")?;
    let port = port_str.parse::<u16>().ok()?;
    let host_id = Uuid::parse_str(host_id_str).ok()?;
    Some(PreviewTarget { port, host_id })
}

/// Returns true if the request is destined for a preview subdomain. Used by
/// the router to decide between the preview pipeline and the regular routes.
pub fn is_preview_request(req: &Request, suffix: Option<&str>) -> bool {
    let Some(suffix) = suffix else { return false };
    let Some(host) = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    parse_preview_target(host, suffix).is_some()
}

/// Handler that forwards a preview request through the matching host's tunnel.
pub async fn preview_subdomain_handler(
    State(state): State<RelayAppState>,
    mut request: Request,
) -> Response {
    let Some(suffix) = state.config.preview_host_suffix.as_deref() else {
        return (StatusCode::NOT_FOUND, "Preview routing not configured").into_response();
    };

    let Some(host_header) = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
    else {
        return (StatusCode::BAD_REQUEST, "Missing Host header").into_response();
    };

    let Some(target) = parse_preview_target(&host_header, suffix) else {
        return (StatusCode::BAD_REQUEST, "Invalid preview Host header").into_response();
    };

    let Some(relay) = state.relay_registry.get(&target.host_id).await else {
        return (StatusCode::NOT_FOUND, "No active host for preview").into_response();
    };

    // Rewrite Host so the host's preview-proxy sees this as a same-host
    // request (`relay_host_id = None`) and forwards directly to localhost:port.
    let rewritten_host = format!("{port}.{suffix}", port = target.port);
    if let Ok(value) = HeaderValue::from_str(&rewritten_host) {
        request.headers_mut().insert(header::HOST, value);
    }

    // No prefix to strip — the request URI is already what the host should
    // route on (e.g. `/`, `/static/foo.css`, `/?_refresh=1`).
    proxy_request_over_control(relay.control.as_ref(), request, "").await
}
