use axum::{
    BoxError, Extension,
    extract::{
        Query, State,
        ws::{CloseFrame, Message, close_code},
    },
    http::StatusCode,
    response::{
        IntoResponse, Sse,
        sse::{Event, KeepAlive},
    },
};
use deployment::Deployment;
use futures_util::TryStreamExt;
use serde::Deserialize;
use services::services::container::ContainerService;
use utils::ws_batch::{coalesce_log_stream, coalesce_ws_stream};

use crate::{
    DeploymentImpl,
    middleware::signed_ws::{MaybeSignedWebSocket, SignedWsUpgrade},
};

#[derive(Debug, Deserialize)]
pub struct DiffStreamQuery {
    #[serde(default)]
    pub stats_only: bool,
}

#[derive(Debug, Deserialize)]
pub struct WorkspaceStreamQuery {
    pub archived: Option<bool>,
    pub limit: Option<i64>,
}

pub async fn stream_workspaces_ws(
    ws: SignedWsUpgrade,
    Query(query): Query<WorkspaceStreamQuery>,
    State(deployment): State<DeploymentImpl>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| async move {
        if let Err(e) = handle_workspaces_ws(socket, deployment, query.archived, query.limit).await
        {
            tracing::warn!("workspaces WS closed: {}", e);
        }
    })
}

pub async fn stream_workspace_diff_ws(
    ws: SignedWsUpgrade,
    Query(params): Query<DiffStreamQuery>,
    Extension(workspace): Extension<db::models::workspace::Workspace>,
    State(deployment): State<DeploymentImpl>,
) -> impl IntoResponse {
    let _ = deployment.container().touch(&workspace).await;
    let stats_only = params.stats_only;
    ws.on_upgrade(move |socket| async move {
        if let Err(e) = handle_workspace_diff_ws(socket, deployment, workspace, stats_only).await {
            tracing::warn!("diff WS closed: {}", e);
        }
    })
}

/// SSE sibling of `stream_workspaces_ws`. WebKit standalone PWAs can't open the
/// concurrent WebSockets a workspace needs, so the same LogMsg stream is offered
/// over HTTP/SSE. Unidirectional, so no `select!`/recv loop is needed.
pub async fn stream_workspaces_sse(
    Query(query): Query<WorkspaceStreamQuery>,
    State(deployment): State<DeploymentImpl>,
) -> Result<Sse<impl futures_util::Stream<Item = Result<Event, BoxError>>>, StatusCode> {
    let stream = deployment
        .events()
        .stream_workspaces_raw(query.archived, query.limit)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Sse::new(
        coalesce_log_stream(stream)
            .map_ok(|msg| msg.to_sse_event())
            .map_err(|e| -> BoxError { Box::new(e) }),
    )
    .keep_alive(KeepAlive::default()))
}

/// SSE sibling of `stream_workspace_diff_ws`.
pub async fn stream_workspace_diff_sse(
    Query(params): Query<DiffStreamQuery>,
    Extension(workspace): Extension<db::models::workspace::Workspace>,
    State(deployment): State<DeploymentImpl>,
) -> Result<Sse<impl futures_util::Stream<Item = Result<Event, BoxError>>>, StatusCode> {
    let _ = deployment.container().touch(&workspace).await;
    let stream = deployment
        .container()
        .stream_diff(&workspace, params.stats_only)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Sse::new(
        coalesce_log_stream(stream)
            .map_ok(|msg| msg.to_sse_event())
            .map_err(|e| -> BoxError { Box::new(e) }),
    )
    .keep_alive(KeepAlive::default()))
}

async fn handle_workspace_diff_ws(
    mut socket: MaybeSignedWebSocket,
    deployment: DeploymentImpl,
    workspace: db::models::workspace::Workspace,
    stats_only: bool,
) -> anyhow::Result<()> {
    use futures_util::StreamExt;

    let stream = deployment
        .container()
        .stream_diff(&workspace, stats_only)
        .await?;

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
                        // Tell the client why, so it reconnects for a fresh
                        // snapshot instead of reading an abrupt 1006 close.
                        let _ = socket
                            .send(Message::Close(Some(CloseFrame {
                                code: close_code::ERROR,
                                reason: "diff stream error".into(),
                            })))
                            .await;
                        break;
                    }
                    None => break,
                }
            }
            msg = socket.recv() => {
                match msg {
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

async fn handle_workspaces_ws(
    mut socket: MaybeSignedWebSocket,
    deployment: DeploymentImpl,
    archived: Option<bool>,
    limit: Option<i64>,
) -> anyhow::Result<()> {
    use futures_util::StreamExt;

    let mut stream = coalesce_ws_stream(
        deployment
            .events()
            .stream_workspaces_raw(archived, limit)
            .await?,
    );

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
                        // Tell the client why, so it reconnects for a fresh
                        // snapshot instead of reading an abrupt 1006 close.
                        let _ = socket
                            .send(Message::Close(Some(CloseFrame {
                                code: close_code::ERROR,
                                reason: "workspaces stream error".into(),
                            })))
                            .await;
                        break;
                    }
                    None => break,
                }
            }
            msg = socket.recv() => {
                match msg {
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

#[cfg(test)]
mod tests {
    use axum::{body::to_bytes, response::IntoResponse};
    use futures_util::stream;
    use utils::log_msg::LogMsg;

    use super::*;

    /// Build the response exactly the way `stream_workspaces_sse` does, so the
    /// test covers the route's own composition rather than axum in isolation.
    fn sse_response(
        source: impl futures_util::Stream<Item = Result<LogMsg, std::io::Error>> + Send + 'static,
    ) -> axum::response::Response {
        Sse::new(
            coalesce_log_stream(source)
                .map_ok(|msg| msg.to_sse_event())
                .map_err(|e| -> BoxError { Box::new(e) }),
        )
        .keep_alive(KeepAlive::default())
        .into_response()
    }

    /// The lag fix banks on an SSE body *aborting* rather than ending: the
    /// browser's fetch reader has to throw so the client reconnects onto a
    /// fresh snapshot. If coalescing, the SSE encoding or axum's `SseBody`
    /// turned the error into a normal end-of-stream, the client would treat it
    /// as a clean close and park on stale state forever.
    #[tokio::test]
    async fn a_stream_error_aborts_the_sse_body_while_a_clean_end_does_not() {
        let ended = sse_response(stream::iter(vec![Ok(LogMsg::Ready)])).into_body();
        assert!(
            to_bytes(ended, usize::MAX).await.is_ok(),
            "a stream that simply ends must produce a complete body"
        );

        let lagged = sse_response(stream::iter(vec![
            Ok(LogMsg::Ready),
            Err(std::io::Error::other(
                "workspaces stream lagged by 1024 messages",
            )),
        ]))
        .into_body();
        assert!(
            to_bytes(lagged, usize::MAX).await.is_err(),
            "a lagged stream must abort the body, not end it"
        );
    }
}
