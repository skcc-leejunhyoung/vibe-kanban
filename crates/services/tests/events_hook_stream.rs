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

/// A file-backed WAL database whose writer pool carries the real event hook,
/// and the stream it publishes to. The hook re-reads rows through its own
/// pool, exactly like the server.
async fn hooked_db() -> (tempfile::TempDir, SqlitePool, Arc<MsgStore>) {
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

    (temp, hooked, store)
}

fn streamed_ops(store: &MsgStore) -> Vec<serde_json::Value> {
    store
        .get_history()
        .iter()
        .filter_map(|msg| match msg {
            LogMsg::JsonPatch(patch) => serde_json::to_value(patch).ok(),
            _ => None,
        })
        .flat_map(|value| value.as_array().cloned().unwrap_or_default())
        .collect()
}

/// SQLite fires the update hook before the statement commits, and the hook
/// re-reads the row through another pooled connection. Every insert must
/// still reach the stream as an `add` carrying `running`; otherwise clients
/// that did not start the turn learn about it only when it ends.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn process_inserts_reach_the_stream_as_running() {
    let (_temp, hooked, store) = hooked_db().await;
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

    let ops = streamed_ops(&store);
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

/// The commit hook also runs before other connections can see the commit, so
/// an update re-read could publish the previous value. Each update publishes
/// exactly one event, in commit order; commits that queue up while the
/// publisher is busy may be read together and show a newer value, but the
/// k-th event must never carry a value older than the k-th write.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn row_updates_stream_their_new_values() {
    let (_temp, hooked, store) = hooked_db().await;
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
    const WRITES: usize = 60;
    for n in 0..WRITES {
        Workspace::set_status_note(&hooked, workspace.id, &format!("요약 {n}"))
            .await
            .unwrap();
        // Spaced like real writers.
        tokio::time::sleep(Duration::from_millis(15)).await;
    }
    tokio::time::sleep(Duration::from_millis(500)).await;

    let path = format!("/workspaces/{}", workspace.id);
    let seen: Vec<usize> = streamed_ops(&store)
        .iter()
        // The workspace insert streams as `add` (and may already carry the
        // first note); each update streams exactly one `replace`.
        .filter(|op| op["path"] == path && op["op"] == "replace")
        .filter_map(|op| {
            op["value"]["status_note"]
                .as_str()?
                .strip_prefix("요약 ")?
                .parse()
                .ok()
        })
        .collect();
    assert_eq!(seen.len(), WRITES, "one event per update: {seen:?}");
    let stale: Vec<(usize, usize)> = seen
        .iter()
        .copied()
        .enumerate()
        .filter(|(k, v)| v < k)
        .collect();
    assert!(
        stale.is_empty(),
        "events carried a value older than their write: {stale:?} in {seen:?}"
    );
    assert_eq!(seen.last(), Some(&(WRITES - 1)), "{seen:?}");
}

/// Applying the stream in order must end in the database's state: a process
/// created and finished back to back ends `completed`, a workspace created
/// and deleted at once ends absent, and a rolled-back delete removes nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stream_order_matches_commit_order() {
    let (_temp, hooked, store) = hooked_db().await;
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
    let mut processes = Vec::new();
    for _ in 0..30 {
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
        ExecutionProcess::update_completion(
            &hooked,
            id,
            db::models::execution_process::ExecutionProcessStatus::Completed,
            Some(0),
        )
        .await
        .unwrap();
        processes.push(id);
    }
    let doomed = Workspace::create(
        &hooked,
        &CreateWorkspace {
            branch: "vk/doomed".into(),
            name: None,
        },
        Uuid::new_v4(),
    )
    .await
    .unwrap();
    sqlx::query("DELETE FROM workspaces WHERE id = ?")
        .bind(doomed.id)
        .execute(&hooked)
        .await
        .unwrap();
    // Roll back a delete, then commit on the same connection: a removal left
    // queued by the rollback would be published with that commit.
    let survivor = processes[0];
    let mut conn = hooked.acquire().await.unwrap();
    sqlx::query("BEGIN").execute(&mut *conn).await.unwrap();
    sqlx::query("DELETE FROM execution_processes WHERE id = ?")
        .bind(survivor)
        .execute(&mut *conn)
        .await
        .unwrap();
    sqlx::query("ROLLBACK").execute(&mut *conn).await.unwrap();
    sqlx::query("UPDATE workspaces SET name = 'after rollback' WHERE id = ?")
        .bind(workspace.id)
        .execute(&mut *conn)
        .await
        .unwrap();
    drop(conn);
    tokio::time::sleep(Duration::from_millis(800)).await;

    // Fold the stream like a client would.
    let mut state = std::collections::HashMap::<String, serde_json::Value>::new();
    for op in streamed_ops(&store) {
        let Some(path) = op["path"].as_str() else {
            continue;
        };
        match op["op"].as_str() {
            Some("add") | Some("replace") => {
                state.insert(path.to_string(), op["value"].clone());
            }
            Some("remove") => {
                state.remove(path);
            }
            _ => {}
        }
    }
    assert!(
        state.contains_key(&format!("/execution_processes/{survivor}")),
        "a rolled-back delete must not remove the process"
    );
    for id in &processes {
        assert_eq!(
            state[&format!("/execution_processes/{id}")]["status"],
            "completed",
            "a finished process must not end up running"
        );
    }
    assert!(!state.contains_key(&format!("/workspaces/{}", doomed.id)));
    assert_eq!(
        state[&format!("/workspaces/{}", workspace.id)]["name"],
        "after rollback"
    );
}
