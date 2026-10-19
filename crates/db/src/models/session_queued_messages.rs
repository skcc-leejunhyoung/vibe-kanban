use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

/// A session's queued follow-ups (front first), serialized as JSON by
/// `QueuedMessageService`, kept so a server restart doesn't lose them.
#[derive(Debug, Clone, FromRow)]
pub struct SessionQueuedMessages {
    pub session_id: Uuid,
    pub messages: String,
}

impl SessionQueuedMessages {
    pub async fn find_all(pool: &SqlitePool) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>("SELECT session_id, messages FROM session_queued_messages")
            .fetch_all(pool)
            .await
    }

    pub async fn upsert(
        pool: &SqlitePool,
        session_id: Uuid,
        messages: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO session_queued_messages (session_id, messages) VALUES (?, ?) \
             ON CONFLICT(session_id) DO UPDATE SET \
                 messages = excluded.messages, \
                 updated_at = datetime('now', 'subsec')",
        )
        .bind(session_id)
        .bind(messages)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn delete(pool: &SqlitePool, session_id: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM session_queued_messages WHERE session_id = ?")
            .bind(session_id)
            .execute(pool)
            .await?;
        Ok(())
    }
}
