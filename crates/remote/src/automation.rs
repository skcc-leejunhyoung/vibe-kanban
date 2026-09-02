use serde_json::Value;
use sqlx::{PgPool, Row};

pub async fn emit_event(pool: &PgPool, event_type: &str, id: impl ToString, data: Value) {
    let mut event =
        serde_json::json!({ "id": id.to_string(), "type": event_type, "source": "vibe" });
    if let (Some(event), Some(data)) = (event.as_object_mut(), data.as_object()) {
        event.extend(data.clone());
    }
    let key = format!("{event_type}:{}", id.to_string());
    if let Err(error) = sqlx::query("INSERT INTO automation_event_outbox (id, payload) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING")
        .bind(key).bind(event).execute(pool).await {
        tracing::warn!(%error, %event_type, "failed to persist automation event");
        return;
    }
    let pool = pool.clone();
    tokio::spawn(async move { drain(&pool).await });
}

pub fn spawn_outbox(pool: PgPool) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(15));
        loop {
            interval.tick().await;
            drain(&pool).await;
        }
    });
}

async fn drain(pool: &PgPool) {
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
        let event: Value = row.get("payload");
        match client
            .post(format!("{}/api/events", url.trim_end_matches('/')))
            .timeout(std::time::Duration::from_secs(10))
            .bearer_auth(&token)
            .json(&event)
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                let _ = sqlx::query("DELETE FROM automation_event_outbox WHERE id = $1")
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
    let url = std::env::var("AUTOMATION_WORKER_INTERNAL_URL")
        .unwrap_or_else(|_| "http://automation-worker:8787".to_string());
    let token = std::env::var("ADMIN_TOKEN").ok()?;
    (!url.trim().is_empty() && !token.trim().is_empty()).then_some((url, token))
}
