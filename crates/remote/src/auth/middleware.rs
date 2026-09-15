use api_types::User;
use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use axum_extra::headers::{Authorization, HeaderMapExt, authorization::Bearer};
use chrono::{DateTime, Utc};
use tower_http::request_id::RequestId;
use tracing::{Span, warn};
use uuid::Uuid;

use super::cache::{AUTH_CACHE, SessionRejection};
use crate::{
    AppState, audit,
    audit::{AuditAction, AuditEvent},
    db::{self, auth::AuthSessionRepository},
};

#[derive(Clone)]
pub struct RequestContext {
    pub user: User,
    pub session_id: Uuid,
    #[allow(dead_code)]
    pub access_token_expires_at: DateTime<Utc>,
}

pub(crate) async fn require_session(
    State(state): State<AppState>,
    mut req: Request<Body>,
    next: Next,
) -> Response {
    let bearer = match req.headers().typed_get::<Authorization<Bearer>>() {
        Some(Authorization(token)) => token.token().to_owned(),
        None => return StatusCode::UNAUTHORIZED.into_response(),
    };

    let ctx = match request_context_from_access_token(&state, &bearer).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };

    Span::current().record("user_id", tracing::field::display(ctx.user.id));

    let request_id = req
        .extensions()
        .get::<RequestId>()
        .and_then(|id| id.header_value().to_str().ok())
        .unwrap_or("")
        .to_owned();

    let tx_ctx = db::TxContext {
        user_id: ctx.user.id,
        request_id,
    };

    req.extensions_mut().insert(ctx);
    db::TX_CONTEXT.scope(Some(tx_ctx), next.run(req)).await
}

pub(super) async fn request_context_from_access_token(
    state: &AppState,
    access_token: &str,
) -> Result<RequestContext, Response> {
    let jwt = state.jwt();
    let identity = match jwt.decode_access_token(access_token) {
        Ok(details) => details,
        Err(error) => {
            warn!(?error, "failed to decode access token");
            return Err(StatusCode::UNAUTHORIZED.into_response());
        }
    };

    let mut ctx = request_context_from_auth_session_id(state, identity.session_id).await?;
    if ctx.user.id != identity.user_id {
        warn!(
            token_user_id = %identity.user_id,
            session_user_id = %ctx.user.id,
            session_id = %identity.session_id,
            "access token user does not match session user"
        );
        return Err(StatusCode::UNAUTHORIZED.into_response());
    }

    ctx.access_token_expires_at = identity.expires_at;
    Ok(ctx)
}

pub(super) async fn request_context_from_auth_session_id(
    state: &AppState,
    session_id: Uuid,
) -> Result<RequestContext, Response> {
    let session_repo = AuthSessionRepository::new(state.pool());
    let now = Utc::now();

    // Cache hit: zero queries. Miss: one session+user JOIN. Revocation
    // invalidates the entry from `db::auth`, so a hit is never a revoked session.
    let session = match AUTH_CACHE
        .resolve_session(session_id, now, session_repo.get_with_user(session_id))
        .await
    {
        Ok(session) => session,
        Err(SessionRejection::NotFound) => {
            warn!("session `{}` not found", session_id);
            return Err(StatusCode::UNAUTHORIZED.into_response());
        }
        Err(SessionRejection::Revoked) => {
            warn!("session `{}` rejected (revoked)", session_id);
            return Err(StatusCode::UNAUTHORIZED.into_response());
        }
        Err(SessionRejection::Inactive { user_id }) => {
            warn!(
                "session `{}` expired due to inactivity; revoking",
                session_id
            );
            if let Err(error) = session_repo.revoke(session_id).await {
                warn!(?error, "failed to revoke inactive session");
            }
            audit::emit(
                AuditEvent::system(AuditAction::AuthSessionRevoked)
                    .user(user_id, Some(session_id))
                    .resource("auth_session", Some(session_id))
                    .http("", "", 401)
                    .description("Session revoked due to inactivity"),
            );
            return Err(StatusCode::UNAUTHORIZED.into_response());
        }
        Err(SessionRejection::Database(error)) => {
            warn!(?error, "failed to load session");
            return Err(StatusCode::INTERNAL_SERVER_ERROR.into_response());
        }
    };

    // `last_used_at` is day-granular: only pay for the UPDATE when the day changed.
    if session.needs_touch(now) {
        match session_repo.touch(session_id).await {
            Ok(()) => session.mark_touched(now),
            Err(error) => warn!(?error, "failed to update session last-used timestamp"),
        }
    }

    Ok(RequestContext {
        user: session.user.clone(),
        session_id,
        access_token_expires_at: now,
    })
}
