use api_types::{
    ChangeHostAccessRequest, HostAccessErrorCode, HostAccessErrorResponse, HostAccessGrant,
    HostAccessPolicy, MutationResponse,
};
use axum::{
    Json, Router,
    extract::{Extension, FromRef, Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, patch, put},
};
use relay_types::{ListRelayHostsResponse, RelayHost, UpdateRelayHostRequest};
use sqlx::PgPool;
use uuid::Uuid;

use super::error::ErrorResponse;
use crate::{
    audit::{self, AuditAction, AuditEvent},
    auth::RequestContext,
    db::{
        host_access::{HostAccessError, HostAccessRepository},
        hosts::HostRepository,
    },
};

pub fn router<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    PgPool: FromRef<S>,
{
    Router::new()
        .route("/hosts", get(list_hosts))
        .route("/hosts/{host_id}", patch(update_host))
        .route("/hosts/{host_id}/access", get(list_access))
        .route(
            "/hosts/{host_id}/access/{user_id}",
            put(grant_access).delete(revoke_access),
        )
}

async fn list_access(
    State(pool): State<PgPool>,
    Extension(ctx): Extension<RequestContext>,
    Path(host_id): Path<Uuid>,
) -> Result<Json<HostAccessPolicy>, HostAccessError> {
    HostAccessRepository::new(&pool)
        .list(host_id, ctx.user.id, ctx.session_id)
        .await
        .map(Json)
}

async fn grant_access(
    State(pool): State<PgPool>,
    Extension(ctx): Extension<RequestContext>,
    Path((host_id, user_id)): Path<(Uuid, Uuid)>,
    Json(request): Json<ChangeHostAccessRequest>,
) -> Result<Json<MutationResponse<HostAccessGrant>>, HostAccessError> {
    let result = HostAccessRepository::new(&pool)
        .change(
            host_id,
            ctx.user.id,
            ctx.session_id,
            user_id,
            &request,
            true,
        )
        .await?;
    audit::emit(
        AuditEvent::from_request(&ctx, AuditAction::HostAccessGranted)
            .resource("host", Some(host_id))
            .http("PUT", format!("/v1/hosts/{host_id}/access/{user_id}"), 200)
            .description(format!(
                "Host access granted to {user_id} at version {}",
                result.data.version
            )),
    );
    Ok(Json(result))
}

async fn revoke_access(
    State(pool): State<PgPool>,
    Extension(ctx): Extension<RequestContext>,
    Path((host_id, user_id)): Path<(Uuid, Uuid)>,
    Query(request): Query<ChangeHostAccessRequest>,
) -> Result<Json<MutationResponse<HostAccessGrant>>, HostAccessError> {
    let result = HostAccessRepository::new(&pool)
        .change(
            host_id,
            ctx.user.id,
            ctx.session_id,
            user_id,
            &request,
            false,
        )
        .await?;
    audit::emit(
        AuditEvent::from_request(&ctx, AuditAction::HostAccessRevoked)
            .resource("host", Some(host_id))
            .http(
                "DELETE",
                format!("/v1/hosts/{host_id}/access/{user_id}"),
                200,
            )
            .description(format!(
                "Host access revoked for {user_id} at version {}",
                result.data.version
            )),
    );
    Ok(Json(result))
}

impl IntoResponse for HostAccessError {
    fn into_response(self) -> Response {
        let (status, code) = match &self {
            Self::HostNotFound => (StatusCode::NOT_FOUND, HostAccessErrorCode::HostNotFound),
            Self::AccountNotFound => (StatusCode::NOT_FOUND, HostAccessErrorCode::AccountNotFound),
            Self::AccountSessionRevoked => (
                StatusCode::UNAUTHORIZED,
                HostAccessErrorCode::AccountSessionRevoked,
            ),
            Self::ReauthenticationRequired => (
                StatusCode::FORBIDDEN,
                HostAccessErrorCode::ReauthenticationRequired,
            ),
            Self::OwnerAccessImmutable => (
                StatusCode::CONFLICT,
                HostAccessErrorCode::OwnerAccessImmutable,
            ),
            Self::HostGenerationConflict => (
                StatusCode::CONFLICT,
                HostAccessErrorCode::HostGenerationConflict,
            ),
            Self::GrantVersionConflict => (
                StatusCode::CONFLICT,
                HostAccessErrorCode::GrantVersionConflict,
            ),
            Self::HostTransitionInProgress => (
                StatusCode::CONFLICT,
                HostAccessErrorCode::HostTransitionInProgress,
            ),
            Self::InvalidAccessVersion => (
                StatusCode::BAD_REQUEST,
                HostAccessErrorCode::InvalidAccessVersion,
            ),
            Self::Database(error) => {
                tracing::warn!(?error, "failed to manage host access");
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(HostAccessErrorResponse {
                        code: HostAccessErrorCode::InternalError,
                        error: "Failed to manage host access".into(),
                    }),
                )
                    .into_response();
            }
        };
        (
            status,
            Json(HostAccessErrorResponse {
                code,
                error: self.to_string(),
            }),
        )
            .into_response()
    }
}

async fn update_host(
    State(pool): State<PgPool>,
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

    let host = HostRepository::new(&pool)
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
    State(pool): State<PgPool>,
    Extension(ctx): Extension<RequestContext>,
) -> Result<Json<ListRelayHostsResponse>, ErrorResponse> {
    let repo = HostRepository::new(&pool);
    let hosts = repo
        .list_accessible_hosts(ctx.user.id)
        .await
        .map_err(|error| {
            tracing::warn!(?error, "failed to list relay hosts");
            ErrorResponse::new(StatusCode::INTERNAL_SERVER_ERROR, "Failed to list hosts")
        })?;

    Ok(Json(ListRelayHostsResponse { hosts }))
}
