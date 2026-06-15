use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool, sqlite::SqliteRow};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebPushSubscription {
    pub id: Uuid,
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
    pub user_agent: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub struct WebPushSubscriptionModel;

impl WebPushSubscriptionModel {
    pub async fn upsert(
        pool: &SqlitePool,
        endpoint: &str,
        p256dh: &str,
        auth: &str,
        user_agent: Option<&str>,
    ) -> Result<WebPushSubscription, sqlx::Error> {
        let id = Uuid::new_v4();
        let row = sqlx::query(
            r#"
            INSERT INTO web_push_subscriptions (id, endpoint, p256dh, auth, user_agent)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT(endpoint) DO UPDATE SET
                p256dh = excluded.p256dh,
                auth = excluded.auth,
                user_agent = excluded.user_agent,
                updated_at = datetime('now', 'subsec')
            RETURNING id, endpoint, p256dh, auth, user_agent, created_at, updated_at
            "#,
        )
        .bind(id)
        .bind(endpoint)
        .bind(p256dh)
        .bind(auth)
        .bind(user_agent)
        .fetch_one(pool)
        .await?;

        Ok(row_to_subscription(row)?)
    }

    pub async fn list(pool: &SqlitePool) -> Result<Vec<WebPushSubscription>, sqlx::Error> {
        let rows = sqlx::query(
            r#"
            SELECT id, endpoint, p256dh, auth, user_agent, created_at, updated_at
            FROM web_push_subscriptions
            ORDER BY created_at ASC
            "#,
        )
        .fetch_all(pool)
        .await?;

        rows.into_iter().map(row_to_subscription).collect()
    }

    pub async fn has_any(pool: &SqlitePool) -> Result<bool, sqlx::Error> {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM web_push_subscriptions")
            .fetch_one(pool)
            .await?;
        Ok(count > 0)
    }

    pub async fn delete(pool: &SqlitePool, endpoint: &str) -> Result<u64, sqlx::Error> {
        let result = sqlx::query("DELETE FROM web_push_subscriptions WHERE endpoint = $1")
            .bind(endpoint)
            .execute(pool)
            .await?;
        Ok(result.rows_affected())
    }
}

fn row_to_subscription(row: SqliteRow) -> Result<WebPushSubscription, sqlx::Error> {
    Ok(WebPushSubscription {
        id: row.try_get("id")?,
        endpoint: row.try_get("endpoint")?,
        p256dh: row.try_get("p256dh")?,
        auth: row.try_get("auth")?,
        user_agent: row.try_get("user_agent")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}
