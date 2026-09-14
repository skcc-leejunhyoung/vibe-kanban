use std::{collections::HashMap, sync::Arc};

use services::services::execution_process::spawn_stream_raw_logs_to_storage;
use tokio::sync::RwLock;
use utils::{execution_logs::process_log_file_path, log_msg::LogMsg, msg_store::MsgStore};
use uuid::Uuid;

const BURST_LINES: usize = 5_000;

/// A blocked sqlite UPDATE (SessionId) must not cost raw JSONL lines: while the
/// storage consumer waits for a pool connection the producer bursts far past
/// the broadcast capacity, so every line has to reach the file anyway.
#[tokio::test]
async fn blocked_db_update_must_not_drop_raw_log_lines() {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
    let session = Uuid::new_v4();
    let execution = Uuid::new_v4();
    let store = Arc::new(MsgStore::new());
    let stores = Arc::new(RwLock::new(HashMap::from([(execution, store.clone())])));
    let db = db::DBService { pool: pool.clone() };
    let held_connection = pool.acquire().await.unwrap();
    let consumer = spawn_stream_raw_logs_to_storage(stores, db, execution, session, None);

    store.push_stdout("warmup\n");
    let path = process_log_file_path(session, execution);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !tokio::fs::read_to_string(&path)
            .await
            .unwrap_or_default()
            .contains("warmup")
        {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("consumer must subscribe and persist the warmup line");

    // The consumer now blocks on the held connection; burst past capacity.
    store.push_session_id("agent-session".into());
    for index in 0..BURST_LINES {
        store.push_stdout(format!("line-{index}\n"));
    }
    drop(held_connection);
    store.push(LogMsg::StorageFinished);
    tokio::time::timeout(std::time::Duration::from_secs(30), consumer)
        .await
        .unwrap()
        .unwrap();

    let jsonl = tokio::fs::read_to_string(&path).await.unwrap();
    tokio::fs::remove_dir_all(utils::execution_logs::process_logs_session_dir(session))
        .await
        .unwrap();
    let lines: Vec<LogMsg> = jsonl
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    println!(
        "Raw JSONL lines persisted={} expected={}",
        lines.len(),
        BURST_LINES + 1
    );
    assert_eq!(lines.len(), BURST_LINES + 1);
    for (index, msg) in lines.iter().skip(1).enumerate() {
        match msg {
            LogMsg::Stdout(content) => assert_eq!(content, &format!("line-{index}\n")),
            other => panic!("unexpected persisted message {other:?}"),
        }
    }
}
