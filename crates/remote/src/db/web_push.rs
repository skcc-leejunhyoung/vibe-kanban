use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum WebPushSubscriptionError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

#[derive(Debug, Clone)]
pub struct WebPushSubscription {
    pub id: Uuid,
    pub user_id: Uuid,
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
    pub user_agent: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub struct WebPushSubscriptionRepository;

impl WebPushSubscriptionRepository {
    pub async fn upsert(
        pool: &PgPool,
        user_id: Uuid,
        endpoint: &str,
        p256dh: &str,
        auth: &str,
        user_agent: Option<&str>,
    ) -> Result<WebPushSubscription, WebPushSubscriptionError> {
        let id = Uuid::new_v4();
        let row = sqlx::query(
            r#"
            INSERT INTO web_push_subscriptions
                (id, user_id, endpoint, p256dh, auth, user_agent)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (endpoint) DO UPDATE
            SET user_id = EXCLUDED.user_id,
                p256dh = EXCLUDED.p256dh,
                auth = EXCLUDED.auth,
                user_agent = EXCLUDED.user_agent,
                updated_at = NOW()
            RETURNING id, user_id, endpoint, p256dh, auth, user_agent, created_at, updated_at
            "#,
        )
        .bind(id)
        .bind(user_id)
        .bind(endpoint)
        .bind(p256dh)
        .bind(auth)
        .bind(user_agent)
        .fetch_one(pool)
        .await?;

        Ok(row_to_subscription(row))
    }

    pub async fn list_by_user(
        pool: &PgPool,
        user_id: Uuid,
    ) -> Result<Vec<WebPushSubscription>, WebPushSubscriptionError> {
        let rows = sqlx::query(
            r#"
            SELECT id, user_id, endpoint, p256dh, auth, user_agent, created_at, updated_at
            FROM web_push_subscriptions
            WHERE user_id = $1
            ORDER BY updated_at DESC
            "#,
        )
        .bind(user_id)
        .fetch_all(pool)
        .await?;

        Ok(rows.into_iter().map(row_to_subscription).collect())
    }

    pub async fn delete_for_user(
        pool: &PgPool,
        user_id: Uuid,
        endpoint: &str,
    ) -> Result<(), WebPushSubscriptionError> {
        sqlx::query(
            r#"
            DELETE FROM web_push_subscriptions
            WHERE user_id = $1 AND endpoint = $2
            "#,
        )
        .bind(user_id)
        .bind(endpoint)
        .execute(pool)
        .await?;

        Ok(())
    }

    pub async fn delete_by_endpoint(
        pool: &PgPool,
        endpoint: &str,
    ) -> Result<(), WebPushSubscriptionError> {
        sqlx::query("DELETE FROM web_push_subscriptions WHERE endpoint = $1")
            .bind(endpoint)
            .execute(pool)
            .await?;

        Ok(())
    }
}

fn row_to_subscription(row: sqlx::postgres::PgRow) -> WebPushSubscription {
    WebPushSubscription {
        id: row.get("id"),
        user_id: row.get("user_id"),
        endpoint: row.get("endpoint"),
        p256dh: row.get("p256dh"),
        auth: row.get("auth"),
        user_agent: row.get("user_agent"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}
