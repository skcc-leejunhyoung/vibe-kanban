use axum::{
    BoxError, Extension,
    extract::{Query, State, ws::Message},
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
        stream
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
        stream
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
    use futures_util::{StreamExt, TryStreamExt};
    use utils::log_msg::LogMsg;

    let stream = deployment
        .container()
        .stream_diff(&workspace, stats_only)
        .await?;

    let mut stream = stream.map_ok(|msg: LogMsg| msg.to_ws_message_unchecked());

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
    use futures_util::{StreamExt, TryStreamExt};

    let mut stream = deployment
        .events()
        .stream_workspaces_raw(archived, limit)
        .await?
        .map_ok(|msg| msg.to_ws_message_unchecked());

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
