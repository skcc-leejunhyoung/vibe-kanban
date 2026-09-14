use anyhow;
use axum::{
    BoxError, Extension, Json, Router,
    extract::{
        Path, Query, State,
        ws::{CloseFrame, Message, close_code},
    },
    http::StatusCode,
    middleware::from_fn_with_state,
    response::{
        IntoResponse, Json as ResponseJson, Sse,
        sse::{Event, KeepAlive},
    },
    routing::{get, post},
};
use db::models::{
    execution_process::{ExecutionProcess, ExecutionProcessStatus},
    execution_process_repo_state::ExecutionProcessRepoState,
};
use deployment::Deployment;
use executors::{
    executors::{BaseCodingAgent, SubagentLiveHandle},
    logs::{NormalizedEntry, NormalizedEntryType, SubagentControlTarget},
};
use futures_util::{StreamExt, TryStreamExt};
use serde::{Deserialize, Serialize};
#[cfg(test)]
use services::services::subagent_transcript::read_file_tail;
use services::services::{
    container::ContainerService,
    subagent_transcript::{self, find_claude_session_id, find_claude_task_output_file},
};
use tokio::time::{Duration, MissedTickBehavior};
use ts_rs::TS;
use utils::{log_msg::LogMsg, response::ApiResponse, ws_batch::coalesce_ws_stream};
use uuid::Uuid;

use crate::{
    DeploymentImpl,
    error::ApiError,
    middleware::{
        load_execution_process_middleware,
        signed_ws::{MaybeSignedWebSocket, SignedWsUpgrade},
    },
};

#[derive(Debug, Deserialize)]
struct SessionExecutionProcessQuery {
    pub session_id: Uuid,
    /// If true, include soft-deleted (dropped) processes in results/stream
    #[serde(default)]
    pub show_soft_deleted: Option<bool>,
}

async fn get_execution_process_by_id(
    Extension(execution_process): Extension<ExecutionProcess>,
    State(_deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<ExecutionProcess>>, ApiError> {
    Ok(ResponseJson(ApiResponse::success(execution_process)))
}

async fn stream_raw_logs_ws(
    ws: SignedWsUpgrade,
    State(deployment): State<DeploymentImpl>,
    Path(exec_id): Path<Uuid>,
) -> impl IntoResponse {
    // Always accept the WebSocket upgrade — handle "not found" inside the
    // connection by sending `finished` and closing cleanly, instead of
    // rejecting with HTTP 404 which the browser surfaces as an opaque
    // connection failure.
    ws.on_upgrade(move |socket| async move {
        if let Err(e) = handle_raw_logs_ws(socket, deployment, exec_id).await {
            tracing::warn!("raw logs WS closed: {}", e);
        }
    })
}

async fn handle_raw_logs_ws(
    mut socket: MaybeSignedWebSocket,
    deployment: DeploymentImpl,
    exec_id: Uuid,
) -> anyhow::Result<()> {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use executors::logs::utils::patch::ConversationPatch;
    use utils::log_msg::LogMsg;

    // Get the raw stream — if not found, send finished and close cleanly
    let raw_stream = match deployment.container().stream_raw_logs(&exec_id).await {
        Some(stream) => stream,
        None => {
            // No logs available: send finished so the client gets a clean
            // close instead of retrying endlessly.
            let _ = socket
                .send(LogMsg::Finished.to_ws_message_unchecked())
                .await;
            let _ = socket.close().await;
            return Ok(());
        }
    };

    let counter = Arc::new(AtomicUsize::new(0));
    let mut stream = coalesce_ws_stream(raw_stream.map_ok({
        let counter = counter.clone();
        move |m| match m {
            LogMsg::Stdout(content) => {
                let index = counter.fetch_add(1, Ordering::SeqCst);
                LogMsg::JsonPatch(ConversationPatch::add_stdout(index, content))
            }
            LogMsg::Stderr(content) => {
                let index = counter.fetch_add(1, Ordering::SeqCst);
                LogMsg::JsonPatch(ConversationPatch::add_stderr(index, content))
            }
            LogMsg::Finished => LogMsg::Finished,
            _ => unreachable!("Raw stream should only have Stdout/Stderr/Finished"),
        }
    }));

    loop {
        tokio::select! {
            item = stream.next() => {
                match item {
                    Some(Ok(msg)) => {
                        if socket.send(msg).await.is_err() {
                            break;
                        }
                    }
                    Some(Err(e)) => {
                        tracing::error!("stream error: {}", e);
                        break;
                    }
                    None => break,
                }
            }
            inbound = socket.recv() => {
                match inbound {
                    Ok(Some(Message::Close(_))) => break,
                    Ok(Some(_)) => {}
                    Ok(None) => break,
                    Err(_) => break,
                }
            }
        }
    }
    // Send a proper close frame so the client sees code 1000 (normal closure)
    // instead of an abnormal TCP drop that triggers reconnection attempts.
    let _ = socket.close().await;
    Ok(())
}

/// SSE sibling of `stream_raw_logs_ws`. Same Stdout/Stderr→ConversationPatch
/// mapping; "no logs" yields a single `finished` event for a clean close.
async fn stream_raw_logs_sse(
    State(deployment): State<DeploymentImpl>,
    Path(exec_id): Path<Uuid>,
) -> impl IntoResponse {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use executors::logs::utils::patch::ConversationPatch;

    let event_stream: futures_util::stream::BoxStream<'static, Result<Event, BoxError>> =
        match deployment.container().stream_raw_logs(&exec_id).await {
            Some(raw_stream) => {
                let counter = Arc::new(AtomicUsize::new(0));
                raw_stream
                    .map_ok(move |m| match m {
                        LogMsg::Stdout(content) => {
                            let index = counter.fetch_add(1, Ordering::SeqCst);
                            LogMsg::JsonPatch(ConversationPatch::add_stdout(index, content))
                                .to_sse_event()
                        }
                        LogMsg::Stderr(content) => {
                            let index = counter.fetch_add(1, Ordering::SeqCst);
                            LogMsg::JsonPatch(ConversationPatch::add_stderr(index, content))
                                .to_sse_event()
                        }
                        LogMsg::Finished => LogMsg::Finished.to_sse_event(),
                        _ => unreachable!("Raw stream should only have Stdout/Stderr/Finished"),
                    })
                    .map_err(|e| -> BoxError { Box::new(e) })
                    .boxed()
            }
            None => {
                futures_util::stream::once(async { Ok(LogMsg::Finished.to_sse_event()) }).boxed()
            }
        };
    Sse::new(event_stream).keep_alive(KeepAlive::default())
}

async fn stream_normalized_logs_ws(
    ws: SignedWsUpgrade,
    State(deployment): State<DeploymentImpl>,
    Path(exec_id): Path<Uuid>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| async move {
        let stream = deployment
            .container()
            .stream_normalized_logs(&exec_id)
            .await;

        match stream {
            Some(stream) => {
                let stream = stream.err_into::<anyhow::Error>().into_stream();
                if let Err(e) = handle_normalized_logs_ws(socket, stream).await {
                    tracing::warn!("normalized logs WS closed: {}", e);
                }
            }
            None => {
                // No logs available: send finished and close cleanly
                let mut socket = socket;
                let _ = socket
                    .send(utils::log_msg::LogMsg::Finished.to_ws_message_unchecked())
                    .await;
                let _ = socket.close().await;
            }
        }
    })
}

async fn handle_normalized_logs_ws(
    mut socket: MaybeSignedWebSocket,
    stream: impl futures_util::Stream<Item = anyhow::Result<LogMsg>> + Unpin + Send + 'static,
) -> anyhow::Result<()> {
    let mut stream = coalesce_ws_stream(stream);
    loop {
        tokio::select! {
            item = stream.next() => {
                match item {
                    Some(Ok(msg)) => {
                        if socket.send(msg).await.is_err() {
                            break;
                        }
                    }
                    Some(Err(e)) => {
                        tracing::error!("stream error: {}", e);
                        break;
                    }
                    None => break,
                }
            }
            inbound = socket.recv() => {
                match inbound {
                    Ok(Some(Message::Close(_))) => break,
                    Ok(Some(_)) => {}
                    Ok(None) => break,
                    Err(_) => break,
                }
            }
        }
    }
    let _ = socket.close().await;
    Ok(())
}

/// SSE sibling of `stream_normalized_logs_ws`.
async fn stream_normalized_logs_sse(
    State(deployment): State<DeploymentImpl>,
    Path(exec_id): Path<Uuid>,
) -> impl IntoResponse {
    let event_stream: futures_util::stream::BoxStream<'static, Result<Event, BoxError>> =
        match deployment
            .container()
            .stream_normalized_logs(&exec_id)
            .await
        {
            Some(stream) => stream
                .map_ok(|m| m.to_sse_event())
                .map_err(|e| -> BoxError { Box::new(e) })
                .boxed(),
            None => {
                futures_util::stream::once(async { Ok(LogMsg::Finished.to_sse_event()) }).boxed()
            }
        };
    Sse::new(event_stream).keep_alive(KeepAlive::default())
}

async fn stop_execution_process(
    Extension(execution_process): Extension<ExecutionProcess>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    deployment
        .container()
        .stop_execution(&execution_process, ExecutionProcessStatus::Killed)
        .await?;

    Ok(ResponseJson(ApiResponse::success(())))
}

#[derive(Debug, Serialize, TS)]
pub struct SubagentTranscript {
    /// Flattened transcript markdown for older clients.
    pub content: String,
    /// Structured entries rendered by the same components as the main chat.
    pub entries: Vec<NormalizedEntry>,
    /// Preserved parent and child snapshots mapped onto transcript entries.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub artifacts: Option<Vec<executors::logs::artifacts::ArtifactReference>>,
}

fn transcript_working_dir(
    container_ref: &str,
    agent_working_dir: Option<&str>,
) -> std::path::PathBuf {
    let workspace_root = std::path::Path::new(container_ref);
    match agent_working_dir.filter(|dir| !dir.is_empty()) {
        Some(dir) => workspace_root.join(dir),
        None => workspace_root.to_path_buf(),
    }
}

/// Whether a subagent control target may be routed to a process of the given
/// base executor. Cross-executor calls (Claude task id → Codex APIs and vice
/// versa) are rejected.
fn target_matches_base(target: &SubagentControlTarget, base: Option<BaseCodingAgent>) -> bool {
    matches!(
        (target, base),
        (
            SubagentControlTarget::Codex { .. },
            Some(BaseCodingAgent::Codex)
        ) | (
            SubagentControlTarget::ClaudeCode { .. },
            Some(BaseCodingAgent::ClaudeCode)
        )
    )
}

/// Reject cross-executor calls. The expected executor comes from the process's
/// own stored action, not from anything the client claims.
#[allow(clippy::result_large_err)]
fn ensure_target_matches_executor(
    execution_process: &ExecutionProcess,
    target: &SubagentControlTarget,
) -> Result<(), ApiError> {
    let base = execution_process
        .executor_action()
        .ok()
        .and_then(|action| action.base_executor());
    if target_matches_base(target, base) {
        Ok(())
    } else {
        Err(ApiError::BadRequest(
            "subagent target does not match the process executor".to_string(),
        ))
    }
}

fn stdout_text(messages: &[LogMsg]) -> String {
    messages
        .iter()
        .filter_map(|msg| match msg {
            LogMsg::Stdout(chunk) => Some(chunk.as_str()),
            _ => None,
        })
        .collect()
}

fn json_has_codex_thread(value: &serde_json::Value, thread_id: &str) -> bool {
    if !matches!(
        value.get("method").and_then(|value| value.as_str()),
        Some("item/started" | "item/completed")
    ) {
        return false;
    }
    let Some(item) = value.get("params").and_then(|params| params.get("item")) else {
        return false;
    };
    match item.get("type").and_then(|value| value.as_str()) {
        Some("subAgentActivity") => {
            item.get("agentThreadId").and_then(|value| value.as_str()) == Some(thread_id)
        }
        Some("collabAgentToolCall") => item
            .get("receiverThreadIds")
            .and_then(|value| value.as_array())
            .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(thread_id))),
        _ => false,
    }
}

fn process_owns_target(stdout: &str, target: &SubagentControlTarget) -> bool {
    stdout.lines().any(|line| {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            return false;
        };
        match target {
            SubagentControlTarget::Codex { thread_id } => json_has_codex_thread(&value, thread_id),
            SubagentControlTarget::ClaudeCode { task_id, .. } => {
                matches!(
                    value.get("subtype").and_then(|value| value.as_str()),
                    Some("task_started" | "task_notification")
                ) && value.get("task_id").and_then(|value| value.as_str()) == Some(task_id)
            }
        }
    })
}

fn codex_invocation_prompt(stdout: &str, thread_id: &str) -> Option<String> {
    let (call_id, prompt) = stdout.lines().find_map(|line| {
        let value = serde_json::from_str::<serde_json::Value>(line.trim()).ok()?;
        if !json_has_codex_thread(&value, thread_id) {
            return None;
        }
        let item = value.get("params")?.get("item")?;
        if item.get("type")?.as_str()? != "collabAgentToolCall"
            || item.get("tool")?.as_str()? != "spawnAgent"
        {
            return None;
        }
        Some((
            item.get("id")?.as_str()?.to_string(),
            item.get("prompt")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|prompt| !prompt.is_empty())
                .map(str::to_string),
        ))
    })?;

    prompt.or_else(|| {
        stdout.lines().find_map(|line| {
            let value = serde_json::from_str::<serde_json::Value>(line.trim()).ok()?;
            if !matches!(
                value.get("method").and_then(|value| value.as_str()),
                Some("item/started" | "item/completed")
            ) {
                return None;
            }
            let item = value.get("params")?.get("item")?;
            if item.get("type")?.as_str()? != "collabAgentToolCall"
                || item.get("tool")?.as_str()? != "spawnAgent"
                || item.get("id")?.as_str()? != call_id
            {
                return None;
            }
            item.get("prompt")?
                .as_str()
                .map(str::trim)
                .filter(|prompt| !prompt.is_empty())
                .map(str::to_string)
        })
    })
}

fn claude_invocation_prompt(stdout: &str, task_id: &str) -> Option<String> {
    let mut tool_use_id = None;
    for line in stdout.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            continue;
        };
        if !matches!(
            value.get("subtype").and_then(|value| value.as_str()),
            Some("task_started" | "task_notification")
        ) || value.get("task_id").and_then(|value| value.as_str()) != Some(task_id)
        {
            continue;
        }
        if let Some(prompt) = value
            .get("prompt")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|prompt| !prompt.is_empty())
        {
            return Some(prompt.to_string());
        }
        tool_use_id = tool_use_id.or_else(|| {
            value
                .get("tool_use_id")
                .and_then(|value| value.as_str())
                .map(str::to_string)
        });
    }

    let tool_use_id = tool_use_id?;
    stdout.lines().find_map(|line| {
        let value = serde_json::from_str::<serde_json::Value>(line.trim()).ok()?;
        if value.get("type")?.as_str()? != "assistant" {
            return None;
        }
        value
            .get("message")?
            .get("content")?
            .as_array()?
            .iter()
            .find_map(|item| {
                if item.get("type")?.as_str()? != "tool_use"
                    || item.get("id")?.as_str()? != tool_use_id
                    || !matches!(item.get("name")?.as_str()?, "Task" | "task" | "Agent")
                {
                    return None;
                }
                item.get("input")?
                    .get("prompt")?
                    .as_str()
                    .map(str::trim)
                    .filter(|prompt| !prompt.is_empty())
                    .map(str::to_string)
            })
    })
}

fn subagent_invocation_prompt(stdout: &str, target: &SubagentControlTarget) -> Option<String> {
    match target {
        SubagentControlTarget::Codex { thread_id } => codex_invocation_prompt(stdout, thread_id),
        SubagentControlTarget::ClaudeCode { task_id, .. } => {
            claude_invocation_prompt(stdout, task_id)
        }
    }
}

fn prepend_invocation_prompt(
    content: &mut String,
    entries: &mut Vec<NormalizedEntry>,
    prompt: Option<String>,
) {
    let Some(prompt) = prompt else {
        return;
    };
    if entries.iter().any(|entry| {
        matches!(&entry.entry_type, NormalizedEntryType::UserMessage)
            && entry.content.trim() == prompt
    }) {
        return;
    }

    entries.insert(
        0,
        NormalizedEntry {
            timestamp: None,
            entry_type: NormalizedEntryType::UserMessage,
            content: prompt.clone(),
            metadata: None,
        },
    );
    let transcript = std::mem::take(content);
    *content = if transcript == "_No transcript content._" || transcript.trim().is_empty() {
        format!("**User**\n\n{prompt}")
    } else {
        format!("**User**\n\n{prompt}\n\n{transcript}")
    };
}

/// Raw log lines for a process: in-memory store while it runs (plus persisted
/// storage, whose retention outlives the store's bounded history).
async fn raw_log_messages(deployment: &DeploymentImpl, exec_id: Uuid) -> Vec<LogMsg> {
    let mut messages = Vec::new();
    if let Some(store) = deployment.container().get_msg_store_by_id(&exec_id).await {
        messages.extend(store.get_history());
    }
    if let Some(stored) =
        services::services::execution_process::load_raw_log_messages(&deployment.db().pool, exec_id)
            .await
    {
        messages.extend(stored);
    }
    messages
}

fn append_preserved_artifacts(
    saved: Option<&services::services::artifacts::ArtifactManifest>,
    scope: &str,
    entries: &mut Vec<NormalizedEntry>,
) -> Vec<executors::logs::artifacts::ArtifactReference> {
    let mut artifacts = saved
        .map(|manifest| {
            services::services::artifacts::preserved_transcript_references(manifest, scope)
        })
        .unwrap_or_default();
    for artifact in &mut artifacts {
        artifact.source_entry = u32::try_from(entries.len()).ok();
        entries.push(NormalizedEntry {
            timestamp: None,
            metadata: None,
            entry_type: NormalizedEntryType::SystemMessage,
            content: artifact.name.clone(),
        });
    }
    artifacts
}

async fn subagent_transcript(
    Extension(execution_process): Extension<ExecutionProcess>,
    State(deployment): State<DeploymentImpl>,
    Json(target): Json<SubagentControlTarget>,
) -> Result<ResponseJson<ApiResponse<SubagentTranscript>>, ApiError> {
    ensure_target_matches_executor(&execution_process, &target)?;
    let messages = raw_log_messages(&deployment, execution_process.id).await;
    let stdout = stdout_text(&messages);
    if !process_owns_target(&stdout, &target) {
        return Err(ApiError::BadRequest(
            "subagent target does not belong to this execution process".to_string(),
        ));
    }
    let invocation_prompt = subagent_invocation_prompt(&stdout, &target);

    let (workspace, session) = execution_process
        .parent_workspace_and_session(&deployment.db().pool)
        .await?
        .ok_or_else(|| {
            ApiError::BadRequest(
                "execution process workspace and session are unavailable".to_string(),
            )
        })?;
    let container_ref = workspace
        .container_ref
        .as_deref()
        .filter(|path| !path.is_empty())
        .ok_or_else(|| {
            ApiError::BadRequest("execution process workspace path is unavailable".to_string())
        })?;
    let worktree_path = transcript_working_dir(container_ref, session.agent_working_dir.as_deref())
        .to_string_lossy()
        .into_owned();

    let scope = subagent_transcript::scope(&target);
    let agent_session_id = find_claude_session_id(&stdout);
    let owned_target = match &target {
        SubagentControlTarget::ClaudeCode { task_id, .. } => SubagentControlTarget::ClaudeCode {
            task_id: task_id.clone(),
            // Client-supplied output paths never grant access.
            output_file: find_claude_task_output_file(&stdout, task_id).map(|(path, _)| path),
        },
        _ => target,
    };
    let handle = deployment
        .container()
        .subagent_handle(&execution_process.id)
        .await;
    let codex = subagent_transcript::codex_from_process(&execution_process).ok();
    let saved = super::artifacts::scoped_manifest(
        &deployment,
        &execution_process,
        &super::artifacts::ArtifactQuery {
            workspace_id: workspace.id,
            session_id: session.id,
            id: None,
            hash: None,
        },
    )
    .await
    .inspect_err(|error| tracing::warn!(%error, "Preserved subagent results are unavailable"))
    .ok()
    .flatten()
    .filter(|manifest| manifest.workspace_id == workspace.id);
    let read = subagent_transcript::read(
        &owned_target,
        agent_session_id.as_deref(),
        &worktree_path,
        handle.as_ref(),
        codex.as_ref(),
    )
    .await;
    let (mut content, mut entries, mut artifacts) = match read {
        Ok((mut content, mut entries, truncated)) => {
            let mut saved = saved;
            if !truncated
                && saved.as_ref().is_some_and(|manifest| {
                    manifest.list.complete && !manifest.transcripts.contains_key(&scope)
                })
                && deployment
                    .container()
                    .get_msg_store_by_id(&execution_process.id)
                    .await
                    .is_none()
            {
                let _guard = services::services::artifacts::RECOVERY.lock().await;
                match services::services::artifacts::ArtifactObserver::recover(
                    container_ref.into(),
                    std::path::PathBuf::from(&worktree_path),
                    workspace.id,
                    session.id,
                    execution_process.id,
                    deployment.file().clone(),
                    entries.iter().cloned().enumerate().collect(),
                    Some(&scope),
                )
                .await
                {
                    Ok(manifest) => saved = Some(manifest),
                    Err(error) => {
                        tracing::warn!(%error, "Subagent artifact recovery failed");
                        content.push_str("\nArtifact recovery failed; showing the available transcript and preserved snapshots.");
                    }
                }
            }
            let artifacts = if truncated {
                append_preserved_artifacts(saved.as_ref(), &scope, &mut entries)
            } else {
                saved
                    .as_ref()
                    .map(|manifest| {
                        services::services::artifacts::transcript_references(
                            manifest,
                            std::path::Path::new(container_ref),
                            std::path::Path::new(&worktree_path),
                            &scope,
                            entries.iter().enumerate(),
                        )
                    })
                    .unwrap_or_default()
            };
            (content, entries, artifacts)
        }
        Err(error) => {
            let mut entries = Vec::new();
            let artifacts = append_preserved_artifacts(saved.as_ref(), &scope, &mut entries);
            if artifacts.is_empty() {
                return Err(ApiError::BadRequest(format!(
                    "Transcript unavailable: {error}"
                )));
            }
            let content = "Original transcript unavailable; showing preserved artifact snapshots."
                .to_string();
            (content, entries, artifacts)
        }
    };
    let original_len = entries.len();
    prepend_invocation_prompt(&mut content, &mut entries, invocation_prompt);
    let offset = (entries.len() - original_len) as u32;
    for artifact in &mut artifacts {
        artifact.source_entry = artifact
            .source_entry
            .and_then(|index| index.checked_add(offset));
    }

    Ok(ResponseJson(ApiResponse::success(SubagentTranscript {
        content,
        entries,
        artifacts: (!artifacts.is_empty()).then_some(artifacts),
    })))
}

async fn subagent_stop(
    Extension(execution_process): Extension<ExecutionProcess>,
    State(deployment): State<DeploymentImpl>,
    Json(target): Json<SubagentControlTarget>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    ensure_target_matches_executor(&execution_process, &target)?;
    let messages = raw_log_messages(&deployment, execution_process.id).await;
    if !process_owns_target(&stdout_text(&messages), &target) {
        return Err(ApiError::BadRequest(
            "subagent target does not belong to this execution process".to_string(),
        ));
    }

    // Stops need the live client; after the process exits only transcript
    // reads remain possible.
    let handle = deployment
        .container()
        .subagent_handle(&execution_process.id)
        .await
        .ok_or_else(|| {
            ApiError::Conflict(
                "execution process is no longer running; the subagent can't be stopped".to_string(),
            )
        })?;

    match (handle, target) {
        (SubagentLiveHandle::Codex(client), SubagentControlTarget::Codex { thread_id }) => {
            client.turn_interrupt(thread_id).await?;
        }
        (
            SubagentLiveHandle::ClaudeCode(peer),
            SubagentControlTarget::ClaudeCode { task_id, .. },
        ) => {
            peer.stop_task(task_id).await?;
        }
        _ => {
            return Err(ApiError::BadRequest(
                "subagent target does not match the process executor".to_string(),
            ));
        }
    }

    Ok(ResponseJson(ApiResponse::success(())))
}

async fn stream_execution_processes_by_session_ws(
    ws: SignedWsUpgrade,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<SessionExecutionProcessQuery>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| async move {
        if let Err(e) = handle_execution_processes_by_session_ws(
            socket,
            deployment,
            query.session_id,
            query.show_soft_deleted.unwrap_or(false),
        )
        .await
        {
            tracing::warn!("execution processes by session WS closed: {}", e);
        }
    })
}

/// SSE sibling of `stream_execution_processes_by_session_ws`.
async fn stream_execution_processes_by_session_sse(
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<SessionExecutionProcessQuery>,
) -> Result<Sse<impl futures_util::Stream<Item = Result<Event, BoxError>>>, StatusCode> {
    let stream = deployment
        .events()
        .stream_execution_processes_for_session_raw(
            query.session_id,
            query.show_soft_deleted.unwrap_or(false),
        )
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Sse::new(
        stream
            .map_ok(|msg| msg.to_sse_event())
            .map_err(|e| -> BoxError { Box::new(e) }),
    )
    .keep_alive(KeepAlive::default()))
}

async fn handle_execution_processes_by_session_ws(
    mut socket: MaybeSignedWebSocket,
    deployment: DeploymentImpl,
    session_id: uuid::Uuid,
    show_soft_deleted: bool,
) -> anyhow::Result<()> {
    // Get the raw stream and convert LogMsg to WebSocket messages
    let mut stream = coalesce_ws_stream(
        deployment
            .events()
            .stream_execution_processes_for_session_raw(session_id, show_soft_deleted)
            .await?,
    );
    let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
    // `interval` ticks immediately by default; the initial snapshot already
    // proves liveness, so wait for the first regular heartbeat instead.
    heartbeat.tick().await;

    loop {
        tokio::select! {
            item = stream.next() => {
                match item {
                    Some(Ok(msg)) => {
                        if socket.send(msg).await.is_err() {
                            break;
                        }
                    }
                    Some(Err(e)) => {
                        tracing::error!("stream error: {}", e);
                        let _ = socket
                            .send(Message::Close(Some(CloseFrame {
                                code: close_code::ERROR,
                                reason: "execution-process stream error".into(),
                            })))
                            .await;
                        break;
                    }
                    None => break,
                }
            }
            _ = heartbeat.tick() => {
                if socket
                    .send(Message::Text(r#"{"heartbeat":true}"#.into()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
            inbound = socket.recv() => {
                match inbound {
                    Ok(Some(Message::Close(_))) => break,
                    Ok(Some(_)) => {}
                    Ok(None) => break,
                    Err(_) => break,
                }
            }
        }
    }
    Ok(())
}

async fn get_execution_process_repo_states(
    Extension(execution_process): Extension<ExecutionProcess>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<Vec<ExecutionProcessRepoState>>>, ApiError> {
    let pool = &deployment.db().pool;
    let repo_states =
        ExecutionProcessRepoState::find_by_execution_process_id(pool, execution_process.id).await?;
    Ok(ResponseJson(ApiResponse::success(repo_states)))
}

pub(super) fn router(deployment: &DeploymentImpl) -> Router<DeploymentImpl> {
    let workspace_id_router = Router::new()
        .route("/", get(get_execution_process_by_id))
        .route("/stop", post(stop_execution_process))
        .route("/subagent/transcript", post(subagent_transcript))
        .route("/subagent/stop", post(subagent_stop))
        .route("/repo-states", get(get_execution_process_repo_states))
        .route("/artifacts", get(super::artifacts::list))
        .route("/artifacts/bundle", get(super::artifacts::bundle))
        .route("/artifacts/content", get(super::artifacts::content))
        .route("/raw-logs/ws", get(stream_raw_logs_ws))
        .route("/raw-logs/sse", get(stream_raw_logs_sse))
        .route("/normalized-logs/ws", get(stream_normalized_logs_ws))
        .route("/normalized-logs/sse", get(stream_normalized_logs_sse))
        .layer(from_fn_with_state(
            deployment.clone(),
            load_execution_process_middleware,
        ));

    let workspaces_router = Router::new()
        .route(
            "/stream/session/ws",
            get(stream_execution_processes_by_session_ws),
        )
        .route(
            "/stream/session/sse",
            get(stream_execution_processes_by_session_sse),
        )
        .nest("/{id}", workspace_id_router);

    Router::new().nest("/execution-processes", workspaces_router)
}

#[cfg(test)]
mod subagent_route_tests {
    use super::*;

    fn codex_target() -> SubagentControlTarget {
        SubagentControlTarget::Codex {
            thread_id: "thread-1".to_string(),
        }
    }

    fn claude_target() -> SubagentControlTarget {
        SubagentControlTarget::ClaudeCode {
            task_id: "a0da1c1e716284dc6".to_string(),
            output_file: None,
        }
    }

    #[test]
    fn cross_executor_targets_are_rejected() {
        // Codex target only routes to Codex processes; Claude only to Claude.
        assert!(target_matches_base(
            &codex_target(),
            Some(BaseCodingAgent::Codex)
        ));
        assert!(target_matches_base(
            &claude_target(),
            Some(BaseCodingAgent::ClaudeCode)
        ));
        assert!(!target_matches_base(
            &codex_target(),
            Some(BaseCodingAgent::ClaudeCode)
        ));
        assert!(!target_matches_base(
            &claude_target(),
            Some(BaseCodingAgent::Codex)
        ));
        assert!(!target_matches_base(
            &claude_target(),
            Some(BaseCodingAgent::Gemini)
        ));
        assert!(!target_matches_base(&codex_target(), None));
    }

    #[test]
    fn transcript_path_uses_session_working_directory() {
        assert_eq!(
            transcript_working_dir("/workspace", Some("repo")),
            std::path::Path::new("/workspace").join("repo")
        );
        assert_eq!(
            transcript_working_dir("/workspace", Some("")),
            std::path::Path::new("/workspace")
        );
        assert_eq!(
            transcript_working_dir("/workspace", None),
            std::path::Path::new("/workspace")
        );
    }

    #[test]
    fn output_file_is_derived_from_own_task_notification_only() {
        let messages = vec![
            LogMsg::Stdout(
                concat!(
                    r#"{"type":"system","subtype":"task_started","task_id":"t1","tool_use_id":"tool_1","description":"x","task_type":"local_agent"}"#,
                    "\n"
                )
                .to_string(),
            ),
            // Notification for a DIFFERENT task must not match.
            LogMsg::Stdout(
                concat!(
                    r#"{"type":"system","subtype":"task_notification","task_id":"other","status":"completed","output_file":"/tmp/session-1/tasks/other.output","session_id":"session-1"}"#,
                    "\n"
                )
                .to_string(),
            ),
            LogMsg::Stdout(
                concat!(
                    r#"{"type":"system","subtype":"task_notification","task_id":"t1","status":"completed","output_file":"/tmp/session-1/tasks/t1.output","session_id":"session-1"}"#,
                    "\n"
                )
                .to_string(),
            ),
        ];
        let stdout = stdout_text(&messages);
        assert_eq!(
            find_claude_task_output_file(&stdout, "t1"),
            Some((
                "/tmp/session-1/tasks/t1.output".to_string(),
                "session-1".to_string()
            ))
        );
        assert_eq!(find_claude_task_output_file(&stdout, "missing"), None);
    }

    #[test]
    fn empty_output_file_yields_none() {
        let messages = vec![LogMsg::Stdout(
            r#"{"type":"system","subtype":"task_notification","task_id":"t1","status":"completed","output_file":"","session_id":"session-1"}"#.to_string(),
        )];
        assert_eq!(
            find_claude_task_output_file(&stdout_text(&messages), "t1"),
            None
        );
    }

    #[test]
    fn multi_line_stdout_chunks_are_scanned() {
        let chunk = concat!(
            r#"{"type":"assistant","message":{"role":"assistant","content":[]}}"#,
            "\n",
            r#"{"type":"system","subtype":"task_notification","task_id":"t1","status":"completed","output_file":"/tmp/session-1/tasks/t1.output","session_id":"session-1"}"#,
            "\n",
        );
        let messages = vec![LogMsg::Stdout(chunk.to_string())];
        assert_eq!(
            find_claude_task_output_file(&stdout_text(&messages), "t1"),
            Some((
                "/tmp/session-1/tasks/t1.output".to_string(),
                "session-1".to_string()
            ))
        );
    }

    #[test]
    fn targets_must_be_present_in_the_process_logs_even_across_chunks() {
        let messages = vec![
            LogMsg::Stdout(
                r#"{"method":"item/completed","params":{"item":{"type":"subAgentAct"#.to_string(),
            ),
            LogMsg::Stdout(
                r#"ivity","agentThreadId":"thread-1"}}}
{"type":"system","subtype":"task_started","task_id":"a0da1c1e716284dc6"}
"#
                .to_string(),
            ),
        ];
        let stdout = stdout_text(&messages);
        assert!(process_owns_target(&stdout, &codex_target()));
        assert!(process_owns_target(&stdout, &claude_target()));
        assert!(!process_owns_target(
            &stdout,
            &SubagentControlTarget::Codex {
                thread_id: "other-thread".to_string()
            }
        ));
    }

    #[test]
    fn codex_target_rejects_thread_ids_in_untrusted_nested_fields() {
        let stdout = concat!(
            r#"{"method":"item/completed","params":{"item":{"type":"dynamicToolCall","arguments":{"agentThreadId":"thread-1"}}}}"#,
            "\n",
            r#"{"method":"other/event","params":{"item":{"type":"subAgentActivity","agentThreadId":"thread-1"}}}"#,
        );
        assert!(!process_owns_target(stdout, &codex_target()));
    }

    #[test]
    fn invocation_prompt_is_recovered_and_prepended_once() {
        let codex_stdout = concat!(
            r#"{"method":"item/started","params":{"item":{"type":"collabAgentToolCall","id":"call-1","tool":"spawnAgent","receiverThreadIds":[],"prompt":"Inspect auth\nrun its tests"}}}"#,
            "\n",
            r#"{"method":"item/completed","params":{"item":{"type":"collabAgentToolCall","id":"call-1","tool":"spawnAgent","receiverThreadIds":["thread-1"]}}}"#,
        );
        assert_eq!(
            subagent_invocation_prompt(codex_stdout, &codex_target()).as_deref(),
            Some("Inspect auth\nrun its tests")
        );

        let claude_stdout = concat!(
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool_1","name":"Task","input":{"prompt":"Inspect auth\nrun its tests"}}]}}"#,
            "\n",
            r#"{"type":"system","subtype":"task_started","task_id":"a0da1c1e716284dc6","tool_use_id":"tool_1"}"#,
        );
        let prompt = subagent_invocation_prompt(claude_stdout, &claude_target());
        assert_eq!(prompt.as_deref(), Some("Inspect auth\nrun its tests"));

        let mut content = "_No transcript content._".to_string();
        let mut entries = Vec::new();
        prepend_invocation_prompt(&mut content, &mut entries, prompt.clone());
        prepend_invocation_prompt(&mut content, &mut entries, prompt);
        assert_eq!(content, "**User**\n\nInspect auth\nrun its tests");
        assert_eq!(entries.len(), 1);
        assert!(matches!(
            &entries[0].entry_type,
            NormalizedEntryType::UserMessage
        ));
    }

    #[tokio::test]
    async fn transcript_file_must_match_the_sdk_task_layout() {
        let temp = tempfile::tempdir().unwrap();
        let task_dir = temp.path().join("session-1/tasks");
        std::fs::create_dir_all(&task_dir).unwrap();
        let path = task_dir.join("t1.output");
        std::fs::write(&path, b"transcript").unwrap();

        let (bytes, truncated) = read_file_tail(path.to_str().unwrap(), "t1", "session-1", 512)
            .await
            .unwrap();
        assert_eq!(bytes, b"transcript");
        assert!(!truncated);
        assert!(
            read_file_tail(path.to_str().unwrap(), "other-task", "session-1", 512)
                .await
                .is_err()
        );

        #[cfg(unix)]
        {
            let subagents = temp.path().join("session-2/subagents");
            let tasks = temp.path().join("session-2/tasks");
            std::fs::create_dir_all(&subagents).unwrap();
            std::fs::create_dir_all(&tasks).unwrap();
            let transcript = subagents.join("agent-t2.jsonl");
            std::fs::write(&transcript, b"sdk transcript").unwrap();
            assert_eq!(
                read_file_tail(transcript.to_str().unwrap(), "t2", "session-2", 512)
                    .await
                    .unwrap()
                    .0,
                b"sdk transcript"
            );
            std::os::unix::fs::symlink(&transcript, tasks.join("t2.output")).unwrap();
            assert_eq!(
                read_file_tail(
                    tasks.join("t2.output").to_str().unwrap(),
                    "t2",
                    "session-2",
                    512
                )
                .await
                .unwrap()
                .0,
                b"sdk transcript"
            );

            let outside = temp.path().join("outside");
            std::fs::create_dir_all(&outside).unwrap();
            std::fs::write(outside.join("t1.output"), b"secret").unwrap();
            let session = temp.path().join("session-3");
            std::fs::create_dir_all(&session).unwrap();
            std::os::unix::fs::symlink(&outside, session.join("tasks")).unwrap();
            assert!(
                read_file_tail(
                    session.join("tasks/t1.output").to_str().unwrap(),
                    "t1",
                    "session-3",
                    512
                )
                .await
                .is_err()
            );
        }
    }
}
