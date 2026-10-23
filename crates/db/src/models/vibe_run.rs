use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum VibeRunError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

/// Per-workspace orchestration state for the automated `vibe` workflow.
///
/// `phase` is one of `coding | review | merging | blocked | done` (kept as a
/// plain string here so the `db` crate stays free of the `services`-level
/// `VibePhase` enum; the orchestrator maps between them).
#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct VibeRun {
    pub workspace_id: Uuid,
    pub task_id: Uuid,
    pub phase: String,
    pub review_session_id: Option<Uuid>,
    pub coding_turns: i64,
    pub review_turns: i64,
    pub merge_retries: i64,
    /// Canonical sentinel token (done/blocked/continue/approve) captured from
    /// the agent's full final message at coding completion; consumed and cleared
    /// by the next finalize.
    pub last_result: Option<String>,
    /// Why the last merge attempt failed (git's message plus who holds the
    /// blocking checkout). Kept until the merge lands.
    pub last_error: Option<String>,
    /// First failure of the current merge wait; `None` when not waiting.
    pub merge_wait_since: Option<DateTime<Utc>>,
    pub merge_wait_attempts: i64,
    /// When the waiting merge is tried again.
    pub merge_retry_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// A merge waiting for its next try.
#[derive(Debug, Clone, Copy)]
pub struct MergeWait {
    pub since: DateTime<Utc>,
    pub attempts: i64,
    pub retry_at: DateTime<Utc>,
}

impl VibeRun {
    const COLUMNS: &'static str = "workspace_id, task_id, phase, review_session_id, \
         coding_turns, review_turns, merge_retries, last_result, last_error, merge_wait_since, \
         merge_wait_attempts, merge_retry_at, created_at, updated_at";

    /// Fetch-or-initialize the run row for a workspace. New rows start in the
    /// `coding` phase. Idempotent: an existing row is returned unchanged.
    pub async fn get_or_create(
        pool: &SqlitePool,
        workspace_id: Uuid,
        task_id: Uuid,
    ) -> Result<Self, VibeRunError> {
        sqlx::query("INSERT OR IGNORE INTO vibe_runs (workspace_id, task_id) VALUES (?, ?)")
            .bind(workspace_id)
            .bind(task_id)
            .execute(pool)
            .await?;

        Self::find_by_workspace_id(pool, workspace_id)
            .await?
            .ok_or(VibeRunError::Database(sqlx::Error::RowNotFound))
    }

    pub async fn find_by_workspace_id(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<Option<Self>, VibeRunError> {
        let row = sqlx::query_as::<_, Self>(&format!(
            "SELECT {} FROM vibe_runs WHERE workspace_id = ?",
            Self::COLUMNS
        ))
        .bind(workspace_id)
        .fetch_optional(pool)
        .await?;
        Ok(row)
    }

    /// Row behind a SQLite update hook notification.
    pub async fn find_by_rowid(
        pool: &SqlitePool,
        rowid: i64,
    ) -> Result<Option<Self>, VibeRunError> {
        let row = sqlx::query_as::<_, Self>(&format!(
            "SELECT {} FROM vibe_runs WHERE rowid = ?",
            Self::COLUMNS
        ))
        .bind(rowid)
        .fetch_optional(pool)
        .await?;
        Ok(row)
    }

    /// All runs not in a terminal phase (`blocked`/`done`). Used by the
    /// orphan-recovery watcher to detect runs that may have stalled.
    pub async fn find_non_terminal(pool: &SqlitePool) -> Result<Vec<Self>, VibeRunError> {
        let rows = sqlx::query_as::<_, Self>(&format!(
            "SELECT {} FROM vibe_runs WHERE phase NOT IN ('blocked', 'done')",
            Self::COLUMNS
        ))
        .fetch_all(pool)
        .await?;
        Ok(rows)
    }

    pub async fn set_phase(
        pool: &SqlitePool,
        workspace_id: Uuid,
        phase: &str,
    ) -> Result<(), VibeRunError> {
        sqlx::query(
            "UPDATE vibe_runs SET phase = ?, updated_at = datetime('now','subsec') \
             WHERE workspace_id = ?",
        )
        .bind(phase)
        .bind(workspace_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Move to the review phase and record the dedicated review session. Also
    /// clears `last_result` so the fresh review verdict drives the merge
    /// decision — a stale token (e.g. an earlier `approve`) must not survive into
    /// the new review and short-circuit it straight to a merge. An earlier
    /// merge failure and its wait end with it.
    pub async fn begin_review(
        pool: &SqlitePool,
        workspace_id: Uuid,
        review_session_id: Uuid,
    ) -> Result<(), VibeRunError> {
        sqlx::query(
            "UPDATE vibe_runs \
             SET phase = 'review', review_session_id = ?, review_turns = 0, \
                 last_result = NULL, last_error = NULL, merge_wait_since = NULL, \
                 merge_wait_attempts = 0, merge_retry_at = NULL, \
                 updated_at = datetime('now','subsec') \
             WHERE workspace_id = ?",
        )
        .bind(review_session_id)
        .bind(workspace_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn set_coding_turns(
        pool: &SqlitePool,
        workspace_id: Uuid,
        coding_turns: i64,
    ) -> Result<(), VibeRunError> {
        sqlx::query(
            "UPDATE vibe_runs SET coding_turns = ?, updated_at = datetime('now','subsec') \
             WHERE workspace_id = ?",
        )
        .bind(coding_turns)
        .bind(workspace_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn set_review_turns(
        pool: &SqlitePool,
        workspace_id: Uuid,
        review_turns: i64,
    ) -> Result<(), VibeRunError> {
        sqlx::query(
            "UPDATE vibe_runs SET review_turns = ?, updated_at = datetime('now','subsec') \
             WHERE workspace_id = ?",
        )
        .bind(review_turns)
        .bind(workspace_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn set_merge_retries(
        pool: &SqlitePool,
        workspace_id: Uuid,
        merge_retries: i64,
    ) -> Result<(), VibeRunError> {
        sqlx::query(
            "UPDATE vibe_runs SET merge_retries = ?, updated_at = datetime('now','subsec') \
             WHERE workspace_id = ?",
        )
        .bind(merge_retries)
        .bind(workspace_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Record a failed merge attempt in `phase`. With `wait` the run waits for
    /// another try; without it any wait is over.
    pub async fn record_merge_failure(
        pool: &SqlitePool,
        workspace_id: Uuid,
        phase: &str,
        last_error: &str,
        wait: Option<&MergeWait>,
    ) -> Result<(), VibeRunError> {
        sqlx::query(
            "UPDATE vibe_runs SET phase = ?, last_error = ?, merge_wait_since = ?, \
                 merge_wait_attempts = ?, merge_retry_at = ?, \
                 updated_at = datetime('now','subsec') \
             WHERE workspace_id = ?",
        )
        .bind(phase)
        .bind(last_error)
        .bind(wait.map(|w| w.since))
        .bind(wait.map_or(0, |w| w.attempts))
        .bind(wait.map(|w| w.retry_at))
        .bind(workspace_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// The merge landed: done, with the failure and any wait cleared.
    pub async fn finish_merge(pool: &SqlitePool, workspace_id: Uuid) -> Result<(), VibeRunError> {
        sqlx::query(
            "UPDATE vibe_runs SET phase = 'done', last_error = NULL, merge_wait_since = NULL, \
                 merge_wait_attempts = 0, merge_retry_at = NULL, \
                 updated_at = datetime('now','subsec') \
             WHERE workspace_id = ?",
        )
        .bind(workspace_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Record (or clear, with `None`) the agent's latest sentinel token.
    pub async fn set_last_result(
        pool: &SqlitePool,
        workspace_id: Uuid,
        last_result: Option<&str>,
    ) -> Result<(), VibeRunError> {
        sqlx::query(
            "UPDATE vibe_runs SET last_result = ?, updated_at = datetime('now','subsec') \
             WHERE workspace_id = ?",
        )
        .bind(last_result)
        .bind(workspace_id)
        .execute(pool)
        .await?;
        Ok(())
    }
}
