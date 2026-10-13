//! Stores the agent's live summary (the `vibe-status` block of its assistant
//! messages) on the workspace row while the process runs, so lists and other
//! clients read it from the workspace stream instead of replaying logs.

use db::models::workspace::Workspace;
use executors::logs::{
    NormalizedEntry, NormalizedEntryType,
    status_note::{self, MAX_VISIBLE_CHARS},
};
use sqlx::SqlitePool;
use uuid::Uuid;

pub struct StatusNoteObserver {
    pool: SqlitePool,
    workspace_id: Uuid,
    saved: Option<String>,
    /// Text of a block whose closing fence has not arrived; stored at completion.
    open: Option<String>,
}

impl StatusNoteObserver {
    /// `saved` seeds the dedupe with the note already on the row, so a turn
    /// that opens by restating it neither rewrites nor rebroadcasts it.
    pub fn new(pool: SqlitePool, workspace_id: Uuid, saved: Option<String>) -> Self {
        Self {
            pool,
            workspace_id,
            saved,
            open: None,
        }
    }

    /// Entries arrive in index order, each in its latest streamed form, so the
    /// last closed block seen is the summary the agent currently stands by.
    pub async fn observe_entry(&mut self, entry: &NormalizedEntry) {
        if !matches!(entry.entry_type, NormalizedEntryType::AssistantMessage) {
            return;
        }
        match status_note::extract_last_block(&entry.content) {
            Some(block) if block.closed => {
                self.open = None;
                self.store(block.text).await;
            }
            Some(block) => self.open = Some(block.text),
            // The agent moved on without closing its block: nothing to keep.
            None => self.open = None,
        }
    }

    /// The process ended: keep whatever an interrupted block already said.
    pub async fn finish(&mut self) {
        if let Some(text) = self.open.take() {
            self.store(text).await;
        }
    }

    async fn store(&mut self, text: String) {
        let text = status_note::truncate_visible(text.trim(), MAX_VISIBLE_CHARS);
        if text.is_empty() || self.saved.as_deref() == Some(text.as_str()) {
            return;
        }
        match Workspace::set_status_note(&self.pool, self.workspace_id, &text).await {
            Ok(()) => self.saved = Some(text),
            Err(error) => tracing::warn!(
                %error,
                workspace_id = %self.workspace_id,
                "Workspace status note not saved"
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::SqlitePoolOptions;

    use super::*;

    fn message(content: &str) -> NormalizedEntry {
        NormalizedEntry {
            timestamp: None,
            entry_type: NormalizedEntryType::AssistantMessage,
            content: content.to_string(),
            metadata: None,
        }
    }

    async fn note(pool: &SqlitePool, id: Uuid) -> Option<String> {
        sqlx::query_scalar("SELECT status_note FROM workspaces WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn stores_closed_blocks_and_interrupted_blocks_at_completion() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql(
            "CREATE TABLE workspaces (id BLOB PRIMARY KEY, status_note TEXT, status_updated_at TEXT);",
        )
        .execute(&pool)
        .await
        .unwrap();
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO workspaces (id) VALUES (?)")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        let mut observer = StatusNoteObserver::new(pool.clone(), id, None);

        // Streaming: the fence is still open, nothing is stored yet.
        observer
            .observe_entry(&message("Working.\n```vibe-status\n로그인 문제를 고치고"))
            .await;
        assert_eq!(note(&pool, id).await, None);

        // The fence closed: stored once, and an unchanged re-observation is a no-op.
        let closed = "Working.\n```vibe-status\n로그인 문제를 고치고 있어요.\n```\nMore.";
        observer.observe_entry(&message(closed)).await;
        observer.observe_entry(&message(closed)).await;
        assert_eq!(
            note(&pool, id).await.as_deref(),
            Some("로그인 문제를 고치고 있어요.")
        );

        // Tool entries never count, and an interrupted block lands at completion.
        observer
            .observe_entry(&NormalizedEntry {
                entry_type: NormalizedEntryType::SystemMessage,
                ..message("```vibe-status\nignored\n```")
            })
            .await;
        observer
            .observe_entry(&message("```vibe-status\n테스트를 돌리는 중이에요"))
            .await;
        assert_eq!(
            note(&pool, id).await.as_deref(),
            Some("로그인 문제를 고치고 있어요.")
        );
        observer.finish().await;
        assert_eq!(
            note(&pool, id).await.as_deref(),
            Some("테스트를 돌리는 중이에요")
        );
    }

    #[tokio::test]
    async fn abandoned_open_block_and_restated_note_leave_the_row_alone() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql(
            "CREATE TABLE workspaces (id BLOB PRIMARY KEY, status_note TEXT, status_updated_at TEXT);",
        )
        .execute(&pool)
        .await
        .unwrap();
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO workspaces (id, status_note) VALUES (?, ?)")
            .bind(id)
            .bind("이미 저장된 요약이에요.")
            .execute(&pool)
            .await
            .unwrap();
        let mut observer =
            StatusNoteObserver::new(pool.clone(), id, Some("이미 저장된 요약이에요.".into()));

        // A new turn that restates the stored note must not touch the row.
        observer
            .observe_entry(&message(
                "```vibe-status
이미 저장된 요약이에요.
```",
            ))
            .await;
        let stamped: Option<String> =
            sqlx::query_scalar("SELECT status_updated_at FROM workspaces WHERE id = ?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(stamped, None);

        // A block left open, then a later message without one: the agent
        // abandoned it, so completion keeps the stored note.
        observer
            .observe_entry(&message(
                "```vibe-status
중간에 끊긴",
            ))
            .await;
        observer.observe_entry(&message("Done.")).await;
        observer.finish().await;
        assert_eq!(
            note(&pool, id).await.as_deref(),
            Some("이미 저장된 요약이에요.")
        );
    }
}
