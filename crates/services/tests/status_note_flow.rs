use std::{collections::HashMap, sync::Arc, time::Duration};

use db::models::workspace::{CreateWorkspace, Workspace};
use executors::logs::{NormalizedEntry, NormalizedEntryType, utils::patch::ConversationPatch};
use services::services::{
    execution_process::spawn_stream_raw_logs_to_storage, status_note::StatusNoteObserver,
};
use sqlx::SqlitePool;
use tokio::sync::RwLock;
use utils::{log_msg::LogMsg, msg_store::MsgStore};
use uuid::Uuid;

/// Raw logs land under the real `dev_assets/sessions/<uuid>/`; remove them.
struct SessionLogDir(Uuid);

impl Drop for SessionLogDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(utils::execution_logs::process_logs_session_dir(self.0));
    }
}

fn message(entry_type: NormalizedEntryType, content: &str) -> NormalizedEntry {
    NormalizedEntry {
        timestamp: None,
        metadata: None,
        entry_type,
        content: content.into(),
    }
}

async fn note(pool: &SqlitePool, id: Uuid) -> Option<String> {
    sqlx::query_scalar("SELECT status_note FROM workspaces WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn wait_for_note(pool: &SqlitePool, id: Uuid, expected: &str) {
    tokio::time::timeout(Duration::from_secs(6), async {
        while note(pool, id).await.as_deref() != Some(expected) {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("status note never became {expected:?}"));
}

/// The storage consumer hands streamed assistant messages to the status
/// observer even without artifact discovery: a block is stored once its fence
/// closes, a later block replaces it, tool entries never count, and a block
/// still open when the process ends is stored by the final pass.
#[tokio::test]
async fn streamed_status_blocks_reach_the_workspace_row() {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
    let workspace = Workspace::create(
        &pool,
        &CreateWorkspace {
            branch: "vk/status".into(),
            name: None,
        },
        Uuid::new_v4(),
    )
    .await
    .unwrap();
    let session = Uuid::new_v4();
    let _cleanup = SessionLogDir(session);
    let execution = Uuid::new_v4();
    let store = Arc::new(MsgStore::new());
    let stores = Arc::new(RwLock::new(HashMap::from([(execution, store.clone())])));
    let consumer = spawn_stream_raw_logs_to_storage(
        stores,
        db::DBService { pool: pool.clone() },
        execution,
        session,
        None,
        Some(StatusNoteObserver::new(pool.clone(), workspace.id, None)),
    );

    // Streaming: the fence is still open, so nothing is stored yet.
    store.push_patch(ConversationPatch::add_normalized_entry(
        0,
        message(
            NormalizedEntryType::AssistantMessage,
            "Working.\n```vibe-status\n로그인 문제를 고치고",
        ),
    ));
    tokio::time::sleep(Duration::from_millis(1400)).await;
    assert_eq!(note(&pool, workspace.id).await, None);

    // The fence closes: the next batch stores the block.
    store.push_patch(ConversationPatch::replace(
        0,
        message(
            NormalizedEntryType::AssistantMessage,
            "Working.\n```vibe-status\n로그인 문제를 고치고 있어요.\n```\nNext.",
        ),
    ));
    wait_for_note(&pool, workspace.id, "로그인 문제를 고치고 있어요.").await;

    // A block in a non-assistant entry never counts, and a new message whose
    // block is still open leaves the stored summary alone until the end.
    store.push_patch(ConversationPatch::add_normalized_entry(
        1,
        message(
            NormalizedEntryType::SystemMessage,
            "```vibe-status\nignored\n```",
        ),
    ));
    store.push_patch(ConversationPatch::add_normalized_entry(
        2,
        message(
            NormalizedEntryType::AssistantMessage,
            "```vibe-status\n테스트를 돌리는 중이에요",
        ),
    ));
    tokio::time::sleep(Duration::from_millis(1400)).await;
    assert_eq!(
        note(&pool, workspace.id).await.as_deref(),
        Some("로그인 문제를 고치고 있어요.")
    );

    // The process ends mid-block: the interrupted text is kept.
    store.push(LogMsg::StorageFinished);
    tokio::time::timeout(Duration::from_secs(15), consumer)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        note(&pool, workspace.id).await.as_deref(),
        Some("테스트를 돌리는 중이에요")
    );
}

/// The row the update hook streams after `set_status_note` carries the new
/// columns, so sidebar rows and the strip see the summary without a poll.
#[tokio::test]
async fn stored_note_rides_the_workspace_stream_row() {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
    let workspace = Workspace::create(
        &pool,
        &CreateWorkspace {
            branch: "vk/status".into(),
            name: Some("Status".into()),
        },
        Uuid::new_v4(),
    )
    .await
    .unwrap();
    let before = workspace.updated_at;
    Workspace::set_status_note(&pool, workspace.id, "요약문이에요.")
        .await
        .unwrap();
    let row = Workspace::find_by_id_with_status(&pool, workspace.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.status_note.as_deref(), Some("요약문이에요."));
    assert!(row.status_updated_at.is_some());
    // The summary never reorders the list or resets the expiry clock.
    assert_eq!(row.updated_at, before);
    let patch =
        serde_json::to_value(services::services::events::patches::workspace_patch::replace(&row))
            .unwrap();
    let value = &patch[0]["value"];
    assert_eq!(value["status_note"], "요약문이에요.");
    assert!(value["status_updated_at"].is_string());
    assert_eq!(value["is_running"], false);
}

/// With the real SQLite update hook installed, `set_status_note` alone makes
/// the workspace stream carry the new summary: no poll, no extra plumbing.
#[tokio::test]
async fn set_status_note_streams_the_row_through_the_update_hook() {
    use std::str::FromStr;

    use services::services::events::EventService;
    use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};

    let temp = tempfile::tempdir().unwrap();
    let options = SqliteConnectOptions::from_str(&format!(
        "sqlite://{}",
        temp.path().join("db.sqlite").display()
    ))
    .unwrap()
    .create_if_missing(true)
    .journal_mode(SqliteJournalMode::Wal);
    // The hook re-reads rows through its own pool, exactly like the server.
    let reader = SqlitePool::connect_with(options.clone()).await.unwrap();
    sqlx::migrate!("../db/migrations")
        .run(&reader)
        .await
        .unwrap();
    let store = Arc::new(MsgStore::new());
    let hook = Arc::new(EventService::create_hook(
        store.clone(),
        Arc::new(RwLock::new(0usize)),
        db::DBService {
            pool: reader.clone(),
        },
    ));
    let hooked = SqlitePoolOptions::new()
        .max_connections(1)
        .after_connect(move |conn, _meta| {
            let hook = hook.clone();
            Box::pin(async move { hook(conn).await })
        })
        .connect_with(options)
        .await
        .unwrap();

    let workspace = Workspace::create(
        &hooked,
        &CreateWorkspace {
            branch: "vk/status".into(),
            name: Some("Status".into()),
        },
        Uuid::new_v4(),
    )
    .await
    .unwrap();
    Workspace::set_status_note(&hooked, workspace.id, "스트림으로 가는 요약이에요.")
        .await
        .unwrap();

    let path = format!("/workspaces/{}", workspace.id);
    let streamed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let hit = store.get_history().iter().rev().find_map(|msg| match msg {
                LogMsg::JsonPatch(patch) => {
                    let ops = serde_json::to_value(patch).unwrap();
                    ops.as_array()
                        .and_then(|ops| {
                            ops.iter().find(|op| {
                                op["op"] == "replace"
                                    && op["path"] == path
                                    && op["value"]["status_note"] == "스트림으로 가는 요약이에요."
                            })
                        })
                        .cloned()
                }
                _ => None,
            });
            if let Some(op) = hit {
                break op;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("the update hook must stream the replaced workspace row");
    assert!(streamed["value"]["status_updated_at"].is_string());
    assert_eq!(streamed["value"]["name"], "Status");
}
