use anyhow;
use axum::{
    BoxError, Extension, Router,
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
use futures_util::{StreamExt, TryStreamExt};
use serde::Deserialize;
use services::services::container::ContainerService;
use tokio::time::{Duration, MissedTickBehavior};
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
