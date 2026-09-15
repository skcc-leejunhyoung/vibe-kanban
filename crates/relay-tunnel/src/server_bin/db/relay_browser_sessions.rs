use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct RelayBrowserSession {
    pub id: Uuid,
    pub host_id: Uuid,
    pub user_id: Uuid,
    pub auth_session_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
}

/// One-query view of a relay browser session plus its auth session and host
/// access, produced by [`RelayBrowserSessionRepository::get_for_proxy`].
#[derive(Debug)]
pub struct ProxyAuthRow {
    pub id: Uuid,
    pub host_id: Uuid,
    pub user_id: Uuid,
    pub auth_session_id: Uuid,
    pub last_used_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub session_user_id: Option<Uuid>,
    pub session_created_at: Option<DateTime<Utc>>,
    pub session_last_used_at: Option<DateTime<Utc>>,
    pub session_revoked_at: Option<DateTime<Utc>>,
    pub host_allowed: bool,
}

pub struct RelayBrowserSessionRepository<'a> {
    pool: &'a PgPool,
}

impl<'a> RelayBrowserSessionRepository<'a> {
    pub fn new(pool: &'a PgPool) -> Self {
        Self { pool }
    }

    pub async fn create(
        &self,
        host_id: Uuid,
        user_id: Uuid,
        auth_session_id: Uuid,
    ) -> Result<RelayBrowserSession, sqlx::Error> {
        sqlx::query_as!(
            RelayBrowserSession,
            r#"
            INSERT INTO relay_browser_sessions (host_id, user_id, auth_session_id)
            VALUES ($1, $2, $3)
            RETURNING
                id              AS "id!: Uuid",
                host_id         AS "host_id!: Uuid",
                user_id         AS "user_id!: Uuid",
                auth_session_id AS "auth_session_id!: Uuid",
                created_at,
                last_used_at,
                revoked_at
            "#,
            host_id,
            user_id,
            auth_session_id
        )
        .fetch_one(self.pool)
        .await
    }

    /// Everything the proxy path needs to authorise one request, in a single
    /// round trip: the browser session, its auth session, and whether that
    /// session's user may reach `host_id`. `session_*` columns are `None`
    /// when the auth session row no longer exists.
    pub async fn get_for_proxy(
        &self,
        session_id: Uuid,
        host_id: Uuid,
    ) -> Result<Option<ProxyAuthRow>, sqlx::Error> {
        sqlx::query_as!(
            ProxyAuthRow,
            r#"
            SELECT
                rbs.id              AS "id!: Uuid",
                rbs.host_id         AS "host_id!: Uuid",
                rbs.user_id         AS "user_id!: Uuid",
                rbs.auth_session_id AS "auth_session_id!: Uuid",
                rbs.last_used_at    AS "last_used_at?",
                rbs.revoked_at      AS "revoked_at?",
                s.user_id           AS "session_user_id?: Uuid",
                s.created_at        AS "session_created_at?",
                s.last_used_at      AS "session_last_used_at?",
                s.revoked_at        AS "session_revoked_at?",
                EXISTS (
                    SELECT 1
                    FROM hosts h
                    LEFT JOIN organization_member_metadata om
                        ON om.organization_id = h.shared_with_organization_id
                        AND om.user_id = s.user_id
                    WHERE h.id = $2
                      AND (h.owner_user_id = s.user_id OR om.user_id IS NOT NULL)
                ) AS "host_allowed!"
            FROM relay_browser_sessions rbs
            LEFT JOIN auth_sessions s ON s.id = rbs.auth_session_id
            WHERE rbs.id = $1
            "#,
            session_id,
            host_id
        )
        .fetch_optional(self.pool)
        .await
    }

    pub async fn touch(&self, session_id: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query!(
            r#"
            UPDATE relay_browser_sessions
            SET last_used_at = date_trunc('day', NOW())
            WHERE id = $1
              AND (
                last_used_at IS NULL
                OR last_used_at < date_trunc('day', NOW())
              )
            "#,
            session_id
        )
        .execute(self.pool)
        .await?;
        Ok(())
    }

    pub async fn revoke(&self, session_id: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query!(
            r#"
            UPDATE relay_browser_sessions
            SET revoked_at = NOW()
            WHERE id = $1
            "#,
            session_id
        )
        .execute(self.pool)
        .await?;
        Ok(())
    }
}
