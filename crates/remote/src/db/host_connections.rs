use api_types::MutationResponse;
use chrono::{DateTime, Utc};
use relay_control::account::{HostGrantSigner, credential_hash, grant_kind, thumbprint};
use relay_types::*;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use super::host_access::{HostAccessError, validate_session};

#[derive(Debug, thiserror::Error)]
pub enum AccountError {
    #[error(transparent)]
    Access(#[from] HostAccessError),
    #[error("Invalid account host request")]
    InvalidRequest,
    #[error("Host credential is invalid or expired")]
    HostCredentialRevoked,
    #[error("This host is unavailable or access was revoked")]
    HostAccessDenied,
    #[error("Host connection has expired")]
    HostConnectionExpired,
    #[error("Host registration or connection has changed")]
    Conflict,
    #[error("Account host access is not configured")]
    Disabled,
    #[error("Control plane unavailable")]
    Database(#[from] sqlx::Error),
}

pub fn spawn_retention(pool: PgPool) {
    tokio::spawn(async move {
        loop {
            let result=sqlx::query("DELETE FROM host_access_audit WHERE created_at<clock_timestamp()-INTERVAL '30 days'").execute(&pool).await;
            if let Err(error) = result {
                tracing::warn!(?error, "Host audit retention deferred");
            }
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
        }
    });
}

#[derive(sqlx::FromRow)]
pub struct AccountHost {
    pub id: Uuid,
    pub owner_user_id: Uuid,
    pub auth_generation: i32,
    pub auth_mode: String,
    pub remote_access_enabled: bool,
    pub transition_request_id: Option<Uuid>,
}

pub async fn audit(
    tx: &mut Transaction<'_, Postgres>,
    host: Uuid,
    actor: Uuid,
    target: Option<Uuid>,
    action: &str,
) -> Result<(), sqlx::Error> {
    let request_id = super::TX_CONTEXT
        .try_with(|ctx| {
            ctx.as_ref()
                .map(|ctx| ctx.request_id.clone())
                .unwrap_or_default()
        })
        .unwrap_or_default();
    sqlx::query("INSERT INTO host_access_audit (host_id, actor_id, target_id, action, result, request_id) VALUES ($1,$2,$3,$4,'allowed',$5)")
        .bind(host).bind(actor).bind(target).bind(action).bind(request_id).execute(&mut **tx).await?;
    // NOTIFY is delivered only after commit. Polling/leases remain authoritative.
    sqlx::query("SELECT pg_notify('host_access_changed', $1)")
        .bind(host.to_string())
        .execute(&mut **tx)
        .await?;
    sqlx::query(
        "DELETE FROM host_access_audit WHERE created_at < clock_timestamp() - INTERVAL '30 days'",
    )
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn finish<T>(
    mut tx: Transaction<'_, Postgres>,
    data: T,
) -> Result<MutationResponse<T>, AccountError> {
    let txid = super::get_txid(&mut *tx).await?;
    tx.commit().await?;
    Ok(MutationResponse { data, txid })
}

pub async fn lock_host(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<AccountHost, AccountError> {
    sqlx::query_as::<_, AccountHost>("SELECT id, owner_user_id, auth_generation, auth_mode, remote_access_enabled, transition_request_id FROM hosts WHERE id=$1 AND deleted_at IS NULL FOR UPDATE")
        .bind(id).fetch_optional(&mut **tx).await?.ok_or(HostAccessError::HostNotFound.into())
}

/// This authentication path is used only by host operations, never user routes.
pub async fn credential_host(
    tx: &mut Transaction<'_, Postgres>,
    secret: &str,
) -> Result<AccountHost, AccountError> {
    let hash = credential_hash(secret).map_err(|_| AccountError::HostCredentialRevoked)?;
    let id: Uuid = sqlx::query_scalar("SELECT host_id FROM host_credentials WHERE secret_hash=$1")
        .bind(&hash)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(AccountError::HostCredentialRevoked)?;
    let host = lock_host(tx, id).await?;
    let accepted: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM host_credentials c JOIN users u ON u.id=$3 WHERE c.host_id=$1 AND c.secret_hash=$2 AND c.generation=$4 AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at>clock_timestamp()) AND c.last_used_at>clock_timestamp()-INTERVAL '90 days' AND u.suspended_at IS NULL)")
        .bind(id).bind(&hash).bind(host.owner_user_id).bind(host.auth_generation).fetch_one(&mut **tx).await?;
    if !accepted {
        return Err(AccountError::HostCredentialRevoked);
    }
    sqlx::query("UPDATE host_credentials SET last_used_at=clock_timestamp() WHERE secret_hash=$1")
        .bind(hash)
        .execute(&mut **tx)
        .await?;
    Ok(host)
}

pub async fn register(
    pool: &PgPool,
    actor: Uuid,
    session: Uuid,
    request: RegisterAccountHostRequest,
) -> Result<MutationResponse<AccountHostRegistration>, AccountError> {
    HostGrantSigner::from_env().map_err(|_| AccountError::Disabled)?;
    let hash = credential_hash(&request.credential).map_err(|_| AccountError::InvalidRequest)?;
    if request.name.trim().is_empty()
        || request.name.chars().count() > 100
        || request.machine_id.is_empty()
        || request.machine_id.len() > 200
        || !request.capabilities.iter().any(|c| c == ACCOUNT_PROTOCOL)
    {
        return Err(AccountError::InvalidRequest);
    }
    let mut tx = super::begin_tx(pool).await?;
    // Serializes first registrations of the same installation before its row exists.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("{actor}:{}", request.machine_id))
        .execute(&mut *tx)
        .await?;
    let id: Uuid = sqlx::query_scalar("INSERT INTO hosts (owner_user_id,machine_id,name) VALUES ($1,$2,$3) ON CONFLICT (owner_user_id,machine_id) DO UPDATE SET machine_id=EXCLUDED.machine_id RETURNING id")
        .bind(actor).bind(&request.machine_id).bind(request.name.trim()).fetch_one(&mut *tx).await?;
    let host=sqlx::query_as::<_,AccountHost>("SELECT id,owner_user_id,auth_generation,auth_mode,remote_access_enabled,transition_request_id FROM hosts WHERE id=$1 FOR UPDATE")
        .bind(id).fetch_one(&mut *tx).await?;
    validate_session(&mut tx, actor, session, true).await?;
    if let Some(transition) = host
        .transition_request_id
        .filter(|transition| *transition == request.request_id)
    {
        let matches: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM host_credentials WHERE host_id=$1 AND request_id=$2 AND secret_hash=$3 AND revoked_at IS NULL)")
            .bind(id).bind(transition).bind(&hash).fetch_one(&mut *tx).await?;
        if !matches {
            return Err(AccountError::Conflict);
        }
        return finish(
            tx,
            AccountHostRegistration {
                host_id: id,
                owner_user_id: actor,
                generation: host.auth_generation,
                transition_request_id: transition,
                auth_mode: host.auth_mode,
            },
        )
        .await;
    }
    if (host.transition_request_id.is_some() || request.expected_generation.is_some())
        && request.expected_generation != Some(host.auth_generation)
    {
        return Err(AccountError::Conflict);
    }
    let generation = host
        .auth_generation
        .checked_add(1)
        .ok_or(AccountError::Conflict)?;
    sqlx::query("UPDATE hosts SET auth_mode='migrating',auth_generation=$2,transition_request_id=$3,capabilities=$4,remote_access_enabled=FALSE,deleted_at=NULL,status='offline',relay_connection_id=NULL,relay_lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1")
        .bind(id).bind(generation).bind(request.request_id).bind(&request.capabilities).execute(&mut *tx).await?;
    sqlx::query("UPDATE relay_browser_sessions SET revoked_at=clock_timestamp() WHERE host_id=$1 AND revoked_at IS NULL").bind(id).execute(&mut *tx).await?;
    sqlx::query("UPDATE host_credentials SET revoked_at=clock_timestamp() WHERE host_id=$1 AND revoked_at IS NULL").bind(id).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO host_credentials (id,host_id,secret_hash,generation,request_id) VALUES ($1,$2,$3,$4,$5)")
        .bind(Uuid::new_v4()).bind(id).bind(hash).bind(generation).bind(request.request_id).execute(&mut *tx).await?;
    audit(&mut tx, id, actor, None, "host.registration_started").await?;
    finish(
        tx,
        AccountHostRegistration {
            host_id: id,
            owner_user_id: actor,
            generation,
            transition_request_id: request.request_id,
            auth_mode: "migrating".into(),
        },
    )
    .await
}

pub async fn activate(
    pool: &PgPool,
    secret: &str,
    request: ActivateAccountHostRequest,
) -> Result<MutationResponse<AccountHostRegistration>, AccountError> {
    let mut tx = super::begin_tx(pool).await?;
    let host = credential_host(&mut tx, secret).await?;
    if host.transition_request_id != Some(request.transition_request_id)
        || host.auth_generation != request.generation
        || !request.capabilities.iter().any(|c| c == ACCOUNT_PROTOCOL)
    {
        return Err(AccountError::Conflict);
    }
    if host.auth_mode == "migrating" {
        sqlx::query("UPDATE hosts SET auth_mode='account',remote_access_enabled=TRUE,registered_at=clock_timestamp(),capabilities=$2,updated_at=clock_timestamp() WHERE id=$1")
            .bind(host.id).bind(request.capabilities).execute(&mut *tx).await?;
        audit(
            &mut tx,
            host.id,
            host.owner_user_id,
            None,
            "host.registration_activated",
        )
        .await?;
    } else if host.auth_mode != "account" {
        return Err(AccountError::Conflict);
    }
    finish(
        tx,
        AccountHostRegistration {
            host_id: host.id,
            owner_user_id: host.owner_user_id,
            generation: host.auth_generation,
            transition_request_id: request.transition_request_id,
            auth_mode: "account".into(),
        },
    )
    .await
}

pub async fn rotate(
    pool: &PgPool,
    secret: &str,
    request: RotateHostCredentialRequest,
) -> Result<MutationResponse<Uuid>, AccountError> {
    let hash = credential_hash(&request.credential).map_err(|_| AccountError::InvalidRequest)?;
    let old_hash = credential_hash(secret).map_err(|_| AccountError::HostCredentialRevoked)?;
    if hash == old_hash {
        return Err(AccountError::InvalidRequest);
    }
    let mut tx = super::begin_tx(pool).await?;
    let host = credential_host(&mut tx, secret).await?;
    let previous: Option<(Uuid, String)> =
        sqlx::query_as("SELECT host_id,secret_hash FROM host_credentials WHERE request_id=$1")
            .bind(request.request_id)
            .fetch_optional(&mut *tx)
            .await?;
    if let Some((id, existing)) = previous {
        if id != host.id || existing != hash {
            return Err(AccountError::Conflict);
        }
    } else {
        sqlx::query("UPDATE host_credentials SET expires_at=LEAST(COALESCE(expires_at,'infinity'),clock_timestamp()+INTERVAL '2 minutes') WHERE host_id=$1 AND revoked_at IS NULL")
            .bind(host.id).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO host_credentials (id,host_id,secret_hash,generation,request_id) VALUES ($1,$2,$3,$4,$5)")
            .bind(Uuid::new_v4()).bind(host.id).bind(hash).bind(host.auth_generation).bind(request.request_id).execute(&mut *tx).await?;
        audit(
            &mut tx,
            host.id,
            host.owner_user_id,
            None,
            "host.credential_rotated",
        )
        .await?;
    }
    finish(tx, request.request_id).await
}

pub async fn open_connection(
    pool: &PgPool,
    actor: Uuid,
    session: Uuid,
    host_id: Uuid,
    request: OpenHostConnectionRequest,
) -> Result<MutationResponse<HostConnectionApproval>, AccountError> {
    let key_thumbprint =
        thumbprint(&request.public_key_b64).map_err(|_| AccountError::InvalidRequest)?;
    let signer = HostGrantSigner::from_env().map_err(|_| AccountError::Disabled)?;
    let mut tx = super::begin_tx(pool).await?;
    let host = lock_host(&mut tx, host_id).await?;
    validate_session(&mut tx, actor, session, false).await?;
    let role: Option<String> = sqlx::query_scalar("SELECT host_access_role($1,$2)")
        .bind(host_id)
        .bind(actor)
        .fetch_one(&mut *tx)
        .await?;
    if host.auth_mode != "account" || !host.remote_access_enabled || role.is_none() {
        return Err(AccountError::HostAccessDenied);
    }
    let version: i32 = if actor == host.owner_user_id {
        0
    } else {
        sqlx::query_scalar("SELECT version FROM host_access_grants WHERE host_id=$1 AND user_id=$2 AND revoked_at IS NULL").bind(host_id).bind(actor).fetch_one(&mut *tx).await?
    };
    let connection_id = if let Some(id) = request.connection_id {
        let valid: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM relay_browser_sessions WHERE id=$1 AND host_id=$2 AND user_id=$3 AND auth_session_id=$4 AND public_key_b64=$5 AND host_generation=$6 AND grant_version=$7 AND revoked_at IS NULL)")
            .bind(id).bind(host_id).bind(actor).bind(session).bind(&request.public_key_b64).bind(host.auth_generation).bind(version).fetch_one(&mut *tx).await?;
        if !valid {
            return Err(AccountError::HostConnectionExpired);
        }
        id
    } else {
        Uuid::new_v4()
    };
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut *tx)
        .await?;
    let expires_at = now + chrono::Duration::seconds(ACCOUNT_GRANT_TTL_SECS);
    sqlx::query("INSERT INTO relay_browser_sessions (id,host_id,user_id,auth_session_id,public_key_b64,grant_version,host_generation,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET expires_at=EXCLUDED.expires_at")
        .bind(connection_id).bind(host_id).bind(actor).bind(session).bind(&request.public_key_b64).bind(version).bind(host.auth_generation).bind(expires_at).execute(&mut *tx).await?;
    let claims = HostGrantClaims {
        issuer: signer.issuer().into(),
        kind: grant_kind().into(),
        audience: host_id,
        user_id: actor,
        auth_session_id: session,
        host_generation: host.auth_generation,
        grant_version: version,
        public_key_b64: request.public_key_b64,
        public_key_thumbprint: key_thumbprint,
        issued_at: now.timestamp(),
        expires_at: expires_at.timestamp(),
        jti: connection_id,
    };
    let grant = signer.sign(&claims).map_err(|_| AccountError::Disabled)?;
    if request.connection_id.is_none() {
        audit(
            &mut tx,
            host_id,
            actor,
            Some(connection_id),
            "host.connection_opened",
        )
        .await?;
    }
    finish(
        tx,
        HostConnectionApproval {
            connection_id,
            grant,
            expires_at,
        },
    )
    .await
}

pub async fn renew(
    pool: &PgPool,
    secret: &str,
    request: RenewHostConnectionsRequest,
) -> Result<RenewHostConnectionsResponse, AccountError> {
    if request.connections.len() > 256 {
        return Err(AccountError::InvalidRequest);
    }
    let mut tx = super::begin_tx(pool).await?;
    let host = credential_host(&mut tx, secret).await?;
    if !host.remote_access_enabled || host.auth_mode != "account" {
        return Err(AccountError::HostAccessDenied);
    }
    let mut leases = Vec::new();
    for id in request.connections {
        let identity: Option<(Uuid, Uuid)> = sqlx::query_as(
            "SELECT user_id,auth_session_id FROM relay_browser_sessions WHERE id=$1 AND host_id=$2",
        )
        .bind(id)
        .bind(host.id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some((user, session)) = identity else {
            continue;
        };
        if let Err(error) = validate_session(&mut tx, user, session, false).await {
            if let HostAccessError::Database(error) = error {
                return Err(error.into());
            }
            continue;
        }
        let row: Option<(String,i32,i32,i64)> = sqlx::query_as("UPDATE relay_browser_sessions SET lease_expires_at=LEAST(expires_at,clock_timestamp()+INTERVAL '60 seconds'),last_used_at=clock_timestamp() WHERE id=$1 AND host_connection_allowed(id,$2) RETURNING public_key_b64,host_generation,grant_version,GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (lease_expires_at-clock_timestamp()))))::bigint")
            .bind(id).bind(host.id).fetch_optional(&mut *tx).await?;
        if let Some((public_key_b64, host_generation, grant_version, seconds)) = row {
            leases.push(HostConnectionLease {
                connection_id: id,
                public_key_b64,
                user_id: user,
                auth_session_id: session,
                host_generation,
                grant_version,
                remaining_seconds: seconds.min(60) as u32,
            });
        }
    }
    tx.commit().await?;
    Ok(RenewHostConnectionsResponse { leases })
}

pub async fn change_state(
    pool: &PgPool,
    host_id: Uuid,
    actor: Uuid,
    session: Uuid,
    request: ChangeHostStateRequest,
    unregister: bool,
) -> Result<MutationResponse<()>, AccountError> {
    let mut tx = super::begin_tx(pool).await?;
    let host = lock_host(&mut tx, host_id).await?;
    if host.owner_user_id != actor {
        return Err(HostAccessError::HostNotFound.into());
    }
    validate_session(&mut tx, actor, session, false).await?;
    if host.auth_generation != request.expected_generation {
        return Err(AccountError::Conflict);
    }
    if request.remote_access_enabled && host.auth_mode != "account" {
        return Err(AccountError::Conflict);
    }
    sqlx::query("UPDATE hosts SET remote_access_enabled=$2,deleted_at=CASE WHEN $3 THEN clock_timestamp() ELSE deleted_at END,updated_at=clock_timestamp() WHERE id=$1")
        .bind(host_id).bind(request.remote_access_enabled && !unregister).bind(unregister).execute(&mut *tx).await?;
    if !request.remote_access_enabled || unregister {
        sqlx::query("UPDATE relay_browser_sessions SET revoked_at=clock_timestamp() WHERE host_id=$1 AND revoked_at IS NULL").bind(host_id).execute(&mut *tx).await?;
    }
    if unregister {
        sqlx::query("UPDATE host_credentials SET revoked_at=clock_timestamp() WHERE host_id=$1 AND revoked_at IS NULL").bind(host_id).execute(&mut *tx).await?;
        sqlx::query("UPDATE host_access_grants SET revoked_at=clock_timestamp(),version=version+1 WHERE host_id=$1 AND revoked_at IS NULL").bind(host_id).execute(&mut *tx).await?;
    }
    audit(
        &mut tx,
        host_id,
        actor,
        None,
        if unregister {
            "host.unregistered"
        } else if request.remote_access_enabled {
            "host.enabled"
        } else {
            "host.disabled"
        },
    )
    .await?;
    finish(tx, ()).await
}

pub async fn terminate_connection(
    pool: &PgPool,
    host_id: Uuid,
    actor: Uuid,
    session: Uuid,
    connection: Uuid,
) -> Result<MutationResponse<()>, AccountError> {
    let mut tx = super::begin_tx(pool).await?;
    let host = lock_host(&mut tx, host_id).await?;
    validate_session(&mut tx, actor, session, false).await?;
    let changed=sqlx::query("UPDATE relay_browser_sessions SET revoked_at=clock_timestamp() WHERE host_id=$1 AND id=$2 AND ($3 OR user_id=$4)")
        .bind(host_id).bind(connection).bind(host.owner_user_id==actor).bind(actor).execute(&mut *tx).await?;
    if changed.rows_affected() == 0 {
        return Err(HostAccessError::HostNotFound.into());
    }
    audit(
        &mut tx,
        host_id,
        actor,
        Some(connection),
        "host.connection_terminated",
    )
    .await?;
    finish(tx, ()).await
}

pub async fn report_preview_ports(
    pool: &PgPool,
    secret: &str,
    request: ReportPreviewPortsRequest,
) -> Result<MutationResponse<()>, AccountError> {
    if request.ports.len() > 64 || request.ports.iter().any(|p| !(1024..=65535).contains(p)) {
        return Err(AccountError::InvalidRequest);
    }
    let mut tx = super::begin_tx(pool).await?;
    let host = credential_host(&mut tx, secret).await?;
    sqlx::query(
        "UPDATE hosts SET preview_ports=$2,preview_ports_updated_at=clock_timestamp() WHERE id=$1",
    )
    .bind(host.id)
    .bind(request.ports)
    .execute(&mut *tx)
    .await?;
    finish(tx, ()).await
}

pub async fn create_preview(
    pool: &PgPool,
    host_id: Uuid,
    actor: Uuid,
    session: Uuid,
    origin: &str,
    request: CreateHostPreviewRequest,
) -> Result<MutationResponse<CreateHostPreviewResponse>, AccountError> {
    let origin_url = url::Url::parse(origin).map_err(|_| AccountError::InvalidRequest)?;
    if !["http", "https"].contains(&origin_url.scheme())
        || origin_url.origin().ascii_serialization() != origin
    {
        return Err(AccountError::InvalidRequest);
    }
    let suffix = std::env::var("RELAY_PREVIEW_HOST_SUFFIX")
        .ok()
        .filter(|s| {
            !s.is_empty()
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        })
        .ok_or(AccountError::Disabled)?;
    let mut tx = super::begin_tx(pool).await?;
    let host = lock_host(&mut tx, host_id).await?;
    validate_session(&mut tx, actor, session, false).await?;
    let allowed:bool=sqlx::query_scalar("SELECT host_access_role(id,$2) IS NOT NULL AND auth_mode='account' AND remote_access_enabled AND $3=ANY(preview_ports) AND preview_ports_updated_at>clock_timestamp()-INTERVAL '40 seconds' FROM hosts WHERE id=$1")
        .bind(host_id).bind(actor).bind(i32::from(request.port)).fetch_one(&mut *tx).await?;
    if !allowed {
        return Err(AccountError::HostAccessDenied);
    }
    let version: i32 = if actor == host.owner_user_id {
        0
    } else {
        sqlx::query_scalar("SELECT version FROM host_access_grants WHERE host_id=$1 AND user_id=$2 AND revoked_at IS NULL").bind(host_id).bind(actor).fetch_one(&mut *tx).await?
    };
    let connection = Uuid::new_v4();
    sqlx::query("INSERT INTO relay_browser_sessions (id,host_id,user_id,auth_session_id,public_key_b64,grant_version,host_generation,expires_at) VALUES ($1,$2,$3,$4,'',$5,$6,clock_timestamp()+INTERVAL '12 hours')")
        .bind(connection).bind(host_id).bind(actor).bind(session).bind(version).bind(host.auth_generation).execute(&mut *tx).await?;
    let code = relay_control::account::new_credential();
    let hash = credential_hash(&code).map_err(|_| AccountError::InvalidRequest)?;
    sqlx::query("INSERT INTO host_preview_sessions (id,host_id,connection_id,port,app_origin,exchange_hash,exchange_expires_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp()+INTERVAL '30 seconds',clock_timestamp()+INTERVAL '12 hours')")
        .bind(Uuid::new_v4()).bind(host_id).bind(connection).bind(i32::from(request.port)).bind(origin).bind(hash).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM host_preview_sessions WHERE expires_at<clock_timestamp()")
        .execute(&mut *tx)
        .await?;
    audit(
        &mut tx,
        host_id,
        actor,
        Some(connection),
        "host.preview_opened",
    )
    .await?;
    finish(
        tx,
        CreateHostPreviewResponse {
            exchange_url: format!(
                "https://p-{}--{host_id}.{suffix}/__vk/authorize",
                request.port
            ),
            code,
        },
    )
    .await
}

pub async fn authorize_preview(
    pool: &PgPool,
    secret: &str,
    request: AuthorizeHostPreviewRequest,
) -> Result<HostConnectionLease, AccountError> {
    let mut tx = super::begin_tx(pool).await?;
    let host = credential_host(&mut tx, secret).await?;
    let id:Uuid=sqlx::query_scalar("SELECT p.connection_id FROM host_preview_sessions p JOIN hosts h ON h.id=p.host_id WHERE p.id=$1 AND p.host_id=$2 AND p.port=$3 AND p.consumed_at IS NOT NULL AND p.expires_at>clock_timestamp() AND $3=ANY(h.preview_ports) AND h.preview_ports_updated_at>clock_timestamp()-INTERVAL '40 seconds' AND host_connection_allowed(p.connection_id,p.host_id)")
        .bind(request.preview_id).bind(host.id).bind(i32::from(request.port)).fetch_optional(&mut *tx).await?.ok_or(AccountError::HostAccessDenied)?;
    tx.commit().await?;
    let response = renew(
        pool,
        secret,
        RenewHostConnectionsRequest {
            connections: vec![id],
        },
    )
    .await?;
    response
        .leases
        .into_iter()
        .next()
        .ok_or(AccountError::HostAccessDenied)
}
