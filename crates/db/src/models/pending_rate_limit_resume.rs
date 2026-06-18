use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum PendingRateLimitResumeError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

/// Records that a coding-agent session was interrupted because its usage rate
/// limit was reached. A background watcher (`rate_limit_watcher`) polls these
/// rows and, once `resume_at` has passed and the session still has auto-resume
/// enabled, sends a `resume_prompt` (e.g. "continue") follow-up to resume the
/// session automatically.
///
/// There is at most one pending resume per session (`session_id` is UNIQUE); a
/// newer interruption replaces the previous schedule via upsert.
#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct PendingRateLimitResume {
    pub id: Uuid,
    pub session_id: Uuid,
    pub execution_process_id: Uuid,
    pub resume_at: DateTime<Utc>,
    pub resume_prompt: String,
    pub created_at: DateTime<Utc>,
    pub last_checked_at: Option<DateTime<Utc>>,
}

impl PendingRateLimitResume {
    /// Insert or replace the pending resume for a session.
    pub async fn upsert(
        pool: &SqlitePool,
        session_id: Uuid,
        execution_process_id: Uuid,
        resume_at: DateTime<Utc>,
        resume_prompt: &str,
    ) -> Result<Self, PendingRateLimitResumeError> {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO pending_rate_limit_resumes \
             (id, session_id, execution_process_id, resume_at, resume_prompt) \
             VALUES (?, ?, ?, ?, ?) \
             ON CONFLICT(session_id) DO UPDATE SET \
                 execution_process_id = excluded.execution_process_id, \
                 resume_at = excluded.resume_at, \
                 resume_prompt = excluded.resume_prompt, \
                 last_checked_at = NULL",
        )
        .bind(id)
        .bind(session_id)
        .bind(execution_process_id)
        .bind(resume_at)
        .bind(resume_prompt)
        .execute(pool)
        .await?;

        Self::find_by_session_id(pool, session_id).await?.ok_or(
            PendingRateLimitResumeError::Database(sqlx::Error::RowNotFound),
        )
    }

    /// All pending resumes, oldest reset time first.
    pub async fn find_all(pool: &SqlitePool) -> Result<Vec<Self>, PendingRateLimitResumeError> {
        let rows = sqlx::query_as::<_, Self>(
            "SELECT id, session_id, execution_process_id, resume_at, resume_prompt, \
                    created_at, last_checked_at \
             FROM pending_rate_limit_resumes \
             ORDER BY resume_at ASC",
        )
        .fetch_all(pool)
        .await?;
        Ok(rows)
    }

    pub async fn find_by_session_id(
        pool: &SqlitePool,
        session_id: Uuid,
    ) -> Result<Option<Self>, PendingRateLimitResumeError> {
        let row = sqlx::query_as::<_, Self>(
            "SELECT id, session_id, execution_process_id, resume_at, resume_prompt, \
                    created_at, last_checked_at \
             FROM pending_rate_limit_resumes \
             WHERE session_id = ?",
        )
        .bind(session_id)
        .fetch_optional(pool)
        .await?;
        Ok(row)
    }

    pub async fn delete_by_session_id(
        pool: &SqlitePool,
        session_id: Uuid,
    ) -> Result<u64, PendingRateLimitResumeError> {
        let res = sqlx::query("DELETE FROM pending_rate_limit_resumes WHERE session_id = ?")
            .bind(session_id)
            .execute(pool)
            .await?;
        Ok(res.rows_affected())
    }

    pub async fn touch_checked(
        pool: &SqlitePool,
        session_id: Uuid,
    ) -> Result<(), PendingRateLimitResumeError> {
        sqlx::query(
            "UPDATE pending_rate_limit_resumes \
             SET last_checked_at = datetime('now','subsec') \
             WHERE session_id = ?",
        )
        .bind(session_id)
        .execute(pool)
        .await?;
        Ok(())
    }
}
