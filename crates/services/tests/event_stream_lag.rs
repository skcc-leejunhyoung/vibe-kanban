use std::sync::Arc;

use futures::StreamExt;
use services::services::events::EventService;
use utils::{log_msg::LogMsg, msg_store::MsgStore};
use uuid::Uuid;

/// Enough to overrun the 1024-slot broadcast channel of an unpolled subscriber.
const BURST: usize = 2_000;

async fn event_service(msg_store: Arc<MsgStore>) -> (EventService, sqlx::SqlitePool) {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
    let events = EventService::new(
        db::DBService { pool: pool.clone() },
        msg_store,
        Arc::new(tokio::sync::RwLock::new(0usize)),
    );
    (events, pool)
}

fn workspace_patch(id: Uuid) -> json_patch::Patch {
    serde_json::from_value(serde_json::json!([{
        "op": "replace",
        "path": format!("/workspaces/{id}"),
        "value": { "archived": false },
    }]))
    .unwrap()
}

/// Both streams take their DB snapshot *after* subscribing, so a lagged
/// broadcast receiver cannot be healed from history. It must surface an error
/// that closes WS/SSE rather than silently dropping the skipped patches and
/// leaving the client on stale state forever.
#[tokio::test]
async fn lagged_event_streams_error_instead_of_dropping_patches() {
    let store = Arc::new(MsgStore::new());
    let (events, _pool) = event_service(store.clone()).await;

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

/// The snapshot query and the subscription bracket a window. A patch published
/// inside it is absent from the snapshot (the read already happened) and, if
/// the subscription came second, already past on the broadcast channel — lost
/// with no error until the next unrelated update. Holding the pool's only
/// connection pins the query open so the window is deterministic instead of a
/// microsecond race.
#[tokio::test]
async fn a_patch_published_during_the_snapshot_query_still_reaches_the_client() {
    let store = Arc::new(MsgStore::new());
    let (events, pool) = event_service(store.clone()).await;
    let held = pool.acquire().await.unwrap();

    let subscribing =
        tokio::spawn(async move { events.stream_workspaces_raw(None, None).await.unwrap() });
    // Let the task reach the blocked query before publishing into the window.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    let id = Uuid::new_v4();
    store.push_patch(workspace_patch(id));

    drop(held);
    let mut stream = subscribing.await.unwrap();

    assert!(matches!(
        stream.next().await,
        Some(Ok(LogMsg::JsonPatch(_)))
    ));
    assert!(matches!(stream.next().await, Some(Ok(LogMsg::Ready))));
    match tokio::time::timeout(std::time::Duration::from_secs(5), stream.next()).await {
        Ok(Some(Ok(LogMsg::JsonPatch(patch)))) => assert_eq!(
            patch.0.first().unwrap().path().to_string(),
            format!("/workspaces/{id}")
        ),
        other => panic!("patch published during the snapshot query was lost: {other:?}"),
    }
}
