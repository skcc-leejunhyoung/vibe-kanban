use axum::{
    Extension, Json, Router,
    extract::{Query, State},
    http::HeaderMap,
    middleware::{from_fn, from_fn_with_state},
    response::Json as ResponseJson,
    routing::{get, post},
};
use db::models::{
    execution_process::{ExecutionProcess, ExecutionProcessStatus},
    pending_rate_limit_resume::PendingRateLimitResume,
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

use crate::{
    DeploymentImpl,
    error::ApiError,
    middleware::{finish_after_disconnect, load_session_middleware},
};

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
/// are drained one at a time as each terminal turn finishes; when nothing is
/// left to finish (the turn this was queued behind already ended), the front
/// message starts now.
async fn queue_message(
    Extension(session): Extension<Session>,
    State(deployment): State<DeploymentImpl>,
    headers: HeaderMap,
    Json(payload): Json<QueueMessageRequest>,
) -> Result<ResponseJson<ApiResponse<QueueStatus>>, ApiError> {
    // An automation retry after a lost response must not queue the prompt twice.
    let pool = deployment.db().pool.clone();
    let key = match crate::routes::automation::claim_action::<ApiResponse<QueueStatus>>(
        &pool,
        &headers,
        "queue_prompt",
    )
    .await?
    {
        crate::routes::automation::ActionClaim::Execute(key) => key,
        crate::routes::automation::ActionClaim::Replay(response) => {
            return Ok(ResponseJson(response));
        }
    };
    let response = queue_message_inner(session, deployment, payload).await?;
    crate::routes::automation::complete_action(&pool, key.as_deref(), &response.0).await?;
    Ok(response)
}

async fn queue_message_inner(
    session: Session,
    deployment: DeploymentImpl,
    payload: QueueMessageRequest,
) -> Result<ResponseJson<ApiResponse<QueueStatus>>, ApiError> {
    let data = DraftFollowUpData {
        message: payload.message,
        executor_config: inherit_executor_config(&deployment, &session, payload.executor_config)
            .await?,
    };

    deployment
        .queued_message_service()
        .enqueue(session.id, data);

    // Only a durable queue/execution acceptance may consume an Autopilot alert.
    deployment
        .queued_message_service()
        .flush(session.id)
        .await?;

    if let Err(e) = drain_idle_queue(&deployment, &session).await {
        // The message stays queued; the next turn's finish or "send now" runs it.
        tracing::error!(
            "Failed to start queued follow-up for idle session {}: {e}",
            session.id
        );
    }

    Ok(ResponseJson(ApiResponse::success(
        deployment.queued_message_service().get_status(session.id),
    )))
}

/// A bare config (identity only) runs with the session's last-used settings,
/// the same rule `follow-up` applies.
async fn inherit_executor_config(
    deployment: &DeploymentImpl,
    session: &Session,
    requested: ExecutorConfig,
) -> Result<ExecutorConfig, ApiError> {
    let latest =
        ExecutionProcess::latest_executor_config_for_session(&deployment.db().pool, session.id)
            .await?;
    Ok(super::resolve_followup_executor_config(requested, latest))
}

/// Start the session's front queued message if nothing else will (see
/// `ContainerService::drain_queue_if_idle`).
pub(crate) async fn drain_idle_queue(
    deployment: &DeploymentImpl,
    session: &Session,
) -> Result<(), ApiError> {
    let result = prepare_and_drain_idle_queue(deployment, session).await;
    if let Err(error) = &result {
        deployment
            .queued_message_service()
            .hold_front(session.id, error.to_string());
    }
    result
}

async fn prepare_and_drain_idle_queue(
    deployment: &DeploymentImpl,
    session: &Session,
) -> Result<(), ApiError> {
    if !deployment
        .queued_message_service()
        .can_drain_now(session.id)
    {
        return Ok(());
    }
    let pool = &deployment.db().pool;
    let mut workspace = Workspace::find_by_id(pool, session.workspace_id)
        .await?
        .ok_or(ApiError::Workspace(WorkspaceError::ValidationError(
            "Workspace not found".to_string(),
        )))?;
    // An idle session's tree may have been cleaned up; restore it like a send.
    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    if let Some(fresh) = Workspace::find_by_id(pool, workspace.id).await? {
        workspace = fresh;
    }
    workspace.container_ref.get_or_insert(container_ref);
    deployment
        .container()
        .drain_queue_if_idle(session, &workspace)
        .await?;
    Ok(())
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
                .cancel_message(session.id, message_id)
                .await
                .map_err(|error| ApiError::Io(std::io::Error::other(error)))?;
        }
        None => {
            deployment
                .queued_message_service()
                .clear_queue(session.id)
                .await
                .map_err(|error| ApiError::Io(std::io::Error::other(error)))?;
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
        executor_config: inherit_executor_config(&deployment, &session, payload.executor_config)
            .await?,
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
                // A terminal script can still be connecting its next action.
                // The idle drain also respects that finalizer's ownership.
                deployment
                    .queued_message_service()
                    .enqueue_front(session.id, data);
                // A manual send supersedes a scheduled automatic resume.
                let _ = PendingRateLimitResume::delete_by_session_id(pool, session.id).await;
                if let Err(error) = drain_idle_queue(&deployment, &session).await {
                    tracing::warn!(%error, "Queued steer could not start yet");
                }
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

/// Request body for editing a message already in the queue.
#[derive(Debug, Deserialize)]
struct UpdateQueuedRequest {
    pub message_id: Uuid,
    pub message: String,
    pub executor_config: ExecutorConfig,
}

/// Edit a queued message in place (text + executor config), preserving its
/// queue position. If the message already drained or was cancelled this is a
/// no-op; the returned status reflects the current queue either way.
async fn update_queued_message(
    Extension(session): Extension<Session>,
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<UpdateQueuedRequest>,
) -> Result<ResponseJson<ApiResponse<QueueStatus>>, ApiError> {
    let data = DraftFollowUpData {
        message: payload.message,
        executor_config: payload.executor_config,
    };

    deployment
        .queued_message_service()
        .update_message(session.id, payload.message_id, data);

    Ok(ResponseJson(ApiResponse::success(
        deployment.queued_message_service().get_status(session.id),
    )))
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
/// and drain that pinned message directly
/// ([`ContainerService::run_steered_message`]) so it isn't stranded.
fn spawn_steer_kill(
    deployment: DeploymentImpl,
    session: Session,
    workspace: Workspace,
    proc: ExecutionProcess,
) {
    tokio::spawn(async move {
        let session_id = session.id;
        // A row that answered early may have no child yet (its worktree is
        // still materialising): stopping it only marks it killed and no exit
        // handler will ever drain the steered message, so drain it here — the
        // same fallback as a kill that errors because the child is gone.
        let had_child = deployment.container().has_live_child(proc.id).await;
        let stopped = deployment
            .container()
            .stop_execution(&proc, ExecutionProcessStatus::Killed)
            .await;
        if let Err(e) = &stopped {
            tracing::warn!("Steer: failed to stop running execution for session {session_id}: {e}");
        }
        if stopped.is_ok() && had_child {
            return;
        }
        // Own the drain until the steered message has its row, so a message
        // enqueued meanwhile waits behind it instead of starting first; then
        // pick up whatever arrived.
        let hold = deployment.queued_message_service().hold_drain(session_id);
        deployment
            .container()
            .run_steered_message(&session, workspace)
            .await;
        drop(hold);
        if let Err(e) = drain_idle_queue(&deployment, &session).await {
            tracing::error!(
                "Steer: failed to start queued follow-up for session {session_id}: {e}"
            );
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
            // Keep the message queued while a script or finalizer owns the
            // session, even in the gap before a chained action gets its row.
            if deployment
                .queued_message_service()
                .promote_to_front(session.id, message_id)
            {
                let _ = PendingRateLimitResume::delete_by_session_id(pool, session.id).await;
                if let Err(error) = drain_idle_queue(&deployment, &session).await {
                    tracing::warn!(%error, "Promoted message could not start yet");
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
        .route("/", get(get_queue_status).delete(delete_queued_message))
        .route(
            "/",
            post(queue_message).layer(from_fn(finish_after_disconnect)),
        )
        .route(
            "/steer",
            post(steer_message).layer(from_fn(finish_after_disconnect)),
        )
        .route(
            "/steer-queued",
            post(steer_queued_message).layer(from_fn(finish_after_disconnect)),
        )
        .route("/update", post(update_queued_message))
        .route("/reorder", post(reorder_queue))
        .layer(from_fn_with_state(
            deployment.clone(),
            load_session_middleware,
        ))
}
