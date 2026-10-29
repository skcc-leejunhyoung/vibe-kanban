//! Persist the prompt before choosing between Autopilot acceptance and user fallback.
use api_types::{AcceptNotificationHandoff, NotificationHandoff};
use db::models::{scratch::DraftFollowUpData, session::Session, workspace::Workspace};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::{
    container::ContainerService,
    queued_message::{QueuedMessage, QueuedMessageService},
    remote_client::{RemoteClient, RemoteClientError},
};

pub async fn receive(
    pool: &SqlitePool,
    client: &RemoteClient,
    queue: &QueuedMessageService,
    request: NotificationHandoff,
) -> anyhow::Result<Uuid> {
    anyhow::ensure!(
        request.handoff.to_string().len() <= 65536,
        "notification handoff too large"
    );
    let key = request.handoff["meta"]["idempotencyKey"]
        .as_str()
        .filter(|key| !key.is_empty() && key.len() <= 200)
        .ok_or_else(|| anyhow::anyhow!("invalid notification handoff key"))?;
    let path = request.handoff["path"].as_str().unwrap_or_default();
    let parts: Vec<_> = path.split('/').collect();
    anyhow::ensure!(
        parts.len() == 5
            && parts[0].is_empty()
            && parts[1] == "api"
            && parts[2] == "sessions"
            && parts[4] == "queue",
        "invalid notification handoff destination"
    );
    let session = Uuid::parse_str(parts[3])?;
    let data: DraftFollowUpData = serde_json::from_value(request.handoff["payload"].clone())?;
    let owner = client
        .notification_account()
        .await
        .ok_or_else(|| anyhow::anyhow!("notification account unavailable"))?;
    let _lock = queue.notification_handoff_lock.lock().await;
    let mut tx = pool.begin().await?;
    let existing: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT owner_user_id,request FROM notification_handoff_inbox WHERE handoff_key=?",
    )
    .bind(key)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((saved_owner, saved)) = existing {
        anyhow::ensure!(
            saved_owner == owner
                && serde_json::from_str::<serde_json::Value>(&saved)?
                    == serde_json::to_value(&request)?,
            "notification handoff changed"
        );
    } else {
        let claimed = sqlx::query("INSERT OR IGNORE INTO automation_action_receipts(idempotency_key,action,status) VALUES(?,'notification_handoff','running')")
            .bind(key).execute(&mut *tx).await?;
        anyhow::ensure!(
            claimed.rows_affected() == 1,
            "notification handoff key already used"
        );
        let message = QueuedMessageService::new_message(session, data);
        sqlx::query("INSERT INTO notification_handoff_inbox(handoff_key,owner_user_id,session_id,message_id,request,message) VALUES(?,?,?,?,?,?)")
            .bind(key).bind(owner).bind(session).bind(message.id).bind(serde_json::to_string(&request)?).bind(serde_json::to_string(&message)?).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    process(pool, client, queue, key, owner).await
}

// Called under the shared queue lock by both HTTP reception and crash recovery.
async fn process(
    pool: &SqlitePool,
    client: &RemoteClient,
    queue: &QueuedMessageService,
    key: &str,
    owner: Uuid,
) -> anyhow::Result<Uuid> {
    let (request, message, status): (String,String,String) = sqlx::query_as("SELECT request,message,status FROM notification_handoff_inbox WHERE handoff_key=? AND owner_user_id=?")
        .bind(key).bind(owner).fetch_one(pool).await?;
    let message: QueuedMessage = serde_json::from_str(&message)?;
    if status == "queued" {
        return Ok(message.session_id);
    }
    anyhow::ensure!(status == "pending", "notification handoff rejected");
    let host_id = client
        .registered_host_id()
        .await?
        .ok_or_else(|| anyhow::anyhow!("notification host unavailable"))?;
    let admission = AcceptNotificationHandoff {
        host_id,
        request: serde_json::from_str(&request)?,
    };
    // No runnable queue entry exists yet. The server locks every member and
    // either accepts the whole batch or leaves the user fallback authoritative.
    match client
        .notification_request(
            reqwest::Method::POST,
            "/v1/notification-handoffs/accept",
            &serde_json::to_value(admission)?,
        )
        .await
    {
        Ok(_) => {}
        Err(
            error @ RemoteClientError::Http {
                status: 404 | 409, ..
            },
        ) => {
            sqlx::query("UPDATE notification_handoff_inbox SET status='rejected' WHERE handoff_key=? AND owner_user_id=? AND status='pending'")
                .bind(key).bind(owner).execute(pool).await?;
            return Err(error.into());
        }
        Err(error) => return Err(error.into()),
    }
    anyhow::ensure!(
        client.notification_account().await == Some(owner),
        "notification account changed"
    );
    let session_id = message.session_id;
    queue.enqueue_notification_handoff(message, key).await?;
    Ok(session_id)
}

pub fn spawn<C: ContainerService + Send + Sync + 'static>(
    pool: SqlitePool,
    client: RemoteClient,
    container: C,
) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
        loop {
            interval.tick().await;
            let Some(owner) = client.notification_account().await else {
                continue;
            };
            let queue = container.queued_message_service();
            let keys = sqlx::query_scalar::<_,String>("SELECT handoff_key FROM notification_handoff_inbox WHERE owner_user_id=? AND status='pending' ORDER BY created_at LIMIT 50")
                .bind(owner).fetch_all(&pool).await;
            let Ok(keys) = keys else {
                tracing::warn!("notification handoff recovery read failed");
                continue;
            };
            for key in keys {
                let result = {
                    let _lock = queue.notification_handoff_lock.lock().await;
                    process(&pool, &client, queue, &key, owner).await
                };
                if let Ok(session_id) = result {
                    if let Ok(Some(session)) = Session::find_by_id(&pool, session_id).await
                        && let Ok(Some(workspace)) =
                            Workspace::find_by_id(&pool, session.workspace_id).await
                        && container
                            .drain_queue_if_idle(&session, &workspace)
                            .await
                            .is_err()
                    {
                        tracing::warn!("notification handoff queue drain failed");
                    }
                } else {
                    tracing::warn!("notification handoff recovery deferred");
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicU16, AtomicUsize, Ordering},
    };

    use axum::{
        Json, Router,
        http::StatusCode,
        routing::{get, post},
    };
    use serde_json::{Value, json};
    use tokio::sync::RwLock;

    use super::*;
    use crate::services::{
        auth::AuthContext,
        oauth_credentials::{Credentials, OAuthCredentials},
    };

    struct Fixture {
        pool: SqlitePool,
        queue: QueuedMessageService,
        client: RemoteClient,
        request: NotificationHandoff,
        status: Arc<AtomicU16>,
        calls: Arc<AtomicUsize>,
        server: tokio::task::JoinHandle<()>,
        _directory: tempfile::TempDir,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.server.abort();
        }
    }
    impl Fixture {
        async fn new(status_code: u16) -> Self {
            let pool = sqlx::sqlite::SqlitePoolOptions::new()
                .max_connections(4)
                .connect("sqlite::memory:")
                .await
                .unwrap();
            sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
            let workspace = Uuid::new_v4();
            let session = Uuid::new_v4();
            sqlx::query("INSERT INTO workspaces(id,branch) VALUES(?,'vk/synthetic-handoff')")
                .bind(workspace)
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO sessions(id,workspace_id) VALUES(?,?)")
                .bind(session)
                .bind(workspace)
                .execute(&pool)
                .await
                .unwrap();
            let owner = Uuid::parse_str("00000000-0000-4000-8000-000000000123").unwrap();
            let host = Uuid::new_v4();
            let hosts = json!({"hosts":[{"id":host,"owner_user_id":owner,"machine_id":"synthetic-machine","name":"Synthetic host","status":"online","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","access_role":"owner","auth_mode":"account","auth_generation":1,"remote_access_enabled":true,"capabilities":[]}]});
            let status = Arc::new(AtomicU16::new(status_code));
            let calls = Arc::new(AtomicUsize::new(0));
            let responder = status.clone();
            let counter = calls.clone();
            let stored = pool.clone();
            let router = Router::new().route("/v1/hosts",get(move|| { let hosts=hosts.clone(); async move { Json(hosts) } }))
                .route("/v1/notification-handoffs/accept",post(move |Json(_):Json<Value>| { let stored=stored.clone(); let responder=responder.clone(); let counter=counter.clone(); async move {
                    // Central admission is never requested before the prompt is durable.
                    let count:i64=sqlx::query_scalar("SELECT COUNT(*) FROM notification_handoff_inbox WHERE status='pending'").fetch_one(&stored).await.unwrap();
                    assert_eq!(count,1);
                    counter.fetch_add(1,Ordering::SeqCst);
                    (StatusCode::from_u16(responder.load(Ordering::SeqCst)).unwrap(),Json(json!({})))
                }}));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
            let directory = tempfile::tempdir().unwrap();
            let auth = AuthContext::new(
                Arc::new(OAuthCredentials::new(
                    directory.path().join("synthetic-credentials.json"),
                )),
                Arc::new(RwLock::new(None)),
            );
            let token = "eyJhbGciOiAiSFMyNTYiLCAidHlwIjogIkpXVCJ9.eyJzdWIiOiAiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMTIzIiwgImV4cCI6IDQxMDI0NDQ4MDB9.c3ludGhldGlj";
            auth.save_credentials(&Credentials {
                access_token: Some(token.into()),
                refresh_token: token.into(),
                expires_at: Some(chrono::Utc::now() + chrono::Duration::hours(1)),
            })
            .await
            .unwrap();
            let client = RemoteClient::new(
                &format!("http://{address}"),
                auth,
                "synthetic-machine".into(),
            )
            .unwrap();
            let request = NotificationHandoff {
                lease_id: Uuid::new_v4(),
                handoff: json!({"path":format!("/api/sessions/{session}/queue"),"payload":{"message":"Synthetic notification prompt","executor_config":{"executor":"CODEX"}},"meta":{"idempotencyKey":"synthetic-handoff"},"members":[{"id":Uuid::new_v4(),"revision":1,"claim_token":Uuid::new_v4()}]}),
            };
            let queue = QueuedMessageService::load(pool.clone()).await;
            Self {
                pool,
                queue,
                client,
                request,
                status,
                calls,
                server,
                _directory: directory,
            }
        }
        async fn receive(&self) -> anyhow::Result<Uuid> {
            receive(&self.pool, &self.client, &self.queue, self.request.clone()).await
        }
        async fn state(&self) -> String {
            sqlx::query_scalar("SELECT status FROM notification_handoff_inbox")
                .fetch_one(&self.pool)
                .await
                .unwrap()
        }
        fn session(&self) -> Uuid {
            Uuid::parse_str(
                self.request.handoff["path"]
                    .as_str()
                    .unwrap()
                    .split('/')
                    .nth(3)
                    .unwrap(),
            )
            .unwrap()
        }
    }

    #[tokio::test]
    async fn fallback_or_superseded_admission_never_enqueues_and_cannot_be_retried_as_new() {
        let f = Fixture::new(409).await;
        assert!(f.receive().await.is_err());
        assert_eq!(f.state().await, "rejected");
        assert!(f.queue.get_queued(f.session()).is_empty());
        assert!(f.receive().await.is_err());
        assert_eq!(f.calls.load(Ordering::SeqCst), 1);
        assert!(
            QueuedMessageService::load(f.pool.clone())
                .await
                .get_queued(f.session())
                .is_empty()
        );
    }

    #[tokio::test]
    async fn lost_admission_response_and_failed_queue_write_recover_once_from_the_inbox() {
        let f = Fixture::new(502).await;
        // The response is unknown. Only the inbox exists; nothing can execute.
        assert!(f.receive().await.is_err());
        assert_eq!(f.state().await, "pending");
        assert!(f.queue.get_queued(f.session()).is_empty());
        f.status.store(200, Ordering::SeqCst);
        sqlx::raw_sql("CREATE TRIGGER synthetic_failed_queue BEFORE INSERT ON session_queued_messages BEGIN SELECT RAISE(FAIL,'synthetic storage failure'); END;").execute(&f.pool).await.unwrap();
        assert!(f.receive().await.is_err());
        let id = f.queue.get_queued(f.session())[0].id;
        assert!(!f.queue.can_drain_now(f.session()));
        assert!(f.queue.take_steered_or_front(f.session(), id).is_none());
        assert_eq!(f.state().await, "pending");
        sqlx::query("DROP TRIGGER synthetic_failed_queue")
            .execute(&f.pool)
            .await
            .unwrap();
        // A fresh service has no in-memory claim or message. The immutable
        // inbox and idempotent central admission are sufficient after restart.
        let restored = QueuedMessageService::load(f.pool.clone()).await;
        receive(&f.pool, &f.client, &restored, f.request.clone())
            .await
            .unwrap();
        assert_eq!(f.state().await, "queued");
        assert_eq!(restored.get_queued(f.session()).len(), 1);
        assert_eq!(restored.get_queued(f.session())[0].id, id);
        let persisted: String=sqlx::query_scalar("SELECT status FROM automation_action_receipts WHERE idempotency_key='synthetic-handoff'").fetch_one(&f.pool).await.unwrap();
        assert_eq!(persisted, "succeeded");
        receive(&f.pool, &f.client, &restored, f.request.clone())
            .await
            .unwrap();
        assert_eq!(restored.get_queued(f.session()).len(), 1);
        let mut altered = f.request.clone();
        altered.handoff["payload"]["message"] = json!("Changed request");
        assert!(
            receive(&f.pool, &f.client, &restored, altered)
                .await
                .is_err()
        );
        assert!(restored.take_next(f.session()).is_some());
        assert!(restored.take_next(f.session()).is_none());
    }
}
