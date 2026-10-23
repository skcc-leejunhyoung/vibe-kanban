use std::path::PathBuf;

use axum::{Extension, Json, extract::State, response::Json as ResponseJson};
use chrono::{DateTime, Utc};
use db::models::{
    coding_agent_turn::CodingAgentTurn,
    execution_process::{ExecutionProcess, ExecutionProcessRunReason},
    session::Session,
    vibe_run::{VibeRun, VibeRunError},
    workspace::{Workspace, WorkspaceError},
    workspace_repo::WorkspaceRepo,
};
use deployment::Deployment;
use executors::{
    actions::{
        ExecutorAction, ExecutorActionType,
        review::{RepoReviewContext as ExecutorRepoReviewContext, ReviewRequest as ReviewAction},
    },
    executors::build_review_prompt,
    profile::ExecutorConfig,
};
use serde::{Deserialize, Serialize};
use services::services::container::ContainerService;
use ts_rs::TS;
use utils::response::ApiResponse;

use crate::{DeploymentImpl, error::ApiError};

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct StartReviewRequest {
    pub executor_config: ExecutorConfig,
    pub additional_prompt: Option<String>,
    #[serde(default)]
    pub use_all_workspace_commits: bool,
}

/// The chat settings selected when manually starting an automated review.
/// This is optional so callers that do not have an active chat selector retain
/// the existing behavior of inheriting the source session's last-used config.
#[derive(Debug, Default, Deserialize, Serialize, TS)]
pub struct VibeReviewRequest {
    pub executor_config: Option<ExecutorConfig>,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum ReviewError {
    ProcessAlreadyRunning,
    NoLinkedIssue,
    /// No blocked or merging vibe run with a review session to merge from.
    NothingToMerge,
}

#[derive(Debug, Serialize, TS)]
pub struct VibeReviewStatus {
    pub phase: Option<String>,
    /// Why the last auto-merge attempt failed, until a merge lands.
    pub last_error: Option<String>,
    /// When a merge waiting on a retryable failure is tried again.
    pub merge_retry_at: Option<DateTime<Utc>>,
}

impl From<Option<VibeRun>> for VibeReviewStatus {
    fn from(run: Option<VibeRun>) -> Self {
        Self {
            phase: run.as_ref().map(|run| run.phase.clone()),
            last_error: run.as_ref().and_then(|run| run.last_error.clone()),
            merge_retry_at: run.and_then(|run| run.merge_retry_at),
        }
    }
}

fn vibe_run_error(error: VibeRunError) -> ApiError {
    match error {
        VibeRunError::Database(error) => ApiError::Database(error),
    }
}

#[axum::debug_handler]
pub async fn vibe_review_status(
    Extension(session): Extension<Session>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<VibeReviewStatus>>, ApiError> {
    let run = VibeRun::find_by_workspace_id(&deployment.db().pool, session.workspace_id)
        .await
        .map_err(vibe_run_error)?;
    Ok(ResponseJson(ApiResponse::success(run.into())))
}

/// Merge a `vibe` run again after it was blocked (or while it waits on a
/// retryable failure): a fresh attempt with the full retry budget. A human
/// asks for it, so any blocked run with a review session qualifies.
#[axum::debug_handler]
pub async fn vibe_retry_merge(
    Extension(session): Extension<Session>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<VibeReviewStatus, ReviewError>>, ApiError> {
    let pool = &deployment.db().pool;
    let run = VibeRun::find_by_workspace_id(pool, session.workspace_id)
        .await
        .map_err(vibe_run_error)?;
    let retryable = run.as_ref().is_some_and(|run| {
        matches!(run.phase.as_str(), "blocked" | "merging") && run.review_session_id.is_some()
    });
    if !retryable {
        return Ok(ResponseJson(ApiResponse::error_with_data(
            ReviewError::NothingToMerge,
        )));
    }
    if ExecutionProcess::has_running_non_dev_server_processes_for_workspace(
        pool,
        session.workspace_id,
    )
    .await?
    {
        return Ok(ResponseJson(ApiResponse::error_with_data(
            ReviewError::ProcessAlreadyRunning,
        )));
    }
    let workspace = Workspace::find_by_id(pool, session.workspace_id)
        .await?
        .ok_or(ApiError::Workspace(WorkspaceError::ValidationError(
            "Workspace not found".to_string(),
        )))?;

    deployment
        .container()
        .vibe_retry_merge(&workspace, true)
        .await?;

    let run = VibeRun::find_by_workspace_id(pool, session.workspace_id)
        .await
        .map_err(vibe_run_error)?;
    Ok(ResponseJson(ApiResponse::success(run.into())))
}

#[axum::debug_handler]
pub async fn start_review(
    Extension(session): Extension<Session>,
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<StartReviewRequest>,
) -> Result<ResponseJson<ApiResponse<ExecutionProcess, ReviewError>>, ApiError> {
    let pool = &deployment.db().pool;

    let mut workspace = Workspace::find_by_id(pool, session.workspace_id)
        .await?
        .ok_or(ApiError::Workspace(WorkspaceError::ValidationError(
            "Workspace not found".to_string(),
        )))?;

    if ExecutionProcess::has_running_non_dev_server_processes_for_session(pool, session.id).await? {
        return Ok(ResponseJson(ApiResponse::error_with_data(
            ReviewError::ProcessAlreadyRunning,
        )));
    }

    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    // Spawn with the row as the ensure left it (see follow_up_inner).
    if let Some(fresh) = Workspace::find_by_id(pool, workspace.id).await? {
        workspace = fresh;
    }
    workspace.container_ref.get_or_insert(container_ref.clone());
    deployment
        .container()
        .wait_for_session_ready(session.id)
        .await;

    let agent_session_id = CodingAgentTurn::find_latest_session_info(pool, session.id)
        .await?
        .map(|info| info.session_id);

    let context: Option<Vec<ExecutorRepoReviewContext>> = if payload.use_all_workspace_commits {
        let repos =
            WorkspaceRepo::find_repos_with_target_branch_for_workspace(pool, workspace.id).await?;
        let workspace_path = PathBuf::from(container_ref.as_str());

        let mut contexts = Vec::new();
        for repo in repos {
            let worktree_path = workspace_path.join(&repo.repo.name);
            if let Ok(base_commit) = deployment.git().get_fork_point(
                &worktree_path,
                &repo.target_branch,
                &workspace.branch,
            ) {
                contexts.push(ExecutorRepoReviewContext {
                    repo_id: repo.repo.id,
                    repo_name: repo.repo.display_name,
                    base_commit,
                });
            }
        }
        if contexts.is_empty() {
            None
        } else {
            Some(contexts)
        }
    } else {
        None
    };

    let prompt = build_review_prompt(context.as_deref(), payload.additional_prompt.as_deref());
    let action = ExecutorAction::new(
        ExecutorActionType::ReviewRequest(ReviewAction {
            executor_config: payload.executor_config.clone(),
            context,
            prompt,
            session_id: agent_session_id,
            working_dir: session.agent_working_dir.clone(),
        }),
        None,
    );

    // Answer with the row so the review turn is on screen at once; the agent
    // spawn finishes in the background (a failure is written to the row).
    let execution_process = deployment
        .container()
        .create_execution_record(
            &workspace,
            &session,
            &action,
            &ExecutionProcessRunReason::CodingAgent,
        )
        .await?;
    {
        let deployment = deployment.clone();
        let record = execution_process.clone();
        tokio::spawn(async move {
            if let Err(e) = deployment
                .container()
                .finish_execution_spawn(&workspace, &session, &record, &action)
                .await
            {
                tracing::error!(
                    "Background review start for session {} failed: {}",
                    session.id,
                    e
                );
            }
        });
    }

    Ok(ResponseJson(ApiResponse::success(execution_process)))
}

/// Manually start a `vibe` review session for the current workspace, behaving as
/// if its coding agent had just reported `VIBE_RESULT: done`. Spawns a fresh
/// dedicated review session (and hands the rest of the automated workflow off to
/// the backend) instead of a one-shot review of the current session.
#[axum::debug_handler]
pub async fn vibe_review(
    Extension(session): Extension<Session>,
    State(deployment): State<DeploymentImpl>,
    payload: Option<Json<VibeReviewRequest>>,
) -> Result<ResponseJson<ApiResponse<Session, ReviewError>>, ApiError> {
    let pool = &deployment.db().pool;

    let workspace = Workspace::find_by_id(pool, session.workspace_id)
        .await?
        .ok_or(ApiError::Workspace(WorkspaceError::ValidationError(
            "Workspace not found".to_string(),
        )))?;

    if workspace.task_id.is_none() {
        return Ok(ResponseJson(ApiResponse::error_with_data(
            ReviewError::NoLinkedIssue,
        )));
    }

    // Automated review owns the workspace's shared review/merge state.
    if ExecutionProcess::has_running_non_dev_server_processes_for_workspace(pool, workspace.id)
        .await?
    {
        return Ok(ResponseJson(ApiResponse::error_with_data(
            ReviewError::ProcessAlreadyRunning,
        )));
    }

    deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;

    let review_session = deployment
        .container()
        .vibe_manual_start_review(
            &workspace,
            &session,
            payload.and_then(|Json(request)| request.executor_config),
        )
        .await?;

    Ok(ResponseJson(ApiResponse::success(review_session)))
}
