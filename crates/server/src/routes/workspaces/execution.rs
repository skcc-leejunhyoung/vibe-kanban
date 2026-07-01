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

/// Pure BFS deciding which waiting workspaces a cascade cancels, extracted from
/// [`cascade_stop_blocked_dependents`] so the graph-walk logic is unit testable
/// without the cloud relationship store or the local DB.
///
/// `blocks[t]` lists the tasks that `t` directly blocks; `waiting` holds the
/// tasks that currently have a deferred (waiting) workspace. Starting at `root`,
/// each dependent is visited once and the walk only descends past a dependent
/// that was itself waiting — a non-waiting dependent (already running/finished,
/// e.g. its blocker resolved) ends that branch. Returns the tasks to cancel, in
/// cancellation order.
fn cascade_order(
    root: Uuid,
    blocks: &std::collections::HashMap<Uuid, Vec<Uuid>>,
    waiting: &HashSet<Uuid>,
) -> Vec<Uuid> {
    let mut visited: HashSet<Uuid> = HashSet::from([root]);
    let mut queue: VecDeque<Uuid> = VecDeque::from([root]);
    let mut cancelled: Vec<Uuid> = Vec::new();

    while let Some(task) = queue.pop_front() {
        for &dependent in blocks.get(&task).into_iter().flatten() {
            if !visited.insert(dependent) {
                continue;
            }
            if waiting.contains(&dependent) {
                cancelled.push(dependent);
                queue.push_back(dependent);
            }
        }
    }
    cancelled
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

    // 1. Load the reachable "blocks" subgraph and the waiting workspace(s) per
    //    task, keeping it as plain data so the cancellation decision below can
    //    run as pure, unit-tested logic (`cascade_order`).
    let mut blocks: std::collections::HashMap<Uuid, Vec<Uuid>> = std::collections::HashMap::new();
    let mut waiting: HashSet<Uuid> = HashSet::new();
    let mut waiting_workspaces: std::collections::HashMap<Uuid, Vec<Uuid>> =
        std::collections::HashMap::new();
    let mut to_load: VecDeque<Uuid> = VecDeque::from([root_task_id]);
    let mut loaded: HashSet<Uuid> = HashSet::from([root_task_id]);

    while let Some(task_id) = to_load.pop_front() {
        // Issues that `task_id` blocks (outgoing `blocking` relationships).
        let dependents: Vec<Uuid> = match client.list_issue_relationships(task_id).await {
            Ok(r) => r
                .issue_relationships
                .into_iter()
                .filter(|rel| matches!(rel.relationship_type, IssueRelationshipType::Blocking))
                .map(|rel| rel.related_issue_id)
                .collect(),
            Err(e) => {
                tracing::warn!(
                    "cascade stop: failed to list relationships for issue {}: {}",
                    task_id,
                    e
                );
                Vec::new()
            }
        };

        for &dependent in &dependents {
            if loaded.insert(dependent) {
                to_load.push_back(dependent);
            }
            if let std::collections::hash_map::Entry::Vacant(slot) =
                waiting_workspaces.entry(dependent)
            {
                match PendingExecutionStart::find_by_task_id(pool, dependent).await {
                    Ok(pendings) if !pendings.is_empty() => {
                        waiting.insert(dependent);
                        slot.insert(pendings.into_iter().map(|p| p.workspace_id).collect());
                    }
                    Ok(_) => {
                        slot.insert(Vec::new());
                    }
                    Err(e) => {
                        tracing::warn!(
                            "cascade stop: failed to find pending starts for issue {}: {}",
                            dependent,
                            e
                        );
                        slot.insert(Vec::new());
                    }
                }
            }
        }
        blocks.insert(task_id, dependents);
    }

    // 2. Decide the cancellation set/order with pure logic.
    let targets = cascade_order(root_task_id, &blocks, &waiting);

    // 3. Cancel each target's waiting workspace(s).
    for target in targets {
        for workspace_id in waiting_workspaces.get(&target).into_iter().flatten() {
            match Workspace::find_by_id(pool, *workspace_id).await {
                Ok(Some(dependent_ws)) => {
                    tracing::info!(
                        "cascade stop: cancelling workspace {} waiting on stopped \
                         blocker (issue {})",
                        dependent_ws.id,
                        target
                    );
                    deployment.container().try_stop(&dependent_ws, false).await;
                }
                Ok(None) => {}
                Err(e) => tracing::warn!(
                    "cascade stop: failed to load workspace {}: {}",
                    workspace_id,
                    e
                ),
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

#[cfg(test)]
mod cascade_tests {
    use std::collections::{HashMap, HashSet};

    use uuid::Uuid;

    use super::cascade_order;

    fn id(n: u128) -> Uuid {
        Uuid::from_u128(n)
    }

    #[test]
    fn chain_root_stop_cancels_all_downstream() {
        // 1→2→3→4, all waiting. Stopping the root cancels the whole chain.
        let (a, b, c, d) = (id(1), id(2), id(3), id(4));
        let blocks = HashMap::from([(a, vec![b]), (b, vec![c]), (c, vec![d])]);
        let waiting = HashSet::from([a, b, c, d]);
        assert_eq!(cascade_order(a, &blocks, &waiting), vec![b, c, d]);
    }

    #[test]
    fn chain_middle_stop_cancels_downstream() {
        // The reported scenario: 1→2→3→4, with 1 running and 2/3/4 waiting.
        // Stopping the MIDDLE node (2) must recursively cancel 3 and 4, and must
        // never walk back up to the untouched blocker 1.
        let (a, b, c, d) = (id(1), id(2), id(3), id(4));
        let blocks = HashMap::from([(a, vec![b]), (b, vec![c]), (c, vec![d])]);
        let waiting = HashSet::from([b, c, d]); // 1 is running, not waiting
        let cancelled = cascade_order(b, &blocks, &waiting);
        assert_eq!(cancelled, vec![c, d]);
        assert!(!cancelled.contains(&a), "must not touch the blocker above");
    }

    #[test]
    fn non_waiting_intermediate_halts_propagation() {
        // 1→2→3, with 2 already running (not waiting) and 3 waiting. The
        // "descend only past a waiting dependent" guard ends the branch at the
        // non-waiting 2, so 3 is left waiting. This documents the guard — if the
        // desired semantics are "cancel everything reachable", drop the guard.
        let (a, b, c) = (id(1), id(2), id(3));
        let blocks = HashMap::from([(a, vec![b]), (b, vec![c])]);
        let waiting = HashSet::from([c]); // only 3 waiting
        assert_eq!(cascade_order(a, &blocks, &waiting), Vec::<Uuid>::new());
    }

    #[test]
    fn non_waiting_intermediate_reachable_when_directly_blocked() {
        // Same graph but 1 *also* directly blocks 3 (1→2, 1→3, 2→3), 2 running.
        // 3 is reached directly from 1, so it is still cancelled even though the
        // 1→2→3 branch is cut at the non-waiting 2.
        let (a, b, c) = (id(1), id(2), id(3));
        let blocks = HashMap::from([(a, vec![b, c]), (b, vec![c])]);
        let waiting = HashSet::from([c]); // 2 running, 3 waiting
        assert_eq!(cascade_order(a, &blocks, &waiting), vec![c]);
    }

    #[test]
    fn fan_out_cancels_all_direct_dependents() {
        // 1 blocks 2, 3, 4 directly. Stopping 1 cancels all three.
        let (a, b, c, d) = (id(1), id(2), id(3), id(4));
        let blocks = HashMap::from([(a, vec![b, c, d])]);
        let waiting = HashSet::from([b, c, d]);
        let mut got = cascade_order(a, &blocks, &waiting);
        got.sort();
        let mut want = vec![b, c, d];
        want.sort();
        assert_eq!(got, want);
    }

    #[test]
    fn cycle_terminates_without_rerunning_root() {
        // 1→2→3→1. Must terminate; the root is never re-cancelled.
        let (a, b, c) = (id(1), id(2), id(3));
        let blocks = HashMap::from([(a, vec![b]), (b, vec![c]), (c, vec![a])]);
        let waiting = HashSet::from([a, b, c]);
        assert_eq!(cascade_order(a, &blocks, &waiting), vec![b, c]);
    }

    #[test]
    fn diamond_join_cancelled_once() {
        // 1→2, 1→3, 2→4, 3→4. The join (4) is cancelled exactly once.
        let (a, b, c, d) = (id(1), id(2), id(3), id(4));
        let blocks = HashMap::from([(a, vec![b, c]), (b, vec![d]), (c, vec![d])]);
        let waiting = HashSet::from([b, c, d]);
        let cancelled = cascade_order(a, &blocks, &waiting);
        assert_eq!(cancelled, vec![b, c, d]);
        assert_eq!(
            cancelled.iter().filter(|&&t| t == d).count(),
            1,
            "join node cancelled exactly once"
        );
    }
}
