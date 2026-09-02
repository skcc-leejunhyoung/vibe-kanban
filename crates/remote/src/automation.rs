use serde_json::Value;
use sqlx::{PgPool, Row};

pub enum ActionReceipt {
    Claimed,
    Running,
    Succeeded(Value),
}

pub async fn begin_action(
    pool: &PgPool,
    key: &str,
    action: &str,
) -> Result<ActionReceipt, sqlx::Error> {
    let inserted = sqlx::query("INSERT INTO automation_action_receipts (idempotency_key, action, status) VALUES ($1, $2, 'running') ON CONFLICT (idempotency_key) DO NOTHING")
        .bind(key).bind(action).execute(pool).await?;
    if inserted.rows_affected() == 1 {
        return Ok(ActionReceipt::Claimed);
    }
    let row = sqlx::query("SELECT action, status, response FROM automation_action_receipts WHERE idempotency_key = $1")
        .bind(key).fetch_one(pool).await?;
    let stored_action: String = row.get("action");
    let status: String = row.get("status");
    let response: Option<Value> = row.get("response");
    Ok(if stored_action == action && status == "succeeded" {
        ActionReceipt::Succeeded(response.unwrap_or(Value::Null))
    } else {
        ActionReceipt::Running
    })
}

pub async fn complete_action<T: serde::Serialize>(
    pool: &PgPool,
    key: &str,
    response: &T,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE automation_action_receipts SET status = 'succeeded', response = $1, updated_at = NOW() WHERE idempotency_key = $2")
        .bind(serde_json::to_value(response).unwrap_or(Value::Null)).bind(key).execute(pool).await?;
    Ok(())
}

pub async fn release_action(pool: &PgPool, key: &str) {
    let _ = sqlx::query(
        "DELETE FROM automation_action_receipts WHERE idempotency_key = $1 AND status = 'running'",
    )
    .bind(key)
    .execute(pool)
    .await;
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
