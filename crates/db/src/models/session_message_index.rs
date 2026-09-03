use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

/// One indexable conversation entry extracted from a normalized log.
#[derive(Debug, Clone)]
pub struct NewSessionMessage {
    pub entry_index: i64,
    pub entry_type: String,
    pub tool_name: Option<String>,
    pub content: String,
}

/// A search hit joined with its session/workspace/task context.
#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct SessionMessageHit {
    pub session_id: Uuid,
    pub session_name: Option<String>,
    pub workspace_id: Uuid,
    pub workspace_name: Option<String>,
    pub task_title: Option<String>,
    pub execution_id: Uuid,
    pub entry_index: i64,
    pub entry_type: String,
    pub tool_name: Option<String>,
    pub content: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct SessionMessageSliceRow {
    pub execution_id: Uuid,
    pub entry_index: i64,
    pub entry_type: String,
    pub tool_name: Option<String>,
    pub content: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow)]
pub struct UnindexedExecution {
    pub execution_id: Uuid,
    pub session_id: Uuid,
    pub created_at: DateTime<Utc>,
}

pub struct SessionMessageIndex;

impl SessionMessageIndex {
    /// Replace all indexed entries for an execution and mark it as extracted.
    /// Idempotent, so exit-time indexing and the startup backfill can race.
    pub async fn rebuild_for_execution(
        pool: &SqlitePool,
        session_id: Uuid,
        execution_id: Uuid,
        created_at: DateTime<Utc>,
        rows: &[NewSessionMessage],
    ) -> Result<(), sqlx::Error> {
        let mut tx = pool.begin().await?;
        sqlx::query!(
            "DELETE FROM session_message_index WHERE execution_id = $1",
            execution_id
        )
        .execute(&mut *tx)
        .await?;
        for row in rows {
            sqlx::query!(
                r#"INSERT INTO session_message_index
                   (session_id, execution_id, entry_index, entry_type, tool_name, content, created_at)
                   VALUES ($1, $2, $3, $4, $5, $6, $7)"#,
                session_id,
                execution_id,
                row.entry_index,
                row.entry_type,
                row.tool_name,
                row.content,
                created_at
            )
            .execute(&mut *tx)
            .await?;
        }
        sqlx::query!(
            r#"INSERT INTO session_message_index_state (execution_id, indexed_at)
               VALUES ($1, datetime('now', 'subsec'))
               ON CONFLICT(execution_id) DO UPDATE SET indexed_at = excluded.indexed_at"#,
            execution_id
        )
        .execute(&mut *tx)
        .await?;
        tx.commit().await
    }

    /// Substring search over indexed conversation entries, newest first. An
    /// empty `query` matches every row (useful with `session_id` to list a
    /// session's turns). `entry_types_json` is a JSON array of entry_type
    /// strings, e.g. `["user_message","tool_use"]`.
    // ponytail: LIKE '%q%' full scan — upgrade to FTS5 if it measurably slows.
    pub async fn search(
        pool: &SqlitePool,
        query: &str,
        repo_id: Option<Uuid>,
        session_id: Option<Uuid>,
        entry_types_json: Option<String>,
        limit: i64,
    ) -> Result<Vec<SessionMessageHit>, sqlx::Error> {
        let escaped = query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let pattern = format!("%{escaped}%");
        sqlx::query_as!(
            SessionMessageHit,
            r#"SELECT smi.session_id AS "session_id!: Uuid",
                      s.name AS session_name,
                      s.workspace_id AS "workspace_id!: Uuid",
                      w.name AS workspace_name,
                      t.title AS "task_title?",
                      smi.execution_id AS "execution_id!: Uuid",
                      smi.entry_index AS "entry_index!: i64",
                      smi.entry_type AS "entry_type!",
                      smi.tool_name,
                      smi.content AS "content!",
                      smi.created_at AS "created_at!: DateTime<Utc>"
               FROM session_message_index smi
               JOIN sessions s ON s.id = smi.session_id
               JOIN workspaces w ON w.id = s.workspace_id
               LEFT JOIN tasks t ON t.id = w.task_id
               WHERE smi.content LIKE $1 ESCAPE '\'
                 AND ($2 IS NULL OR EXISTS (
                     SELECT 1 FROM workspace_repos wr
                     WHERE wr.workspace_id = s.workspace_id AND wr.repo_id = $2
                 ))
                 AND ($3 IS NULL OR smi.session_id = $3)
                 AND ($4 IS NULL OR smi.entry_type IN (
                     SELECT je.value FROM json_each($4) je
                 ))
               ORDER BY smi.created_at DESC, smi.execution_id, smi.entry_index
               LIMIT $5"#,
            pattern,
            repo_id,
            session_id,
            entry_types_json,
            limit
        )
        .fetch_all(pool)
        .await
    }

    /// Entries around a hit, in session conversation order (executions ordered
    /// by start time, entries by index), crossing execution boundaries.
    pub async fn slice(
        pool: &SqlitePool,
        session_id: Uuid,
        execution_id: Uuid,
        entry_index: i64,
        radius: i64,
    ) -> Result<Vec<SessionMessageSliceRow>, sqlx::Error> {
        sqlx::query_as!(
            SessionMessageSliceRow,
            r#"WITH ordered AS (
                   SELECT execution_id, entry_index, entry_type, tool_name, content, created_at,
                          ROW_NUMBER() OVER (ORDER BY created_at, execution_id, entry_index) AS rn
                   FROM session_message_index
                   WHERE session_id = $1
               ),
               target AS (
                   SELECT rn FROM ordered WHERE execution_id = $2 AND entry_index = $3
               )
               SELECT o.execution_id AS "execution_id!: Uuid",
                      o.entry_index AS "entry_index!: i64",
                      o.entry_type AS "entry_type!",
                      o.tool_name,
                      o.content AS "content!",
                      o.created_at AS "created_at!: DateTime<Utc>"
               FROM ordered o, target t
               WHERE o.rn BETWEEN t.rn - $4 AND t.rn + $4
               ORDER BY o.rn"#,
            session_id,
            execution_id,
            entry_index,
            radius
        )
        .fetch_all(pool)
        .await
    }

    /// Finished coding-agent executions not yet extracted, newest first so the
    /// backfill makes recent history searchable soonest.
    pub async fn find_unindexed_executions(
        pool: &SqlitePool,
    ) -> Result<Vec<UnindexedExecution>, sqlx::Error> {
        sqlx::query_as!(
            UnindexedExecution,
            r#"SELECT ep.id AS "execution_id!: Uuid",
                      ep.session_id AS "session_id!: Uuid",
                      ep.created_at AS "created_at!: DateTime<Utc>"
               FROM execution_processes ep
               WHERE ep.run_reason = 'codingagent'
                 AND ep.status != 'running'
                 AND NOT EXISTS (
                     SELECT 1 FROM session_message_index_state st
                     WHERE st.execution_id = ep.id
                 )
               ORDER BY ep.created_at DESC"#
        )
        .fetch_all(pool)
        .await
    }
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;
    use sqlx::sqlite::SqlitePoolOptions;

    use super::*;

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    async fn seed_session(pool: &SqlitePool) -> Uuid {
        let workspace_id = Uuid::new_v4();
        let session_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO workspaces (id, branch, name) VALUES ($1, 'vk/test', '검색 워크스페이스')",
        )
        .bind(workspace_id)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO sessions (id, workspace_id) VALUES ($1, $2)")
            .bind(session_id)
            .bind(workspace_id)
            .execute(pool)
            .await
            .unwrap();
        session_id
    }

    async fn seed_execution(pool: &SqlitePool, session_id: Uuid, status: &str) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO execution_processes (id, session_id, run_reason, status) VALUES ($1, $2, 'codingagent', $3)",
        )
        .bind(id)
        .bind(session_id)
        .bind(status)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    fn message(entry_index: i64, entry_type: &str, content: &str) -> NewSessionMessage {
        NewSessionMessage {
            entry_index,
            entry_type: entry_type.to_string(),
            tool_name: None,
            content: content.to_string(),
        }
    }

    #[tokio::test]
    async fn rebuild_search_and_slice_roundtrip() {
        let pool = test_pool().await;
        let session_id = seed_session(&pool).await;
        let exec1 = seed_execution(&pool, session_id, "completed").await;
        let exec2 = seed_execution(&pool, session_id, "completed").await;
        let t1 = Utc.with_ymd_and_hms(2026, 8, 25, 10, 0, 0).unwrap();
        let t2 = Utc.with_ymd_and_hms(2026, 8, 25, 11, 0, 0).unwrap();

        SessionMessageIndex::rebuild_for_execution(
            &pool,
            session_id,
            exec1,
            t1,
            &[
                message(0, "user_message", "FTS5 대신 LIKE로 결정한 이유 정리"),
                message(1, "assistant_message", "한국어 부분문자열 매칭 때문입니다"),
            ],
        )
        .await
        .unwrap();
        SessionMessageIndex::rebuild_for_execution(
            &pool,
            session_id,
            exec2,
            t2,
            &[message(0, "assistant_message", "진행률 100% 완료")],
        )
        .await
        .unwrap();

        // Substring search inside a Korean word, newest hit first.
        let hits = SessionMessageIndex::search(&pool, "결정", None, None, None, 10)
            .await
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].execution_id, exec1);
        assert_eq!(hits[0].entry_index, 0);
        assert_eq!(hits[0].workspace_name.as_deref(), Some("검색 워크스페이스"));

        // LIKE wildcards in the query are escaped, not interpreted.
        let hits = SessionMessageIndex::search(&pool, "100%", None, None, None, 10)
            .await
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].execution_id, exec2);
        assert!(
            SessionMessageIndex::search(&pool, "100% 없음", None, None, None, 10)
                .await
                .unwrap()
                .is_empty()
        );

        // Entry-type filter.
        let hits = SessionMessageIndex::search(
            &pool,
            "결정",
            None,
            None,
            Some(r#"["assistant_message"]"#.to_string()),
            10,
        )
        .await
        .unwrap();
        assert!(hits.is_empty());

        // Multi-value entry-type filter and limit (a space matches every row).
        let hits = SessionMessageIndex::search(
            &pool,
            " ",
            None,
            None,
            Some(r#"["user_message","assistant_message"]"#.to_string()),
            2,
        )
        .await
        .unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].execution_id, exec2, "newest turn first");

        // Repo filter: a repo the workspace contains matches, a foreign one doesn't.
        let repo_id = Uuid::new_v4();
        sqlx::query("INSERT INTO repos (id, path, name, display_name) VALUES ($1, '/tmp/probe-repo', 'probe', 'probe')")
            .bind(repo_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO workspace_repos (id, workspace_id, repo_id, target_branch) SELECT $1, workspace_id, $2, 'main' FROM sessions WHERE id = $3")
            .bind(Uuid::new_v4())
            .bind(repo_id)
            .bind(session_id)
            .execute(&pool)
            .await
            .unwrap();
        let hits = SessionMessageIndex::search(&pool, "결정", Some(repo_id), None, None, 10)
            .await
            .unwrap();
        assert_eq!(hits.len(), 1);
        let hits = SessionMessageIndex::search(&pool, "결정", Some(Uuid::new_v4()), None, None, 10)
            .await
            .unwrap();
        assert!(hits.is_empty());

        // Session filter: another session with the same text is excluded, and an
        // empty query lists every row of that session (turn outline use case).
        let other_session = seed_session(&pool).await;
        let other_exec = seed_execution(&pool, other_session, "completed").await;
        SessionMessageIndex::rebuild_for_execution(
            &pool,
            other_session,
            other_exec,
            t2,
            &[message(0, "user_message", "다른 세션의 결정")],
        )
        .await
        .unwrap();
        let hits = SessionMessageIndex::search(&pool, "결정", None, None, None, 10)
            .await
            .unwrap();
        assert_eq!(hits.len(), 2);
        let hits = SessionMessageIndex::search(&pool, "결정", None, Some(session_id), None, 10)
            .await
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].session_id, session_id);
        let hits = SessionMessageIndex::search(&pool, "", None, Some(session_id), None, 10)
            .await
            .unwrap();
        assert_eq!(
            hits.len(),
            3,
            "empty query matches every row of the session"
        );
        assert!(hits.iter().all(|h| h.session_id == session_id));

        // Slice around the last entry of exec1 crosses into exec2.
        let slice = SessionMessageIndex::slice(&pool, session_id, exec1, 1, 1)
            .await
            .unwrap();
        let keys: Vec<(Uuid, i64)> = slice
            .iter()
            .map(|r| (r.execution_id, r.entry_index))
            .collect();
        assert_eq!(keys, vec![(exec1, 0), (exec1, 1), (exec2, 0)]);

        // Rebuild replaces prior rows (idempotent re-index).
        SessionMessageIndex::rebuild_for_execution(
            &pool,
            session_id,
            exec2,
            t2,
            &[message(0, "assistant_message", "다시 쓴 내용")],
        )
        .await
        .unwrap();
        assert!(
            SessionMessageIndex::search(&pool, "100%", None, None, None, 10)
                .await
                .unwrap()
                .is_empty()
        );

        // Deleting the sessions cascades to index rows and state markers.
        sqlx::query("DELETE FROM sessions WHERE id IN ($1, $2)")
            .bind(session_id)
            .bind(other_session)
            .execute(&pool)
            .await
            .unwrap();
        let (rows, markers): (i64, i64) = sqlx::query_as(
            "SELECT (SELECT COUNT(*) FROM session_message_index), (SELECT COUNT(*) FROM session_message_index_state)",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!((rows, markers), (0, 0));
    }

    #[tokio::test]
    async fn unindexed_scan_skips_marked_and_running_executions() {
        let pool = test_pool().await;
        let session_id = seed_session(&pool).await;
        let done = seed_execution(&pool, session_id, "completed").await;
        let _running = seed_execution(&pool, session_id, "running").await;

        let pending = SessionMessageIndex::find_unindexed_executions(&pool)
            .await
            .unwrap();
        assert_eq!(
            pending.iter().map(|p| p.execution_id).collect::<Vec<_>>(),
            vec![done]
        );

        // Marking via rebuild (even with zero rows) removes it from the scan.
        SessionMessageIndex::rebuild_for_execution(&pool, session_id, done, Utc::now(), &[])
            .await
            .unwrap();
        assert!(
            SessionMessageIndex::find_unindexed_executions(&pool)
                .await
                .unwrap()
                .is_empty()
        );
    }
}
