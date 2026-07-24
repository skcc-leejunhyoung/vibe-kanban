use api_types::UserWebSettings;
use chrono::{DateTime, Utc};
use sqlx::{Executor, Postgres};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum UserWebSettingsError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

pub struct UserWebSettingsRepository;

/// Revision returned when the account has no stored settings yet. The client
/// treats any non-empty string as a usable revision, so this keeps the
/// optimistic-concurrency handshake happy on first load.
const EMPTY_REVISION: &str = "0";

fn revision_from(updated_at: DateTime<Utc>) -> String {
    updated_at.timestamp_millis().to_string()
}

impl UserWebSettingsRepository {
    pub async fn find_or_default<'e, E>(
        executor: E,
        user_id: Uuid,
    ) -> Result<UserWebSettings, UserWebSettingsError>
    where
        E: Executor<'e, Database = Postgres>,
    {
        let record = sqlx::query!(
            r#"
            SELECT settings, updated_at AS "updated_at!: DateTime<Utc>"
            FROM user_web_settings
            WHERE user_id = $1
            "#,
            user_id
        )
        .fetch_optional(executor)
        .await?;

        Ok(match record {
            Some(row) => UserWebSettings {
                settings: Some(row.settings),
                config_revision: revision_from(row.updated_at),
            },
            None => UserWebSettings {
                settings: None,
                config_revision: EMPTY_REVISION.to_string(),
            },
        })
    }

    pub async fn upsert<'e, E>(
        executor: E,
        user_id: Uuid,
        settings: serde_json::Value,
    ) -> Result<UserWebSettings, UserWebSettingsError>
    where
        E: Executor<'e, Database = Postgres>,
    {
        let row = sqlx::query!(
            r#"
            INSERT INTO user_web_settings (user_id, settings, updated_at)
            VALUES ($1, $2, NOW())
            ON CONFLICT (user_id) DO UPDATE
            SET settings = EXCLUDED.settings,
                updated_at = NOW()
            RETURNING settings, updated_at AS "updated_at!: DateTime<Utc>"
            "#,
            user_id,
            settings
        )
        .fetch_one(executor)
        .await?;

        Ok(UserWebSettings {
            settings: Some(row.settings),
            config_revision: revision_from(row.updated_at),
        })
    }
}
