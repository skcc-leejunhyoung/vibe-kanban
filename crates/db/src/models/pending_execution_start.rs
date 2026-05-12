use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum PendingExecutionStartError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

/// Records that an execution_process row has been created but the actual
/// agent spawn was deferred because the workspace's linked task has
/// unresolved blocker issues. A background watcher reevaluates these rows
/// and triggers the spawn once every blocker reaches a resolved status.
#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct PendingExecutionStart {
    pub id: Uuid,
    pub execution_process_id: Uuid,
    pub workspace_id: Uuid,
    pub session_id: Uuid,
    pub task_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub last_checked_at: Option<DateTime<Utc>>,
}

impl PendingExecutionStart {
    pub async fn create(
        pool: &SqlitePool,
        execution_process_id: Uuid,
        workspace_id: Uuid,
        session_id: Uuid,
        task_id: Uuid,
    ) -> Result<Self, PendingExecutionStartError> {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO pending_execution_starts \
             (id, execution_process_id, workspace_id, session_id, task_id) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(execution_process_id)
        .bind(workspace_id)
        .bind(session_id)
        .bind(task_id)
        .execute(pool)
        .await?;

        Self::find_by_process_id(pool, execution_process_id)
            .await?
            .ok_or(PendingExecutionStartError::Database(
                sqlx::Error::RowNotFound,
            ))
    }

    pub async fn find_all(pool: &SqlitePool) -> Result<Vec<Self>, PendingExecutionStartError> {
        let rows = sqlx::query_as::<_, Self>(
            "SELECT id, execution_process_id, workspace_id, session_id, task_id, \
                    created_at, last_checked_at \
             FROM pending_execution_starts \
             ORDER BY created_at ASC",
        )
        .fetch_all(pool)
        .await?;
        Ok(rows)
    }

    pub async fn find_by_process_id(
        pool: &SqlitePool,
        execution_process_id: Uuid,
    ) -> Result<Option<Self>, PendingExecutionStartError> {
        let row = sqlx::query_as::<_, Self>(
            "SELECT id, execution_process_id, workspace_id, session_id, task_id, \
                    created_at, last_checked_at \
             FROM pending_execution_starts \
             WHERE execution_process_id = ?",
        )
        .bind(execution_process_id)
        .fetch_optional(pool)
        .await?;
        Ok(row)
    }

    pub async fn delete_by_process_id(
        pool: &SqlitePool,
        execution_process_id: Uuid,
    ) -> Result<u64, PendingExecutionStartError> {
        let res =
            sqlx::query("DELETE FROM pending_execution_starts WHERE execution_process_id = ?")
                .bind(execution_process_id)
                .execute(pool)
                .await?;
        Ok(res.rows_affected())
    }

    pub async fn touch_checked(
        pool: &SqlitePool,
        execution_process_id: Uuid,
    ) -> Result<(), PendingExecutionStartError> {
        sqlx::query(
            "UPDATE pending_execution_starts \
             SET last_checked_at = datetime('now','subsec') \
             WHERE execution_process_id = ?",
        )
        .bind(execution_process_id)
        .execute(pool)
        .await?;
        Ok(())
    }
}
