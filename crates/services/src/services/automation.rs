use serde_json::Value;
use sqlx::{Row, SqlitePool};

pub async fn emit_event(pool: &SqlitePool, event_type: &str, id: impl ToString, data: Value) {
    let mut event = serde_json::json!({
        "id": id.to_string(),
        "type": event_type,
        "source": "vibe",
    });
    if let (Some(event), Some(data)) = (event.as_object_mut(), data.as_object()) {
        event.extend(data.clone());
    }
    let key = format!("{event_type}:{}", id.to_string());
    if let Err(error) = persist(pool, &key, &event).await {
        tracing::warn!(%error, %event_type, "failed to persist automation event");
        return;
    }
    let pool = pool.clone();
    tokio::spawn(async move { drain(&pool).await });
}

async fn persist(pool: &SqlitePool, key: &str, event: &Value) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT OR IGNORE INTO automation_event_outbox (id, payload) VALUES (?, ?)")
        .bind(key)
        .bind(event.to_string())
        .execute(pool)
        .await?;
    Ok(())
}

pub fn spawn_outbox(pool: SqlitePool) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(15));
        loop {
            interval.tick().await;
            drain(&pool).await;
        }
    });
}

async fn drain(pool: &SqlitePool) {
    let Some((url, token)) = endpoint() else {
        return;
    };
    let Ok(rows) = sqlx::query(
        "SELECT id, payload FROM automation_event_outbox ORDER BY created_at LIMIT 100",
    )
    .fetch_all(pool)
    .await
    else {
        return;
    };
    let client = reqwest::Client::new();
    for row in rows {
        let id: String = row.get("id");
        let payload: String = row.get("payload");
        let Ok(event) = serde_json::from_str::<Value>(&payload) else {
            continue;
        };
        match client
            .post(format!("{}/api/events", url.trim_end_matches('/')))
            .timeout(std::time::Duration::from_secs(10))
            .bearer_auth(&token)
            .json(&event)
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                let _ = sqlx::query("DELETE FROM automation_event_outbox WHERE id = ?")
                    .bind(id)
                    .execute(pool)
                    .await;
            }
            Ok(response) => {
                tracing::warn!(status = %response.status(), "automation event rejected")
            }
            Err(error) => tracing::warn!(%error, "failed to emit automation event"),
        }
    }
}

fn endpoint() -> Option<(String, String)> {
    let url = std::env::var("AUTOMATION_WORKER_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:8787".to_string());
    let token = std::env::var("AUTOMATION_WORKER_TOKEN")
        .or_else(|_| std::env::var("ADMIN_TOKEN"))
        .ok()?;
    (!url.trim().is_empty() && !token.trim().is_empty()).then_some((url, token))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn persists_event_until_delivery_succeeds() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE automation_event_outbox (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)")
            .execute(&pool).await.unwrap();
        persist(&pool, "issue_created:1", &serde_json::json!({ "id": "1" }))
            .await
            .unwrap();
        persist(&pool, "issue_created:1", &serde_json::json!({ "id": "1" }))
            .await
            .unwrap();

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM automation_event_outbox")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
    }
}
