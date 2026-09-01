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
    executors::{
        BaseCodingAgent, CodingAgent, StandardCodingAgentExecutor, SubagentLiveHandle,
        claude::task_output_to_markdown, codex::transcript::thread_transcript_markdown,
    },
    logs::SubagentControlTarget,
    profile::ExecutorConfigs,
};
use futures_util::{StreamExt, TryStreamExt};
use serde::{Deserialize, Serialize};
use services::services::container::ContainerService;
use tokio::time::{Duration, MissedTickBehavior};
use ts_rs::TS;
use utils::{log_msg::LogMsg, response::ApiResponse};
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
    let mut stream = raw_stream.map_ok({
        let counter = counter.clone();
        move |m| match m {
            LogMsg::Stdout(content) => {
                let index = counter.fetch_add(1, Ordering::SeqCst);
                let patch = ConversationPatch::add_stdout(index, content);
                LogMsg::JsonPatch(patch).to_ws_message_unchecked()
            }
            LogMsg::Stderr(content) => {
                let index = counter.fetch_add(1, Ordering::SeqCst);
                let patch = ConversationPatch::add_stderr(index, content);
                LogMsg::JsonPatch(patch).to_ws_message_unchecked()
            }
            LogMsg::Finished => LogMsg::Finished.to_ws_message_unchecked(),
            _ => unreachable!("Raw stream should only have Stdout/Stderr/Finished"),
        }
    });

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
    let mut stream = stream.map_ok(|msg| msg.to_ws_message_unchecked());
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
    /// Flattened transcript markdown.
    pub content: String,
}

/// Keep only the tail of oversized transcripts; the viewer is a dialog, not a
/// log browser.
const TRANSCRIPT_MAX_BYTES: usize = 512 * 1024;

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

/// Find the SDK-reported transcript path for a Claude background task by
/// scanning this process's own raw logs for its `task_notification`. The path
/// never comes from the client, so no arbitrary-path access is possible.
fn find_claude_task_output_file(messages: &[LogMsg], task_id: &str) -> Option<String> {
    for msg in messages {
        let LogMsg::Stdout(chunk) = msg else {
            continue;
        };
        // Cheap prefilter before JSON parsing.
        if !chunk.contains(task_id) || !chunk.contains("task_notification") {
            continue;
        }
        for line in chunk.lines() {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
                continue;
            };
            if value.get("subtype").and_then(|v| v.as_str()) == Some("task_notification")
                && value.get("task_id").and_then(|v| v.as_str()) == Some(task_id)
                && let Some(path) = value.get("output_file").and_then(|v| v.as_str())
                && !path.is_empty()
            {
                return Some(path.to_string());
            }
        }
    }
    None
}

/// Read at most the last `max_bytes` of a regular file. Refuses special files
/// and never buffers more than the cap, so a hostile/huge path can't blow up
/// memory. Returns the bytes and whether the head was cut off.
async fn read_file_tail(path: &str, max_bytes: usize) -> std::io::Result<(Vec<u8>, bool)> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};

    let metadata = tokio::fs::metadata(path).await?;
    if !metadata.is_file() {
        return Err(std::io::Error::other("not a regular file"));
    }
    let len = metadata.len();
    let start = len.saturating_sub(max_bytes as u64);
    let mut file = tokio::fs::File::open(path).await?;
    if start > 0 {
        file.seek(std::io::SeekFrom::Start(start)).await?;
    }
    let mut bytes = Vec::new();
    file.take(max_bytes as u64).read_to_end(&mut bytes).await?;
    Ok((bytes, start > 0))
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

/// Resolve the Codex executor for an exited process so its thread rollouts can
/// still be read via a short-lived app-server probe.
#[allow(clippy::result_large_err)]
fn codex_from_process(
    execution_process: &ExecutionProcess,
) -> Result<executors::executors::codex::Codex, ApiError> {
    let action = execution_process
        .executor_action()
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    let config = match action.typ() {
        executors::actions::ExecutorActionType::CodingAgentInitialRequest(req) => {
            &req.executor_config
        }
        executors::actions::ExecutorActionType::CodingAgentFollowUpRequest(req) => {
            &req.executor_config
        }
        executors::actions::ExecutorActionType::ReviewRequest(req) => &req.executor_config,
        executors::actions::ExecutorActionType::ScriptRequest(_) => {
            return Err(ApiError::BadRequest(
                "process has no coding-agent executor".to_string(),
            ));
        }
    };
    let mut agent = ExecutorConfigs::get_cached()
        .get_coding_agent(&config.profile_id())
        .ok_or_else(|| ApiError::BadRequest("unknown executor profile".to_string()))?;
    if config.has_overrides() {
        agent.apply_overrides(config);
    }
    match agent {
        CodingAgent::Codex(codex) => Ok(codex),
        _ => Err(ApiError::BadRequest(
            "subagent target does not match the process executor".to_string(),
        )),
    }
}

async fn subagent_transcript(
    Extension(execution_process): Extension<ExecutionProcess>,
    State(deployment): State<DeploymentImpl>,
    Json(target): Json<SubagentControlTarget>,
) -> Result<ResponseJson<ApiResponse<SubagentTranscript>>, ApiError> {
    ensure_target_matches_executor(&execution_process, &target)?;

    let content = match target {
        SubagentControlTarget::Codex { thread_id } => {
            let thread = match deployment
                .container()
                .subagent_handle(&execution_process.id)
                .await
            {
                Some(SubagentLiveHandle::Codex(client)) => {
                    client.thread_read(thread_id, true).await?.thread
                }
                // Process exited (or a non-Codex handle, excluded by the guard
                // above): read the persisted rollout via a one-shot app-server.
                _ => {
                    codex_from_process(&execution_process)?
                        .read_thread_transcript(&thread_id)
                        .await?
                }
            };
            thread_transcript_markdown(&thread)
        }
        SubagentControlTarget::ClaudeCode { task_id, .. } => {
            // Ignore any client-sent output_file; re-derive it from the
            // process's own logs (session-scoped permission check by
            // construction — only the executor that owns this process can have
            // written the notification line).
            let messages = raw_log_messages(&deployment, execution_process.id).await;
            let path = find_claude_task_output_file(&messages, &task_id).ok_or_else(|| {
                ApiError::BadRequest("no transcript reported for this task".to_string())
            })?;
            let (bytes, truncated) = read_file_tail(&path, TRANSCRIPT_MAX_BYTES)
                .await
                .map_err(|e| ApiError::BadRequest(format!("transcript file unavailable: {e}")))?;
            let text = String::from_utf8_lossy(&bytes);
            let mut content = task_output_to_markdown(&text);
            if truncated {
                content = format!("_… transcript truncated …_\n\n{content}");
            }
            content
        }
    };

    Ok(ResponseJson(ApiResponse::success(SubagentTranscript {
        content,
    })))
}

async fn subagent_stop(
    Extension(execution_process): Extension<ExecutionProcess>,
    State(deployment): State<DeploymentImpl>,
    Json(target): Json<SubagentControlTarget>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    ensure_target_matches_executor(&execution_process, &target)?;

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
    let mut stream = deployment
        .events()
        .stream_execution_processes_for_session_raw(session_id, show_soft_deleted)
        .await?
        .map_ok(|msg| msg.to_ws_message_unchecked());
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
    fn output_file_is_derived_from_own_task_notification_only() {
        let messages = vec![
            LogMsg::Stdout(
                r#"{"type":"system","subtype":"task_started","task_id":"t1","tool_use_id":"tool_1","description":"x","task_type":"local_agent"}"#.to_string(),
            ),
            // Notification for a DIFFERENT task must not match.
            LogMsg::Stdout(
                r#"{"type":"system","subtype":"task_notification","task_id":"other","status":"completed","output_file":"/tmp/other.output"}"#.to_string(),
            ),
            LogMsg::Stdout(
                r#"{"type":"system","subtype":"task_notification","task_id":"t1","status":"completed","output_file":"/tmp/tasks/t1.output"}"#.to_string(),
            ),
        ];
        assert_eq!(
            find_claude_task_output_file(&messages, "t1").as_deref(),
            Some("/tmp/tasks/t1.output")
        );
        assert_eq!(find_claude_task_output_file(&messages, "missing"), None);
    }

    #[test]
    fn empty_output_file_yields_none() {
        let messages = vec![LogMsg::Stdout(
            r#"{"type":"system","subtype":"task_notification","task_id":"t1","status":"completed","output_file":""}"#.to_string(),
        )];
        assert_eq!(find_claude_task_output_file(&messages, "t1"), None);
    }

    #[test]
    fn multi_line_stdout_chunks_are_scanned() {
        let chunk = concat!(
            r#"{"type":"assistant","message":{"role":"assistant","content":[]}}"#,
            "\n",
            r#"{"type":"system","subtype":"task_notification","task_id":"t1","status":"completed","output_file":"/tmp/tasks/t1.output"}"#,
            "\n",
        );
        let messages = vec![LogMsg::Stdout(chunk.to_string())];
        assert_eq!(
            find_claude_task_output_file(&messages, "t1").as_deref(),
            Some("/tmp/tasks/t1.output")
        );
    }
}
