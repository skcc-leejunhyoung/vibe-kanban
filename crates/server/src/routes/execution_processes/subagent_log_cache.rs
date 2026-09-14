//! Incremental parent-log metadata for subagent polling. File offsets are only
//! advanced past complete records; stdout chunks have their own line boundary.
use std::{
    fs::{File, Metadata},
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Arc, LazyLock},
    time::Duration,
};

use db::models::{
    execution_process::ExecutionProcess, execution_process_logs::ExecutionProcessLogs,
};
use deployment::Deployment;
use executors::logs::SubagentControlTarget;
use moka::future::Cache;
use serde::Deserialize;
use serde_json::Value;
use services::services::container::ContainerService;
use tokio::sync::Mutex;
use utils::{execution_logs::process_log_file_path, log_msg::LogMsg};
use uuid::Uuid;

use crate::DeploymentImpl;

const MAX_PROCESSES: u64 = 32;
const MAX_PROCESS_BYTES: usize = 2 * 1024 * 1024;
const CHECKPOINT_BYTES: usize = 256;

static LOGS: LazyLock<Cache<Uuid, Arc<Mutex<ProcessLogs>>>> = LazyLock::new(|| {
    Cache::builder()
        .max_capacity(MAX_PROCESSES)
        .time_to_idle(Duration::from_secs(600))
        .build()
});

#[derive(Clone, Default)]
pub(super) struct ParsedLogs {
    pub events: Vec<Value>,
    pub session_id: Option<String>,
    bytes: usize,
}

impl ParsedLogs {
    pub(super) fn push_stdout(&mut self, chunk: &str, pending: &mut String) {
        pending.push_str(chunk);
        let end = pending.rfind('\n').map_or(0, |index| index + 1);
        for line in pending[..end].lines() {
            if let Ok(value) = serde_json::from_str(line) {
                self.push_event(value);
            }
        }
        pending.drain(..end);
        // Existing logs also accept a complete final JSON value without LF.
        if let Ok(value) = serde_json::from_str(pending) {
            self.push_event(value);
            pending.clear();
        }
    }

    fn push_event(&mut self, value: Value) {
        if self.session_id.is_none() {
            self.session_id = value
                .get("session_id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_owned);
        }
        let relevant = matches!(
            value.get("subtype").and_then(Value::as_str),
            Some("task_started" | "task_notification")
        ) || (matches!(
            value.get("method").and_then(Value::as_str),
            Some("item/started" | "item/completed")
        ) && matches!(
            value.pointer("/params/item/type").and_then(Value::as_str),
            Some("subAgentActivity" | "collabAgentToolCall")
        )) || (value.get("type").and_then(Value::as_str) == Some("assistant")
            && value
                .pointer("/message/content")
                .and_then(Value::as_array)
                .is_some_and(|items| {
                    items.iter().any(|item| {
                        item.get("type").and_then(Value::as_str) == Some("tool_use")
                            && matches!(
                                item.get("name").and_then(Value::as_str),
                                Some("Task" | "task" | "Agent")
                            )
                    })
                }));
        if relevant {
            self.bytes = self.bytes.saturating_add(value_bytes(&value));
            self.events.push(value);
        }
    }

    pub(super) fn claude_output_file(&self, task_id: &str) -> Option<String> {
        self.events.iter().find_map(|event| {
            if event.get("subtype")?.as_str()? != "task_notification"
                || event.get("task_id")?.as_str()? != task_id
            {
                return None;
            }
            let path = event.get("output_file")?.as_str()?;
            event.get("session_id")?.as_str()?;
            (!path.is_empty()).then(|| path.to_owned())
        })
    }
}

// Include container capacity and conservative map-node overhead, not just text.
fn value_bytes(value: &Value) -> usize {
    std::mem::size_of::<Value>()
        + match value {
            Value::String(s) => s.capacity(),
            Value::Array(items) => {
                items.capacity() * std::mem::size_of::<Value>()
                    + items.iter().map(value_bytes).sum::<usize>()
            }
            Value::Object(fields) => fields
                .iter()
                .map(|(key, value)| 128 + key.capacity() + value_bytes(value))
                .sum(),
            _ => 0,
        }
}

#[derive(Default)]
struct ProcessLogs {
    path: PathBuf,
    metadata: Option<Metadata>,
    offset: u64,
    head_bytes: Vec<u8>,
    tail_bytes: Vec<u8>,
    parsed: Arc<ParsedLogs>,
    pending_stdout: String,
    has_records: bool,
    loaded_legacy: bool,
}

fn same_file(a: &Metadata, b: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        a.dev() == b.dev() && a.ino() == b.ino()
    }
    #[cfg(not(unix))]
    {
        a.created().ok() == b.created().ok()
    }
}

impl ProcessLogs {
    fn checkpoints_match(&self, file: &mut File, bytes_read: &mut u64) -> io::Result<bool> {
        // ponytail: rewrites preserving both windows need a writer generation
        // marker to distinguish them from appends without a full rescan.
        let mut actual = [0; CHECKPOINT_BYTES];
        for (start, expected) in [
            (0, &self.head_bytes),
            (self.offset - self.tail_bytes.len() as u64, &self.tail_bytes),
        ] {
            file.seek(SeekFrom::Start(start))?;
            file.read_exact(&mut actual[..expected.len()])?;
            *bytes_read += expected.len() as u64;
            if &actual[..expected.len()] != expected.as_slice() {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn tail(&mut self, path: &Path) -> io::Result<u64> {
        let mut file = File::open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(io::Error::other("execution log is not a regular file"));
        }
        let mut reset = self.path != path
            || self.metadata.as_ref().is_none_or(|previous| {
                !same_file(previous, &metadata)
                    || self.offset > metadata.len()
                    || previous.len() > metadata.len()
                    || (self.offset == metadata.len()
                        && previous.modified().ok() != metadata.modified().ok())
            });
        let mut bytes_read = 0;
        if !reset
            && self.offset > 0
            && self.metadata.as_ref().is_some_and(|previous| {
                previous.len() != metadata.len()
                    || previous.modified().ok() != metadata.modified().ok()
            })
        {
            // copytruncate can regrow past the old offset between polls. Check
            // bounded windows only when metadata changed; unchanged polls read 0.
            reset = !self.checkpoints_match(&mut file, &mut bytes_read)?;
        }
        if reset {
            *self = Self::default();
            self.path = path.to_owned();
        }
        self.metadata = Some(metadata.clone());
        file.seek(SeekFrom::Start(self.offset))?;
        let mut reader = BufReader::new(file.take(metadata.len() - self.offset));
        let mut line = Vec::new();
        loop {
            line.clear();
            let count = reader.read_until(b'\n', &mut line)?;
            if count == 0 {
                break;
            }
            bytes_read += count as u64;
            // Ignore normalized patches without allocating their JSON trees.
            #[derive(Deserialize)]
            struct StdoutRecord {
                #[serde(rename = "Stdout")]
                stdout: Option<String>,
            }
            let record = serde_json::from_slice::<StdoutRecord>(&line);
            if !line.ends_with(b"\n") && record.is_err() {
                break; // Incomplete JSONL record: retry it after the writer appends.
            }
            self.offset += count as u64;
            self.head_bytes
                .extend_from_slice(&line[..count.min(CHECKPOINT_BYTES - self.head_bytes.len())]);
            let keep = CHECKPOINT_BYTES.saturating_sub(count);
            self.tail_bytes
                .drain(..self.tail_bytes.len().saturating_sub(keep));
            self.tail_bytes
                .extend_from_slice(&line[count.saturating_sub(CHECKPOINT_BYTES)..]);
            if let Ok(record) = record {
                if !self.has_records && self.loaded_legacy {
                    self.parsed = Arc::default();
                    self.pending_stdout.clear();
                }
                self.has_records = true;
                if let Some(stdout) = record.stdout {
                    Arc::make_mut(&mut self.parsed).push_stdout(&stdout, &mut self.pending_stdout);
                }
            }
        }
        Ok(bytes_read)
    }

    fn snapshot(&mut self) -> Arc<ParsedLogs> {
        if self.pending_stdout.capacity() > MAX_PROCESS_BYTES {
            self.pending_stdout.shrink_to(8 * 1024);
        }
        let parsed = self.parsed.clone();
        let bytes = parsed.bytes
            + parsed.events.capacity() * std::mem::size_of::<Value>()
            + parsed.session_id.as_ref().map_or(0, String::capacity)
            + self.pending_stdout.capacity()
            + self.head_bytes.capacity()
            + self.tail_bytes.capacity();
        if bytes > MAX_PROCESS_BYTES {
            // ponytail: oversized metadata is served but not retained; reread on
            // the next poll. Add an on-disk index if this rare case is common.
            *self = Self::default();
        }
        parsed
    }
}

pub(super) async fn read(
    deployment: &DeploymentImpl,
    process: &ExecutionProcess,
    target: &SubagentControlTarget,
) -> Arc<ParsedLogs> {
    let slot = LOGS
        .get_with(process.id, async {
            Arc::new(Mutex::new(ProcessLogs::default()))
        })
        .await;
    let mut state = slot.lock_owned().await;
    let path = process_log_file_path(process.session_id, process.id);
    let session_id = process.session_id;
    let process_id = process.id;
    let result = tokio::task::spawn_blocking(move || {
        let mut result = state.tail(&path);
        if cfg!(debug_assertions)
            && result
                .as_ref()
                .is_err_and(|e| e.kind() == io::ErrorKind::NotFound)
        {
            let path = utils::execution_logs::process_log_file_path_in_root(
                &utils::assets::prod_asset_dir_path(),
                session_id,
                process_id,
            );
            result = state.tail(&path);
        }
        if let Err(error) = &result {
            if error.kind() != io::ErrorKind::NotFound {
                tracing::warn!(%process_id, %error, "Cannot tail subagent parent log");
            }
            if state.metadata.is_some() {
                *state = ProcessLogs::default();
            }
        }
        let has_records = state.has_records;
        // Enforce retention before returning from the blocking task, including
        // when the HTTP request was cancelled while it was reading the file.
        let parsed = state.snapshot();
        (state, result, parsed, has_records)
    })
    .await;
    let (mut state, result, mut parsed, has_records) = match result {
        Ok(result) => result,
        Err(error) => {
            tracing::warn!(%process_id, %error, "Subagent log reader failed");
            return Arc::default();
        }
    };
    // Pre-file-migration logs are immutable. Load that fallback once per entry.
    if !has_records
        && !state.loaded_legacy
        && let Ok(records) =
            ExecutionProcessLogs::find_by_execution_id(&deployment.db().pool, process_id).await
        && let Ok(messages) = ExecutionProcessLogs::parse_logs(&records)
    {
        for message in messages {
            if let LogMsg::Stdout(stdout) = message {
                let state = &mut *state;
                Arc::make_mut(&mut state.parsed).push_stdout(&stdout, &mut state.pending_stdout);
            }
        }
        state.loaded_legacy = true;
        parsed = state.snapshot();
    }
    let needs_live = result.is_err() || !super::process_owns_target(&parsed.events, target);
    drop(state);
    if needs_live
        && let Some(store) = deployment
            .container()
            .get_msg_store_by_id(&process_id)
            .await
    {
        // Storage may trail the live event that opened the dialog, or fail.
        // Only that fallback copies stdout; normalized history is never cloned.
        return tokio::task::spawn_blocking(move || {
            let stdout: String = store.with_history(|messages| {
                messages
                    .filter_map(|msg| match msg {
                        LogMsg::Stdout(chunk) => Some(chunk.as_str()),
                        _ => None,
                    })
                    .collect()
            });
            let mut live = ParsedLogs::default();
            live.push_stdout(&stdout, &mut String::new());
            live.session_id = live.session_id.or_else(|| parsed.session_id.clone());
            live.events.extend(parsed.events.iter().cloned());
            Arc::new(live)
        })
        .await
        .unwrap_or_default();
    }
    parsed
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use serde_json::json;

    use super::*;

    fn line(chunk: &str) -> Vec<u8> {
        let mut bytes = serde_json::to_vec(&LogMsg::Stdout(chunk.to_owned())).unwrap();
        bytes.push(b'\n');
        bytes
    }

    fn notification(task: &str) -> String {
        format!(
            "{}\n",
            json!({"type":"system", "subtype":"task_notification", "task_id":task,
            "session_id":"session", "output_file":format!("/tmp/session/tasks/{task}.output")})
        )
    }

    #[test]
    fn tail_reads_only_new_bytes_and_retains_split_jsonl_and_stdout() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("process.jsonl");
        let mut writer = File::create(&path).unwrap();
        for _ in 0..10_000 {
            writer
                .write_all(&line(
                    "{\"type\":\"assistant\",\"message\":{\"content\":\"irrelevant\"}}\n",
                ))
                .unwrap();
        }
        writer.write_all(&line(&notification("first"))).unwrap();
        let mut cache = ProcessLogs::default();
        let initial = cache.tail(&path).unwrap();
        let first = cache.snapshot();
        assert_eq!(first.events.len(), 1);
        assert_eq!(first.session_id.as_deref(), Some("session"));
        assert!(first.claude_output_file("missing").is_none());
        assert_eq!(cache.tail(&path).unwrap(), 0);
        assert!(Arc::ptr_eq(&first, &cache.snapshot()));

        let event = notification("다음");
        let split = event.find("다음").unwrap();
        writer.write_all(&line(&event[..split])).unwrap();
        cache.tail(&path).unwrap();
        assert_eq!(cache.parsed.events.len(), 1);
        let next = line(&event[split..]);
        // Split the outer UTF-8 JSONL record inside a Korean character.
        let split = next.iter().position(|byte| *byte >= 128).unwrap() + 1;
        writer.write_all(&next[..split]).unwrap();
        let offset = cache.offset;
        cache.tail(&path).unwrap();
        assert_eq!(cache.offset, offset);
        writer.write_all(&next[split..]).unwrap();
        let appended = cache.tail(&path).unwrap();
        assert_eq!(appended as usize, next.len() + CHECKPOINT_BYTES * 2);
        assert_eq!(cache.parsed.events.len(), 2);
        assert_eq!(
            cache.parsed.claude_output_file("다음").as_deref(),
            Some("/tmp/session/tasks/다음.output")
        );
        assert_eq!(
            first.events.len(),
            1,
            "in-flight readers keep their own snapshot"
        );
        assert_eq!(cache.tail(&path).unwrap(), 0);
        println!(
            "SKC-4774 parent-log tail: initial_bytes={initial} unchanged_poll_bytes=0 appended_record_bytes={} checkpoint_bytes={} total_read_bytes={appended} retained_events=2",
            next.len(),
            CHECKPOINT_BYTES * 2
        );
    }

    #[test]
    fn truncation_and_rotation_reset_ownership_and_partial_stdout() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("process.jsonl");
        std::fs::write(
            &path,
            [line(&notification("old")), line("{\"partial\":")].concat(),
        )
        .unwrap();
        let mut cache = ProcessLogs::default();
        cache.tail(&path).unwrap();
        assert!(!cache.pending_stdout.is_empty());
        std::fs::write(&path, line(&notification("new"))).unwrap();
        cache.tail(&path).unwrap();
        assert!(cache.parsed.claude_output_file("old").is_none());
        assert!(cache.pending_stdout.is_empty());
        assert!(cache.parsed.claude_output_file("new").is_some());

        // Replacement has the same size: offset > length alone is insufficient.
        let rotated = dir.path().join("replacement.jsonl");
        std::fs::write(&rotated, line(&notification("rot"))).unwrap();
        std::fs::rename(rotated, &path).unwrap();
        cache.tail(&path).unwrap();
        assert!(cache.parsed.claude_output_file("new").is_none());
        assert!(cache.parsed.claude_output_file("rot").is_some());
    }

    #[test]
    fn copytruncate_regrowth_resets_cached_events_and_partial_stdout() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("process.jsonl");
        let padding =
            line("{\"type\":\"assistant\",\"message\":\"unchanged padding\"}\n").repeat(8);
        // Exercise both checkpoints: an unchanged prefix or an unchanged tail
        // must not hide a rewritten ownership event elsewhere in the log.
        for (prefix, suffix) in [
            (Vec::new(), Vec::new()),
            (padding.clone(), Vec::new()),
            (Vec::new(), padding.clone()),
        ] {
            let old = [
                prefix.clone(),
                line(&notification("old")),
                suffix.clone(),
                line("{\"partial\":"),
            ]
            .concat();
            std::fs::write(&path, &old).unwrap();
            let mut cache = ProcessLogs::default();
            cache.tail(&path).unwrap();
            let previous = cache.snapshot();
            assert!(!cache.pending_stdout.is_empty());
            let metadata = std::fs::metadata(&path).unwrap();

            let replacement = [
                prefix,
                line(&notification("new")),
                suffix,
                line("{\"partial\":"),
                line(&format!("1}}\n{}", notification("end"))),
            ]
            .concat();
            assert!(replacement.len() > old.len());
            std::fs::write(&path, &replacement).unwrap();
            assert!(same_file(&metadata, &std::fs::metadata(&path).unwrap()));
            cache.tail(&path).unwrap();
            assert!(cache.parsed.claude_output_file("old").is_none());
            assert!(cache.parsed.claude_output_file("new").is_some());
            assert!(cache.parsed.claude_output_file("end").is_some());
            assert!(cache.pending_stdout.is_empty());
            assert!(previous.claude_output_file("old").is_some());
            assert_eq!(cache.tail(&path).unwrap(), 0);
        }
    }

    #[test]
    fn metadata_and_partial_line_caps_do_not_truncate_the_response() {
        let mut cache = ProcessLogs::default();
        let prompt = "x".repeat(MAX_PROCESS_BYTES);
        Arc::make_mut(&mut cache.parsed).push_stdout(
            &format!(
                "{}\n",
                json!({
                    "subtype":"task_started", "task_id":"large", "prompt":prompt
                })
            ),
            &mut cache.pending_stdout,
        );
        let response = cache.snapshot();
        assert_eq!(
            response.events[0]["prompt"].as_str().unwrap().len(),
            MAX_PROCESS_BYTES
        );
        assert!(cache.parsed.events.is_empty());
        cache.pending_stdout = "x".repeat(MAX_PROCESS_BYTES + 1);
        cache.snapshot();
        assert_eq!(cache.pending_stdout.capacity(), 0);
    }

    #[tokio::test]
    async fn process_cache_is_bounded_and_isolates_same_target_names() {
        let cache = &*LOGS;
        let mut parsed = ParsedLogs::default();
        parsed.push_stdout(&notification("same-task"), &mut String::new());
        cache
            .insert(
                Uuid::from_u128(1),
                Arc::new(Mutex::new(ProcessLogs {
                    parsed: Arc::new(parsed),
                    ..Default::default()
                })),
            )
            .await;
        cache.insert(Uuid::from_u128(2), Arc::default()).await;
        assert!(
            cache
                .get(&Uuid::from_u128(2))
                .await
                .unwrap()
                .lock()
                .await
                .parsed
                .events
                .is_empty()
        );
        for id in 3..MAX_PROCESSES + 10 {
            cache
                .insert(Uuid::from_u128(id as u128), Arc::default())
                .await;
        }
        cache.run_pending_tasks().await;
        assert!(cache.entry_count() <= MAX_PROCESSES);
    }
}
