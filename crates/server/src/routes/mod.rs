use axum::{
    Router,
    extract::{Request, State},
    http::{HeaderValue, header},
    middleware::Next,
    response::Response,
    routing::{IntoMakeService, get},
};
use tower_http::{compression::CompressionLayer, validate_request::ValidateRequestHeaderLayer};

use crate::{DeploymentImpl, middleware};

pub mod approvals;
pub mod automation;
pub mod config;
pub mod containers;
pub mod filesystem;
// pub mod github;
pub mod attachments;
pub mod events;
pub mod execution_processes;
pub mod frontend;
pub mod health;
pub mod host_relay;
pub mod oauth;
pub mod organizations;
pub mod preview;
pub mod relay_auth;
pub mod releases;
pub mod remote;
pub mod repo;
pub mod scratch;
pub mod search;
pub mod sessions;
pub mod spec_intake;
pub mod ssh_session;
pub mod tags;
pub mod terminal;
pub mod web_push;
pub mod webrtc;
pub mod workspaces;

pub fn router(deployment: DeploymentImpl) -> IntoMakeService<Router> {
    let relay_signed_routes = Router::new()
        .route("/health", get(health::health_check))
        .merge(config::router())
        .merge(automation::router())
        .merge(containers::router(&deployment))
        .merge(workspaces::router(&deployment))
        .merge(execution_processes::router(&deployment))
        .merge(tags::router(&deployment))
        .merge(oauth::router())
        .merge(organizations::router())
        .merge(filesystem::router())
        .merge(repo::router())
        .merge(events::router(&deployment))
        .merge(approvals::router())
        .merge(scratch::router(&deployment))
        .merge(search::router(&deployment))
        .merge(preview::api_router())
        .merge(releases::router())
        .merge(sessions::router(&deployment))
        .merge(spec_intake::router(&deployment))
        .merge(terminal::router())
        .merge(web_push::router())
        .route("/ssh-session", get(ssh_session::ssh_session_ws))
        .nest("/remote", remote::router())
        .merge(webrtc::router())
        .nest("/attachments", attachments::routes())
        .layer(axum::middleware::from_fn_with_state(
            deployment.clone(),
            middleware::sign_relay_response,
        ))
        .layer(axum::middleware::from_fn_with_state(
            deployment.clone(),
            middleware::require_relay_request_signature,
        ))
        .with_state(deployment.clone());

    let api_routes = Router::new()
        .merge(relay_auth::router())
        .merge(host_relay::router(&deployment))
        .merge(relay_signed_routes)
        .layer(ValidateRequestHeaderLayer::custom(
            middleware::validate_origin,
        ))
        .layer(axum::middleware::from_fn(middleware::log_server_errors))
        .with_state(deployment.clone());

    Router::new()
        .route("/", get(frontend::serve_frontend_root))
        .route("/{*path}", get(frontend::serve_frontend))
        .nest("/api", api_routes)
        .layer(axum::middleware::from_fn_with_state(
            deployment.clone(),
            preview_host_dispatch,
        ))
        .layer(CompressionLayer::new())
        .with_state(deployment)
        .into_make_service()
}

/// If the inbound Host first label has `--` (e.g. `3000--<uuid>` or `3000`),
/// hand the request to the preview subdomain proxy instead of running it
/// through normal routing. This lets the preview proxy serve dev-server
/// content on the same port that already accepts API/frontend traffic.
async fn preview_host_dispatch(
    State(deployment): State<DeploymentImpl>,
    request: Request,
    next: Next,
) -> Response {
    if request_has_preview_host(&request) {
        let mut response = preview::subdomain_proxy_request(State(deployment), request).await;
        // Stop the outer `CompressionLayer` from re-encoding the dev-server's
        // response. Streaming brotli over the relay tunnel produced corrupt
        // bytes for some payloads (e.g. UTF-8 JSON locales). The preview proxy
        // already strips upstream content-encoding, so claiming `identity`
        // here is accurate and tells the layer to leave the body alone.
        if !response.headers().contains_key(header::CONTENT_ENCODING) {
            response.headers_mut().insert(
                header::CONTENT_ENCODING,
                HeaderValue::from_static("identity"),
            );
        }
        return response;
    }
    next.run(request).await
}

fn request_has_preview_host(request: &Request) -> bool {
    let Some(host) = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    let host_no_port = host.split(':').next().unwrap_or("");
    let mut labels = host_no_port.split('.');
    let Some(first) = labels.next() else {
        return false;
    };
    if first.is_empty() {
        return false;
    }
    let port_label = match first.split_once("--") {
        Some((port, _)) => port,
        None => first,
    };
    if port_label.parse::<u16>().is_err() {
        return false;
    }
    // Reject pure-IP authorities (e.g. `127.0.0.1`) where every remaining
    // label is numeric. Real preview hostnames always contain a domain part.

    labels.any(|label| label.chars().any(|c| c.is_ascii_alphabetic()))
}
