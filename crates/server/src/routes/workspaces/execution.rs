use std::collections::{HashSet, VecDeque};

use api_types::IssueRelationshipType;
use axum::{
    Extension, Router,
    extract::State,
    response::Json as ResponseJson,
    routing::{get, post},
};
use db::models::{
    execution_process::{ExecutionProcess, ExecutionProcessRunReason, ExecutionProcessStatus},
    pending_execution_start::PendingExecutionStart,
    session::{CreateSession, Session},
    workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
use deployment::Deployment;
use executors::actions::{
    ExecutorAction, ExecutorActionType,
    script::{ScriptContext, ScriptRequest, ScriptRequestLanguage},
};
use serde::{Deserialize, Serialize};
use services::services::container::ContainerService;
use ts_rs::TS;
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum RunScriptError {
    NoScriptConfigured,
    ProcessAlreadyRunning,
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/dev-server/start", post(start_dev_server))
        .route("/dev-servers", get(get_dev_servers))
        .route("/cleanup", post(run_cleanup_script))
        .route("/archive", post(run_archive_script))
        .route("/stop", post(stop_workspace_execution))
}

/// Return dev server processes for the workspace across all of its sessions.
/// The preview is workspace-scoped, so it must not depend on which session the
/// user currently has selected.
pub async fn get_dev_servers(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<Vec<ExecutionProcess>>>, ApiError> {
    let pool = &deployment.db().pool;
    let dev_servers = ExecutionProcess::find_dev_servers_by_workspace(pool, workspace.id).await?;
    Ok(ResponseJson(ApiResponse::success(dev_servers)))
}

#[axum::debug_handler]
pub async fn start_dev_server(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<Vec<ExecutionProcess>>>, ApiError> {
    let pool = &deployment.db().pool;

    let existing_dev_servers =
        match ExecutionProcess::find_running_dev_servers_by_workspace(pool, workspace.id).await {
            Ok(servers) => servers,
            Err(e) => {
                tracing::error!(
                    "Failed to find running dev servers for workspace {}: {}",
                    workspace.id,
                    e
                );
                return Err(ApiError::Workspace(
                    db::models::workspace::WorkspaceError::ValidationError(e.to_string()),
                ));
            }
        };

    for dev_server in existing_dev_servers {
        tracing::info!(
            "Stopping existing dev server {} for workspace {}",
            dev_server.id,
            workspace.id
        );

        if let Err(e) = deployment
            .container()
            .stop_execution(&dev_server, ExecutionProcessStatus::Killed)
            .await
        {
            tracing::error!("Failed to stop dev server {}: {}", dev_server.id, e);
        }
    }

    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let repos_with_dev_script: Vec<_> = repos
        .iter()
        .filter(|r| r.dev_server_script.as_ref().is_some_and(|s| !s.is_empty()))
        .collect();

    if repos_with_dev_script.is_empty() {
        return Ok(ResponseJson(ApiResponse::error(
            "No dev server script configured for any repository in this workspace",
        )));
    }

    let session = match Session::find_latest_by_workspace_id(pool, workspace.id).await? {
        Some(s) => s,
        None => {
            Session::create(
                pool,
                &CreateSession {
                    executor: Some("dev-server".to_string()),
                    name: None,
                },
                Uuid::new_v4(),
                workspace.id,
            )
            .await?
        }
    };

    let mut execution_processes = Vec::new();
    for repo in repos_with_dev_script {
        let executor_action = ExecutorAction::new(
            ExecutorActionType::ScriptRequest(ScriptRequest {
                script: repo.dev_server_script.clone().unwrap(),
                language: ScriptRequestLanguage::Bash,
                context: ScriptContext::DevServer,
                // In-place ("quick chat") workspaces run in the repo root itself
                // (`container_ref` IS the repo), so there is no per-repo subdir to
                // descend into — run the dev script at the root.
                working_dir: if workspace.in_place {
                    None
                } else {
                    Some(repo.name.clone())
                },
            }),
            None,
        );

        let execution_process = deployment
            .container()
            .start_execution(
                &workspace,
                &session,
                &executor_action,
                &ExecutionProcessRunReason::DevServer,
            )
            .await?;
        execution_processes.push(execution_process);
    }

    deployment
        .track_if_analytics_allowed(
            "dev_server_started",
            serde_json::json!({
                "workspace_id": workspace.id.to_string(),
            }),
        )
        .await;

    Ok(ResponseJson(ApiResponse::success(execution_processes)))
}

pub async fn stop_workspace_execution(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    deployment.container().try_stop(&workspace, false).await;

    // Cascade: a workspace deferred behind this one (linked via a `blocking`
    // issue relationship) can never be unblocked by it once it is stopped, so
    // cancel those waiting starts too — transitively down the dependency graph.
    if let Some(task_id) = workspace.task_id {
        cascade_stop_blocked_dependents(&deployment, task_id).await;
    }

    deployment
        .track_if_analytics_allowed(
            "task_attempt_stopped",
            serde_json::json!({
                "workspace_id": workspace.id.to_string(),
            }),
        )
        .await;

    Ok(ResponseJson(ApiResponse::success(())))
}

/// Cancels every workspace queued behind `root_task_id` via a `blocking` issue
/// relationship, transitively. When a vibe session is stopped, the issues it was
/// blocking can no longer become unblocked by it, so their deferred ("waiting")
/// starts are cancelled too, cascading down the dependency graph.
///
/// Only deferred (blocker-gated) starts are stopped — `try_stop` skips processes
/// that are not `Running`, and a deferred start carries a `pending_execution_starts`
/// row, so an already-finished or genuinely-running dependent is left as-is.
/// Best-effort: the relationship graph lives in the cloud, so this no-ops when no
/// remote client is configured, and individual failures are logged, not raised.
async fn cascade_stop_blocked_dependents(deployment: &DeploymentImpl, root_task_id: Uuid) {
    let client = match deployment.remote_client() {
        Ok(c) => c,
        Err(_) => return,
    };
    let pool = &deployment.db().pool;

    let mut visited: HashSet<Uuid> = HashSet::from([root_task_id]);
    let mut queue: VecDeque<Uuid> = VecDeque::from([root_task_id]);

    while let Some(task_id) = queue.pop_front() {
        // Issues that `task_id` blocks (outgoing `blocking` relationships).
        let relationships = match client.list_issue_relationships(task_id).await {
            Ok(r) => r.issue_relationships,
            Err(e) => {
                tracing::warn!(
                    "cascade stop: failed to list relationships for issue {}: {}",
                    task_id,
                    e
                );
                continue;
            }
        };

        for rel in relationships {
            if !matches!(rel.relationship_type, IssueRelationshipType::Blocking) {
                continue;
            }
            let dependent_task = rel.related_issue_id;
            if !visited.insert(dependent_task) {
                continue;
            }

            // Stop any workspace deferred behind this dependent issue.
            let mut stopped_any = false;
            match PendingExecutionStart::find_by_task_id(pool, dependent_task).await {
                Ok(pendings) => {
                    for pending in pendings {
                        match Workspace::find_by_id(pool, pending.workspace_id).await {
                            Ok(Some(dependent_ws)) => {
                                tracing::info!(
                                    "cascade stop: cancelling workspace {} waiting on stopped \
                                     blocker (issue {})",
                                    dependent_ws.id,
                                    dependent_task
                                );
                                deployment.container().try_stop(&dependent_ws, false).await;
                                stopped_any = true;
                            }
                            Ok(None) => {}
                            Err(e) => tracing::warn!(
                                "cascade stop: failed to load workspace {}: {}",
                                pending.workspace_id,
                                e
                            ),
                        }
                    }
                }
                Err(e) => tracing::warn!(
                    "cascade stop: failed to find pending starts for issue {}: {}",
                    dependent_task,
                    e
                ),
            }

            // Only propagate down a chain we actually cut. If this dependent was
            // not waiting (already running or finished — e.g. its blocker had
            // resolved), its own descendants are not gated on the stopped blocker
            // and must be left untouched.
            if stopped_any {
                queue.push_back(dependent_task);
            }
        }
    }
}

#[axum::debug_handler]
pub async fn run_cleanup_script(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<ExecutionProcess, RunScriptError>>, ApiError> {
    let pool = &deployment.db().pool;

    if ExecutionProcess::has_running_non_dev_server_processes_for_workspace(pool, workspace.id)
        .await?
    {
        return Ok(ResponseJson(ApiResponse::error_with_data(
            RunScriptError::ProcessAlreadyRunning,
        )));
    }

    deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;

    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let executor_action = match deployment.container().cleanup_actions_for_repos(&repos) {
        Some(action) => action,
        None => {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                RunScriptError::NoScriptConfigured,
            )));
        }
    };

    let session = match Session::find_latest_by_workspace_id(pool, workspace.id).await? {
        Some(s) => s,
        None => {
            Session::create(
                pool,
                &CreateSession {
                    executor: None,
                    name: None,
                },
                Uuid::new_v4(),
                workspace.id,
            )
            .await?
        }
    };

    let execution_process = deployment
        .container()
        .start_execution(
            &workspace,
            &session,
            &executor_action,
            &ExecutionProcessRunReason::CleanupScript,
        )
        .await?;

    deployment
        .track_if_analytics_allowed(
            "cleanup_script_executed",
            serde_json::json!({
                "workspace_id": workspace.id.to_string(),
            }),
        )
        .await;

    Ok(ResponseJson(ApiResponse::success(execution_process)))
}

pub async fn run_archive_script(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<ExecutionProcess, RunScriptError>>, ApiError> {
    let pool = &deployment.db().pool;
    if ExecutionProcess::has_running_non_dev_server_processes_for_workspace(pool, workspace.id)
        .await?
    {
        return Ok(ResponseJson(ApiResponse::error_with_data(
            RunScriptError::ProcessAlreadyRunning,
        )));
    }

    deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;

    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let executor_action = match deployment.container().archive_actions_for_repos(&repos) {
        Some(action) => action,
        None => {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                RunScriptError::NoScriptConfigured,
            )));
        }
    };
    let session = match Session::find_latest_by_workspace_id(pool, workspace.id).await? {
        Some(s) => s,
        None => {
            Session::create(
                pool,
                &CreateSession {
                    executor: None,
                    name: None,
                },
                Uuid::new_v4(),
                workspace.id,
            )
            .await?
        }
    };

    let execution_process = deployment
        .container()
        .start_execution(
            &workspace,
            &session,
            &executor_action,
            &ExecutionProcessRunReason::ArchiveScript,
        )
        .await?;

    deployment
        .track_if_analytics_allowed(
            "archive_script_executed",
            serde_json::json!({
                "workspace_id": workspace.id.to_string(),
            }),
        )
        .await;

    Ok(ResponseJson(ApiResponse::success(execution_process)))
}
