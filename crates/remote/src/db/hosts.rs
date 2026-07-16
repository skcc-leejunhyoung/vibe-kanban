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
            "SELECT EXISTS(SELECT 1 FROM hosts WHERE id = $1 AND owner_user_id = $2)",
        )
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
                h.status,
                h.last_seen_at,
                h.agent_version,
                h.created_at,
                h.updated_at,
                CASE
                    WHEN h.owner_user_id = $1 THEN 'owner'
                    ELSE 'member'
                END AS "access_role!"
            FROM hosts h
            LEFT JOIN organization_member_metadata om
                ON om.organization_id = h.shared_with_organization_id
                AND om.user_id = $1
            WHERE h.owner_user_id = $1 OR om.user_id IS NOT NULL
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
            WHERE id = $1 AND owner_user_id = $2
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
                'owner' AS "access_role!"
            "#,
            host_id,
            owner_user_id,
            name
        )
        .fetch_optional(self.pool)
        .await
    }
}
