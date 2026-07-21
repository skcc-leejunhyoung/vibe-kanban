use axum::{
    BoxError, Router,
    extract::{State, ws::Message},
    http::StatusCode,
    response::{
        IntoResponse, Json as ResponseJson, Sse,
        sse::{Event, KeepAlive},
    },
    routing::{get, post},
};
use deployment::Deployment;
use futures_util::StreamExt;
use utils::{
    approvals::{ApprovalOutcome, ApprovalResponse},
    log_msg::LogMsg,
    response::ApiResponse,
};

use crate::{
    DeploymentImpl,
    middleware::signed_ws::{MaybeSignedWebSocket, SignedWsUpgrade},
};

async fn respond_to_approval(
    State(deployment): State<DeploymentImpl>,
    axum::extract::Path(id): axum::extract::Path<String>,
    ResponseJson(request): ResponseJson<ApprovalResponse>,
) -> Result<ResponseJson<ApiResponse<ApprovalOutcome>>, StatusCode> {
    let service = deployment.approvals();

    match service.respond(&id, request).await {
        Ok((outcome, _)) => Ok(ResponseJson(ApiResponse::success(outcome))),
        Err(e) => {
            tracing::error!("Failed to respond to approval: {:?}", e);
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

async fn stream_approvals_ws(
    ws: SignedWsUpgrade,
    State(deployment): State<DeploymentImpl>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| async move {
        if let Err(e) = handle_approvals_ws(socket, deployment).await {
            tracing::warn!("approvals WS closed: {}", e);
        }
    })
}

/// SSE sibling of `stream_approvals_ws`. Emits the snapshot patch, a `Ready`,
/// then live patches — the patch_stream's first item is the snapshot.
async fn stream_approvals_sse(State(deployment): State<DeploymentImpl>) -> impl IntoResponse {
    let mut stream = deployment.approvals().patch_stream();

    // Mirror `handle_approvals_ws`: take the snapshot first and, if the stream
    // is already closed, end the SSE response immediately instead of holding the
    // connection open. Otherwise emit snapshot + `Ready`, then the live patches.
    let prelude: Vec<Result<Event, BoxError>> = match stream.next().await {
        Some(snapshot) => vec![
            Ok(LogMsg::JsonPatch(snapshot).to_sse_event()),
            Ok(LogMsg::Ready.to_sse_event()),
        ],
        None => vec![],
    };

    let live = stream
        .map(|patch| -> Result<Event, BoxError> { Ok(LogMsg::JsonPatch(patch).to_sse_event()) });
    let event_stream = futures_util::stream::iter(prelude).chain(live).boxed();
    Sse::new(event_stream).keep_alive(KeepAlive::default())
}

async fn handle_approvals_ws(
    mut socket: MaybeSignedWebSocket,
    deployment: DeploymentImpl,
) -> anyhow::Result<()> {
    let mut stream = deployment.approvals().patch_stream();

    if let Some(snapshot_patch) = stream.next().await {
        socket
            .send(LogMsg::JsonPatch(snapshot_patch).to_ws_message_unchecked())
            .await?;
    } else {
        return Ok(());
    }
    socket.send(LogMsg::Ready.to_ws_message_unchecked()).await?;

    loop {
        tokio::select! {
            patch = stream.next() => {
                let Some(patch) = patch else {
                    break;
                };

                if socket
                    .send(LogMsg::JsonPatch(patch).to_ws_message_unchecked())
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
                    Err(error) => {
                        tracing::warn!("approvals WS receive error: {}", error);
                        break;
                    }
                }
            }
        }
    }

    Ok(())
}

pub(super) fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/approvals/{id}/respond", post(respond_to_approval))
        .route("/approvals/stream/ws", get(stream_approvals_ws))
        .route("/approvals/stream/sse", get(stream_approvals_sse))
}
