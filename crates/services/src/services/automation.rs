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

pub fn spawn_outbox(pool: SqlitePool, host_id: String) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(15));
        loop {
            interval.tick().await;
            drain(&pool, &host_id).await;
        }
    });
}

async fn drain(pool: &SqlitePool, host_id: &str) {
    let Some((url, token)) = endpoint() else {
        return;
    };
    drain_to(pool, &url, &token, host_id).await;
}

async fn drain_to(pool: &SqlitePool, url: &str, token: &str, host_id: &str) {
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
        let Ok(mut event) = serde_json::from_str::<Value>(&payload) else {
            continue;
        };
        if event["type"] == "artifact_scope_ended" {
            event["hostId"] = Value::String(host_id.to_owned());
        }
        let path = if event["type"] == "artifact_scope_ended" {
            "artifact-lifecycle"
        } else {
            "events"
        };
        match client
            .post(format!("{}/api/{path}", url.trim_end_matches('/')))
            .timeout(std::time::Duration::from_secs(10))
            .bearer_auth(token)
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
    async fn cleanup_outbox_retries_gateway_failure_without_losing_the_event() {
        use std::sync::{
            Arc,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        };

        use axum::{Router, http::StatusCode, routing::post};
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE automation_event_outbox (id TEXT PRIMARY KEY, payload TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO automation_event_outbox (id, payload) VALUES ('synthetic-cleanup', ?)")
            .bind(serde_json::json!({"id":"synthetic-cleanup", "type":"artifact_scope_ended", "workspaceId":"synthetic-workspace", "epoch":1, "deleted":false}).to_string()).execute(&pool).await.unwrap();
        let available = Arc::new(AtomicBool::new(false));
        let calls = Arc::new(AtomicUsize::new(0));
        let handler_available = available.clone();
        let handler_calls = calls.clone();
        let app = Router::new().route(
            "/api/artifact-lifecycle",
            post(move |axum::Json(event): axum::Json<Value>| {
                let available = handler_available.clone();
                let calls = handler_calls.clone();
                async move {
                    assert_eq!(event["hostId"], "synthetic-host");
                    assert_eq!(event["type"], "artifact_scope_ended");
                    calls.fetch_add(1, Ordering::SeqCst);
                    if available.load(Ordering::SeqCst) {
                        StatusCode::ACCEPTED
                    } else {
                        StatusCode::SERVICE_UNAVAILABLE
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        drain_to(&pool, &url, "synthetic-token", "synthetic-host").await;
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM automation_event_outbox")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
        available.store(true, Ordering::SeqCst);
        drain_to(&pool, &url, "synthetic-token", "synthetic-host").await;
        drain_to(&pool, &url, "synthetic-token", "synthetic-host").await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM automation_event_outbox")
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
        server.abort();
    }

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
    async fn unfinished_action_receipt_blocks_duplicate_side_effects() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE automation_action_receipts (idempotency_key TEXT PRIMARY KEY, action TEXT NOT NULL, status TEXT NOT NULL, response TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)")
            .execute(&pool).await.unwrap();
        assert_eq!(
            begin_action(&pool, "key", "start_workspace").await.unwrap(),
            ActionReceipt::Claimed
        );
        assert_eq!(
            begin_action(&pool, "key", "start_workspace").await.unwrap(),
            ActionReceipt::Running
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
            sqlx::query_scalar("SELECT payload FROM automation_event_outbox WHERE json_extract(payload, '$.type') != 'artifact_scope_ended' ORDER BY id")
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
            "SELECT payload FROM automation_event_outbox WHERE payload LIKE ? AND json_extract(payload, '$.type') != 'artifact_scope_ended'",
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
