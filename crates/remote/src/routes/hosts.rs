use axum::{
    Json, Router,
    extract::{Extension, Path, State},
    http::StatusCode,
    routing::{get, patch},
};
use relay_types::{ListRelayHostsResponse, RelayHost, UpdateRelayHostRequest};
use uuid::Uuid;

use super::error::ErrorResponse;
use crate::{AppState, auth::RequestContext, db::hosts::HostRepository};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/hosts", get(list_hosts))
        .route("/hosts/{host_id}", patch(update_host))
}

async fn update_host(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Path(host_id): Path<Uuid>,
    Json(request): Json<UpdateRelayHostRequest>,
) -> Result<Json<RelayHost>, ErrorResponse> {
    let name = request.name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(ErrorResponse::new(
            StatusCode::BAD_REQUEST,
            "Host name must be between 1 and 100 characters",
        ));
    }

    let host = HostRepository::new(state.pool())
        .update_name(host_id, ctx.user.id, name)
        .await
        .map_err(|error| {
            tracing::warn!(?error, %host_id, "failed to update relay host name");
            ErrorResponse::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to update host name",
            )
        })?
        .ok_or_else(|| ErrorResponse::new(StatusCode::NOT_FOUND, "Host not found"))?;

    Ok(Json(host))
}

async fn list_hosts(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
) -> Result<Json<ListRelayHostsResponse>, ErrorResponse> {
    let repo = HostRepository::new(state.pool());
    let hosts = repo
        .list_accessible_hosts(ctx.user.id)
        .await
        .map_err(|error| {
            tracing::warn!(?error, "failed to list relay hosts");
            ErrorResponse::new(StatusCode::INTERNAL_SERVER_ERROR, "Failed to list hosts")
        })?;

    Ok(Json(ListRelayHostsResponse { hosts }))
}
