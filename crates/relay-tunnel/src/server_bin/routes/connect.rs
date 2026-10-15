//! WebSocket control channel handler for local server connections.

use std::sync::Arc;

use axum::{
    Extension,
    extract::{Query, State, ws::WebSocketUpgrade},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use relay_tunnel_core::server::run_control_channel;
use serde::Deserialize;
use uuid::Uuid;

use super::super::{
    auth::RequestContext,
    db::hosts::HostRepository,
    relay_registry::{ActiveRelay, RelayRegistry},
    state::RelayAppState,
};

#[derive(Debug, Deserialize)]
pub struct ConnectQuery {
    pub machine_id: String,
    pub name: String,
    #[serde(default)]
    pub agent_version: Option<String>,
}

/// Local server connects here to establish a relay control channel.
/// The host record is upserted from the authenticated user + machine_id query param.
pub async fn relay_connect(
    State(state): State<RelayAppState>,
    Extension(ctx): Extension<RequestContext>,
    Query(query): Query<ConnectQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    let repo = HostRepository::new(&state.pool);

    let host_id = match repo
        .upsert_host(
            ctx.user.id,
            &query.machine_id,
            &query.name,
            query.agent_version.as_deref(),
        )
        .await
    {
        Ok(Some(id)) => id,
        Ok(None) => {
            return (
                StatusCode::CONFLICT,
                "Host does not accept legacy connections",
            )
                .into_response();
        }
        Err(error) => {
            tracing::error!(?error, "failed to upsert host for relay connect");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    match repo
        .mark_host_online(host_id, query.agent_version.as_deref())
        .await
    {
        Ok(true) => {}
        Ok(false) => {
            return (
                StatusCode::CONFLICT,
                "Host does not accept legacy connections",
            )
                .into_response();
        }
        Err(error) => {
            tracing::warn!(?error, "failed to mark host online");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }

    let registry = state.relay_registry.clone();
    let pool = state.pool.clone();

    ws.on_upgrade(move |socket| async move {
        handle_control_channel(socket, pool, registry, host_id, None, None).await;
    })
}

pub async fn account_relay_connect(
    State(state): State<RelayAppState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let Some(secret) = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Ok(hash) = relay_control::account::credential_hash(secret) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let host:Option<Uuid>=match sqlx::query_scalar("SELECT h.id FROM hosts h JOIN host_credentials c ON c.host_id=h.id JOIN users u ON u.id=h.owner_user_id WHERE c.secret_hash=$1 AND c.revoked_at IS NULL AND c.generation=h.auth_generation AND c.last_used_at>clock_timestamp()-INTERVAL '90 days' AND (c.expires_at IS NULL OR c.expires_at>clock_timestamp()) AND h.auth_mode='account' AND h.deleted_at IS NULL AND u.suspended_at IS NULL")
        .bind(&hash).fetch_optional(&state.pool).await {Ok(id)=>id,Err(_)=>return StatusCode::SERVICE_UNAVAILABLE.into_response()};
    let Some(host_id) = host else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if state.relay_registry.get(&host_id).await.is_some() {
        return (
            StatusCode::CONFLICT,
            "Another installation is already connected",
        )
            .into_response();
    }
    let connection_id = Uuid::new_v4();
    let claimed=sqlx::query("UPDATE hosts SET relay_connection_id=$2,relay_lease_until=clock_timestamp()+INTERVAL '10 seconds' WHERE id=$1 AND (relay_lease_until IS NULL OR relay_lease_until<clock_timestamp())")
        .bind(host_id).bind(connection_id).execute(&state.pool).await;
    match claimed {
        Ok(result) if result.rows_affected() == 1 => {}
        Ok(_) => {
            return (
                StatusCode::CONFLICT,
                "Another installation is already connected",
            )
                .into_response();
        }
        Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
    ws.on_upgrade(move |socket| {
        handle_control_channel(
            socket,
            state.pool,
            state.relay_registry,
            host_id,
            Some(hash),
            Some(connection_id),
        )
    })
}

async fn handle_control_channel(
    socket: axum::extract::ws::WebSocket,
    pool: sqlx::PgPool,
    registry: RelayRegistry,
    host_id: Uuid,
    credential_hash: Option<String>,
    connection_id: Option<Uuid>,
) {
    let registry_for_connect = registry.clone();
    let connected_relay = Arc::new(tokio::sync::Mutex::new(None::<Arc<ActiveRelay>>));
    let connected_relay_for_connect = connected_relay.clone();
    let cancelled = tokio_util::sync::CancellationToken::new();
    let conflict_cancel = cancelled.clone();
    let is_account = credential_hash.is_some();
    let run = run_control_channel(socket, move |control| {
        let registry_for_connect = registry_for_connect.clone();
        let connected_relay_for_connect = connected_relay_for_connect.clone();
        async move {
            let relay = Arc::new(ActiveRelay::new(control));
            if is_account {
                if !registry_for_connect
                    .insert_if_absent(host_id, relay.clone())
                    .await
                {
                    conflict_cancel.cancel();
                    return;
                }
            } else {
                registry_for_connect.insert(host_id, relay.clone()).await;
            }
            *connected_relay_for_connect.lock().await = Some(relay);
            tracing::debug!(%host_id, "Relay control channel connected");
        }
    });
    let monitor = async {
        let mut deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        loop {
            let started = std::time::Instant::now();
            let remaining = deadline
                .saturating_duration_since(started)
                .min(std::time::Duration::from_secs(2));
            let result=tokio::time::timeout(remaining,sqlx::query_scalar::<_,bool>(
                "SELECT EXISTS(SELECT 1 FROM hosts h JOIN users u ON u.id=h.owner_user_id WHERE h.id=$1 AND h.deleted_at IS NULL AND u.suspended_at IS NULL AND ($3::uuid IS NULL OR h.relay_connection_id=$3) AND (($2::text IS NULL AND h.auth_mode='legacy_pairing' AND h.remote_access_enabled) OR ($2 IS NOT NULL AND h.auth_mode='account' AND EXISTS(SELECT 1 FROM host_credentials c WHERE c.host_id=h.id AND c.secret_hash=$2 AND c.generation=h.auth_generation AND c.revoked_at IS NULL AND c.last_used_at>clock_timestamp()-INTERVAL '90 days' AND (c.expires_at IS NULL OR c.expires_at>clock_timestamp())))))")
                .bind(host_id).bind(&credential_hash).bind(connection_id).fetch_one(&pool)).await;
            match result {
                Ok(Ok(true)) => {
                    deadline = started + std::time::Duration::from_secs(60);
                    let _=tokio::time::timeout(std::time::Duration::from_secs(2), async {
                        sqlx::query("UPDATE hosts SET status='online',last_seen_at=clock_timestamp(),relay_lease_until=CASE WHEN $2::uuid IS NOT NULL THEN clock_timestamp()+INTERVAL '10 seconds' ELSE relay_lease_until END WHERE id=$1 AND ($2 IS NULL OR relay_connection_id=$2)")
                            .bind(host_id).bind(connection_id).execute(&pool).await?;
                        if let Some(hash)=&credential_hash {sqlx::query("UPDATE host_credentials SET last_used_at=clock_timestamp() WHERE secret_hash=$1").bind(hash).execute(&pool).await?;}
                        Ok::<_,sqlx::Error>(())
                    }).await;
                }
                Ok(Ok(false)) => break,
                _ if std::time::Instant::now() >= deadline => break,
                _ => {}
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    };
    let run_result = tokio::select! {
        result=run=>result,
        _=monitor=>Ok(()),
        _=cancelled.cancelled()=>Ok(()),
    };

    if let Err(error) = run_result {
        tracing::warn!(?error, %host_id, "relay session error");
    }

    let should_mark_offline = if let Some(relay) = connected_relay.lock().await.clone() {
        registry.remove_if_same(&host_id, &relay).await
    } else {
        registry.get(&host_id).await.is_none()
    };

    let repo = HostRepository::new(&pool);
    if let Some(connection_id) = connection_id {
        let _=tokio::time::timeout(std::time::Duration::from_secs(2), sqlx::query("UPDATE hosts SET status='offline',relay_connection_id=NULL,relay_lease_until=NULL WHERE id=$1 AND relay_connection_id=$2").bind(host_id).bind(connection_id).execute(&pool)).await;
    } else if should_mark_offline {
        if let Err(error) = repo.mark_host_offline(host_id).await {
            tracing::warn!(?error, "failed to mark host offline");
        }
    } else {
        tracing::debug!(
            %host_id,
            "Relay control channel disconnected; keeping host online because a newer channel is active"
        );
    }
    tracing::debug!(%host_id, "Relay control channel disconnected");
}
