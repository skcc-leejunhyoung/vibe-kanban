//! Shared, bounded reads of executor-owned child transcripts. Callers must
//! establish ownership from the parent execution, never client paths.
use anyhow::{Context, Result};
use db::models::execution_process::ExecutionProcess;
use executors::{
    executors::{
        CodingAgent, StandardCodingAgentExecutor, SubagentLiveHandle,
        claude::{task_output_to_entries, task_output_to_markdown},
        codex::{
            Codex,
            transcript::{thread_transcript_entries, thread_transcript_markdown},
        },
    },
    logs::{NormalizedEntry, NormalizedEntryType, SubagentControlTarget},
    profile::ExecutorConfigs,
};

pub const TRANSCRIPT_MAX_BYTES: usize = 512 * 1024;

pub fn scope(target: &SubagentControlTarget) -> String {
    match target {
        SubagentControlTarget::Codex { thread_id } => format!("codex:{thread_id}"),
        SubagentControlTarget::ClaudeCode { task_id, .. } => format!("claude:{task_id}"),
    }
}

pub async fn read(
    target: &SubagentControlTarget,
    agent_session_id: Option<&str>,
    working_dir: &str,
    handle: Option<&SubagentLiveHandle>,
    codex: Option<&Codex>,
) -> Result<(String, Vec<NormalizedEntry>, bool)> {
    match target {
        SubagentControlTarget::Codex { thread_id } => {
            let live = if let Some(SubagentLiveHandle::Codex(client)) = handle {
                tokio::time::timeout(
                    std::time::Duration::from_secs(2),
                    client.thread_read_full(thread_id.clone()),
                )
                .await
                .ok()
                .and_then(Result::ok)
                .map(|response| response.thread)
            } else {
                None
            };
            let thread = match live {
                Some(thread) => thread,
                None => {
                    codex
                        .context("Codex transcript reader unavailable")?
                        .read_thread_transcript(thread_id)
                        .await?
                }
            };
            Ok((
                thread_transcript_markdown(&thread),
                thread_transcript_entries(&thread, working_dir),
                false,
            ))
        }
        SubagentControlTarget::ClaudeCode {
            task_id,
            output_file,
        } => {
            let session = agent_session_id.context("Claude session is unavailable")?;
            let path = match output_file.as_ref().filter(|path| !path.is_empty()) {
                Some(path) => path.clone(),
                None => {
                    find_live_claude_task_output_file(session, task_id)
                        .await
                        .context("No transcript reported for this task")?
                        .0
                }
            };
            let (bytes, truncated) =
                read_file_tail(&path, task_id, session, TRANSCRIPT_MAX_BYTES).await?;
            let text = String::from_utf8_lossy(&bytes);
            let mut content = task_output_to_markdown(&text);
            let mut entries = task_output_to_entries(&text, working_dir);
            if truncated {
                content = format!("_… transcript truncated …_\n\n{content}");
                entries.insert(
                    0,
                    NormalizedEntry {
                        timestamp: None,
                        metadata: None,
                        entry_type: NormalizedEntryType::SystemMessage,
                        content: "… transcript truncated …".into(),
                    },
                );
            }
            Ok((content, entries, truncated))
        }
    }
}

/// Derive the SDK transcript path and session from this process's notification.
pub fn find_claude_task_output_file(stdout: &str, task_id: &str) -> Option<(String, String)> {
    stdout.lines().find_map(|line| {
        let value = serde_json::from_str::<serde_json::Value>(line.trim()).ok()?;
        if value.get("subtype").and_then(|value| value.as_str()) != Some("task_notification")
            || value.get("task_id").and_then(|value| value.as_str()) != Some(task_id)
        {
            return None;
        }
        let path = value.get("output_file")?.as_str()?;
        let session_id = value.get("session_id")?.as_str()?;
        (!path.is_empty()).then(|| (path.to_string(), session_id.to_string()))
    })
}

pub fn find_claude_session_id(stdout: &str) -> Option<String> {
    stdout.lines().find_map(|line| {
        let value = serde_json::from_str::<serde_json::Value>(line.trim()).ok()?;
        value
            .get("session_id")
            .and_then(|value| value.as_str())
            .filter(|session_id| !session_id.is_empty())
            .map(str::to_string)
    })
}

async fn find_live_claude_task_output_file(
    session_id: &str,
    task_id: &str,
) -> Option<(String, String)> {
    let projects = executors::executors::claude::claude_projects_dir()?;
    let mut entries = tokio::fs::read_dir(projects).await.ok()?;
    let file_name = format!("agent-{task_id}.jsonl");
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry
            .path()
            .join(session_id)
            .join("subagents")
            .join(&file_name);
        if tokio::fs::try_exists(&path).await.ok()? {
            return Some((path.to_string_lossy().into_owned(), session_id.to_string()));
        }
    }
    None
}

/// Read at most the last `max_bytes` of a regular file. Refuses special files
/// and never buffers more than the cap, so a hostile/huge path can't blow up
/// memory. Returns the bytes and whether the head was cut off.
fn task_transcript_path_matches(path: &std::path::Path, task_id: &str, session_id: &str) -> bool {
    let expected_file = format!("{task_id}.output");
    path.file_name().and_then(|name| name.to_str()) == Some(&expected_file)
        && path
            .parent()
            .and_then(|dir| dir.file_name())
            .and_then(|name| name.to_str())
            == Some("tasks")
        && path
            .parent()
            .and_then(std::path::Path::parent)
            .and_then(|dir| dir.file_name())
            .and_then(|name| name.to_str())
            == Some(session_id)
}

fn canonical_task_transcript_path_matches(
    path: &std::path::Path,
    task_id: &str,
    session_id: &str,
) -> bool {
    let expected_file = format!("agent-{task_id}.jsonl");
    task_transcript_path_matches(path, task_id, session_id)
        || (path.file_name().and_then(|name| name.to_str()) == Some(expected_file.as_str())
            && path
                .parent()
                .and_then(|dir| dir.file_name())
                .and_then(|name| name.to_str())
                == Some("subagents")
            && path
                .parent()
                .and_then(std::path::Path::parent)
                .and_then(|dir| dir.file_name())
                .and_then(|name| name.to_str())
                == Some(session_id))
}

pub async fn read_file_tail(
    path: &str,
    task_id: &str,
    session_id: &str,
    max_bytes: usize,
) -> std::io::Result<(Vec<u8>, bool)> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};

    let path = std::path::Path::new(path);
    if !canonical_task_transcript_path_matches(path, task_id, session_id) {
        return Err(std::io::Error::other("invalid task transcript path"));
    }
    let path = tokio::fs::canonicalize(path).await?;
    if !canonical_task_transcript_path_matches(&path, task_id, session_id) {
        return Err(std::io::Error::other(
            "invalid canonical task transcript path",
        ));
    }
    let metadata = tokio::fs::symlink_metadata(&path).await?;
    if !metadata.file_type().is_file() {
        return Err(std::io::Error::other("not a regular file"));
    }
    let mut options = tokio::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    let mut file = options.open(&path).await?;
    let opened = file.metadata().await?;
    if !opened.is_file() {
        return Err(std::io::Error::other("not a regular file"));
    }
    let start = opened.len().saturating_sub(max_bytes as u64);
    if start > 0 {
        file.seek(std::io::SeekFrom::Start(start)).await?;
    }
    let mut bytes = Vec::new();
    file.take(max_bytes as u64).read_to_end(&mut bytes).await?;
    // A running subagent appends while we read, so length/mtime drift is
    // expected. Identity is what must hold: the path still resolves to the
    // same inode we opened and read from.
    let current = tokio::fs::metadata(&path).await?;
    if tokio::fs::canonicalize(&path).await? != path {
        return Err(std::io::Error::other(
            "transcript path changed while reading",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.dev() != opened.dev()
            || metadata.ino() != opened.ino()
            || opened.dev() != current.dev()
            || opened.ino() != current.ino()
        {
            return Err(std::io::Error::other("transcript changed while reading"));
        }
    }
    Ok((bytes, start > 0))
}

/// Resolve the Codex executor for an exited process so its thread rollouts can
/// still be read via a short-lived app-server probe.
pub fn codex_from_process(
    execution_process: &ExecutionProcess,
) -> Result<executors::executors::codex::Codex> {
    let action = execution_process
        .executor_action()
        .map_err(|e| anyhow::Error::msg(e.to_string()))?;
    let config = match action.typ() {
        executors::actions::ExecutorActionType::CodingAgentInitialRequest(req) => {
            &req.executor_config
        }
        executors::actions::ExecutorActionType::CodingAgentFollowUpRequest(req) => {
            &req.executor_config
        }
        executors::actions::ExecutorActionType::ReviewRequest(req) => &req.executor_config,
        executors::actions::ExecutorActionType::ScriptRequest(_) => {
            return Err(anyhow::Error::msg(
                "process has no coding-agent executor".to_string(),
            ));
        }
    };
    let mut agent = ExecutorConfigs::get_cached()
        .get_coding_agent(&config.profile_id())
        .ok_or_else(|| anyhow::Error::msg("unknown executor profile".to_string()))?;
    if config.has_overrides() {
        agent.apply_overrides(config);
    }
    match agent {
        CodingAgent::Codex(codex) => Ok(codex),
        _ => Err(anyhow::Error::msg(
            "subagent target does not match the process executor".to_string(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    /// A running subagent appends to its transcript while the dialog reads it.
    /// Growth is normal, not an error — only a change of file identity is.
    #[tokio::test]
    async fn read_file_tail_tolerates_a_growing_transcript() {
        let dir = tempfile::tempdir().unwrap();
        let session = "session-1";
        let task = "task-1";
        let subagents = dir.path().join(session).join("subagents");
        std::fs::create_dir_all(&subagents).unwrap();
        let path = subagents.join(format!("agent-{task}.jsonl"));
        std::fs::write(&path, "x".repeat(1 << 20)).unwrap();

        let appended = path.clone();
        let writer = std::thread::spawn(move || {
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(appended)
                .unwrap();
            for _ in 0..200 {
                file.write_all(&[b'y'; 4096]).unwrap();
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        });

        let path = path.to_string_lossy().into_owned();
        for _ in 0..50 {
            super::read_file_tail(&path, task, session, 1 << 20)
                .await
                .expect("a growing transcript must stay readable");
        }
        writer.join().unwrap();
    }
}
