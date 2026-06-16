use std::collections::HashSet;

use api_types::UserNotificationPreference;
use sqlx::{Executor, PgPool, Postgres};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum UserNotificationPreferenceError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

pub struct UserNotificationPreferenceRepository;

impl UserNotificationPreferenceRepository {
    pub async fn find_or_default<'e, E>(
        executor: E,
        user_id: Uuid,
    ) -> Result<UserNotificationPreference, UserNotificationPreferenceError>
    where
        E: Executor<'e, Database = Postgres>,
    {
        let record = sqlx::query_as!(
            UserNotificationPreference,
            r#"
            SELECT
                user_id AS "user_id!: Uuid",
                review_requested_enabled AS "review_requested_enabled!"
            FROM user_notification_preferences
            WHERE user_id = $1
            "#,
            user_id
        )
        .fetch_optional(executor)
        .await?;

        Ok(record.unwrap_or(UserNotificationPreference {
            user_id,
            review_requested_enabled: true,
        }))
    }

    pub async fn upsert<'e, E>(
        executor: E,
        user_id: Uuid,
        review_requested_enabled: bool,
    ) -> Result<UserNotificationPreference, UserNotificationPreferenceError>
    where
        E: Executor<'e, Database = Postgres>,
    {
        let record = sqlx::query_as!(
            UserNotificationPreference,
            r#"
            INSERT INTO user_notification_preferences (
                user_id,
                review_requested_enabled,
                updated_at
            )
            VALUES ($1, $2, NOW())
            ON CONFLICT (user_id) DO UPDATE
            SET review_requested_enabled = EXCLUDED.review_requested_enabled,
                updated_at = NOW()
            RETURNING
                user_id AS "user_id!: Uuid",
                review_requested_enabled AS "review_requested_enabled!"
            "#,
            user_id,
            review_requested_enabled
        )
        .fetch_one(executor)
        .await?;

        Ok(record)
    }

    pub async fn review_enabled_user_ids(
        pool: &PgPool,
        user_ids: &[Uuid],
    ) -> Result<HashSet<Uuid>, UserNotificationPreferenceError> {
        if user_ids.is_empty() {
            return Ok(HashSet::new());
        }

        let disabled = sqlx::query_scalar!(
            r#"
            SELECT user_id AS "user_id!: Uuid"
            FROM user_notification_preferences
            WHERE user_id = ANY($1)
              AND review_requested_enabled = FALSE
            "#,
            user_ids
        )
        .fetch_all(pool)
        .await?
        .into_iter()
        .collect::<HashSet<_>>();

        Ok(user_ids
            .iter()
            .copied()
            .filter(|user_id| !disabled.contains(user_id))
            .collect())
    }
}
