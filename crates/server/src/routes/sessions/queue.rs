use axum::{
    Extension, Json, Router,
    extract::{Query, State},
    middleware::from_fn_with_state,
    response::Json as ResponseJson,
    routing::{get, post},
};
use db::models::{
    execution_process::{ExecutionProcess, ExecutionProcessStatus},
    scratch::DraftFollowUpData,
    session::Session,
    workspace::{Workspace, WorkspaceError},
};
use deployment::Deployment;
use executors::profile::ExecutorConfig;
use serde::Deserialize;
use services::services::{container::ContainerService, queued_message::QueueStatus};
use ts_rs::TS;
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError, middleware::load_session_middleware};

/// Request body for queueing (or steering) a follow-up message
#[derive(Debug, Deserialize, TS)]
struct QueueMessageRequest {
    pub message: String,
    pub executor_config: ExecutorConfig,
}

/// Optional `?message_id=` for `DELETE`: present cancels a single queued message,
/// absent clears the whole queue.
#[derive(Debug, Deserialize)]
struct CancelQuery {
    message_id: Option<Uuid>,
}

/// Append a follow-up message to the back of the session's queue. The messages
/// are drained one at a time as each terminal turn finishes.
async fn queue_message(
    Extension(session): Extension<Session>,
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<QueueMessageRequest>,
) -> Result<ResponseJson<ApiResponse<QueueStatus>>, ApiError> {
    let data = DraftFollowUpData {
        message: payload.message,
        executor_config: payload.executor_config,
    };

    deployment
        .queued_message_service()
        .enqueue(session.id, data);

    deployment
        .track_if_analytics_allowed(
            "follow_up_queued",
            serde_json::json!({
                "session_id": session.id.to_string(),
                "workspace_id": session.workspace_id.to_string(),
            }),
        )
        .await;

    Ok(ResponseJson(ApiResponse::success(
        deployment.queued_message_service().get_status(session.id),
    )))
}

/// Cancel a single queued message (`?message_id=`) or the whole queue.
async fn delete_queued_message(
    Extension(session): Extension<Session>,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<CancelQuery>,
) -> Result<ResponseJson<ApiResponse<QueueStatus>>, ApiError> {
    match query.message_id {
        Some(message_id) => {
            deployment
                .queued_message_service()
                .cancel_message(session.id, message_id);
        }
        None => {
            deployment.queued_message_service().clear_queue(session.id);
        }
    }

    deployment
        .track_if_analytics_allowed(
            "follow_up_queue_cancelled",
            serde_json::json!({
                "session_id": session.id.to_string(),
                "workspace_id": session.workspace_id.to_string(),
            }),
        )
        .await;

    Ok(ResponseJson(ApiResponse::success(
        deployment.queued_message_service().get_status(session.id),
    )))
}

/// Get the current queue status for a session.
async fn get_queue_status(
    Extension(session): Extension<Session>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<QueueStatus>>, ApiError> {
    let status = deployment.queued_message_service().get_status(session.id);

    Ok(ResponseJson(ApiResponse::success(status)))
}

/// "Send now" / steer: interrupt the currently-running coding-agent turn and run
/// this message immediately instead of waiting for the turn to finish.
///
/// When a turn is running we push the message to the front of the queue, mark the
/// session as steering, then kill the turn in the background — the kill's exit
/// handler drains that front message as a follow-up (continuing the session).
/// When nothing is running (idle, or the turn just finished) there is nothing to
/// interrupt, so we start the follow-up directly.
async fn steer_message(
    Extension(session): Extension<Session>,
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<QueueMessageRequest>,
) -> Result<ResponseJson<ApiResponse<QueueStatus>>, ApiError> {
    let pool = &deployment.db().pool;
    let data = DraftFollowUpData {
        message: payload.message,
        executor_config: payload.executor_config,
    };

    let workspace = Workspace::find_by_id(pool, session.workspace_id)
        .await?
        .ok_or(ApiError::Workspace(WorkspaceError::ValidationError(
            "Workspace not found".to_string(),
        )))?;

    let running = ExecutionProcess::find_running_coding_agent_for_session(pool, session.id).await?;

    deployment
        .track_if_analytics_allowed(
            "follow_up_steered",
            serde_json::json!({
                "session_id": session.id.to_string(),
                "workspace_id": session.workspace_id.to_string(),
                "interrupted": running.is_some(),
            }),
        )
        .await;

    match running {
        Some(proc) => {
            deployment
                .queued_message_service()
                .enqueue_front(session.id, data);
            deployment
                .queued_message_service()
                .mark_steering(session.id);

            // Kill the running turn in the background so "send now" returns
            // immediately; the exit handler drains the steered message.
            let deployment_bg = deployment.clone();
            let session_for_fallback = session.clone();
            let workspace_for_fallback = workspace.clone();
            tokio::spawn(async move {
                let session_id = session_for_fallback.id;
                if let Err(e) = deployment_bg
                    .container()
                    .stop_execution(&proc, ExecutionProcessStatus::Killed)
                    .await
                {
                    tracing::warn!(
                        "Steer: failed to stop running execution for session {session_id}: {e}"
                    );
                    // The exit monitor may never fire (child already gone). If the
                    // session is still marked steering, drain the message directly
                    // so it isn't stranded.
                    if deployment_bg
                        .queued_message_service()
                        .take_steering(session_id)
                        && let Some(msg) =
                            deployment_bg.queued_message_service().take_next(session_id)
                        && let Err(e) = deployment_bg
                            .container()
                            .start_followup_for_session(
                                &session_for_fallback,
                                &workspace_for_fallback,
                                &msg.data,
                            )
                            .await
                    {
                        tracing::error!(
                            "Steer: fallback follow-up failed for session {session_id}: {e}"
                        );
                    }
                }
            });
        }
        None => {
            // Nothing to interrupt — run it now.
            deployment
                .container()
                .start_followup_for_session(&session, &workspace, &data)
                .await?;
        }
    }

    Ok(ResponseJson(ApiResponse::success(
        deployment.queued_message_service().get_status(session.id),
    )))
}

pub(super) fn router(deployment: &DeploymentImpl) -> Router<DeploymentImpl> {
    Router::new()
        .route(
            "/",
            get(get_queue_status)
                .post(queue_message)
                .delete(delete_queued_message),
        )
        .route("/steer", post(steer_message))
        .layer(from_fn_with_state(
            deployment.clone(),
            load_session_middleware,
        ))
}
