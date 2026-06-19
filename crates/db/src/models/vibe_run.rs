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
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl VibeRun {
    const COLUMNS: &'static str = "workspace_id, task_id, phase, review_session_id, \
         coding_turns, review_turns, merge_retries, last_result, created_at, updated_at";

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

    /// Move to the review phase and record the dedicated review session.
    pub async fn begin_review(
        pool: &SqlitePool,
        workspace_id: Uuid,
        review_session_id: Uuid,
    ) -> Result<(), VibeRunError> {
        sqlx::query(
            "UPDATE vibe_runs \
             SET phase = 'review', review_session_id = ?, review_turns = 0, \
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
