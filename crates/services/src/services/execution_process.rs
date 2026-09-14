use std::{
    collections::HashMap,
    io::{IsTerminal, Write},
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result};
use chrono::Utc;
use db::{
    DBService,
    models::{
        coding_agent_turn::CodingAgentTurn, execution_process::ExecutionProcess,
        execution_process_logs::ExecutionProcessLogs, scheduled_resume::ScheduledResume,
    },
};
use futures::{StreamExt, TryStreamExt};
use indicatif::{ProgressBar, ProgressStyle};
use sqlx::SqlitePool;
use tokio::{
    io::AsyncWriteExt,
    sync::{RwLock, mpsc},
    task::JoinHandle,
};
use utils::{
    assets::prod_asset_dir_path,
    execution_logs::{
        ExecutionLogWriter, process_log_file_path, process_log_file_path_in_root,
        read_execution_log_file,
    },
    log_msg::LogMsg,
    msg_store::MsgStore,
};
use uuid::Uuid;

pub async fn migrate_execution_logs_to_files() -> Result<()> {
    let pool = DBService::new_migration_pool()
        .await
        .map_err(|e| anyhow::anyhow!("Migration DB pool error: {}", e))?;

    if !ExecutionProcessLogs::has_any(&pool).await? {
        return Ok(());
    }

    let is_tty = std::io::stderr().is_terminal();
    if is_tty {
        let _ = writeln!(
            std::io::stderr(),
            "Performing one time database migration to move logs from SQLite to flat file to improve performance, data remains local, may take a few minutes, please don't exit while this process is running..."
        );
    }

    let pb = if is_tty {
        Some(new_spinner("Migrating"))
    } else {
        None
    };

    let total_processes = Arc::new(std::sync::atomic::AtomicUsize::new(0));

    let count_task = {
        let pool = pool.clone();
        let pb = pb.clone();
        let total_processes = total_processes.clone();
        tokio::spawn(async move {
            if let Ok(count) = ExecutionProcessLogs::count_distinct_processes(&pool).await {
                total_processes.store(count as usize, std::sync::atomic::Ordering::Relaxed);
                if let Some(pb) = pb {
                    pb.set_length(count as u64);
                    pb.set_style(
                        ProgressStyle::default_bar()
                            .template("{bar:36.yellow} {percent:>3}% {msg:<12.dim}")
                            .unwrap_or_else(|_| ProgressStyle::default_bar())
                            .progress_chars("■⬝"),
                    );
                }
            }
        })
    };

    let completed = Arc::new(std::sync::atomic::AtomicUsize::new(0));

    ExecutionProcessLogs::stream_distinct_processes(&pool)
        .map_err(anyhow::Error::from)
        .map(|res| {
            let pool = pool.clone();
            let pb = pb.clone();
            let completed = completed.clone();
            let total_processes = total_processes.clone();
            async move {
                let p = res?;

                let path = process_log_file_path(p.session_id, p.execution_id);
                if path.exists() {
                    if let Some(pb) = &pb {
                        pb.inc(1);
                    }
                    return Ok::<(), anyhow::Error>(());
                }

                if let Some(parent) = path.parent() {
                    tokio::fs::create_dir_all(parent).await?;
                }

                let temp_path = path.with_extension("jsonl.tmp");
                let mut file = tokio::fs::OpenOptions::new()
                    .create(true)
                    .write(true)
                    .truncate(true)
                    .open(&temp_path)
                    .await?;

                let mut logs_stream =
                    ExecutionProcessLogs::stream_log_lines_by_execution_id(&pool, &p.execution_id);
                let mut has_logs = false;
                while let Some(log_res) = logs_stream.next().await {
                    let log = log_res?;
                    has_logs = true;
                    let mut line = log;
                    if !line.ends_with('\n') {
                        line.push('\n');
                    }
                    file.write_all(line.as_bytes()).await?;
                }

                if !has_logs {
                    let _ = tokio::fs::remove_file(&temp_path).await;
                    if let Some(pb) = &pb {
                        pb.inc(1);
                    }
                    return Ok::<(), anyhow::Error>(());
                }

                file.sync_all().await?;
                tokio::fs::rename(temp_path, path).await?;

                let c = completed.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;

                if let Some(pb) = &pb {
                    pb.inc(1);
                } else if c.is_multiple_of(100) {
                    let t = total_processes.load(std::sync::atomic::Ordering::Relaxed);
                    let _ = writeln!(
                        std::io::stderr(),
                        "sqlite-migration:{}",
                        if t > 0 {
                            (c * 100 / t).to_string()
                        } else {
                            "?".to_string()
                        }
                    );
                }

                Ok::<(), anyhow::Error>(())
            }
        })
        .buffer_unordered(64)
        .try_collect::<Vec<_>>()
        .await?;

    let _ = count_task.await;

    if let Some(pb) = pb {
        pb.finish_and_clear();
    } else {
        let _ = writeln!(std::io::stderr(), "sqlite-migration:done");
    }

    let vacuum_pb = if is_tty {
        Some(new_spinner("Compacting"))
    } else {
        let _ = writeln!(std::io::stderr(), "Compacting database...");
        None
    };

    ExecutionProcessLogs::delete_all(&pool).await?;
    sqlx::query("VACUUM").execute(&pool).await?;

    if let Some(pb) = vacuum_pb {
        pb.finish_and_clear();
    }

    let _ = writeln!(std::io::stderr(), "Database migration complete.");

    pool.close().await;

    Ok(())
}

pub async fn remove_session_process_logs(session_id: Uuid) -> Result<()> {
    let dir = utils::execution_logs::process_logs_session_dir(session_id);
    match tokio::fs::remove_dir_all(&dir).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => {
            Err(e).with_context(|| format!("remove session process logs at {}", dir.display()))
        }
    }
}

pub async fn load_raw_log_messages(pool: &SqlitePool, execution_id: Uuid) -> Option<Vec<LogMsg>> {
    if let Some(jsonl) = read_execution_logs_for_execution(pool, execution_id)
        .await
        .inspect_err(|e| {
            tracing::warn!(
                "Failed to read execution log file for execution {}: {:#}",
                execution_id,
                e
            );
        })
        .ok()
        .flatten()
    {
        // Parsing a large JSONL log (tens of MB, tens of thousands of lines)
        // is CPU-bound and yields nothing to the async scheduler. Running it
        // inline on a tokio worker starves other tasks — including the
        // supervisor's `/api/health` probe, which then trips a restart. Offload
        // to the blocking pool so the async workers stay responsive.
        let messages = tokio::task::spawn_blocking(move || {
            utils::execution_logs::parse_log_jsonl_lossy(execution_id, &jsonl)
        })
        .await
        .unwrap_or_else(|e| {
            tracing::error!(
                "Log-parse task panicked/cancelled for execution {}: {}",
                execution_id,
                e
            );
            Vec::new()
        });
        if !messages.is_empty() {
            return Some(messages);
        }
    }

    let db_log_records = match ExecutionProcessLogs::find_by_execution_id(pool, execution_id).await
    {
        Ok(records) if !records.is_empty() => records,
        Ok(_) => return None,
        Err(e) => {
            tracing::error!(
                "Failed to fetch DB logs for execution {}: {}",
                execution_id,
                e
            );
            return None;
        }
    };

    match ExecutionProcessLogs::parse_logs(&db_log_records) {
        Ok(msgs) => Some(msgs),
        Err(e) => {
            tracing::error!(
                "Failed to parse DB logs for execution {}: {}",
                execution_id,
                e
            );
            None
        }
    }
}

pub async fn append_log_message(session_id: Uuid, execution_id: Uuid, msg: &LogMsg) -> Result<()> {
    let mut log_writer = ExecutionLogWriter::new_for_execution(session_id, execution_id)
        .await
        .with_context(|| format!("create log writer for execution {}", execution_id))?;
    let json_line = serde_json::to_string(msg)
        .with_context(|| format!("serialize log message for execution {}", execution_id))?;
    let mut json_line_with_newline = json_line;
    json_line_with_newline.push('\n');
    log_writer
        .append_jsonl_line(&json_line_with_newline)
        .await
        .with_context(|| format!("append log message for execution {}", execution_id))?;
    log_writer
        .flush()
        .await
        .with_context(|| format!("flush log message for execution {}", execution_id))?;
    Ok(())
}

/// Idle gap after which buffered raw-log lines are written out to disk.
const LOG_FLUSH_IDLE: Duration = Duration::from_secs(1);

enum TurnUpdate {
    SessionId(String),
    MessageId(String),
    ScheduledResume(String),
}

/// Apply turn metadata updates in arrival order on a task of their own: a
/// contended sqlite pool then stalls this task, never the raw-log consumer,
/// which would otherwise fall behind the broadcast and lose lines.
fn spawn_turn_updates(
    pool: SqlitePool,
    execution_id: Uuid,
    session_id: Uuid,
) -> (mpsc::UnboundedSender<TurnUpdate>, JoinHandle<()>) {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        while let Some(update) = rx.recv().await {
            match update {
                TurnUpdate::SessionId(agent_session_id) => {
                    if let Err(e) = CodingAgentTurn::update_agent_session_id(
                        &pool,
                        execution_id,
                        &agent_session_id,
                    )
                    .await
                    {
                        tracing::error!(
                            "Failed to update agent_session_id {} for execution process {}: {}",
                            agent_session_id,
                            execution_id,
                            e
                        );
                    }
                }
                TurnUpdate::MessageId(agent_message_id) => {
                    if let Err(e) = CodingAgentTurn::update_agent_message_id(
                        &pool,
                        execution_id,
                        &agent_message_id,
                    )
                    .await
                    {
                        tracing::error!(
                            "Failed to update agent_message_id {} for execution process {}: {}",
                            agent_message_id,
                            execution_id,
                            e
                        );
                    }
                }
                TurnUpdate::ScheduledResume(crons_json) => {
                    persist_scheduled_resumes(&pool, session_id, &crons_json).await;
                }
            }
        }
    });
    (tx, task)
}

async fn flush_log_writer(writer: &mut Option<ExecutionLogWriter>, execution_id: Uuid) {
    if let Some(writer) = writer
        && let Err(e) = writer.flush().await
    {
        tracing::error!(
            "Failed to flush log file for execution {}: {}",
            execution_id,
            e
        );
    }
}

pub fn spawn_stream_raw_logs_to_storage(
    msg_stores: Arc<RwLock<HashMap<Uuid, Arc<MsgStore>>>>,
    db: DBService,
    execution_id: Uuid,
    session_id: Uuid,
    artifacts: Option<super::artifacts::ArtifactObserver>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut log_writer =
            match ExecutionLogWriter::new_for_execution(session_id, execution_id).await {
                Ok(w) => Some(w),
                Err(e) => {
                    tracing::error!(
                        "Failed to create log file writer for execution {}: {}",
                        execution_id,
                        e
                    );
                    None
                }
            };

        let store = {
            let map = msg_stores.read().await;
            map.get(&execution_id).cloned()
        };

        if let Some(store) = store {
            let mut stream = store.history_plus_stream();
            // Coalesce streamed replacements while the observer is busy. Never
            // await snapshot/CLI I/O in the sole raw-log persistence consumer.
            let artifact_updates = Arc::new(std::sync::Mutex::new((
                std::collections::BTreeMap::new(),
                None::<String>,
            )));
            let (artifact_done, mut done) = tokio::sync::oneshot::channel::<()>();
            let artifact_task = artifacts.map(|mut observer| {
                let updates = artifact_updates.clone();
                tokio::spawn(async move {
                    let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
                    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                    loop {
                        let complete = tokio::select! {
                            _ = &mut done => true,
                            _ = interval.tick() => false,
                        };
                        let (entries, session_id) = std::mem::take(&mut *updates.lock().unwrap());
                        if let Some(session_id) = session_id {
                            observer.set_agent_session_id(&session_id);
                        }
                        for (index, entry) in entries {
                            observer.observe_entry(index, &entry).await;
                        }
                        if let Err(error) = observer.tick(complete).await {
                            tracing::warn!(%execution_id, %error, complete, "Artifact snapshot failed");
                        }
                        if complete {
                            break;
                        }
                    }
                })
            });
            let (updates, update_task) =
                spawn_turn_updates(db.pool.clone(), execution_id, session_id);
            loop {
                let msg = match tokio::time::timeout(LOG_FLUSH_IDLE, stream.next()).await {
                    Ok(Some(Ok(msg))) => msg,
                    Ok(Some(Err(error))) => {
                        // Only an unrecoverable broadcast lag (span evicted from
                        // history) reaches here; the file is missing that span.
                        tracing::error!(
                            %execution_id,
                            %error,
                            "Execution log stream lost messages; raw log is incomplete"
                        );
                        continue;
                    }
                    Ok(None) => break,
                    Err(_idle) => {
                        flush_log_writer(&mut log_writer, execution_id).await;
                        continue;
                    }
                };
                match &msg {
                    LogMsg::Stdout(_) | LogMsg::Stderr(_) => match serde_json::to_string(&msg) {
                        Ok(jsonl_line) => {
                            let mut jsonl_line_with_newline = jsonl_line;
                            jsonl_line_with_newline.push('\n');

                            if let Some(writer) = &mut log_writer
                                && let Err(e) =
                                    writer.append_jsonl_line(&jsonl_line_with_newline).await
                            {
                                tracing::error!(
                                    "Failed to append log line for execution {}: {}",
                                    execution_id,
                                    e
                                );
                            }
                        }
                        Err(e) => {
                            tracing::error!(
                                "Failed to serialize log message for execution {}: {}",
                                execution_id,
                                e
                            );
                        }
                    },
                    LogMsg::SessionId(agent_session_id) => {
                        if artifact_task.is_some() {
                            artifact_updates.lock().unwrap().1 = Some(agent_session_id.clone());
                        }
                        let _ = updates.send(TurnUpdate::SessionId(agent_session_id.clone()));
                    }
                    LogMsg::MessageId(agent_message_id) => {
                        let _ = updates.send(TurnUpdate::MessageId(agent_message_id.clone()));
                    }
                    LogMsg::ScheduledResume(crons_json) => {
                        let _ = updates.send(TurnUpdate::ScheduledResume(crons_json.clone()));
                    }
                    LogMsg::StorageFinished => {
                        break;
                    }
                    LogMsg::JsonPatch(patch) => {
                        if artifact_task.is_some()
                            && let Some((index, entry)) =
                                executors::logs::utils::patch::extract_normalized_entry_from_patch(
                                    patch,
                                )
                        {
                            artifact_updates.lock().unwrap().0.insert(index, entry);
                        }
                    }
                    // The process exited: make its complete raw log visible
                    // to readers before the storage marker arrives.
                    LogMsg::Finished => flush_log_writer(&mut log_writer, execution_id).await,
                    LogMsg::Ready => continue,
                }
            }
            flush_log_writer(&mut log_writer, execution_id).await;
            // The finalization barrier awaits this task, so the follow-up sees
            // the turn's session/message ids once every queued update landed.
            drop(updates);
            if let Err(error) = update_task.await {
                tracing::error!(%execution_id, %error, "Turn metadata updater failed");
            }
            // The execution's existing finalization barrier also waits for the
            // last coalesced entries and filesystem snapshot to be preserved.
            drop(artifact_done);
            if let Some(task) = artifact_task
                && let Err(error) = task.await
            {
                tracing::error!(%execution_id, %error, "Artifact observer failed");
            }
        }
    })
}

/// Persist agent-scheduled wakeups (claude `session_crons`) forwarded by the
/// Stop hook as ScheduledResume rows. Each cron's 5-field schedule is resolved
/// to an absolute `next_fire_at`; the unique (session_id, cron_id) index keeps
/// a cron re-reported on every Stop registered only once. Best-effort: parse or
/// persistence failures are logged and skipped, never surfaced to the agent.
async fn persist_scheduled_resumes(pool: &SqlitePool, session_id: Uuid, crons_json: &str) {
    let crons: Vec<serde_json::Value> = match serde_json::from_str(crons_json) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(
                "Failed to parse scheduled_resume payload for session {session_id}: {e}"
            );
            return;
        }
    };
    let now = Utc::now();
    for cron in &crons {
        let (Some(cron_id), Some(schedule), Some(prompt)) = (
            cron.get("id").and_then(|v| v.as_str()),
            cron.get("schedule").and_then(|v| v.as_str()),
            cron.get("prompt").and_then(|v| v.as_str()),
        ) else {
            continue;
        };
        let recurring = cron
            .get("recurring")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let Some(next_fire_at) = ScheduledResume::next_fire_at_for_registration(schedule, now)
        else {
            tracing::warn!(
                "Skipping scheduled resume with unparseable cron '{schedule}' for session {session_id}"
            );
            continue;
        };
        if let Err(e) = ScheduledResume::upsert(
            pool,
            session_id,
            cron_id,
            prompt,
            schedule,
            recurring,
            next_fire_at,
        )
        .await
        {
            tracing::error!("Failed to persist scheduled resume for session {session_id}: {e}");
        }
    }
}

async fn read_execution_logs_for_execution(
    pool: &SqlitePool,
    execution_id: Uuid,
) -> Result<Option<String>> {
    let session_id = if let Some(process) = ExecutionProcess::find_by_id(pool, execution_id).await?
    {
        process.session_id
    } else {
        return Ok(None);
    };
    let path = process_log_file_path(session_id, execution_id);

    match tokio::fs::metadata(&path).await {
        Ok(_) => Ok(Some(read_execution_log_file(&path).await.with_context(
            || format!("read execution log file for execution {execution_id}"),
        )?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if cfg!(debug_assertions) {
                // Convenience for local development with a clone of a prod db. Read only access to prod logs.
                let prod_path =
                    process_log_file_path_in_root(&prod_asset_dir_path(), session_id, execution_id);
                match read_execution_log_file(&prod_path).await {
                    Ok(contents) => return Ok(Some(contents)),
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                    Err(err) => {
                        return Err(err).with_context(|| {
                            format!(
                                "read execution log file for execution {execution_id} from {}",
                                prod_path.display()
                            )
                        });
                    }
                }
            }
            Ok(None)
        }
        Err(e) => Err(e).with_context(|| {
            format!(
                "check execution log file exists for execution {execution_id} at {}",
                path.display()
            )
        }),
    }
}

fn new_spinner(message: &'static str) -> ProgressBar {
    let pb = ProgressBar::new_spinner();
    pb.set_style(
        ProgressStyle::default_spinner()
            .template("{spinner:.yellow} {msg:<12.dim}")
            .unwrap_or_else(|_| ProgressStyle::default_spinner())
            .tick_chars("⠁⠂⠄⡀⢀⠠⠐⠈ "),
    );
    pb.set_message(message);
    pb.enable_steady_tick(std::time::Duration::from_millis(100));
    pb
}
