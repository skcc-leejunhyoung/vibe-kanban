//! Owners can prepare grants while a host still uses pairing. Grants only
//! authorize account-mode discovery; protocol activation is a separate migration.

use api_types::{
    ChangeHostAccessRequest, HostAccessGrant, HostAccessPolicy, HostAuthMode, MutationResponse,
};
use chrono::{DateTime, Duration, Utc};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use super::auth::MAX_SESSION_INACTIVITY_DURATION;

#[derive(Debug, thiserror::Error)]
pub enum HostAccessError {
    #[error("Host not found")]
    HostNotFound,
    #[error("Account not found")]
    AccountNotFound,
    #[error("Account session is no longer valid")]
    AccountSessionRevoked,
    #[error("Sign in again before granting host access")]
    ReauthenticationRequired,
    #[error("The host owner's access cannot be changed")]
    OwnerAccessImmutable,
    #[error("The host authentication generation has changed")]
    HostGenerationConflict,
    #[error("The account's host access has changed; reload before retrying")]
    GrantVersionConflict,
    #[error("The host authentication mode is being changed")]
    HostTransitionInProgress,
    #[error("Host generation must be positive and grant version must be nonnegative")]
    InvalidAccessVersion,
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

#[derive(sqlx::FromRow)]
struct OwnerHost {
    id: Uuid,
    owner_user_id: Uuid,
    auth_mode: HostAuthMode,
    auth_generation: i32,
    remote_access_enabled: bool,
}

pub struct HostAccessRepository<'a> {
    pool: &'a PgPool,
}

impl<'a> HostAccessRepository<'a> {
    pub fn new(pool: &'a PgPool) -> Self {
        Self { pool }
    }

    pub async fn list(
        &self,
        host_id: Uuid,
        actor_id: Uuid,
        session_id: Uuid,
    ) -> Result<HostAccessPolicy, HostAccessError> {
        let mut tx = super::begin_tx(self.pool).await?;
        let host = lock_owned_host(&mut tx, host_id, actor_id).await?;
        validate_session(&mut tx, actor_id, session_id, false).await?;
        let grants = sqlx::query_as::<_, HostAccessGrant>(
            "SELECT host_id, user_id, granted_by, version, created_at, updated_at, revoked_at
             FROM host_access_grants WHERE host_id = $1 ORDER BY created_at, user_id",
        )
        .bind(host_id)
        .fetch_all(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(HostAccessPolicy {
            host_id: host.id,
            owner_user_id: host.owner_user_id,
            auth_mode: host.auth_mode,
            auth_generation: host.auth_generation,
            remote_access_enabled: host.remote_access_enabled,
            grants,
        })
    }

    pub async fn change(
        &self,
        host_id: Uuid,
        actor_id: Uuid,
        session_id: Uuid,
        user_id: Uuid,
        request: &ChangeHostAccessRequest,
        grant_access: bool,
    ) -> Result<MutationResponse<HostAccessGrant>, HostAccessError> {
        if request.expected_host_generation <= 0 || request.expected_version < 0 {
            return Err(HostAccessError::InvalidAccessVersion);
        }
        let mut tx = super::begin_tx(self.pool).await?;
        // Serialize grants and revocations with each other and with host migration.
        let host = lock_owned_host(&mut tx, host_id, actor_id).await?;
        validate_session(&mut tx, actor_id, session_id, grant_access).await?;
        if user_id == host.owner_user_id {
            return Err(HostAccessError::OwnerAccessImmutable);
        }
        if request.expected_host_generation != host.auth_generation {
            return Err(HostAccessError::HostGenerationConflict);
        }
        if grant_access && host.auth_mode == HostAuthMode::Migrating {
            return Err(HostAccessError::HostTransitionInProgress);
        }
        let user_exists = sqlx::query_scalar::<_, Uuid>(
            "SELECT id FROM users WHERE id = $1 AND (NOT $2 OR suspended_at IS NULL) FOR SHARE",
        )
        .bind(user_id)
        .bind(grant_access)
        .fetch_optional(&mut *tx)
        .await?
        .is_some();
        if !user_exists {
            return Err(HostAccessError::AccountNotFound);
        }
        let current = sqlx::query_as::<_, HostAccessGrant>(
            "SELECT host_id, user_id, granted_by, version, created_at, updated_at, revoked_at
             FROM host_access_grants WHERE host_id = $1 AND user_id = $2",
        )
        .bind(host_id)
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await?;
        if current.as_ref().map_or(0, |grant| grant.version) != request.expected_version {
            return Err(HostAccessError::GrantVersionConflict);
        }

        let unchanged = current
            .as_ref()
            .is_some_and(|grant| grant.revoked_at.is_none() == grant_access);
        let data = if unchanged {
            current.expect("unchanged grant exists")
        } else {
            // A revoke of an absent grant leaves a tombstone to reject delayed PUTs.
            sqlx::query_as::<_, HostAccessGrant>(
                "INSERT INTO host_access_grants (host_id, user_id, granted_by, revoked_at)
                 VALUES ($1, $2, CASE WHEN $4 THEN $3 ELSE NULL END,
                         CASE WHEN $4 THEN NULL ELSE clock_timestamp() END)
                 ON CONFLICT (host_id, user_id) DO UPDATE SET
                     granted_by = CASE WHEN $4 THEN $3 ELSE host_access_grants.granted_by END,
                     version = host_access_grants.version + 1,
                     updated_at = clock_timestamp(),
                     revoked_at = CASE WHEN $4 THEN NULL ELSE clock_timestamp() END
                 RETURNING host_id, user_id, granted_by, version, created_at, updated_at, revoked_at",
            )
            .bind(host_id)
            .bind(user_id)
            .bind(actor_id)
            .bind(grant_access)
            .fetch_one(&mut *tx)
            .await?
        };
        if !grant_access {
            // A later re-grant must not revive any session issued before revocation.
            sqlx::query(
                "UPDATE relay_browser_sessions SET revoked_at = clock_timestamp()
                 WHERE host_id = $1 AND user_id = $2 AND revoked_at IS NULL",
            )
            .bind(host_id)
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        }
        super::host_connections::audit(
            &mut tx,
            host_id,
            actor_id,
            Some(user_id),
            if grant_access {
                "host.access_granted"
            } else {
                "host.access_revoked"
            },
        )
        .await?;
        let txid = super::get_txid(&mut *tx).await?;
        tx.commit().await?;
        Ok(MutationResponse { data, txid })
    }
}

async fn lock_owned_host(
    tx: &mut Transaction<'_, Postgres>,
    host_id: Uuid,
    actor_id: Uuid,
) -> Result<OwnerHost, HostAccessError> {
    sqlx::query_as::<_, OwnerHost>(
        "SELECT id, owner_user_id, auth_mode, auth_generation, remote_access_enabled
         FROM hosts WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL FOR UPDATE",
    )
    .bind(host_id)
    .bind(actor_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(HostAccessError::HostNotFound)
}

pub(crate) async fn validate_session(
    tx: &mut Transaction<'_, Postgres>,
    actor_id: Uuid,
    session_id: Uuid,
    require_recent_login: bool,
) -> Result<(), HostAccessError> {
    if sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM users WHERE id = $1 AND suspended_at IS NULL FOR SHARE",
    )
    .bind(actor_id)
    .fetch_optional(&mut **tx)
    .await?
    .is_none()
    {
        return Err(HostAccessError::AccountSessionRevoked);
    }
    #[derive(sqlx::FromRow)]
    struct Session {
        created_at: DateTime<Utc>,
        last_used_at: Option<DateTime<Utc>>,
        revoked_at: Option<DateTime<Utc>>,
        authenticated_at: Option<DateTime<Utc>>,
    }
    // Recheck the database, including on cache hits; a concurrent logout waits
    // for this transaction, so it cannot commit before a newly added grant.
    let session = sqlx::query_as::<_, Session>(
        "SELECT created_at, last_used_at, revoked_at, authenticated_at
         FROM auth_sessions WHERE id = $1 AND user_id = $2 FOR SHARE",
    )
    .bind(session_id)
    .bind(actor_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(HostAccessError::AccountSessionRevoked)?;
    // Compare database-issued times against the same clock after acquiring the lock.
    let now = sqlx::query_scalar::<_, DateTime<Utc>>("SELECT clock_timestamp()")
        .fetch_one(&mut **tx)
        .await?;
    if session.revoked_at.is_some()
        || now.signed_duration_since(session.last_used_at.unwrap_or(session.created_at))
            > MAX_SESSION_INACTIVITY_DURATION
    {
        return Err(HostAccessError::AccountSessionRevoked);
    }
    if require_recent_login
        && !session.authenticated_at.is_some_and(|at| {
            let age = now.signed_duration_since(at);
            age >= Duration::zero() && age <= Duration::minutes(5)
        })
    {
        return Err(HostAccessError::ReauthenticationRequired);
    }
    Ok(())
}
