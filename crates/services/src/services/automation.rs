use serde_json::Value;
use sqlx::{Row, SqlitePool};

#[derive(Debug, PartialEq)]
pub enum ActionReceipt {
    Claimed,
    Running,
    Succeeded(serde_json::Value),
}

pub async fn begin_action(
    pool: &SqlitePool,
    key: &str,
    action: &str,
) -> Result<ActionReceipt, sqlx::Error> {
    let inserted = sqlx::query("INSERT OR IGNORE INTO automation_action_receipts (idempotency_key, action, status) VALUES (?, ?, 'running')")
        .bind(key)
        .bind(action)
        .execute(pool)
        .await?;
    if inserted.rows_affected() == 1 {
        return Ok(ActionReceipt::Claimed);
    }
    let row = sqlx::query(
        "SELECT action, status, response FROM automation_action_receipts WHERE idempotency_key = ?",
    )
    .bind(key)
    .fetch_one(pool)
    .await?;
    let stored_action: String = row.get("action");
    if stored_action != action {
        return Ok(ActionReceipt::Running);
    }
    let status: String = row.get("status");
    let response: Option<String> = row.get("response");
    Ok(if status == "succeeded" {
        ActionReceipt::Succeeded(
            response
                .and_then(|value| serde_json::from_str(&value).ok())
                .unwrap_or(serde_json::Value::Null),
        )
    } else {
        ActionReceipt::Running
    })
}

pub async fn complete_action<T: serde::Serialize>(
    pool: &SqlitePool,
    key: &str,
    response: &T,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE automation_action_receipts SET status = 'succeeded', response = ?, updated_at = CURRENT_TIMESTAMP WHERE idempotency_key = ?")
        .bind(serde_json::to_string(response).unwrap_or_else(|_| "null".to_string()))
        .bind(key)
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
    use sqlx::sqlite::SqlitePoolOptions;
    use uuid::Uuid;

    use super::*;

    #[tokio::test]
    async fn action_receipt_is_reused_after_success() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE automation_action_receipts (idempotency_key TEXT PRIMARY KEY, action TEXT NOT NULL, status TEXT NOT NULL, response TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)")
            .execute(&pool).await.unwrap();
        assert_eq!(
            begin_action(&pool, "key", "notify").await.unwrap(),
            ActionReceipt::Claimed
        );
        assert_eq!(
            begin_action(&pool, "key", "notify").await.unwrap(),
            ActionReceipt::Running
        );
        complete_action(&pool, "key", &serde_json::json!({ "ok": true }))
            .await
            .unwrap();
        assert_eq!(
            begin_action(&pool, "key", "notify").await.unwrap(),
            ActionReceipt::Succeeded(serde_json::json!({ "ok": true }))
        );
    }

    #[tokio::test]
    async fn source_changes_enqueue_events_in_the_same_database_write() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
        let workspace_id = Uuid::new_v4();
        let session_id = Uuid::new_v4();
        let process_id = Uuid::new_v4();
        sqlx::query("INSERT INTO workspaces (id, branch) VALUES (?, 'vk/test')")
            .bind(workspace_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sessions (id, workspace_id) VALUES (?, ?)")
            .bind(session_id)
            .bind(workspace_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO execution_processes (id, session_id, run_reason, status, executor_action) VALUES (?, ?, 'codingagent', 'running', ?)")
            .bind(process_id)
            .bind(session_id)
            .bind(serde_json::json!({
                "automation_origin": {
                    "routine_id": "routine-child",
                    "routine_chain": ["routine-parent", "routine-child"]
                }
            }).to_string())
            .execute(&pool)
            .await
            .unwrap();

        sqlx::query("UPDATE workspaces SET archived = 1 WHERE id = ?")
            .bind(workspace_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE execution_processes SET status = 'completed' WHERE id = ?")
            .bind(process_id)
            .execute(&pool)
            .await
            .unwrap();

        let payloads: Vec<String> =
            sqlx::query_scalar("SELECT payload FROM automation_event_outbox ORDER BY id")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(payloads.len(), 2);
        assert!(
            payloads
                .iter()
                .any(|payload| payload.contains(&workspace_id.to_string()))
        );
        assert!(
            payloads
                .iter()
                .any(|payload| payload.contains(&process_id.to_string()))
        );
        let execution_payload: serde_json::Value = payloads
            .iter()
            .find(|payload| payload.contains(&process_id.to_string()))
            .and_then(|payload| serde_json::from_str(payload).ok())
            .unwrap();
        assert_eq!(execution_payload["originRoutineId"], "routine-child");
        assert_eq!(
            execution_payload["routineChain"],
            serde_json::json!(["routine-parent", "routine-child"])
        );
        let workspace_payload: serde_json::Value = payloads
            .iter()
            .find(|payload| payload.contains(&workspace_id.to_string()))
            .and_then(|payload| serde_json::from_str(payload).ok())
            .unwrap();
        assert_eq!(workspace_payload["originRoutineId"], "routine-child");
        assert_eq!(
            workspace_payload["routineChain"],
            serde_json::json!(["routine-parent", "routine-child"])
        );

        let manual_workspace_id = Uuid::new_v4();
        let manual_session_id = Uuid::new_v4();
        sqlx::query("INSERT INTO workspaces (id, branch) VALUES (?, 'vk/manual')")
            .bind(manual_workspace_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sessions (id, workspace_id) VALUES (?, ?)")
            .bind(manual_session_id)
            .bind(manual_workspace_id)
            .execute(&pool)
            .await
            .unwrap();
        for (action, created_at) in [
            (serde_json::json!({}), "2026-09-03T00:00:00Z"),
            (
                serde_json::json!({
                    "automation_origin": {
                        "routine_id": "later-prompt",
                        "routine_chain": ["later-prompt"]
                    }
                }),
                "2026-09-03T00:01:00Z",
            ),
        ] {
            sqlx::query("INSERT INTO execution_processes (id, session_id, run_reason, status, executor_action, created_at) VALUES (?, ?, 'codingagent', 'completed', ?, ?)")
                .bind(Uuid::new_v4())
                .bind(manual_session_id)
                .bind(action.to_string())
                .bind(created_at)
                .execute(&pool)
                .await
                .unwrap();
        }
        sqlx::query("UPDATE workspaces SET archived = 1 WHERE id = ?")
            .bind(manual_workspace_id)
            .execute(&pool)
            .await
            .unwrap();
        let manual_payload: serde_json::Value = sqlx::query_scalar::<_, String>(
            "SELECT payload FROM automation_event_outbox WHERE payload LIKE ?",
        )
        .bind(format!("%{manual_workspace_id}%"))
        .fetch_one(&pool)
        .await
        .and_then(|payload| {
            serde_json::from_str(&payload).map_err(|error| sqlx::Error::Decode(Box::new(error)))
        })
        .unwrap();
        assert!(manual_payload["originRoutineId"].is_null());
        assert_eq!(manual_payload["routineChain"], serde_json::json!([]));

        let rolled_back_workspace_id = Uuid::new_v4();
        sqlx::query("INSERT INTO workspaces (id, branch) VALUES (?, 'vk/rollback')")
            .bind(rolled_back_workspace_id)
            .execute(&pool)
            .await
            .unwrap();
        let mut transaction = pool.begin().await.unwrap();
        sqlx::query("UPDATE workspaces SET archived = 1 WHERE id = ?")
            .bind(rolled_back_workspace_id)
            .execute(&mut *transaction)
            .await
            .unwrap();
        transaction.rollback().await.unwrap();
        let rolled_back_events: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM automation_event_outbox WHERE payload LIKE ?")
                .bind(format!("%{rolled_back_workspace_id}%"))
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(rolled_back_events, 0);
    }
}
