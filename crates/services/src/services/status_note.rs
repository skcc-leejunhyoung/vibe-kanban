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
    /// Text of a block whose closing fence has not arrived; stored at completion.
    open: Option<String>,
    /// Entry index and text of the last closed block this process stored. The
    /// same closed block is observed again on every batch while prose keeps
    /// streaming after it, and must not overwrite what another process wrote.
    stored: Option<(usize, String)>,
}

impl StatusNoteObserver {
    pub fn new(pool: SqlitePool, workspace_id: Uuid) -> Self {
        Self {
            pool,
            workspace_id,
            open: None,
            stored: None,
        }
    }

    /// Entries arrive in index order, each in its latest streamed form, so the
    /// last closed block seen is the summary the agent currently stands by.
    pub async fn observe_entry(&mut self, index: usize, entry: &NormalizedEntry) {
        if !matches!(entry.entry_type, NormalizedEntryType::AssistantMessage) {
            return;
        }
        match status_note::extract_last_block(&entry.content) {
            Some(block) if block.closed => {
                self.open = None;
                let seen = (index, block.text);
                if self.stored.as_ref() == Some(&seen) {
                    return;
                }
                self.store(seen.1.clone()).await;
                self.stored = Some(seen);
            }
            Some(block) => self.open = Some(block.text),
            // A later message without a block leaves an earlier open block as
            // the draft; it is stored as far as it got when the process ends.
            None => {}
        }
    }

    /// The process ended: keep whatever an interrupted block already said.
    pub async fn finish(&mut self) {
        if let Some(text) = self.open.take() {
            self.store(text).await;
        }
    }

    /// The row is the final dedupe: `set_status_note` is a no-op for an
    /// unchanged note, so a new block that restates the stored summary never
    /// bumps the clock, while a restatement after another process wrote
    /// something else does win.
    async fn store(&mut self, text: String) {
        let text = status_note::truncate_visible(text.trim(), MAX_VISIBLE_CHARS);
        if text.is_empty() {
            return;
        }
        match Workspace::set_status_note(&self.pool, self.workspace_id, &text).await {
            Ok(()) => {}
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
        let mut observer = StatusNoteObserver::new(pool.clone(), id);

        // Streaming: the fence is still open, nothing is stored yet.
        observer
            .observe_entry(
                0,
                &message("Working.\n```vibe-status\n로그인 문제를 고치고"),
            )
            .await;
        assert_eq!(note(&pool, id).await, None);

        // The fence closed: stored once, and an unchanged re-observation is a no-op.
        let closed = "Working.\n```vibe-status\n로그인 문제를 고치고 있어요.\n```\nMore.";
        observer.observe_entry(0, &message(closed)).await;
        observer.observe_entry(0, &message(closed)).await;
        assert_eq!(
            note(&pool, id).await.as_deref(),
            Some("로그인 문제를 고치고 있어요.")
        );

        // Tool entries never count, and an interrupted block lands at completion.
        observer
            .observe_entry(
                1,
                &NormalizedEntry {
                    entry_type: NormalizedEntryType::SystemMessage,
                    ..message("```vibe-status\nignored\n```")
                },
            )
            .await;
        observer
            .observe_entry(2, &message("```vibe-status\n테스트를 돌리는 중이에요"))
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
    async fn restated_note_leaves_the_row_alone_and_an_open_block_is_kept() {
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
        let mut observer = StatusNoteObserver::new(pool.clone(), id);

        // A new turn that restates the stored note must not touch the row.
        observer
            .observe_entry(
                0,
                &message(
                    "```vibe-status
이미 저장된 요약이에요.
```",
                ),
            )
            .await;
        let stamped: Option<String> =
            sqlx::query_scalar("SELECT status_updated_at FROM workspaces WHERE id = ?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(stamped, None);

        // A block left open, then a later message without one: the draft is
        // still the latest summary and is stored as far as it got.
        observer
            .observe_entry(
                1,
                &message(
                    "```vibe-status
중간에 끊긴",
                ),
            )
            .await;
        observer.observe_entry(2, &message("Done.")).await;
        observer.finish().await;
        assert_eq!(note(&pool, id).await.as_deref(), Some("중간에 끊긴"));
    }

    /// Two processes on one workspace: a block re-observed on every batch (the
    /// message keeps streaming prose after it) must not overwrite what the
    /// other process stored, while a new block restating it does.
    #[tokio::test]
    async fn re_observed_block_does_not_overwrite_another_process() {
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
        let mut observer = StatusNoteObserver::new(pool.clone(), id);
        observer
            .observe_entry(7, &message("```vibe-status\n첫 요약이에요.\n```\nmore"))
            .await;
        assert_eq!(note(&pool, id).await.as_deref(), Some("첫 요약이에요."));

        // Another process writes its own summary.
        Workspace::set_status_note(&pool, id, "다른 세션 요약이에요.")
            .await
            .unwrap();
        observer
            .observe_entry(
                7,
                &message("```vibe-status\n첫 요약이에요.\n```\nmore prose"),
            )
            .await;
        assert_eq!(
            note(&pool, id).await.as_deref(),
            Some("다른 세션 요약이에요.")
        );

        // A new block from this process, even with the same text, is current again.
        observer
            .observe_entry(9, &message("```vibe-status\n첫 요약이에요.\n```"))
            .await;
        assert_eq!(note(&pool, id).await.as_deref(), Some("첫 요약이에요."));
    }

    #[tokio::test]
    async fn stored_note_is_cut_to_the_visible_limit() {
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
        let mut observer = StatusNoteObserver::new(pool.clone(), id);
        let long = "가".repeat(MAX_VISIBLE_CHARS + 50);
        observer
            .observe_entry(0, &message(&format!("```vibe-status\n{long}\n```")))
            .await;
        let stored = note(&pool, id).await.unwrap();
        assert_eq!(stored.chars().count(), MAX_VISIBLE_CHARS + 1);
        assert!(stored.ends_with('…'));
    }
}
