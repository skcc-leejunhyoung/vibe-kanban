use api_types::MutationResponse;
use axum::{
    Extension, Json, Router,
    extract::{FromRef, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, patch, post},
};
use relay_control::account::HostGrantSigner;
use relay_types::*;
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    auth::{AUTH_CACHE, RequestContext},
    db::{
        self,
        host_access::{HostAccessError, validate_session},
        host_connections::{self as connections, AccountError},
    },
};

/// Record rejected host mutations after their transaction has rolled back.
/// Only identifiers/status are stored; never request bodies, codes or secrets.
pub async fn audit_denied(
    State(pool): State<PgPool>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let context = request.extensions().get::<RequestContext>().cloned();
    let parts = request
        .uri()
        .path()
        .split('/')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>();
    let host = parts
        .iter()
        .position(|p| *p == "hosts")
        .and_then(|i| parts.get(i + 1))
        .and_then(|id| id.parse::<Uuid>().ok());
    let method = request.method().as_str().to_owned();
    let action = if parts.contains(&"connections") {
        "host.connection_denied"
    } else if parts.contains(&"previews") {
        "host.preview_denied"
    } else {
        "host.management_denied"
    };
    let request_id = request
        .headers()
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .chars()
        .take(128)
        .collect::<String>();
    let response = next.run(request).await;
    if let (Some(ctx), Some(host)) = (context, host)
        && response.status().is_client_error()
        && method != "GET"
        && method != "HEAD"
    {
        let result=sqlx::query("INSERT INTO host_access_audit (host_id,actor_id,action,result,request_id) SELECT id,$2,$3,$4,$5 FROM hosts WHERE id=$1")
                .bind(host).bind(ctx.user.id).bind(action).bind(response.status().as_u16().to_string()).bind(request_id).execute(&pool).await;
        if let Err(error) = result {
            tracing::warn!(?error, "Failed to record denied host operation");
        }
    }
    response
}

pub fn router<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    PgPool: FromRef<S>,
{
    Router::new()
        .route("/hosts/register", post(register))
        .route(
            "/hosts/{host}/connections",
            post(open).get(list_connections),
        )
        .route("/hosts/{host}/connections/{connection}", delete(terminate))
        .route(
            "/hosts/{host}/state",
            patch(change_state).delete(unregister),
        )
        .route("/hosts/{host}/audit", get(audit))
        .route("/hosts/{host}/previews", post(create_preview))
        .route("/hosts/{host}/accounts/{user}", get(account_profile))
        .route("/account/sessions", get(sessions).delete(logout_all))
        .route("/account/sessions/{session}", delete(logout_session))
}

// Public only with respect to user JWT middleware; each mutation requires a
// scoped host credential. A user token cannot authenticate these endpoints.
pub fn host_router<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    PgPool: FromRef<S>,
{
    Router::new()
        .route("/host-grant-keys", get(keys))
        .route("/host-credentials/activate", post(activate))
        .route("/host-credentials/rotate", post(rotate))
        .route("/host-connections/renew", post(renew))
        .route("/host-previews/ports", post(report_preview_ports))
        .route("/host-previews/authorize", post(authorize_preview))
}

impl IntoResponse for AccountError {
    fn into_response(self) -> Response {
        let (status, code) = match &self {
            Self::Access(_) => {
                if let Self::Access(error) = self {
                    return error.into_response();
                }
                unreachable!()
            }
            Self::InvalidRequest => (StatusCode::BAD_REQUEST, "INVALID_REQUEST"),
            Self::HostCredentialRevoked => (StatusCode::UNAUTHORIZED, "HOST_CREDENTIAL_REVOKED"),
            Self::HostAccessDenied => (StatusCode::FORBIDDEN, "HOST_ACCESS_REVOKED"),
            Self::HostConnectionExpired => (StatusCode::UNAUTHORIZED, "HOST_CONNECTION_EXPIRED"),
            Self::Conflict => (StatusCode::CONFLICT, "HOST_GENERATION_CONFLICT"),
            Self::Disabled => (StatusCode::SERVICE_UNAVAILABLE, "ACCOUNT_HOSTS_DISABLED"),
            Self::Database(error) => {
                tracing::warn!(?error, "account host operation failed");
                (StatusCode::SERVICE_UNAVAILABLE, "CONTROL_PLANE_UNAVAILABLE")
            }
        };
        (
            status,
            Json(serde_json::json!({"code":code,"error":self.to_string()})),
        )
            .into_response()
    }
}

fn credential(headers: &HeaderMap) -> Result<&str, AccountError> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|v| v.starts_with("vkh_"))
        .ok_or(AccountError::HostCredentialRevoked)
}

async fn keys() -> Result<Json<HostGrantKeys>, AccountError> {
    Ok(Json(
        HostGrantSigner::from_env()
            .map_err(|_| AccountError::Disabled)?
            .public_keys(),
    ))
}

async fn create_preview(
    State(pool): State<PgPool>,
    Extension(ctx): Extension<RequestContext>,
    Path(host): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<CreateHostPreviewRequest>,
) -> Result<Json<MutationResponse<CreateHostPreviewResponse>>, AccountError> {
    let origin = headers
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .ok_or(AccountError::InvalidRequest)?;
    connections::create_preview(&pool, host, ctx.user.id, ctx.session_id, origin, request)
        .await
        .map(Json)
}
async fn report_preview_ports(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Json(request): Json<ReportPreviewPortsRequest>,
) -> Result<Json<MutationResponse<()>>, AccountError> {
    connections::report_preview_ports(&pool, credential(&headers)?, request)
        .await
        .map(Json)
}
async fn authorize_preview(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Json(request): Json<AuthorizeHostPreviewRequest>,
) -> Result<Json<HostConnectionLease>, AccountError> {
    connections::authorize_preview(&pool, credential(&headers)?, request)
        .await
        .map(Json)
}

async fn register(
    State(pool): State<PgPool>,
    Extension(ctx): Extension<RequestContext>,
    Json(request): Json<RegisterAccountHostRequest>,
) -> Result<Json<MutationResponse<AccountHostRegistration>>, AccountError> {
    connections::register(&pool, ctx.user.id, ctx.session_id, request)
        .await
        .map(Json)
}
async fn activate(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Json(request): Json<ActivateAccountHostRequest>,
) -> Result<Json<MutationResponse<AccountHostRegistration>>, AccountError> {
    connections::activate(&pool, credential(&headers)?, request)
        .await
        .map(Json)
}
async fn rotate(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Json(request): Json<RotateHostCredentialRequest>,
) -> Result<Json<MutationResponse<Uuid>>, AccountError> {
    connections::rotate(&pool, credential(&headers)?, request)
        .await
        .map(Json)
}
async fn renew(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Json(request): Json<RenewHostConnectionsRequest>,
) -> Result<Json<RenewHostConnectionsResponse>, AccountError> {
    connections::renew(&pool, credential(&headers)?, request)
        .await
        .map(Json)
}
async fn open(
    State(pool): State<PgPool>,
    Extension(ctx): Extension<RequestContext>,
    Path(host): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<OpenHostConnectionRequest>,
) -> Result<Json<MutationResponse<HostConnectionApproval>>, AccountError> {
    if let Some(label) = headers.get("user-agent").and_then(|v| v.to_str().ok()) {
        let label: String = label
            .chars()
            .filter(|c| !c.is_control())
            .take(256)
            .collect();
        sqlx::query(
            "UPDATE auth_sessions SET device_label=$2 WHERE id=$1 AND device_label IS NULL",
        )
        .bind(ctx.session_id)
        .bind(label)
        .execute(&pool)
        .await?;
    }
    connections::open_connection(&pool, ctx.user.id, ctx.session_id, host, request)
        .await
        .map(Json)
}
async fn change_state(
    State(pool): State<PgPool>,
    Extension(ctx): Extension<RequestContext>,
    Path(host): Path<Uuid>,
    Json(request): Json<ChangeHostStateRequest>,
) -> Result<Json<MutationResponse<()>>, AccountError> {
    connections::change_state(&pool, host, ctx.user.id, ctx.session_id, request, false)
        .await
        .map(Json)
}
async fn unregister(
    State(pool): State<PgPool>,
    Extension(ctx): Extension<RequestContext>,
    Path(host): Path<Uuid>,
    Query(request): Query<ChangeHostStateRequest>,
) -> Result<Json<MutationResponse<()>>, AccountError> {
    connections::change_state(&pool, host, ctx.user.id, ctx.session_id, request, true)
        .await
        .map(Json)
}
async fn terminate(
    State(pool): State<PgPool>,
    Extension(ctx): Extension<RequestContext>,
    Path((host, connection)): Path<(Uuid, Uuid)>,
) -> Result<Json<MutationResponse<()>>, AccountError> {
    connections::terminate_connection(&pool, host, ctx.user.id, ctx.session_id, connection)
        .await
        .map(Json)
}
async fn list_connections(
    State(pool): State<PgPool>,
    Extension(ctx): Extension<RequestContext>,
    Path(host_id): Path<Uuid>,
) -> Result<Json<Vec<HostConnectionInfo>>, AccountError> {
    let mut tx = db::begin_tx(&pool).await?;
    let host = connections::lock_host(&mut tx, host_id).await?;
    validate_session(&mut tx, ctx.user.id, ctx.session_id, false).await?;
    let rows=sqlx::query_as::<_,HostConnectionInfo>("SELECT id,user_id,auth_session_id,created_at,last_used_at,expires_at FROM relay_browser_sessions WHERE host_id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp() AND ($2 OR user_id=$3) ORDER BY created_at DESC LIMIT 256")
        .bind(host_id).bind(host.owner_user_id==ctx.user.id).bind(ctx.user.id).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(rows))
}
async fn audit(
    State(pool): State<PgPool>,
    Extension(ctx): Extension<RequestContext>,
    Path(host_id): Path<Uuid>,
) -> Result<Json<Vec<HostAccessAuditEntry>>, AccountError> {
    let mut tx = db::begin_tx(&pool).await?;
    let host = connections::lock_host(&mut tx, host_id).await?;
    validate_session(&mut tx, ctx.user.id, ctx.session_id, false).await?;
    if host.owner_user_id != ctx.user.id {
        return Err(HostAccessError::HostNotFound.into());
    }
    let rows=sqlx::query_as::<_,HostAccessAuditEntry>("SELECT id,actor_id,target_id,action,result,created_at FROM host_access_audit WHERE host_id=$1 AND created_at>clock_timestamp()-INTERVAL '30 days' ORDER BY created_at DESC LIMIT 100")
        .bind(host_id).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(rows))
}
async fn account_profile(
    State(pool): State<PgPool>,
    Extension(ctx): Extension<RequestContext>,
    Path((host_id, user)): Path<(Uuid, Uuid)>,
) -> Result<Json<HostAccountProfile>, AccountError> {
    let mut tx = db::begin_tx(&pool).await?;
    let host = connections::lock_host(&mut tx, host_id).await?;
    validate_session(&mut tx, ctx.user.id, ctx.session_id, false).await?;
    if host.owner_user_id != ctx.user.id {
        return Err(HostAccessError::HostNotFound.into());
    }
    let profile = sqlx::query_as::<_, HostAccountProfile>(
        "SELECT id,username,first_name,last_name FROM users WHERE id=$1 AND suspended_at IS NULL",
    )
    .bind(user)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(HostAccessError::AccountNotFound)?;
    tx.commit().await?;
    Ok(Json(profile))
}
async fn sessions(
    State(pool): State<PgPool>,
    headers: HeaderMap,
    Extension(ctx): Extension<RequestContext>,
) -> Result<Json<Vec<AccountSessionInfo>>, AccountError> {
    let mut tx = db::begin_tx(&pool).await?;
    validate_session(&mut tx, ctx.user.id, ctx.session_id, false).await?;
    if let Some(label) = headers.get("user-agent").and_then(|v| v.to_str().ok()) {
        let label: String = label
            .chars()
            .filter(|c| !c.is_control())
            .take(256)
            .collect();
        sqlx::query(
            "UPDATE auth_sessions SET device_label=$2 WHERE id=$1 AND device_label IS NULL",
        )
        .bind(ctx.session_id)
        .bind(label)
        .execute(&mut *tx)
        .await?;
    }
    let rows=sqlx::query_as::<_,AccountSessionInfo>("SELECT id,device_label,created_at,last_used_at,id=$2 AS current FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL AND COALESCE(last_used_at,created_at)>clock_timestamp()-INTERVAL '365 days' ORDER BY created_at DESC")
        .bind(ctx.user.id).bind(ctx.session_id).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(rows))
}
async fn revoke_sessions(
    pool: &PgPool,
    ctx: RequestContext,
    id: Option<Uuid>,
) -> Result<Json<MutationResponse<()>>, AccountError> {
    let mut tx = db::begin_tx(pool).await?;
    // Lock all affected rows in one order before validating the caller, including
    // concurrent "log out all" calls from two devices.
    let ids:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM auth_sessions WHERE user_id=$1 AND ($2::uuid IS NULL OR id=$2 OR id=$3) ORDER BY id FOR UPDATE")
        .bind(ctx.user.id).bind(id).bind(ctx.session_id).fetch_all(&mut *tx).await?;
    validate_session(&mut tx, ctx.user.id, ctx.session_id, false).await?;
    if id.is_some_and(|id| !ids.contains(&id)) {
        return Err(HostAccessError::AccountNotFound.into());
    }
    sqlx::query("UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE user_id=$1 AND ($2::uuid IS NULL OR id=$2)").bind(ctx.user.id).bind(id).execute(&mut *tx).await?;
    sqlx::query("UPDATE relay_browser_sessions SET revoked_at=clock_timestamp() WHERE user_id=$1 AND ($2::uuid IS NULL OR auth_session_id=$2) AND revoked_at IS NULL").bind(ctx.user.id).bind(id).execute(&mut *tx).await?;
    let txid = db::get_txid(&mut *tx).await?;
    tx.commit().await?;
    for id in ids {
        AUTH_CACHE.invalidate_session(id).await;
    }
    Ok(Json(MutationResponse { data: (), txid }))
}
async fn logout_all(
    State(pool): State<PgPool>,
    Extension(ctx): Extension<RequestContext>,
) -> Result<Json<MutationResponse<()>>, AccountError> {
    revoke_sessions(&pool, ctx, None).await
}
async fn logout_session(
    State(pool): State<PgPool>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<Uuid>,
) -> Result<Json<MutationResponse<()>>, AccountError> {
    revoke_sessions(&pool, ctx, Some(id)).await
}
