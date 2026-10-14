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
    /// Index of the newest message whose block was taken into account. An
    /// older message seen again (an entry can be replaced after later ones
    /// streamed in) never overrides a newer summary.
    newest: Option<usize>,
    /// Index and text of the newest block while its closing fence has not
    /// arrived. Stored as far as it got once the agent moves on or the
    /// process ends.
    open: Option<(usize, String)>,
    /// Entry index and text of the last block this process stored. The same
    /// closed block is observed again on every batch while prose keeps
    /// streaming after it, and must not overwrite what another process wrote.
    stored: Option<(usize, String)>,
}

/// Entries that mean the agent has moved past an earlier message, mirroring
/// the client's rule for when an unclosed block stops growing. Errors (stderr)
/// and user messages can be appended while a message still streams, so they
/// do not count.
fn moves_on(entry_type: &NormalizedEntryType) -> bool {
    matches!(
        entry_type,
        NormalizedEntryType::AssistantMessage
            | NormalizedEntryType::ToolUse { .. }
            | NormalizedEntryType::Thinking
    )
}

impl StatusNoteObserver {
    pub fn new(pool: SqlitePool, workspace_id: Uuid) -> Self {
        Self {
            pool,
            workspace_id,
            newest: None,
            open: None,
            stored: None,
        }
    }

    /// Entries arrive in index order, each in its latest streamed form, so the
    /// last closed block of the newest message is the summary the agent
    /// currently stands by.
    pub async fn observe_entry(&mut self, index: usize, entry: &NormalizedEntry) {
        let block = matches!(entry.entry_type, NormalizedEntryType::AssistantMessage)
            .then(|| status_note::extract_last_block(&entry.content))
            .flatten()
            // A fence opened but still empty is not a summary yet (the client
            // skips it too), so it neither replaces nor drops an earlier draft.
            .filter(|block| !block.text.is_empty())
            .filter(|_| self.newest.is_none_or(|newest| index >= newest));
        // The agent moved on from an unclosed block: keep it as far as it got,
        // unless this very entry brings a newer block that replaces it.
        if block.is_none()
            && moves_on(&entry.entry_type)
            && let Some((open_index, text)) = self.open.take()
        {
            if index > open_index {
                self.save(open_index, text).await;
            } else {
                self.open = Some((open_index, text));
            }
        }
        // An older message seen again never overrides a newer summary.
        let Some(block) = block else {
            return;
        };
        self.newest = Some(index);
        if block.closed {
            self.open = None;
            self.save(index, block.text).await;
        } else {
            self.open = Some((index, block.text));
        }
    }

    /// The process ended: keep whatever an interrupted block already said.
    pub async fn finish(&mut self) {
        if let Some((index, text)) = self.open.take() {
            self.save(index, text).await;
        }
    }

    async fn save(&mut self, index: usize, text: String) {
        let seen = (index, text);
        if self.stored.as_ref() == Some(&seen) {
            return;
        }
        if self.store(&seen.1).await {
            self.stored = Some(seen);
        } else if self.newest.is_none_or(|newest| index >= newest) && self.open.is_none() {
            // Retried by the next entry that moves on, or at completion.
            self.open = Some(seen);
        }
    }

    /// The row is the final dedupe: `set_status_note` is a no-op for an
    /// unchanged note, so a new block that restates the stored summary never
    /// bumps the clock, while a restatement after another process wrote
    /// something else does win. False when the write failed (retried on the
    /// next observation).
    async fn store(&self, text: &str) -> bool {
        let text = status_note::truncate_visible(text.trim(), MAX_VISIBLE_CHARS);
        if text.is_empty() {
            return true;
        }
        match Workspace::set_status_note(&self.pool, self.workspace_id, &text).await {
            Ok(()) => true,
            Err(error) => {
                tracing::warn!(
                    %error,
                    workspace_id = %self.workspace_id,
                    "Workspace status note not saved"
                );
                false
            }
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

        // A block left open, then anything after it (here a tool call): the
        // agent moved on, so the draft is stored as far as it got, right away.
        observer
            .observe_entry(
                1,
                &message(
                    "```vibe-status
중간에 끊긴",
                ),
            )
            .await;
        assert_eq!(
            note(&pool, id).await.as_deref(),
            Some("이미 저장된 요약이에요.")
        );
        // A stderr line can land while the message still streams: not a sign
        // that the agent moved on.
        observer
            .observe_entry(
                2,
                &NormalizedEntry {
                    entry_type: NormalizedEntryType::ErrorMessage {
                        error_type: executors::logs::NormalizedEntryError::Other,
                    },
                    ..message("warning: something on stderr")
                },
            )
            .await;
        assert_eq!(
            note(&pool, id).await.as_deref(),
            Some("이미 저장된 요약이에요.")
        );
        observer
            .observe_entry(
                3,
                &NormalizedEntry {
                    entry_type: NormalizedEntryType::Thinking,
                    ..message("")
                },
            )
            .await;
        assert_eq!(note(&pool, id).await.as_deref(), Some("중간에 끊긴"));
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

    /// An older message seen again after a newer one never wins: it neither
    /// overwrites the newer stored summary nor drops a newer open draft.
    #[tokio::test]
    async fn older_message_seen_again_never_overrides_a_newer_summary() {
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
        let old = message("```vibe-status\n옛 요약이에요.\n```");
        observer.observe_entry(2, &old).await;
        observer
            .observe_entry(6, &message("```vibe-status\n새 요약이에요.\n```"))
            .await;
        observer.observe_entry(2, &old).await;
        assert_eq!(note(&pool, id).await.as_deref(), Some("새 요약이에요."));

        observer
            .observe_entry(9, &message("```vibe-status\n쓰다 끊긴 요약"))
            .await;
        observer
            .observe_entry(6, &message("```vibe-status\n새 요약이에요.\n```"))
            .await;
        observer.finish().await;
        assert_eq!(note(&pool, id).await.as_deref(), Some("쓰다 끊긴 요약"));
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
