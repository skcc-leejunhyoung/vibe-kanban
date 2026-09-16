use std::sync::Arc;

use futures::StreamExt;
use services::services::events::EventService;
use utils::{log_msg::LogMsg, msg_store::MsgStore};
use uuid::Uuid;

/// Enough to overrun the 1024-slot broadcast channel of an unpolled subscriber.
const BURST: usize = 2_000;

async fn event_service(msg_store: Arc<MsgStore>) -> EventService {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
    EventService::new(
        db::DBService { pool },
        msg_store,
        Arc::new(tokio::sync::RwLock::new(0usize)),
    )
}

/// Both streams take their DB snapshot *after* subscribing, so a lagged
/// broadcast receiver cannot be healed from history. It must surface an error
/// that closes WS/SSE rather than silently dropping the skipped patches and
/// leaving the client on stale state forever.
#[tokio::test]
async fn lagged_event_streams_error_instead_of_dropping_patches() {
    let store = Arc::new(MsgStore::new());
    let events = event_service(store.clone()).await;

    let mut workspaces = events.stream_workspaces_raw(None, None).await.unwrap();
    let mut scratch = events
        .stream_scratch_raw(Uuid::new_v4(), &db::models::scratch::ScratchType::DraftTask)
        .await
        .unwrap();

    // Neither stream is polled yet, so both receivers fall behind.
    for index in 0..BURST {
        store.push_patch(
            serde_json::from_value(serde_json::json!([{
                "op": "replace",
                "path": format!("/workspaces/{}", Uuid::new_v4()),
                "value": { "seq": index },
            }]))
            .unwrap(),
        );
    }

    for (name, stream) in [("workspaces", &mut workspaces), ("scratch", &mut scratch)] {
        // Snapshot, then Ready, then the lag error.
        assert!(matches!(
            stream.next().await,
            Some(Ok(LogMsg::JsonPatch(_)))
        ));
        assert!(matches!(stream.next().await, Some(Ok(LogMsg::Ready))));
        // Timed: silently dropping the lag leaves the stream parked forever,
        // which would hang the test instead of failing it.
        match tokio::time::timeout(std::time::Duration::from_secs(5), stream.next()).await {
            // Name-checked: each stream must fail through its own arm, not
            // inherit a sibling's.
            Ok(Some(Err(e))) => assert!(
                e.to_string()
                    .starts_with(&format!("{name} stream lagged by ")),
                "{name}: unexpected error {e}"
            ),
            other => panic!("{name}: expected a lag error, got {other:?}"),
        }
    }
}
