use std::collections::{HashMap, HashSet};

use axum::{Json, extract::State, response::Json as ResponseJson};
use db::models::{
    coding_agent_turn::CodingAgentTurn,
    execution_process::{ExecutionProcess, ExecutionProcessStatus},
    merge::MergeStatus,
    pending_execution_start::PendingExecutionStart,
    pull_request::PullRequest,
    workspace::Workspace,
};
use deployment::Deployment;
use executors::logs::{TodoProgress, todo_progress_from_logs};
use serde::{Deserialize, Serialize};
use services::services::container::ContainerService;
use ts_rs::TS;
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

/// Request for fetching workspace summaries
#[derive(Debug, Deserialize, Serialize, TS)]
pub struct WorkspaceSummaryRequest {
    pub archived: bool,
}

/// Summary info for a single workspace
#[derive(Debug, Serialize, TS)]
pub struct WorkspaceSummary {
    pub workspace_id: Uuid,
    /// Session ID of the latest execution process
    pub latest_session_id: Option<Uuid>,
    /// Is a tool approval currently pending?
    pub has_pending_approval: bool,
    /// Number of files with changes
    pub files_changed: Option<usize>,
    /// Total lines added across all files
    pub lines_added: Option<usize>,
    /// Total lines removed across all files
    pub lines_removed: Option<usize>,
    /// When the latest execution process completed
    #[ts(optional)]
    pub latest_process_completed_at: Option<chrono::DateTime<chrono::Utc>>,
    /// Status of the latest execution process
    pub latest_process_status: Option<ExecutionProcessStatus>,
    /// True when the latest execution is a blocker-gated deferred start that
    /// hasn't spawned yet — the workspace is "waiting" on its linked issue's
    /// upstream blockers. Its `latest_process_status` is `Running` even though no
    /// agent is actually running, so the UI uses this to show a "waiting" state
    /// (and to allow stopping the wait) instead of a live "running" state.
    pub is_waiting_on_blockers: bool,
    /// Is a dev server currently running?
    pub has_running_dev_server: bool,
    /// Does this workspace have unseen coding agent turns?
    pub has_unseen_turns: bool,
    /// Total items in the agent's latest TODO list. Only computed while the
    /// workspace is running; `None` when idle or no TODO list exists.
    pub todo_total: Option<usize>,
    /// Completed items in the agent's latest TODO list (see `todo_total`).
    pub todo_completed: Option<usize>,
    /// The most recent prompt sent in this workspace (what it's working on)
    pub latest_prompt: Option<String>,
    /// PR status for this workspace (if any PR exists)
    pub pr_status: Option<MergeStatus>,
    /// PR number for this workspace (if any PR exists)
    pub pr_number: Option<i64>,
    /// PR URL for this workspace (if any PR exists)
    pub pr_url: Option<String>,
}

/// Response containing summaries for requested workspaces
#[derive(Debug, Serialize, TS)]
pub struct WorkspaceSummaryResponse {
    pub summaries: Vec<WorkspaceSummary>,
}

#[derive(Debug, Clone, Default, Serialize, TS)]
pub struct DiffStats {
    pub files_changed: usize,
    pub lines_added: usize,
    pub lines_removed: usize,
}

/// Fetch summary information for workspaces filtered by archived status.
/// This endpoint returns data that cannot be efficiently included in the streaming endpoint.
#[axum::debug_handler]
pub async fn get_workspace_summaries(
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<WorkspaceSummaryRequest>,
) -> Result<ResponseJson<ApiResponse<WorkspaceSummaryResponse>>, ApiError> {
    let pool = &deployment.db().pool;
    let archived = request.archived;

    // 1. Fetch all workspaces with the given archived status
    let workspaces: Vec<Workspace> = Workspace::find_all_with_status(pool, Some(archived), None)
        .await?
        .into_iter()
        .map(|ws| ws.workspace)
        .collect();

    if workspaces.is_empty() {
        return Ok(ResponseJson(ApiResponse::success(
            WorkspaceSummaryResponse { summaries: vec![] },
        )));
    }

    // 2. Fetch latest process info for workspaces with this archived status
    let latest_processes = ExecutionProcess::find_latest_for_workspaces(pool, archived).await?;

    // 2b. Blocker-gated deferred starts: their execution_process row is Running
    //     but no agent was actually spawned. Collect their ids so the latest
    //     process can be surfaced as "waiting" rather than "running".
    //     Best-effort — on failure no workspace is marked waiting.
    let pending_ep_ids: HashSet<Uuid> = PendingExecutionStart::find_all(pool)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|p| p.execution_process_id)
        .collect();

    // 3. Check which workspaces have running dev servers
    let dev_server_workspaces =
        ExecutionProcess::find_workspaces_with_running_dev_servers(pool, archived).await?;

    // 4. Check pending approvals for running processes
    let running_ep_ids: Vec<_> = latest_processes
        .values()
        .filter(|info| info.status == ExecutionProcessStatus::Running)
        .map(|info| info.execution_process_id)
        .collect();
    let pending_approval_eps = deployment
        .approvals()
        .get_pending_execution_process_ids(&running_ep_ids);

    // 4b. Compute TODO progress for *running* workspaces only. While a process
    //     runs its logs live in the in-memory MsgStore, not the DB
    //     (execution_process_logs stays empty for live runs), so we read the
    //     latest normalized entries from there. The indicator only shows while
    //     running, so idle/finished workspaces are skipped entirely.
    let todo_futures: Vec<_> = latest_processes
        .iter()
        .filter(|(_, info)| info.status == ExecutionProcessStatus::Running)
        .map(|(ws_id, info)| {
            let deployment = deployment.clone();
            let ws_id = *ws_id;
            let ep_id = info.execution_process_id;
            async move {
                let msg_store = deployment.container().get_msg_store_by_id(&ep_id).await?;
                let messages = msg_store.get_history();
                todo_progress_from_logs(&messages).map(|progress| (ws_id, progress))
            }
        })
        .collect();
    let todo_progress: HashMap<Uuid, TodoProgress> = futures_util::future::join_all(todo_futures)
        .await
        .into_iter()
        .flatten()
        .collect();

    // 5. Check which workspaces have unseen coding agent turns
    let unseen_workspaces = CodingAgentTurn::find_workspaces_with_unseen(pool, archived).await?;

    // 5b. Fetch the latest prompt for each workspace (what it's working on)
    let latest_prompts =
        CodingAgentTurn::find_latest_prompts_for_workspaces(pool, archived).await?;

    // 6. Get PR status for each workspace
    let pr_statuses = PullRequest::get_latest_for_workspaces(pool, archived).await?;

    // 7. Compute diff stats for each workspace (in parallel)
    let diff_futures: Vec<_> = workspaces
        .iter()
        .map(|ws| {
            let workspace = ws.clone();
            let deployment = deployment.clone();
            async move {
                if workspace.container_ref.is_some() {
                    compute_workspace_diff_stats(&deployment, &workspace)
                        .await
                        .map(|stats| (workspace.id, stats))
                } else {
                    None
                }
            }
        })
        .collect();

    let diff_results: Vec<Option<(Uuid, DiffStats)>> =
        futures_util::future::join_all(diff_futures).await;
    let diff_stats: HashMap<Uuid, DiffStats> = diff_results.into_iter().flatten().collect();

    // 8. Assemble response
    let summaries: Vec<WorkspaceSummary> = workspaces
        .iter()
        .map(|ws| {
            let id = ws.id;
            let latest = latest_processes.get(&id);
            let has_pending = latest
                .map(|p| pending_approval_eps.contains(&p.execution_process_id))
                .unwrap_or(false);
            let stats = diff_stats.get(&id);
            let todo = todo_progress.get(&id);

            WorkspaceSummary {
                workspace_id: id,
                latest_session_id: latest.map(|p| p.session_id),
                has_pending_approval: has_pending,
                files_changed: stats.map(|s| s.files_changed),
                lines_added: stats.map(|s| s.lines_added),
                lines_removed: stats.map(|s| s.lines_removed),
                latest_process_completed_at: latest.and_then(|p| p.completed_at),
                latest_process_status: latest.map(|p| p.status.clone()),
                is_waiting_on_blockers: latest
                    .map(|p| pending_ep_ids.contains(&p.execution_process_id))
                    .unwrap_or(false),
                has_running_dev_server: dev_server_workspaces.contains(&id),
                has_unseen_turns: unseen_workspaces.contains(&id),
                todo_total: todo.map(|t| t.total),
                todo_completed: todo.map(|t| t.completed),
                latest_prompt: latest_prompts.get(&id).cloned(),
                pr_status: pr_statuses.get(&id).map(|pr| pr.pr_status.clone()),
                pr_number: pr_statuses.get(&id).map(|pr| pr.pr_number),
                pr_url: pr_statuses.get(&id).map(|pr| pr.pr_url.clone()),
            }
        })
        .collect();

    Ok(ResponseJson(ApiResponse::success(
        WorkspaceSummaryResponse { summaries },
    )))
}

/// Compute diff stats for a workspace.
pub async fn compute_workspace_diff_stats(
    deployment: &DeploymentImpl,
    workspace: &Workspace,
) -> Option<DiffStats> {
    let stats = services::services::diff_stream::compute_diff_stats(
        &deployment.db().pool,
        deployment.git(),
        workspace,
    )
    .await?;

    Some(DiffStats {
        files_changed: stats.files_changed,
        lines_added: stats.lines_added,
        lines_removed: stats.lines_removed,
    })
}
