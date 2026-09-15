//! Relay path handlers: auth code exchange and proxy.

use axum::{
    extract::{Path, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Utc};
use relay_tunnel_core::server::proxy_request_over_control;
use uuid::Uuid;

use super::super::{
    db::{
        auth_sessions::{AuthSessionRepository, MAX_SESSION_INACTIVITY_DURATION},
        relay_browser_sessions::RelayBrowserSessionRepository,
    },
    state::RelayAppState,
};

const RELAY_PROXY_PREFIX: &str = "/relay/h";

/// Handle `ANY /relay/h/{host_id}/s/{browser_session_id}`.
pub(super) async fn relay_path_proxy(
    State(state): State<RelayAppState>,
    Path((host_id, browser_session_id)): Path<(Uuid, Uuid)>,
    request: Request,
) -> Response {
    if let Err(response) =
        validate_browser_session_for_host(&state, browser_session_id, host_id).await
    {
        return response;
    }

    do_relay_proxy_for_host(&state, host_id, browser_session_id, request).await
}

/// Handle `ANY /relay/h/{host_id}/s/{browser_session_id}/{*tail}`.
pub(super) async fn relay_path_proxy_with_tail(
    State(state): State<RelayAppState>,
    Path((host_id, browser_session_id, _tail)): Path<(Uuid, Uuid, String)>,
    request: Request,
) -> Response {
    if let Err(response) =
        validate_browser_session_for_host(&state, browser_session_id, host_id).await
    {
        return response;
    }

    do_relay_proxy_for_host(&state, host_id, browser_session_id, request).await
}

/// One Postgres round trip per proxied request (browser session ⋈ auth
/// session + host access), plus the two day-granular touches only when the
/// UTC day actually changed.
///
/// Deliberately uncached: logout and membership changes happen in the remote
/// server process, which cannot invalidate a cache held here, so the single
/// query stays the source of truth and revocation is always immediate.
async fn validate_browser_session_for_host(
    state: &RelayAppState,
    relay_browser_session_id: Uuid,
    expected_host_id: Uuid,
) -> Result<(), Response> {
    let relay_browser_session_repo = RelayBrowserSessionRepository::new(&state.pool);
    let row = match relay_browser_session_repo
        .get_for_proxy(relay_browser_session_id, expected_host_id)
        .await
    {
        Ok(Some(row)) => row,
        Ok(None) => return Err(StatusCode::UNAUTHORIZED.into_response()),
        Err(error) => {
            tracing::warn!(?error, "failed to load relay browser session");
            return Err(StatusCode::INTERNAL_SERVER_ERROR.into_response());
        }
    };

    if row.revoked_at.is_some() {
        return Err(StatusCode::UNAUTHORIZED.into_response());
    }

    if row.host_id != expected_host_id {
        return Err((StatusCode::FORBIDDEN, "Host access denied").into_response());
    }

    // Auth session checks mirror `auth::request_context_from_auth_session_id`;
    // as before, an unusable auth session also revokes the browser session.
    let now = Utc::now();
    let (Some(session_user_id), Some(session_created_at)) =
        (row.session_user_id, row.session_created_at)
    else {
        tracing::warn!("session `{}` not found", row.auth_session_id);
        revoke_browser_session(&relay_browser_session_repo, row.id).await;
        return Err(StatusCode::UNAUTHORIZED.into_response());
    };

    if row.session_revoked_at.is_some() {
        tracing::warn!("session `{}` rejected (revoked)", row.auth_session_id);
        revoke_browser_session(&relay_browser_session_repo, row.id).await;
        return Err(StatusCode::UNAUTHORIZED.into_response());
    }

    let last_activity_at = row.session_last_used_at.unwrap_or(session_created_at);
    if now.signed_duration_since(last_activity_at) > MAX_SESSION_INACTIVITY_DURATION {
        tracing::warn!(
            "session `{}` expired due to inactivity; revoking",
            row.auth_session_id
        );
        if let Err(error) = AuthSessionRepository::new(&state.pool)
            .revoke(row.auth_session_id)
            .await
        {
            tracing::warn!(?error, "failed to revoke inactive session");
        }
        revoke_browser_session(&relay_browser_session_repo, row.id).await;
        return Err(StatusCode::UNAUTHORIZED.into_response());
    }

    if session_user_id != row.user_id {
        tracing::warn!(
            relay_browser_session_user_id = %row.user_id,
            auth_session_user_id = %session_user_id,
            relay_browser_session_id = %row.id,
            "relay browser session user mismatch"
        );
        return Err(StatusCode::UNAUTHORIZED.into_response());
    }

    if !row.host_allowed {
        return Err((StatusCode::FORBIDDEN, "Host access denied").into_response());
    }

    if day_changed(row.session_last_used_at, now)
        && let Err(error) = AuthSessionRepository::new(&state.pool)
            .touch(row.auth_session_id)
            .await
    {
        tracing::warn!(?error, "failed to update session last-used timestamp");
    }

    if day_changed(row.last_used_at, now)
        && let Err(error) = relay_browser_session_repo.touch(row.id).await
    {
        tracing::debug!(
            ?error,
            relay_browser_session_id = %row.id,
            "failed to update relay browser session last-used timestamp"
        );
    }

    Ok(())
}

/// `touch` writes `date_trunc('day', NOW())`; skip the round trip when the
/// stored day is already today.
fn day_changed(last_used_at: Option<DateTime<Utc>>, now: DateTime<Utc>) -> bool {
    last_used_at.is_none_or(|t| t.date_naive() < now.date_naive())
}

async fn revoke_browser_session(repo: &RelayBrowserSessionRepository<'_>, id: Uuid) {
    if let Err(error) = repo.revoke(id).await {
        tracing::warn!(?error, "failed to revoke relay browser session");
    }
}

async fn do_relay_proxy_for_host(
    state: &RelayAppState,
    host_id: Uuid,
    browser_session_id: Uuid,
    request: Request,
) -> Response {
    let relay = match state.relay_registry.get(&host_id).await {
        Some(relay) => relay,
        None => return (StatusCode::NOT_FOUND, "No active relay").into_response(),
    };

    let strip_prefix = format!("{RELAY_PROXY_PREFIX}/{host_id}/s/{browser_session_id}");
    proxy_request_over_control(relay.control.as_ref(), request, &strip_prefix).await
}
