use std::path::PathBuf;

use axum::{Extension, Json, extract::State, response::Json as ResponseJson};
use chrono::{DateTime, Utc};
use db::models::{
    coding_agent_turn::CodingAgentTurn,
    execution_process::{ExecutionProcess, ExecutionProcessRunReason},
    session::Session,
    vibe_run::{PrBase, PrBaseSelection, PrRequest, VibeRun, VibeRunError},
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
use services::services::{
    config::AgentAccessConfig, container::ContainerService, vibe_orchestrator::PR_FOLLOW_UP,
    vibe_pr_bases,
};
use ts_rs::TS;
use utils::response::ApiResponse;

use crate::{
    DeploymentImpl,
    error::ApiError,
    middleware::{Toggle, is_agent_request},
};

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
    /// "Review and create PR": once the review approves, the automation
    /// worker has this host merge, push the target branch and open an
    /// AI-drafted draft PR. Nothing after this request depends on the caller
    /// staying connected (a host without the worker stops at the approval).
    #[serde(default)]
    pub create_pr: bool,
    #[serde(default)]
    #[ts(optional)]
    pub pr_bases: Option<Vec<PrBaseSelection>>,
}

#[derive(Debug, Default, Deserialize, Serialize, TS)]
pub struct VibeRetryRequest {
    #[serde(default)]
    #[ts(optional)]
    pub pr_bases: Option<Vec<PrBaseSelection>>,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum ReviewError {
    ProcessAlreadyRunning,
    NoLinkedIssue,
    /// No merging vibe run, or one blocked by a failed merge or by the push /
    /// PR step after it, to try again.
    NothingToMerge,
}

#[derive(Debug, Serialize, TS)]
pub struct VibeReviewStatus {
    /// `coding`, `review`, `merging`, `pushing`, `creating_pr`, `blocked` or
    /// `done`; `None` when the workspace has no vibe run.
    pub phase: Option<String>,
    /// Why the last auto-merge attempt failed, until a merge lands; or why the
    /// step named by `failed_phase` stopped.
    pub last_error: Option<String>,
    /// When a merge waiting on a retryable failure is tried again.
    pub merge_retry_at: Option<DateTime<Utc>>,
    /// The run was started as "review and create PR".
    pub pr_requested: bool,
    /// `pushing` or `creating_pr` when that step blocked the run: a retry
    /// resumes there without reviewing or merging again.
    pub failed_phase: Option<String>,
    #[ts(optional)]
    pub pr_bases: Option<Vec<PrBase>>,
    /// When the run last changed (entered its phase).
    pub updated_at: Option<DateTime<Utc>>,
    /// The `vibe.*` event the automation worker has not acted on yet
    /// (`vibe.turn_ended`, `vibe.merge_result`, ...): the run waits for it.
    pub pending_kind: Option<String>,
    /// That event's verdict: the turn's `VIBE_RESULT` (`approve`, ...) or the
    /// merge's or PR's outcome (`merged`, `opened`, ...).
    pub pending_outcome: Option<String>,
}

impl From<Option<VibeRun>> for VibeReviewStatus {
    fn from(run: Option<VibeRun>) -> Self {
        let Some(run) = run else {
            return Self {
                phase: None,
                last_error: None,
                merge_retry_at: None,
                pr_requested: false,
                failed_phase: None,
                pr_bases: None,
                updated_at: None,
                pending_kind: None,
                pending_outcome: None,
            };
        };
        let pending = run.pending.as_ref().map(|pending| &pending.0);
        let field = |name: &str| {
            pending
                .and_then(|pending| pending.get(name))
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        };
        let pending_kind = field("kind");
        let pending_outcome = field("outcome").or_else(|| field("result"));
        Self {
            phase: Some(run.phase),
            last_error: run.last_error,
            merge_retry_at: run.merge_retry_at,
            pr_requested: run.pr_requested,
            failed_phase: run.failed_phase,
            pr_bases: run.pr_bases.map(|bases| bases.0),
            updated_at: Some(run.updated_at),
            pending_kind,
            pending_outcome,
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

/// Whether a manual retry may merge `run`: an approved run still merging, or
/// one blocked by a failed merge. A run its review blocked was never approved.
fn can_retry_merge(run: &VibeRun) -> bool {
    run.review_session_id.is_some()
        && matches!(run.phase.as_str(), "merging" | "blocked")
        && run.last_error.is_some()
}

/// Try a `vibe` run's failed step again. A run blocked by the push or the PR
/// after its merge resumes at that step, with no new review or merge. A run
/// blocked by a failed merge (or waiting on a retryable one) merges again: a
/// fresh attempt with the full retry budget.
#[axum::debug_handler]
pub async fn vibe_retry_merge(
    Extension(session): Extension<Session>,
    State(deployment): State<DeploymentImpl>,
    headers: axum::http::HeaderMap,
    payload: Option<Json<VibeRetryRequest>>,
) -> Result<ResponseJson<ApiResponse<VibeReviewStatus, ReviewError>>, ApiError> {
    let pool = &deployment.db().pool;
    let request = payload.map(|Json(request)| request).unwrap_or_default();
    let Some(run) = VibeRun::find_by_workspace_id(pool, session.workspace_id)
        .await
        .map_err(vibe_run_error)?
        .filter(can_retry_merge)
    else {
        return Ok(ResponseJson(ApiResponse::error_with_data(
            ReviewError::NothingToMerge,
        )));
    };
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
        .ok_or_else(|| ApiError::BadRequest("Workspace not found".into()))?;
    if is_agent_request(&headers) && (run.pr_requested || run.failed_phase.is_some()) {
        require_create_pr_access(&deployment).await?;
    }
    let bases = if run.pr_requested {
        Some(
            vibe_pr_bases::resolve(
                pool,
                deployment.git(),
                &workspace,
                request.pr_bases.as_deref(),
                if request.pr_bases.is_some() {
                    None
                } else {
                    run.pr_bases.as_ref().map(|b| b.0.as_slice())
                },
                run.failed_phase.is_some(),
            )
            .await
            .map_err(ApiError::BadRequest)?,
        )
    } else {
        if request.pr_bases.is_some() {
            return Err(ApiError::BadRequest(
                "PR bases require a review-and-create-PR run".into(),
            ));
        }
        None
    };
    if !VibeRun::retry(pool, &run, bases.as_deref())
        .await
        .map_err(vibe_run_error)?
    {
        return Ok(ResponseJson(ApiResponse::error_with_data(
            ReviewError::NothingToMerge,
        )));
    }
    if run.failed_phase.is_some() {
        PR_FOLLOW_UP.notify_one();
    } else {
        deployment
            .container()
            .vibe_retry_merge(&workspace, run.generation + 1, true)
            .await?;
    }

    let run = VibeRun::find_by_workspace_id(pool, session.workspace_id)
        .await
        .map_err(vibe_run_error)?;
    Ok(ResponseJson(ApiResponse::success(run.into())))
}

#[axum::debug_handler]
pub async fn start_review(
    Extension(session): Extension<Session>,
    State(deployment): State<DeploymentImpl>,
    headers: axum::http::HeaderMap,
    Json(payload): Json<StartReviewRequest>,
) -> Result<ResponseJson<ApiResponse<ExecutionProcess, ReviewError>>, ApiError> {
    let pool = deployment.db().pool.clone();
    let agent_session = crate::routes::automation::agent_session(&headers);
    let result = start_review_inner(Extension(session), State(deployment), Json(payload)).await;
    if let Ok(response) = &result
        && let Some(execution) = response.0.data()
    {
        crate::routes::automation::record_agent_origin(&pool, execution.id, agent_session).await;
    }
    result
}

async fn start_review_inner(
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

    let (agent_session_id, discard_from_message_id) =
        CodingAgentTurn::find_latest_session_info(pool, session.id)
            .await?
            .map(|info| (info.session_id, info.discard_from_message_id))
            .unzip();

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
            discard_from_message_id: discard_from_message_id.flatten(),
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

/// The agent-access toggle a `create_pr` review still lacks, if any. With
/// `create_pr` the server later pushes the target branch and opens a PR on the
/// request's word alone, so an agent needs what those two calls need when it
/// makes them itself.
fn missing_create_pr_toggle(access: &AgentAccessConfig) -> Option<Toggle> {
    [Toggle::GitMerge, Toggle::GitWrite]
        .into_iter()
        .find(|toggle| !toggle.enabled(access))
}

/// Refuse an agent that lacks a toggle the server's push and PR need.
async fn require_create_pr_access(deployment: &DeploymentImpl) -> Result<(), ApiError> {
    let access = deployment.config().read().await.agent_access.clone();
    match missing_create_pr_toggle(&access) {
        Some(off) => Err(ApiError::Forbidden(format!(
            "Review and create PR pushes the target branch and opens a pull request: \
             agent_access.{} is off on this host",
            off.key()
        ))),
        None => Ok(()),
    }
}

/// Manually start a `vibe` review session for the current workspace, behaving as
/// if its coding agent had just reported `VIBE_RESULT: done`. Spawns a fresh
/// dedicated review session (and hands the rest of the automated workflow off to
/// the backend) instead of a one-shot review of the current session.
#[axum::debug_handler]
pub async fn vibe_review(
    Extension(session): Extension<Session>,
    State(deployment): State<DeploymentImpl>,
    headers: axum::http::HeaderMap,
    payload: Option<Json<VibeReviewRequest>>,
) -> Result<ResponseJson<ApiResponse<Session, ReviewError>>, ApiError> {
    let pool = &deployment.db().pool;
    let request = payload.map(|Json(request)| request).unwrap_or_default();
    if request.create_pr && is_agent_request(&headers) {
        require_create_pr_access(&deployment).await?;
    }

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

    let pr = if request.create_pr {
        Some(PrRequest {
            executor_config: request.executor_config.clone(),
            bases: vibe_pr_bases::resolve(
                pool,
                deployment.git(),
                &workspace,
                request.pr_bases.as_deref(),
                None,
                false,
            )
            .await
            .map_err(ApiError::BadRequest)?,
        })
    } else {
        if request.pr_bases.is_some() {
            return Err(ApiError::BadRequest("pr_bases requires create_pr".into()));
        }
        None
    };

    deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;

    let review_session = deployment
        .container()
        .vibe_manual_start_review(&workspace, &session, request.executor_config, pr)
        .await?;

    Ok(ResponseJson(ApiResponse::success(review_session)))
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::*;

    #[test]
    fn manual_retry_merges_only_approved_runs() {
        let run = |phase: &str, last_error: Option<&str>| VibeRun {
            workspace_id: Uuid::nil(),
            task_id: Uuid::nil(),
            phase: phase.to_string(),
            generation: 0,
            review_session_id: Some(Uuid::nil()),
            coding_turns: 0,
            review_turns: 0,
            merge_retries: 0,
            last_result: None,
            last_error: last_error.map(str::to_string),
            merge_wait_since: None,
            merge_wait_attempts: 0,
            merge_retry_at: None,
            pr_requested: false,
            pr_executor_config: None,
            pr_bases: None,
            failed_phase: None,
            pending: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        assert!(!can_retry_merge(&run("merging", None)));
        assert!(can_retry_merge(&run("merging", Some("checkout busy"))));
        assert!(can_retry_merge(&run(
            "blocked",
            Some("repo: merge conflict")
        )));
        // Blocked by its review (never approved), or not at the merge yet.
        assert!(!can_retry_merge(&run("blocked", None)));
        assert!(!can_retry_merge(&run("review", None)));
        assert!(!can_retry_merge(&VibeRun {
            review_session_id: None,
            ..run("merging", None)
        }));
    }

    // Asking for the PR makes the server push the base branch and open a PR
    // later, with no further request: an agent must hold both permissions
    // when it asks, or the flag would get it past them.
    #[test]
    fn an_agent_needs_push_and_pr_access_to_ask_for_the_pr() {
        let access = |git_write, git_merge| AgentAccessConfig {
            git_write,
            git_merge,
            ..Default::default()
        };
        // By default agents may not merge into or push the base branch.
        assert_eq!(
            missing_create_pr_toggle(&AgentAccessConfig::default()),
            Some(Toggle::GitMerge)
        );
        assert_eq!(
            missing_create_pr_toggle(&access(false, true)),
            Some(Toggle::GitWrite)
        );
        assert_eq!(missing_create_pr_toggle(&access(true, true)), None);
    }
}
