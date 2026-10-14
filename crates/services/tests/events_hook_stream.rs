use std::{str::FromStr, sync::Arc, time::Duration};

use db::models::{
    execution_process::{CreateExecutionProcess, ExecutionProcess, ExecutionProcessRunReason},
    session::{CreateSession, Session},
    workspace::{CreateWorkspace, Workspace},
};
use executors::actions::{
    ExecutorAction, ExecutorActionType,
    script::{ScriptContext, ScriptRequest, ScriptRequestLanguage},
};
use services::services::events::EventService;
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};
use tokio::sync::RwLock;
use utils::{log_msg::LogMsg, msg_store::MsgStore};
use uuid::Uuid;

/// SQLite fires the update hook before the statement commits, and the hook
/// re-reads the row through another pooled connection. Every insert must
/// still reach the stream as an `add` carrying `running`; otherwise clients
/// that did not start the turn learn about it only when it ends.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn process_inserts_reach_the_stream_as_running() {
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
        .max_connections(4)
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
            branch: "vk/stream".into(),
            name: None,
        },
        Uuid::new_v4(),
    )
    .await
    .unwrap();
    let session = Session::create(
        &hooked,
        &CreateSession {
            executor: None,
            variant: None,
            name: None,
        },
        Uuid::new_v4(),
        workspace.id,
    )
    .await
    .unwrap();
    let action = ExecutorAction::new(
        ExecutorActionType::ScriptRequest(ScriptRequest {
            script: "true".into(),
            language: ScriptRequestLanguage::Bash,
            context: ScriptContext::SetupScript,
            working_dir: None,
        }),
        None,
    );
    let mut ids = Vec::new();
    for _ in 0..40 {
        let id = Uuid::new_v4();
        ExecutionProcess::create(
            &hooked,
            &CreateExecutionProcess {
                session_id: session.id,
                executor_action: action.clone(),
                run_reason: ExecutionProcessRunReason::SetupScript,
            },
            id,
            &[],
        )
        .await
        .unwrap();
        ids.push(id);
    }
    tokio::time::sleep(Duration::from_millis(800)).await;

    let ops: Vec<serde_json::Value> = store
        .get_history()
        .iter()
        .filter_map(|msg| match msg {
            LogMsg::JsonPatch(patch) => serde_json::to_value(patch).ok(),
            _ => None,
        })
        .flat_map(|value| value.as_array().cloned().unwrap_or_default())
        .collect();
    let missing: Vec<&Uuid> = ids
        .iter()
        .filter(|id| {
            !ops.iter().any(|op| {
                op["op"] == "add"
                    && op["path"] == format!("/execution_processes/{id}")
                    && op["value"]["status"] == "running"
            })
        })
        .collect();
    // A re-read that misses the row is reported as a deletion instead.
    let spurious = ops
        .iter()
        .filter(|op| {
            op["value"]["record"]["type"] == "DELETED_EXECUTION_PROCESS"
                || (op["op"] == "remove"
                    && op["path"]
                        .as_str()
                        .is_some_and(|path| path.starts_with("/execution_processes/")))
        })
        .count();
    assert!(
        missing.is_empty() && spurious == 0,
        "{} of {} inserts never streamed as running, {spurious} spurious deletions",
        missing.len(),
        ids.len()
    );
}
