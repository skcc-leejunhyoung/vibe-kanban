use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
pub struct CodingAgentTurn {
    pub id: Uuid,
    pub execution_process_id: Uuid,
    pub agent_session_id: Option<String>,
    pub agent_message_id: Option<String>,
    pub prompt: Option<String>,  // The prompt sent to the executor
    pub summary: Option<String>, // Final assistant message/summary
    pub seen: bool,              // Whether user has viewed this turn
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize, TS)]
pub struct CreateCodingAgentTurn {
    pub execution_process_id: Uuid,
    pub prompt: Option<String>,
}

/// Session info from a coding agent turn, used for follow-up requests
#[derive(Debug)]
pub struct CodingAgentResumeInfo {
    pub session_id: String,
    pub message_id: Option<String>,
    /// Message id of the first dropped turn that kept writing to this same
    /// native session: its history from there on is no longer part of the
    /// conversation. `None` when every turn had a native session of its own.
    pub discard_from_message_id: Option<String>,
}

impl CodingAgentTurn {
    /// Find session info from the latest coding agent turn for a session.
    /// Only returns turns that have an agent_session_id set.
    ///
    /// `CROSS JOIN` keeps SQLite walking the session's processes newest first
    /// and stopping at the first match. Left to choose, it scans every turn
    /// with a native session and sorts, evaluating the subquery for each one
    /// (~1 s on a session with thousands of runs).
    pub async fn find_latest_session_info(
        pool: &SqlitePool,
        session_id: Uuid,
    ) -> Result<Option<CodingAgentResumeInfo>, sqlx::Error> {
        sqlx::query_as!(
            CodingAgentResumeInfo,
            r#"SELECT
                cat.agent_session_id as "session_id!",
                cat.agent_message_id as "message_id",
                (SELECT stale.agent_message_id
                   FROM execution_processes dropped
                   JOIN coding_agent_turns stale ON stale.execution_process_id = dropped.id
                  WHERE dropped.session_id = ep.session_id
                    AND dropped.run_reason = 'codingagent'
                    AND dropped.dropped = TRUE
                    AND dropped.created_at > ep.created_at
                    AND stale.agent_session_id = cat.agent_session_id
                    AND stale.agent_message_id IS NOT NULL
                  ORDER BY dropped.created_at ASC
                  LIMIT 1) as "discard_from_message_id?: String"
               FROM execution_processes ep
               CROSS JOIN coding_agent_turns cat ON ep.id = cat.execution_process_id
               WHERE ep.session_id = $1
                 AND ep.run_reason = 'codingagent'
                 AND ep.dropped = FALSE
                 AND cat.agent_session_id IS NOT NULL
               ORDER BY ep.created_at DESC
               LIMIT 1"#,
            session_id
        )
        .fetch_optional(pool)
        .await
    }

    /// Find coding agent turn by execution process ID
    pub async fn find_by_execution_process_id(
        pool: &SqlitePool,
        execution_process_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as!(
            CodingAgentTurn,
            r#"SELECT
                id as "id!: Uuid",
                execution_process_id as "execution_process_id!: Uuid",
                agent_session_id,
                agent_message_id,
                prompt,
                summary,
                seen as "seen!: bool",
                created_at as "created_at!: DateTime<Utc>",
                updated_at as "updated_at!: DateTime<Utc>"
               FROM coding_agent_turns
               WHERE execution_process_id = $1"#,
            execution_process_id
        )
        .fetch_optional(pool)
        .await
    }

    /// Create a new coding agent turn
    pub async fn create(
        pool: &SqlitePool,
        data: &CreateCodingAgentTurn,
        id: Uuid,
    ) -> Result<Self, sqlx::Error> {
        let now = Utc::now();

        tracing::debug!(
            "Creating coding agent turn: id={}, execution_process_id={}, agent_session_id=None (will be set later)",
            id,
            data.execution_process_id
        );

        sqlx::query_as!(
            CodingAgentTurn,
            r#"INSERT INTO coding_agent_turns (
                id, execution_process_id, agent_session_id, agent_message_id, prompt, summary, seen,
                created_at, updated_at
               )
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
               RETURNING
                id as "id!: Uuid",
                execution_process_id as "execution_process_id!: Uuid",
                agent_session_id,
                agent_message_id,
                prompt,
                summary,
                seen as "seen!: bool",
                created_at as "created_at!: DateTime<Utc>",
                updated_at as "updated_at!: DateTime<Utc>""#,
            id,
            data.execution_process_id,
            None::<String>, // agent_session_id initially None until parsed from output
            None::<String>, // agent_message_id initially None until parsed from output
            data.prompt,
            None::<String>, // summary initially None
            false,          // seen - defaults to unseen
            now,            // created_at
            now             // updated_at
        )
        .fetch_one(pool)
        .await
    }

    /// Update coding agent turn with agent session ID
    pub async fn update_agent_session_id(
        pool: &SqlitePool,
        execution_process_id: Uuid,
        agent_session_id: &str,
    ) -> Result<(), sqlx::Error> {
        let now = Utc::now();
        sqlx::query!(
            r#"UPDATE coding_agent_turns
               SET agent_session_id = $1, updated_at = $2
               WHERE execution_process_id = $3"#,
            agent_session_id,
            now,
            execution_process_id
        )
        .execute(pool)
        .await?;

        Ok(())
    }

    /// Update coding agent turn with agent message ID (for --resume-session-at)
    pub async fn update_agent_message_id(
        pool: &SqlitePool,
        execution_process_id: Uuid,
        agent_message_id: &str,
    ) -> Result<(), sqlx::Error> {
        let now = Utc::now();
        sqlx::query!(
            r#"UPDATE coding_agent_turns
               SET agent_message_id = $1, updated_at = $2
               WHERE execution_process_id = $3"#,
            agent_message_id,
            now,
            execution_process_id
        )
        .execute(pool)
        .await?;

        Ok(())
    }

    /// Update coding agent turn summary
    pub async fn update_summary(
        pool: &SqlitePool,
        execution_process_id: Uuid,
        summary: &str,
    ) -> Result<(), sqlx::Error> {
        let now = Utc::now();
        sqlx::query!(
            r#"UPDATE coding_agent_turns
               SET summary = $1, updated_at = $2
               WHERE execution_process_id = $3"#,
            summary,
            now,
            execution_process_id
        )
        .execute(pool)
        .await?;

        Ok(())
    }

    /// Mark a coding agent turn as unseen by execution process ID.
    pub async fn mark_unseen_by_execution_process_id(
        pool: &SqlitePool,
        execution_process_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        let now = Utc::now();
        sqlx::query(
            r#"UPDATE coding_agent_turns
               SET seen = 0, updated_at = ?
               WHERE execution_process_id = ?
                 AND seen = 1"#,
        )
        .bind(now)
        .bind(execution_process_id)
        .execute(pool)
        .await?;

        Ok(())
    }

    /// Mark all coding agent turns for a workspace as seen
    pub async fn mark_seen_by_workspace_id(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        let now = Utc::now();
        sqlx::query!(
            r#"UPDATE coding_agent_turns
               SET seen = 1, updated_at = $1
               WHERE execution_process_id IN (
                   SELECT ep.id FROM execution_processes ep
                   JOIN sessions s ON ep.session_id = s.id
                   WHERE s.workspace_id = $2
               ) AND seen = 0"#,
            now,
            workspace_id
        )
        .execute(pool)
        .await?;

        Ok(())
    }

    /// Check if a workspace has any unseen coding agent turns
    /// Find all workspaces that have unseen coding agent turns, filtered by archived status
    pub async fn find_workspaces_with_unseen(
        pool: &SqlitePool,
        archived: bool,
    ) -> Result<std::collections::HashSet<Uuid>, sqlx::Error> {
        let result: Vec<Uuid> = sqlx::query_scalar!(
            // CROSS JOIN pins the join order: SQLite otherwise scans every
            // session before filtering by archived (~20ms vs <1ms).
            r#"SELECT DISTINCT s.workspace_id as "workspace_id!: Uuid"
               FROM workspaces w
               CROSS JOIN sessions s ON s.workspace_id = w.id
               CROSS JOIN execution_processes ep ON ep.session_id = s.id
               CROSS JOIN coding_agent_turns cat ON cat.execution_process_id = ep.id
               WHERE cat.seen = 0 AND w.archived = $1"#,
            archived
        )
        .fetch_all(pool)
        .await?;

        Ok(result.into_iter().collect())
    }

    /// Find the most recent non-empty prompt for each workspace with the given
    /// archived status. Returns a map of workspace_id -> latest prompt text.
    /// Used to surface what each workspace is working on in the sidebar.
    pub async fn find_latest_prompts_for_workspaces(
        pool: &SqlitePool,
        archived: bool,
    ) -> Result<std::collections::HashMap<Uuid, String>, sqlx::Error> {
        // Join order pinned as in `find_workspaces_with_unseen`.
        let rows = sqlx::query!(
            r#"SELECT workspace_id as "workspace_id!: Uuid", prompt as "prompt!"
               FROM (
                   SELECT s.workspace_id AS workspace_id,
                          cat.prompt AS prompt,
                          ROW_NUMBER() OVER (
                              PARTITION BY s.workspace_id
                              ORDER BY cat.created_at DESC, cat.id DESC
                          ) AS rn
                   FROM workspaces w
                   CROSS JOIN sessions s ON s.workspace_id = w.id
                   CROSS JOIN execution_processes ep ON ep.session_id = s.id
                   CROSS JOIN coding_agent_turns cat ON cat.execution_process_id = ep.id
                   WHERE w.archived = $1
                     AND cat.prompt IS NOT NULL
                     AND TRIM(cat.prompt) <> ''
               ) ranked
               WHERE rn = 1"#,
            archived
        )
        .fetch_all(pool)
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| (r.workspace_id, r.prompt))
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::SqlitePoolOptions;

    use super::*;

    async fn session() -> (SqlitePool, Uuid) {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let (workspace_id, session_id) = (Uuid::new_v4(), Uuid::new_v4());
        sqlx::query("INSERT INTO workspaces (id, branch, name) VALUES ($1, 'vk/test', 'Test')")
            .bind(workspace_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sessions (id, workspace_id) VALUES ($1, $2)")
            .bind(session_id)
            .bind(workspace_id)
            .execute(&pool)
            .await
            .unwrap();
        (pool, session_id)
    }

    /// One agent run: its process `minute` minutes in, the native session it
    /// wrote to and the message it recorded.
    async fn run(
        pool: &SqlitePool,
        session_id: Uuid,
        minute: u32,
        dropped: bool,
        native: &str,
        message: &str,
    ) {
        let process = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO execution_processes (id, session_id, run_reason, status, dropped, created_at)
             VALUES ($1, $2, 'codingagent', 'completed', $3, $4)",
        )
        .bind(process)
        .bind(session_id)
        .bind(dropped)
        .bind(format!("2026-01-01 00:{minute:02}:00"))
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO coding_agent_turns (id, execution_process_id, agent_session_id, agent_message_id)
             VALUES ($1, $2, $3, $4)",
        )
        .bind(Uuid::new_v4())
        .bind(process)
        .bind(native)
        .bind(message)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn resume_info(pool: &SqlitePool, session_id: Uuid) -> (String, Option<String>) {
        let info = CodingAgentTurn::find_latest_session_info(pool, session_id)
            .await
            .unwrap()
            .unwrap();
        (info.session_id, info.discard_from_message_id)
    }

    #[tokio::test]
    async fn dropped_runs_on_the_resumed_session_are_cut_from_the_first() {
        let (pool, session_id) = session().await;
        run(&pool, session_id, 1, false, "thread-1", "turn-1").await;
        run(&pool, session_id, 2, true, "thread-1", "turn-2").await;
        run(&pool, session_id, 3, true, "thread-1", "turn-3").await;
        assert_eq!(
            resume_info(&pool, session_id).await,
            ("thread-1".to_string(), Some("turn-2".to_string()))
        );

        // The follow-up branched off: nothing on the branch is dropped.
        run(&pool, session_id, 4, false, "thread-2", "turn-4").await;
        assert_eq!(
            resume_info(&pool, session_id).await,
            ("thread-2".to_string(), None)
        );
    }

    /// Runs that forked a native session of their own left the one being
    /// continued untouched.
    #[tokio::test]
    async fn dropped_runs_on_other_sessions_need_no_cut() {
        let (pool, session_id) = session().await;
        run(&pool, session_id, 1, false, "thread-1", "turn-1").await;
        run(&pool, session_id, 2, true, "thread-2", "turn-2").await;
        assert_eq!(
            resume_info(&pool, session_id).await,
            ("thread-1".to_string(), None)
        );
    }
}
