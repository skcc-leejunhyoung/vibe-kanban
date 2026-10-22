use axum::{
    Extension, Json,
    extract::{Query, State},
    http::StatusCode,
    response::Json as ResponseJson,
};
use db::models::{
    coding_agent_turn::CodingAgentTurn,
    execution_process::{ExecutionProcess, ExecutionProcessStatus},
    requests::AutopilotWorkspaceResponse,
    session::Session,
    task::Task,
    workspace::{Workspace, WorkspaceError},
};
use deployment::Deployment;
use serde::Deserialize;
use services::services::{container::ContainerService, diff_stream, remote_sync};
use sqlx::Error as SqlxError;
use utils::response::ApiResponse;
use workspace_manager::WorkspaceManager;

use crate::{DeploymentImpl, error::ApiError};

#[derive(Debug, Deserialize)]
pub struct DeleteWorkspaceQuery {
    #[serde(default)]
    pub delete_remote: bool,
    #[serde(default)]
    pub delete_branches: bool,
}

#[derive(Debug, Deserialize)]
pub struct ListWorkspacesQuery {
    /// Omitted returns active and archived workspaces.
    pub archived: Option<bool>,
}

pub async fn get_workspaces(
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<ListWorkspacesQuery>,
) -> Result<ResponseJson<ApiResponse<Vec<Workspace>>>, ApiError> {
    let pool = &deployment.db().pool;
    let mut workspaces = Workspace::fetch_all(pool).await?;
    if let Some(archived) = query.archived {
        workspaces.retain(|workspace| workspace.archived == archived);
    }
    Ok(ResponseJson(ApiResponse::success(workspaces)))
}

pub async fn get_workspace(
    Extension(workspace): Extension<Workspace>,
) -> Result<ResponseJson<ApiResponse<Workspace>>, ApiError> {
    Ok(ResponseJson(ApiResponse::success(workspace)))
}

/// This host's active Autopilot with its single session and the executor
/// config of its latest turn. 404 while there is none (or it is paused, i.e.
/// archived), which is how automation learns to skip a run.
pub async fn get_autopilot(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<AutopilotWorkspaceResponse>>, ApiError> {
    let pool = &deployment.db().pool;
    let Some(workspace) = Workspace::find_active_autopilot(pool).await? else {
        return Err(ApiError::Workspace(WorkspaceError::WorkspaceNotFound));
    };
    let session = Session::find_latest_by_workspace_id(pool, workspace.id).await?;
    let (executor_config, is_running) = match &session {
        Some(session) => (
            crate::scheduled_resume_watcher::latest_executor_config(pool, session.id)
                .await
                .map_err(|e| ApiError::BadRequest(e.to_string()))?,
            ExecutionProcess::has_running_non_dev_server_processes_for_session(pool, session.id)
                .await?,
        ),
        None => (None, false),
    };
    Ok(ResponseJson(ApiResponse::success(
        AutopilotWorkspaceResponse {
            workspace,
            session,
            executor_config,
            is_running,
        },
    )))
}

pub async fn update_workspace(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<db::models::requests::UpdateWorkspace>,
) -> Result<ResponseJson<ApiResponse<Workspace>>, ApiError> {
    let pool = &deployment.db().pool;
    let is_archiving = request.archived == Some(true) && !workspace.archived;

    Workspace::update(
        pool,
        workspace.id,
        request.archived,
        request.pinned,
        request.name.as_deref(),
    )
    .await?;
    let updated = Workspace::find_by_id(pool, workspace.id)
        .await?
        .ok_or(WorkspaceError::WorkspaceNotFound)?;

    if (request.archived.is_some() || request.name.is_some())
        && let Ok(client) = deployment.remote_client()
    {
        let ws = updated.clone();
        let name = request.name.clone();
        let archived = request.archived;
        let stats =
            diff_stream::compute_diff_stats(&deployment.db().pool, deployment.git(), &ws).await;
        tokio::spawn(async move {
            remote_sync::sync_workspace_to_remote(
                &client,
                ws.id,
                name.map(Some),
                archived,
                stats.as_ref(),
            )
            .await;
        });
    }

    if is_archiving && let Err(e) = deployment.container().archive_workspace(workspace.id).await {
        tracing::error!("Failed to archive workspace {}: {}", workspace.id, e);
    }
    Ok(ResponseJson(ApiResponse::success(updated)))
}

/// Resolve the project id a workspace belongs to (via its linked task), if any.
/// Returns `None` for workspaces that aren't linked to a task (e.g. draft/standalone).
pub async fn get_workspace_project_id(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<Option<String>>>, ApiError> {
    let pool = &deployment.db().pool;
    let project_id = match workspace.task_id {
        Some(task_id) => Task::find_by_id(pool, task_id)
            .await?
            .map(|task| task.project_id.to_string()),
        None => None,
    };
    Ok(ResponseJson(ApiResponse::success(project_id)))
}

pub async fn get_first_user_message(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<Option<String>>>, ApiError> {
    let pool = &deployment.db().pool;
    let message = Workspace::get_first_user_message(pool, workspace.id).await?;
    Ok(ResponseJson(ApiResponse::success(message)))
}

pub async fn delete_workspace(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<DeleteWorkspaceQuery>,
) -> Result<(StatusCode, ResponseJson<ApiResponse<()>>), ApiError> {
    let pool = &deployment.db().pool;
    let workspace_manager = deployment.workspace_manager();
    let workspace_id = workspace.id;

    if ExecutionProcess::has_running_non_dev_server_processes_for_workspace(pool, workspace_id)
        .await?
    {
        return Err(ApiError::Conflict(
            "Cannot delete workspace while processes are running. Stop all processes first."
                .to_string(),
        ));
    }

    let dev_servers =
        ExecutionProcess::find_running_dev_servers_by_workspace(pool, workspace_id).await?;

    for dev_server in dev_servers {
        tracing::info!(
            "Stopping dev server {} before deleting workspace {}",
            dev_server.id,
            workspace_id
        );

        if let Err(e) = deployment
            .container()
            .stop_execution(&dev_server, ExecutionProcessStatus::Killed)
            .await
        {
            tracing::error!(
                "Failed to stop dev server {} for workspace {}: {}",
                dev_server.id,
                workspace_id,
                e
            );
        }
    }

    let managed_workspace = workspace_manager.load_managed_workspace(workspace).await?;
    let deletion_context = managed_workspace.prepare_deletion_context().await?;
    let rows_affected = managed_workspace.delete_record().await?;

    if rows_affected == 0 {
        return Err(ApiError::Database(SqlxError::RowNotFound));
    }

    match deployment.remote_client() {
        Ok(client) if query.delete_remote => match client.delete_workspace(workspace_id).await {
            Ok(()) => {
                tracing::info!("Deleted remote workspace for {}", workspace_id);
            }
            Err(e) => {
                tracing::warn!(
                    "Failed to delete remote workspace for {}: {}",
                    workspace_id,
                    e
                );
            }
        },
        // The local row is gone, so the remote mirror can never be opened again.
        // Archive it rather than deleting it: the issue keeps its PR links, but
        // the board and issue panel stop listing a workspace that no longer
        // exists. Without this the mirror stays `archived = false` forever and
        // shows up as an unopenable, undeletable card.
        Ok(client) => {
            remote_sync::sync_workspace_to_remote(&client, workspace_id, None, Some(true), None)
                .await;
        }
        Err(_) => {
            tracing::debug!(
                "Remote client not available, skipping remote cleanup for {}",
                workspace_id
            );
        }
    }

    // For in-place ("quick chat") workspaces this only removes session process
    // logs: `prepare_deletion_context` already zeroed out the directory and repo
    // paths, so the background cleanup can never touch the user's real checkout
    // or its branch (see the SAFETY note there).
    WorkspaceManager::spawn_workspace_deletion_cleanup(deletion_context, query.delete_branches);

    Ok((StatusCode::ACCEPTED, ResponseJson(ApiResponse::success(()))))
}

#[axum::debug_handler]
pub async fn mark_seen(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    let pool = &deployment.db().pool;
    CodingAgentTurn::mark_seen_by_workspace_id(pool, workspace.id).await?;
    Ok(ResponseJson(ApiResponse::success(())))
}
