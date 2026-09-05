use executors::logs::{ActionType, NormalizedEntry, NormalizedEntryType, ToolStatus};
use services::services::{
    artifacts::{self, ArtifactObserver},
    file::FileService,
};
use uuid::Uuid;

#[tokio::test]
async fn live_file_bundle_must_refresh_when_only_css_changes() {
    let temp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(temp.path()).unwrap();
    std::fs::write(
        root.join("report.html"),
        "<html><link rel=\"stylesheet\" href=\"style.css\"><body>report</body></html>",
    )
    .unwrap();
    std::fs::write(root.join("style.css"), "body{color:red}").unwrap();
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
    let files = FileService::new(pool).unwrap();
    let session = Uuid::new_v4();
    let execution = Uuid::new_v4();
    let mut observer = ArtifactObserver::start(
        root.clone(),
        root.clone(),
        Uuid::new_v4(),
        session,
        execution,
        files.clone(),
    )
    .await
    .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(900)).await;
    observer
        .observe_entry(
            0,
            &NormalizedEntry {
                timestamp: None,
                metadata: None,
                content: "read report".into(),
                entry_type: NormalizedEntryType::ToolUse {
                    tool_name: "Read".into(),
                    status: ToolStatus::Success,
                    action_type: ActionType::FileRead {
                        path: "report.html".into(),
                    },
                },
            },
        )
        .await;
    observer.tick(false).await.unwrap();
    let initial = artifacts::load(session, execution).await.unwrap().unwrap();
    let report = initial
        .list
        .artifacts
        .iter()
        .find(|a| a.name == "report.html")
        .unwrap();
    let initial_css = initial.bundles[&report.id].resources[0]
        .content_hash
        .clone();
    std::fs::write(root.join("style.css"), "body{color:blue}").unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    observer.tick(false).await.unwrap();
    let live = artifacts::load(session, execution).await.unwrap().unwrap();
    let live_css = live.bundles[&report.id].resources[0].content_hash.clone();
    let observed_css = live
        .list
        .artifacts
        .iter()
        .find(|a| a.name == "style.css")
        .unwrap()
        .content_hash
        .clone()
        .unwrap();
    observer.tick(true).await.unwrap();
    let final_manifest = artifacts::load(session, execution).await.unwrap().unwrap();
    let final_css = final_manifest.bundles[&report.id].resources[0]
        .content_hash
        .clone();
    files.delete_orphaned_files().await.unwrap();
    tokio::fs::remove_dir_all(utils::execution_logs::process_logs_session_dir(session))
        .await
        .unwrap();
    println!(
        "initial={initial_css}\nlive_bundle={live_css}\nlive_css_artifact={observed_css}\nfinal_bundle={final_css}"
    );
    assert_eq!(
        final_css, observed_css,
        "finalization does refresh the dependency"
    );
    assert_eq!(
        live_css, observed_css,
        "the live HTML bundle must use the updated CSS bytes"
    );
}

#[tokio::test]
async fn slow_artifact_storage_must_not_drop_raw_logs() {
    use std::{collections::HashMap, sync::Arc};

    use services::services::execution_process::spawn_stream_raw_logs_to_storage;
    use tokio::sync::RwLock;
    use utils::{execution_logs::process_log_file_path, log_msg::LogMsg, msg_store::MsgStore};
    let temp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(temp.path()).unwrap();
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
    let files = FileService::new(pool.clone()).unwrap();
    let session = Uuid::new_v4();
    let observed_id = Uuid::new_v4();
    let control_id = Uuid::new_v4();
    let observer = ArtifactObserver::start(
        root.clone(),
        root,
        Uuid::new_v4(),
        session,
        observed_id,
        files.clone(),
    )
    .await
    .unwrap();
    let store = Arc::new(MsgStore::new());
    let stores = Arc::new(RwLock::new(HashMap::from([
        (observed_id, store.clone()),
        (control_id, store.clone()),
    ])));
    let db = db::DBService { pool: pool.clone() };
    let held_connection = pool.acquire().await.unwrap();
    let observed = spawn_stream_raw_logs_to_storage(
        stores.clone(),
        db.clone(),
        observed_id,
        session,
        Some(observer),
    );
    let control = spawn_stream_raw_logs_to_storage(stores, db, control_id, session, None);
    store.push_stdout("warmup\n");
    for id in [observed_id, control_id] {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if tokio::fs::read_to_string(process_log_file_path(session, id))
                    .await
                    .unwrap_or_default()
                    .contains("warmup")
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
    store.push_patch(
        executors::logs::utils::patch::ConversationPatch::add_normalized_entry(
            0,
            NormalizedEntry {
                timestamp: None,
                metadata: None,
                entry_type: NormalizedEntryType::AssistantMessage,
                content: "```html\n<html><body>report</body></html>\n```".into(),
            },
        ),
    );
    tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
    for index in 0..1500 {
        store.push_stdout(format!("message-{index}\n"));
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    }
    for version in 1..=3 {
        store.push_patch(executors::logs::utils::patch::ConversationPatch::replace(
            0,
            NormalizedEntry {
                timestamp: None,
                metadata: None,
                entry_type: NormalizedEntryType::AssistantMessage,
                content: format!("```html\n<html><body>version {version}</body></html>\n```"),
            },
        ));
    }
    store.push(LogMsg::StorageFinished);
    drop(held_connection);
    tokio::time::timeout(std::time::Duration::from_secs(15), observed)
        .await
        .unwrap()
        .unwrap();
    control.await.unwrap();
    let observed_count = tokio::fs::read_to_string(process_log_file_path(session, observed_id))
        .await
        .unwrap()
        .lines()
        .count();
    let control_count = tokio::fs::read_to_string(process_log_file_path(session, control_id))
        .await
        .unwrap()
        .lines()
        .count();
    let manifest = artifacts::load(session, observed_id)
        .await
        .unwrap()
        .unwrap();
    assert!(manifest.list.complete);
    let artifact = &manifest.list.artifacts[0];
    let content = tokio::fs::read_to_string(
        artifacts::directory(session, observed_id).join(artifact.content_hash.as_ref().unwrap()),
    )
    .await
    .unwrap();
    assert!(
        content.contains("version 3"),
        "finalization must drain the latest replacement"
    );
    files.delete_orphaned_files().await.unwrap();
    tokio::fs::remove_dir_all(utils::execution_logs::process_logs_session_dir(session))
        .await
        .unwrap();
    println!(
        "Raw log lines: with artifact observer={observed_count}, control without observer={control_count}, expected=1501"
    );
    assert_eq!(control_count, 1501);
    assert_eq!(
        observed_count, control_count,
        "artifact storage must not stall the sole raw-log persistence consumer"
    );
}
