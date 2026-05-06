mod auth_code;
pub mod connect;
pub mod path_routes;
pub mod preview_subdomain;

use axum::{
    Router,
    extract::{Request, State},
    http::{HeaderName, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{any, get, post},
};
use serde::Serialize;
use tower_http::{
    cors::{AllowHeaders, AllowMethods, AllowOrigin, CorsLayer, ExposeHeaders},
    trace::TraceLayer,
};

use super::{auth, state::RelayAppState};

pub fn build_router(state: RelayAppState) -> Router {
    let protected = Router::new()
        .route("/relay/connect", get(connect::relay_connect))
        .route(
            "/relay/create/{host_id}",
            post(auth_code::create_relay_session),
        )
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_session,
        ));

    // Proxy routes are authenticated at the application layer via
    // browser_session_id validation and cryptographic signed headers/frames.
    let proxy = Router::new()
        .route(
            "/relay/h/{host_id}/s/{browser_session_id}",
            any(path_routes::relay_path_proxy),
        )
        .route(
            "/relay/h/{host_id}/s/{browser_session_id}/",
            any(path_routes::relay_path_proxy),
        )
        .route(
            "/relay/h/{host_id}/s/{browser_session_id}/{*tail}",
            any(path_routes::relay_path_proxy_with_tail),
        );

    let public = Router::new().route("/health", get(health));

    Router::<RelayAppState>::new()
        .nest("/v1", protected)
        .nest("/v1", proxy)
        .merge(public)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            preview_subdomain_dispatch,
        ))
        .layer(
            CorsLayer::new()
                .allow_origin(AllowOrigin::mirror_request())
                .allow_methods(AllowMethods::mirror_request())
                .allow_headers(AllowHeaders::mirror_request())
                .expose_headers(ExposeHeaders::list([
                    HeaderName::from_static("x-vk-resp-ts"),
                    HeaderName::from_static("x-vk-resp-nonce"),
                    HeaderName::from_static("x-vk-resp-signature"),
                ]))
                .allow_credentials(true),
        )
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, axum::Json(HealthResponse { status: "ok" }))
}

/// If the inbound Host header looks like a preview subdomain, route through
/// the host control tunnel; otherwise fall through to the normal routes.
async fn preview_subdomain_dispatch(
    State(state): State<RelayAppState>,
    request: Request,
    next: Next,
) -> Response {
    let suffix = state.config.preview_host_suffix.as_deref();
    if preview_subdomain::is_preview_request(&request, suffix) {
        return preview_subdomain::preview_subdomain_handler(State(state), request).await;
    }
    next.run(request).await
}
