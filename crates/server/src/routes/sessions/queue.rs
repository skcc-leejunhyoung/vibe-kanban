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
/// interrupt, so we start the follow-up directly. A second steer that lands while
/// an earlier one's kill is still in flight just queues behind it rather than
/// killing again or starting a duplicate turn.
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

    match running {
        Some(proc) => {
            // Push the message to the front and pin it as the steer target. The
            // exit handler drains by this id (not by queue position), so a
            // reorder/promote that lands before the kill fires can't divert the
            // interrupt to a different message.
            let queued = deployment
                .queued_message_service()
                .enqueue_front(session.id, data);

            // Compare-and-set: only the first steer for this session owns the
            // interrupt. `mark_steering` returns false when a steer is already in
            // flight (a previous turn was killed but its drain hasn't started the
            // follow-up yet, so it briefly leaves nothing in `running`). In that
            // case don't kill again — the in-flight steer's id-based drain runs
            // its own pinned target and the finalize chain runs this message in
            // turn. Killing again could start two turns on the same session at
            // once.
            if !deployment
                .queued_message_service()
                .mark_steering(session.id, queued.id)
            {
                return Ok(ResponseJson(ApiResponse::success(
                    deployment.queued_message_service().get_status(session.id),
                )));
            }

            // Kill the running turn in the background so "send now" returns
            // immediately; the exit handler drains the steered message.
            spawn_steer_kill(deployment.clone(), session.clone(), workspace, proc);
        }
        None => {
            // Nothing is running. But a steer kill may still be in flight that
            // already moved its turn out of `running`; starting a follow-up now
            // would double up with that kill's pending drain. In that case just
            // queue and let the in-flight chain run it. Truly idle → run it now.
            if deployment.queued_message_service().is_steering(session.id) {
                deployment
                    .queued_message_service()
                    .enqueue(session.id, data);
            } else {
                deployment
                    .container()
                    .start_followup_for_session(&session, &workspace, &data)
                    .await?;
            }
        }
    }

    Ok(ResponseJson(ApiResponse::success(
        deployment.queued_message_service().get_status(session.id),
    )))
}

/// Request body for "send now" on a message already in the queue.
#[derive(Debug, Deserialize)]
struct SteerQueuedRequest {
    pub message_id: Uuid,
}

/// Request body for reordering the queue: the desired id order (front first).
#[derive(Debug, Deserialize)]
struct ReorderQueueRequest {
    pub message_ids: Vec<Uuid>,
}

/// Spawn the background kill of a running coding-agent turn for a steer
/// ("send now"). Returning immediately keeps the HTTP handler snappy: the
/// kill's exit handler normally drains the pinned (steered) message and starts
/// it as a follow-up. If the kill errors because the child is already gone the
/// exit monitor may never fire, so as a fallback we consume the steering target
/// and drain that pinned message directly so it isn't stranded.
fn spawn_steer_kill(
    deployment: DeploymentImpl,
    session: Session,
    workspace: Workspace,
    proc: ExecutionProcess,
) {
    tokio::spawn(async move {
        let session_id = session.id;
        if let Err(e) = deployment
            .container()
            .stop_execution(&proc, ExecutionProcessStatus::Killed)
            .await
        {
            tracing::warn!("Steer: failed to stop running execution for session {session_id}: {e}");
            if let Some(steered_id) = deployment
                .queued_message_service()
                .take_steering(session_id)
                && let Some(msg) = deployment
                    .queued_message_service()
                    .take_steered_or_front(session_id, steered_id)
                && let Err(e) = deployment
                    .container()
                    .start_followup_for_session(&session, &workspace, &msg.data)
                    .await
            {
                tracing::error!("Steer: fallback follow-up failed for session {session_id}: {e}");
            }
        }
    });
}

/// "Send now" for a message already in the queue: promote it to the front and
/// run it next, interrupting the current turn instead of waiting in line.
///
/// Mirrors [`steer_message`] but acts on an existing queued message (by id)
/// rather than a freshly composed one: when a turn is running we promote the
/// message to the front and kill the turn (its exit handler drains the front);
/// when idle we pull the message out of the queue and start it directly. The
/// same compare-and-set on the steering flag prevents a second concurrent kill.
async fn steer_queued_message(
    Extension(session): Extension<Session>,
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<SteerQueuedRequest>,
) -> Result<ResponseJson<ApiResponse<QueueStatus>>, ApiError> {
    let pool = &deployment.db().pool;
    let message_id = payload.message_id;

    let workspace = Workspace::find_by_id(pool, session.workspace_id)
        .await?
        .ok_or(ApiError::Workspace(WorkspaceError::ValidationError(
            "Workspace not found".to_string(),
        )))?;

    let running = ExecutionProcess::find_running_coding_agent_for_session(pool, session.id).await?;

    match running {
        Some(proc) => {
            // Only the first steer owns the interrupt (see `steer_message`). A
            // concurrent one just bumps this message toward the front and lets
            // the in-flight steer's id-pinned drain run its own target — no
            // second kill.
            if !deployment
                .queued_message_service()
                .mark_steering(session.id, message_id)
            {
                deployment
                    .queued_message_service()
                    .promote_to_front(session.id, message_id);
                return Ok(ResponseJson(ApiResponse::success(
                    deployment.queued_message_service().get_status(session.id),
                )));
            }

            // We pinned `message_id` as the steer target, so the kill's drain
            // picks exactly it regardless of later reordering. Move it to the
            // front too so it's visibly next; if it's already gone
            // (drained/cancelled) there's nothing to steer, so release the
            // target instead of killing a turn for nothing.
            if !deployment
                .queued_message_service()
                .promote_to_front(session.id, message_id)
            {
                deployment
                    .queued_message_service()
                    .take_steering(session.id);
                return Ok(ResponseJson(ApiResponse::success(
                    deployment.queued_message_service().get_status(session.id),
                )));
            }

            spawn_steer_kill(deployment.clone(), session.clone(), workspace, proc);
        }
        None => {
            // A steer kill may still be in flight; just ensure this message
            // drains next rather than starting a duplicate turn. Truly idle →
            // pull it out of the queue and run it immediately.
            if deployment.queued_message_service().is_steering(session.id) {
                deployment
                    .queued_message_service()
                    .promote_to_front(session.id, message_id);
            } else if let Some(msg) = deployment
                .queued_message_service()
                .cancel_message(session.id, message_id)
            {
                // The message is now out of the queue. If starting it fails
                // (e.g. executor mismatch), put it back at the front instead of
                // dropping it: unlike `steer_message`, this was a message the
                // user had safely queued, so losing it on error would be silent
                // data loss. `start_followup_for_session` only re-enqueues on
                // its Ok (already-running) path, so this never double-inserts.
                if let Err(e) = deployment
                    .container()
                    .start_followup_for_session(&session, &workspace, &msg.data)
                    .await
                {
                    deployment
                        .queued_message_service()
                        .enqueue_front(session.id, msg.data);
                    return Err(e.into());
                }
            }
        }
    }

    Ok(ResponseJson(ApiResponse::success(
        deployment.queued_message_service().get_status(session.id),
    )))
}

/// Reorder the session's queue to the given id order (front first). Drained
/// one at a time as each terminal turn finishes, so the new order takes effect
/// for the messages that haven't run yet.
async fn reorder_queue(
    Extension(session): Extension<Session>,
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<ReorderQueueRequest>,
) -> Result<ResponseJson<ApiResponse<QueueStatus>>, ApiError> {
    deployment
        .queued_message_service()
        .reorder(session.id, &payload.message_ids);

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
        .route("/steer-queued", post(steer_queued_message))
        .route("/reorder", post(reorder_queue))
        .layer(from_fn_with_state(
            deployment.clone(),
            load_session_middleware,
        ))
}
