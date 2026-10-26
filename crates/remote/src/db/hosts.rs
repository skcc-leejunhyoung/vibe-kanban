use relay_types::RelayHost;
use sqlx::PgPool;
use uuid::Uuid;

pub struct HostRepository<'a> {
    pool: &'a PgPool,
}

impl<'a> HostRepository<'a> {
    pub fn new(pool: &'a PgPool) -> Self {
        Self { pool }
    }

    pub async fn is_owned_by(&self, host_id: Uuid, user_id: Uuid) -> Result<bool, sqlx::Error> {
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM hosts WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL)",
        )
        .bind(host_id)
        .bind(user_id)
        .fetch_one(self.pool)
        .await
    }

    pub async fn is_accessible_by(
        &self,
        host_id: Uuid,
        user_id: Uuid,
    ) -> Result<bool, sqlx::Error> {
        sqlx::query_scalar::<_, bool>("SELECT host_access_role($1, $2) IS NOT NULL")
            .bind(host_id)
            .bind(user_id)
            .fetch_one(self.pool)
            .await
    }

    pub async fn list_accessible_hosts(
        &self,
        user_id: Uuid,
    ) -> Result<Vec<RelayHost>, sqlx::Error> {
        sqlx::query_as!(
            RelayHost,
            r#"
            SELECT
                h.id,
                h.owner_user_id,
                h.machine_id AS "machine_id!",
                COALESCE(h.custom_name, h.name) AS "name!",
                CASE WHEN h.auth_mode='account' AND (h.relay_lease_until IS NULL OR h.relay_lease_until<=clock_timestamp()) THEN 'offline' ELSE h.status END AS "status!",
                h.last_seen_at,
                h.agent_version,
                h.created_at,
                h.updated_at,
                host_access_role(h.id, $1) AS "access_role!",
                h.auth_mode, h.auth_generation, h.remote_access_enabled, h.capabilities
            FROM hosts h
            JOIN (
                SELECT id FROM hosts WHERE owner_user_id = $1
                UNION
                SELECT shared.id FROM hosts shared
                JOIN organization_member_metadata om
                    ON om.organization_id = shared.shared_with_organization_id
                WHERE om.user_id = $1
                UNION
                SELECT host_id FROM host_access_grants
                WHERE user_id = $1 AND revoked_at IS NULL
            ) candidates ON candidates.id = h.id
            WHERE host_access_role(h.id, $1) IS NOT NULL
            ORDER BY h.updated_at DESC
            "#,
            user_id
        )
        .fetch_all(self.pool)
        .await
    }

    pub async fn update_name(
        &self,
        host_id: Uuid,
        owner_user_id: Uuid,
        name: &str,
    ) -> Result<Option<RelayHost>, sqlx::Error> {
        sqlx::query_as!(
            RelayHost,
            r#"
            UPDATE hosts
            SET custom_name = $3,
                updated_at = NOW()
            WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL
            RETURNING
                id,
                owner_user_id,
                machine_id AS "machine_id!",
                COALESCE(custom_name, name) AS "name!",
                status,
                last_seen_at,
                agent_version,
                created_at,
                updated_at,
                'owner' AS "access_role!",
                auth_mode, auth_generation, remote_access_enabled, capabilities
            "#,
            host_id,
            owner_user_id,
            name
        )
        .fetch_optional(self.pool)
        .await
    }
}
