use chrono::{DateTime, Utc};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

#[derive(Debug, Clone, FromRow)]
pub struct GitHubHostCredential {
    pub user_id: Uuid,
    pub github_user_id: String,
    pub github_login: String,
    pub scopes: Vec<String>,
    pub encrypted_token: String,
    pub updated_at: DateTime<Utc>,
}

pub struct GitHubHostCredentialRepository;

impl GitHubHostCredentialRepository {
    pub async fn get(
        pool: &PgPool,
        user_id: Uuid,
    ) -> Result<Option<GitHubHostCredential>, sqlx::Error> {
        sqlx::query_as::<_, GitHubHostCredential>(
            "SELECT user_id, github_user_id, github_login, scopes, encrypted_token, updated_at
             FROM github_host_credentials
             WHERE user_id = $1",
        )
        .bind(user_id)
        .fetch_optional(pool)
        .await
    }

    pub async fn upsert(
        pool: &PgPool,
        user_id: Uuid,
        github_user_id: &str,
        github_login: &str,
        scopes: &[String],
        encrypted_token: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO github_host_credentials
                 (user_id, github_user_id, github_login, scopes, encrypted_token)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (user_id) DO UPDATE SET
                 github_user_id = EXCLUDED.github_user_id,
                 github_login = EXCLUDED.github_login,
                 scopes = EXCLUDED.scopes,
                 encrypted_token = EXCLUDED.encrypted_token,
                 updated_at = NOW()",
        )
        .bind(user_id)
        .bind(github_user_id)
        .bind(github_login)
        .bind(scopes)
        .bind(encrypted_token)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn delete(pool: &PgPool, user_id: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM github_host_credentials WHERE user_id = $1")
            .bind(user_id)
            .execute(pool)
            .await?;
        Ok(())
    }
}
