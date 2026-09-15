use chrono::{DateTime, Utc};
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum OAuthAccountError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

#[derive(Debug, Error)]
pub enum OAuthReconnectError {
    #[error("GitHub/provider account does not match the signed-in user")]
    AccountMismatch,
    #[error("oauth handoff already redeemed or expired")]
    InvalidHandoff,
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct OAuthAccount {
    pub id: Uuid,
    pub user_id: Uuid,
    pub provider: String,
    pub provider_user_id: String,
    pub email: Option<String>,
    pub username: Option<String>,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub encrypted_provider_tokens: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct OAuthAccountInsert<'a> {
    pub user_id: Uuid,
    pub provider: &'a str,
    pub provider_user_id: &'a str,
    pub email: Option<&'a str>,
    pub username: Option<&'a str>,
    pub display_name: Option<&'a str>,
    pub avatar_url: Option<&'a str>,
    pub encrypted_provider_tokens: Option<&'a str>,
}

pub struct OAuthAccountRepository<'a> {
    pool: &'a PgPool,
}

impl<'a> OAuthAccountRepository<'a> {
    pub fn new(pool: &'a PgPool) -> Self {
        Self { pool }
    }

    /// Serialize with reconnect redemption; a stale provider failure must never
    /// revoke a session issued with the replacement credential.
    pub async fn revoke_sessions_if_credentials_current(
        &self,
        user_id: Uuid,
        provider: &str,
        expected: Option<&OAuthAccount>,
    ) -> Result<bool, OAuthAccountError> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT id FROM users WHERE id = $1 FOR UPDATE")
            .bind(user_id)
            .fetch_one(&mut *tx)
            .await?;
        let current: Option<(Uuid, Option<String>)> = sqlx::query_as(
            "SELECT id, encrypted_provider_tokens FROM oauth_accounts
             WHERE user_id = $1 AND provider = $2 LIMIT 1 FOR UPDATE",
        )
        .bind(user_id)
        .bind(provider)
        .fetch_optional(&mut *tx)
        .await?;
        if current.as_ref().map(|(id, token)| (*id, token.as_deref()))
            != expected.map(|account| (account.id, account.encrypted_provider_tokens.as_deref()))
        {
            return Ok(false);
        }
        // Unredeemed handoffs have no issued refresh token. Keep those sessions
        // so a failure just before redemption cannot destroy the recovery itself.
        super::auth::AuthSessionRepository::revoke_issued_user_sessions(&mut tx, user_id).await?;
        tx.commit().await?;
        // After commit, so a request racing the transaction cannot re-cache a
        // session that is about to be revoked.
        crate::auth::AUTH_CACHE.invalidate_all_sessions();
        Ok(true)
    }

    pub async fn update_encrypted_provider_tokens_if_current(
        &self,
        expected: &OAuthAccount,
        encrypted: &str,
    ) -> Result<bool, OAuthAccountError> {
        let result = sqlx::query(
            "UPDATE oauth_accounts SET encrypted_provider_tokens = $3
             WHERE id = $1 AND encrypted_provider_tokens IS NOT DISTINCT FROM $2",
        )
        .bind(expected.id)
        .bind(&expected.encrypted_provider_tokens)
        .bind(encrypted)
        .execute(self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Link/renew only after PKCE redemption. Consumption and credential writes
    /// commit together, so retries or a conflicting identity cannot partly link.
    pub async fn reconnect_and_redeem(
        &self,
        handoff_id: Uuid,
        account: OAuthAccountInsert<'_>,
        refresh_token_id: Uuid,
    ) -> Result<(), OAuthReconnectError> {
        let mut tx = self.pool.begin().await?;
        // Serialize first-time links for one user; never replace their provider identity.
        sqlx::query("SELECT id FROM users WHERE id = $1 FOR UPDATE")
            .bind(account.user_id)
            .fetch_one(&mut *tx)
            .await?;
        let existing: Vec<String> = sqlx::query_scalar(
            "SELECT provider_user_id FROM oauth_accounts WHERE user_id = $1 AND provider = $2",
        )
        .bind(account.user_id)
        .bind(account.provider)
        .fetch_all(&mut *tx)
        .await?;
        if existing.iter().any(|id| id != account.provider_user_id) {
            return Err(OAuthReconnectError::AccountMismatch);
        }
        let consumed: Option<Uuid> = sqlx::query_scalar(
            "UPDATE oauth_handoffs SET status = 'redeemed', encrypted_provider_tokens = NULL, redeemed_at = NOW()
             WHERE id = $1 AND reconnect_user_id = $2 AND provider = $3
               AND status = 'authorized' AND expires_at > NOW() AND session_id IS NOT NULL
             RETURNING session_id",
        )
        .bind(handoff_id)
        .bind(account.user_id)
        .bind(account.provider)
        .fetch_optional(&mut *tx)
        .await?;
        let session_id = consumed.ok_or(OAuthReconnectError::InvalidHandoff)?;
        let linked = sqlx::query(
            "INSERT INTO oauth_accounts (user_id, provider, provider_user_id, email, username, display_name, avatar_url, encrypted_provider_tokens)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (provider, provider_user_id) DO UPDATE SET
                 email = EXCLUDED.email, username = EXCLUDED.username,
                 display_name = EXCLUDED.display_name, avatar_url = EXCLUDED.avatar_url,
                 encrypted_provider_tokens = EXCLUDED.encrypted_provider_tokens
             WHERE oauth_accounts.user_id = EXCLUDED.user_id",
        )
        .bind(account.user_id)
        .bind(account.provider)
        .bind(account.provider_user_id)
        .bind(account.email)
        .bind(account.username)
        .bind(account.display_name)
        .bind(account.avatar_url)
        .bind(account.encrypted_provider_tokens)
        .execute(&mut *tx)
        .await?;
        if linked.rows_affected() != 1 {
            return Err(OAuthReconnectError::AccountMismatch);
        }
        let rotated = sqlx::query(
            "UPDATE auth_sessions SET refresh_token_id = $2, refresh_token_issued_at = NOW(),
                 last_used_at = NOW(), previous_refresh_token_id = NULL,
                 previous_refresh_token_grace_expires_at = NULL
             WHERE id = $1 AND user_id = $3 AND revoked_at IS NULL",
        )
        .bind(session_id)
        .bind(refresh_token_id)
        .bind(account.user_id)
        .execute(&mut *tx)
        .await?;
        if rotated.rows_affected() != 1 {
            return Err(OAuthReconnectError::InvalidHandoff);
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn get_by_provider_user(
        &self,
        provider: &str,
        provider_user_id: &str,
    ) -> Result<Option<OAuthAccount>, OAuthAccountError> {
        sqlx::query_as!(
            OAuthAccount,
            r#"
            SELECT
                id                AS "id!: Uuid",
                user_id           AS "user_id!: Uuid",
                provider          AS "provider!",
                provider_user_id  AS "provider_user_id!",
                email             AS "email?",
                username          AS "username?",
                display_name      AS "display_name?",
                avatar_url        AS "avatar_url?",
                encrypted_provider_tokens AS "encrypted_provider_tokens?",
                created_at        AS "created_at!",
                updated_at        AS "updated_at!"
            FROM oauth_accounts
            WHERE provider = $1
              AND provider_user_id = $2
            "#,
            provider,
            provider_user_id
        )
        .fetch_optional(self.pool)
        .await
        .map_err(OAuthAccountError::from)
    }

    pub async fn get_by_user_provider(
        &self,
        user_id: Uuid,
        provider: &str,
    ) -> Result<Option<OAuthAccount>, OAuthAccountError> {
        sqlx::query_as!(
            OAuthAccount,
            r#"
            SELECT
                id                AS "id!: Uuid",
                user_id           AS "user_id!: Uuid",
                provider          AS "provider!",
                provider_user_id  AS "provider_user_id!",
                email             AS "email?",
                username          AS "username?",
                display_name      AS "display_name?",
                avatar_url        AS "avatar_url?",
                encrypted_provider_tokens AS "encrypted_provider_tokens?",
                created_at        AS "created_at!",
                updated_at        AS "updated_at!"
            FROM oauth_accounts
            WHERE user_id = $1
              AND provider = $2
            LIMIT 1
            "#,
            user_id,
            provider,
        )
        .fetch_optional(self.pool)
        .await
        .map_err(OAuthAccountError::from)
    }

    pub async fn list_by_user(
        &self,
        user_id: Uuid,
    ) -> Result<Vec<OAuthAccount>, OAuthAccountError> {
        sqlx::query_as!(
            OAuthAccount,
            r#"
            SELECT
                id                AS "id!: Uuid",
                user_id           AS "user_id!: Uuid",
                provider          AS "provider!",
                provider_user_id  AS "provider_user_id!",
                email             AS "email?",
                username          AS "username?",
                display_name      AS "display_name?",
                avatar_url        AS "avatar_url?",
                encrypted_provider_tokens AS "encrypted_provider_tokens?",
                created_at        AS "created_at!",
                updated_at        AS "updated_at!"
            FROM oauth_accounts
            WHERE user_id = $1
            ORDER BY provider
            "#,
            user_id
        )
        .fetch_all(self.pool)
        .await
        .map_err(OAuthAccountError::from)
    }

    pub async fn upsert(
        &self,
        account: OAuthAccountInsert<'_>,
    ) -> Result<OAuthAccount, OAuthAccountError> {
        sqlx::query_as!(
            OAuthAccount,
            r#"
            INSERT INTO oauth_accounts (
                user_id,
                provider,
                provider_user_id,
                email,
                username,
                display_name,
                avatar_url,
                encrypted_provider_tokens
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (provider, provider_user_id) DO UPDATE
            SET
                email = EXCLUDED.email,
                username = EXCLUDED.username,
                display_name = EXCLUDED.display_name,
                avatar_url = EXCLUDED.avatar_url,
                encrypted_provider_tokens = COALESCE(
                    EXCLUDED.encrypted_provider_tokens,
                    oauth_accounts.encrypted_provider_tokens
                )
            RETURNING
                id                AS "id!: Uuid",
                user_id           AS "user_id!: Uuid",
                provider          AS "provider!",
                provider_user_id  AS "provider_user_id!",
                email             AS "email?",
                username          AS "username?",
                display_name      AS "display_name?",
                avatar_url        AS "avatar_url?",
                encrypted_provider_tokens AS "encrypted_provider_tokens?",
                created_at        AS "created_at!",
                updated_at        AS "updated_at!"
            "#,
            account.user_id,
            account.provider,
            account.provider_user_id,
            account.email,
            account.username,
            account.display_name,
            account.avatar_url,
            account.encrypted_provider_tokens
        )
        .fetch_one(self.pool)
        .await
        .map_err(OAuthAccountError::from)
    }

    pub async fn backfill_encrypted_provider_tokens(
        &self,
        user_id: Uuid,
        provider: &str,
        encrypted_provider_tokens: &str,
    ) -> Result<(), OAuthAccountError> {
        sqlx::query(
            r#"
            UPDATE oauth_accounts
            SET encrypted_provider_tokens = $3
            WHERE user_id = $1
              AND provider = $2
              AND encrypted_provider_tokens IS NULL
            "#,
        )
        .bind(user_id)
        .bind(provider)
        .bind(encrypted_provider_tokens)
        .execute(self.pool)
        .await?;

        Ok(())
    }
}
