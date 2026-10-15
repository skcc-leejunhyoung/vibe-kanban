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
) -> Result<Json<RelayHost>, crate::db::host_connections::AccountError> {
    use crate::db::{
        host_access::validate_session,
        host_connections::{self, AccountError},
    };
    let name = request.name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(AccountError::InvalidRequest);
    }
    let mut tx = crate::db::begin_tx(&pool).await?;
    let host = host_connections::lock_host(&mut tx, host_id).await?;
    validate_session(&mut tx, ctx.user.id, ctx.session_id, false).await?;
    if host.owner_user_id != ctx.user.id {
        return Err(HostAccessError::HostNotFound.into());
    }
    let row=sqlx::query_as::<_,RelayHost>("UPDATE hosts SET custom_name=$2,updated_at=clock_timestamp() WHERE id=$1 RETURNING id,owner_user_id,machine_id,COALESCE(custom_name,name) AS name,status,last_seen_at,agent_version,created_at,updated_at,'owner'::text AS access_role,auth_mode,auth_generation,remote_access_enabled,capabilities")
        .bind(host_id).bind(name).fetch_one(&mut *tx).await?;
    host_connections::audit(&mut tx, host_id, ctx.user.id, None, "host.renamed").await?;
    tx.commit().await?;
    Ok(Json(row))
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
