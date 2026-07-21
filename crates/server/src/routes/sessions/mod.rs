pub mod queue;
pub mod review;

use std::str::FromStr;

use axum::{
    Extension, Json, Router,
    extract::{Query, State},
    http::StatusCode,
    middleware::from_fn_with_state,
    response::Json as ResponseJson,
    routing::{get, post},
};
use db::models::{
    coding_agent_turn::CodingAgentTurn,
    execution_process::{ExecutionProcess, ExecutionProcessRunReason, ExecutionProcessStatus},
    pending_execution_start::PendingExecutionStart,
    pending_rate_limit_resume::PendingRateLimitResume,
    requests::UpdateSession,
    scratch::{Scratch, ScratchType},
    session::{CreateSession, Session, SessionError},
    workspace::{Workspace, WorkspaceError},
    workspace_repo::WorkspaceRepo,
};
use deployment::Deployment;
use executors::{
    actions::{
        ExecutorAction, ExecutorActionType, coding_agent_follow_up::CodingAgentFollowUpRequest,
        coding_agent_initial::CodingAgentInitialRequest,
    },
    executors::BaseCodingAgent,
    profile::{ExecutorConfig, ExecutorConfigs, ExecutorProfileId},
};
use serde::{Deserialize, Serialize};
use services::services::{container::ContainerService, issue_gating};
use ts_rs::TS;
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{
    DeploymentImpl, error::ApiError, middleware::load_session_middleware,
    routes::workspaces::execution::RunScriptError,
};

#[derive(Debug, Deserialize)]
pub struct SessionQuery {
    pub workspace_id: Uuid,
}

#[derive(Debug, Deserialize, TS)]
pub struct CreateSessionRequest {
    pub workspace_id: Uuid,
    pub executor: Option<String>,
    pub variant: Option<String>,
    pub name: Option<String>,
}

pub async fn get_sessions(
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<SessionQuery>,
) -> Result<ResponseJson<ApiResponse<Vec<Session>>>, ApiError> {
    let pool = &deployment.db().pool;
    let sessions = Session::find_by_workspace_id(pool, query.workspace_id).await?;
    Ok(ResponseJson(ApiResponse::success(sessions)))
}

pub async fn get_session(
    Extension(session): Extension<Session>,
) -> Result<ResponseJson<ApiResponse<Session>>, ApiError> {
    Ok(ResponseJson(ApiResponse::success(session)))
}

async fn seed_auto_resume_default(
    pool: &sqlx::SqlitePool,
    session_id: Uuid,
    executor_profile_id: &ExecutorProfileId,
) -> Result<bool, sqlx::Error> {
    let configs = ExecutorConfigs::get_cached();
    let agent = configs.get_coding_agent_or_default(executor_profile_id);
    if !agent.auto_resume_on_limit() {
        return Ok(false);
    }

    Session::set_auto_resume_enabled(pool, session_id, true).await?;
    Ok(true)
}

#[derive(Debug, Deserialize, TS)]
pub struct SetAutoResumeRequest {
    pub enabled: bool,
}

#[derive(Debug, Serialize, TS)]
pub struct AutoResumeStatus {
    pub enabled: bool,
    /// RFC3339 reset time when a resume is currently scheduled, else null.
    pub pending_resume_at: Option<String>,
}

/// Returns the session's auto-resume toggle state and any pending resume time.
pub async fn get_auto_resume(
    Extension(session): Extension<Session>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<AutoResumeStatus>>, ApiError> {
    let pool = &deployment.db().pool;
    let pending_resume_at = PendingRateLimitResume::find_by_session_id(pool, session.id)
        .await
        .ok()
        .flatten()
        .map(|p| p.resume_at.to_rfc3339());
    Ok(ResponseJson(ApiResponse::success(AutoResumeStatus {
        enabled: session.auto_resume_enabled,
        pending_resume_at,
    })))
}

/// Toggles usage-based auto-resume for the session. Turning it off also cancels
/// any pending resume.
pub async fn set_auto_resume(
    Extension(session): Extension<Session>,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<SetAutoResumeRequest>,
) -> Result<ResponseJson<ApiResponse<AutoResumeStatus>>, ApiError> {
    let pool = &deployment.db().pool;
    let pending_resume = if request.enabled {
        None
    } else {
        PendingRateLimitResume::find_by_session_id(pool, session.id).await?
    };

    Session::set_auto_resume_enabled(pool, session.id, request.enabled).await?;

    if let Some(pending) = pending_resume {
        // Claim via delete: only finalize if this call actually removed the row,
        // so a concurrent rate_limit_watcher abandon_resume can't double-run the
        // (non-idempotent) finalization on the same execution.
        if PendingRateLimitResume::delete_by_session_id(pool, session.id).await? > 0 {
            deployment
                .container()
                .finalize_cancelled_rate_limit_resume(pending.execution_process_id)
                .await?;
        }
    }

    let pending_resume_at = PendingRateLimitResume::find_by_session_id(pool, session.id)
        .await
        .ok()
        .flatten()
        .map(|p| p.resume_at.to_rfc3339());
    Ok(ResponseJson(ApiResponse::success(AutoResumeStatus {
        enabled: request.enabled,
        pending_resume_at,
    })))
}

pub async fn create_session(
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<CreateSessionRequest>,
) -> Result<ResponseJson<ApiResponse<Session>>, ApiError> {
    let pool = &deployment.db().pool;

    // Verify workspace exists
    let _workspace = Workspace::find_by_id(pool, payload.workspace_id)
        .await?
        .ok_or(ApiError::Workspace(WorkspaceError::ValidationError(
            "Workspace not found".to_string(),
        )))?;

    let mut session = Session::create(
        pool,
        &CreateSession {
            executor: payload.executor,
            name: payload.name,
        },
        Uuid::new_v4(),
        payload.workspace_id,
    )
    .await?;

    // Seed the per-session auto-resume toggle from the agent's default setting
    // (the `auto_resume_on_limit` option in the agent settings screen).
    if let Some(executor_str) = session.executor.as_deref()
        && let Ok(executor) = BaseCodingAgent::from_str(executor_str)
    {
        let executor_profile_id = ExecutorProfileId {
            executor,
            variant: payload.variant,
        };
        if seed_auto_resume_default(pool, session.id, &executor_profile_id).await? {
            session.auto_resume_enabled = true;
        }
    }

    Ok(ResponseJson(ApiResponse::success(session)))
}

pub async fn update_session(
    Extension(session): Extension<Session>,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<UpdateSession>,
) -> Result<ResponseJson<ApiResponse<Session>>, ApiError> {
    let pool = &deployment.db().pool;

    Session::update(pool, session.id, request.name.as_deref()).await?;

    let updated = Session::find_by_id(pool, session.id)
        .await?
        .ok_or(ApiError::Session(SessionError::NotFound))?;

    Ok(ResponseJson(ApiResponse::success(updated)))
}

pub async fn delete_session(
    Extension(session): Extension<Session>,
    State(deployment): State<DeploymentImpl>,
) -> Result<(StatusCode, ResponseJson<ApiResponse<()>>), ApiError> {
    let pool = &deployment.db().pool;
    let session_id = session.id;

    // Refuse deletion while non-dev-server processes are still running.
    if ExecutionProcess::has_running_non_dev_server_processes_for_session(pool, session_id).await? {
        return Err(ApiError::Conflict(
            "Cannot delete session while processes are running. Stop all processes first."
                .to_string(),
        ));
    }

    // Stop any running dev servers tied to this session before deleting it.
    let dev_servers =
        ExecutionProcess::find_running_dev_servers_by_session(pool, session_id).await?;
    for dev_server in dev_servers {
        tracing::info!(
            "Stopping dev server {} before deleting session {}",
            dev_server.id,
            session_id
        );

        if let Err(e) = deployment
            .container()
            .stop_execution(&dev_server, ExecutionProcessStatus::Killed)
            .await
        {
            tracing::error!(
                "Failed to stop dev server {} for session {}: {}",
                dev_server.id,
                session_id,
                e
            );
        }
    }

    // FK CASCADE removes execution_processes (and their children) for this session.
    let rows_affected = Session::delete(pool, session_id).await?;
    if rows_affected == 0 {
        return Err(ApiError::Session(SessionError::NotFound));
    }

    // Best-effort cleanup of the draft follow-up scratch (no FK to cascade).
    if let Err(e) = Scratch::delete(pool, session_id, &ScratchType::DraftFollowUp).await {
        tracing::debug!(
            "Failed to delete draft follow-up scratch for session {}: {}",
            session_id,
            e
        );
    }

    // Best-effort cleanup of the on-disk process-log directory. FK CASCADE only
    // removes execution_process_logs rows, not the per-session log directory on
    // disk, so without this every session delete would leak it (workspace
    // deletion already does this for each of its sessions).
    if let Err(e) =
        services::services::execution_process::remove_session_process_logs(session_id).await
    {
        tracing::warn!(
            "Failed to remove filesystem process logs for session {}: {}",
            session_id,
            e
        );
    }

    Ok((StatusCode::OK, ResponseJson(ApiResponse::success(()))))
}

#[derive(Debug, Deserialize, TS)]
pub struct CreateFollowUpAttempt {
    pub prompt: String,
    pub executor_config: ExecutorConfig,
    pub retry_process_id: Option<Uuid>,
    pub force_when_dirty: Option<bool>,
    pub perform_git_reset: Option<bool>,
}

#[derive(Debug, Deserialize, TS)]
pub struct CreateHandoffAttempt {
    pub prompt: String,
    pub executor_config: ExecutorConfig,
}

#[derive(Debug, Deserialize, TS)]
pub struct ResetProcessRequest {
    pub process_id: Uuid,
    pub force_when_dirty: Option<bool>,
    pub perform_git_reset: Option<bool>,
}

/// Resolve the executor config for a follow-up turn.
///
/// A "bare" request — executor identity only, with no variant and no
/// model/reasoning/agent/permission overrides — is what backend-driven resumes
/// such as the `run_session_prompt` MCP tool send. Treat it as "resume with
/// whatever the session was last using" and inherit the full config from the
/// session's latest coding-agent execution; otherwise the turn silently
/// downgrades to the executor's default model and variant.
///
/// The web UI always sends a fully-resolved config (it carries the last-used
/// model forward), so interactive follow-ups keep the caller's config untouched.
/// Inheritance only applies when the latest config uses the same executor.
fn resolve_followup_executor_config(
    requested: ExecutorConfig,
    latest: Option<ExecutorConfig>,
) -> ExecutorConfig {
    if requested.variant.is_none()
        && !requested.has_overrides()
        && let Some(latest) = latest
        && latest.executor == requested.executor
    {
        return latest;
    }
    requested
}

pub async fn follow_up(
    Extension(mut session): Extension<Session>,
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<CreateFollowUpAttempt>,
) -> Result<ResponseJson<ApiResponse<ExecutionProcess>>, ApiError> {
    let pool = &deployment.db().pool;

    // Load workspace from session
    let workspace = Workspace::find_by_id(pool, session.workspace_id)
        .await?
        .ok_or(ApiError::Workspace(WorkspaceError::ValidationError(
            "Workspace not found".to_string(),
        )))?;

    tracing::info!("{:?}", workspace);

    deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;

    // Full config from the session's most recent coding-agent execution, which
    // carries the user's model / variant / reasoning / agent overrides.
    let latest_executor_config =
        ExecutionProcess::latest_executor_config_for_session(pool, session.id).await?;

    // Validate executor matches session if session has prior executions
    let expected_executor: Option<String> = latest_executor_config
        .as_ref()
        .map(|config| config.executor.to_string())
        .or_else(|| session.executor.clone());

    if let Some(expected) = expected_executor {
        let actual = payload.executor_config.executor.to_string();
        if expected != actual {
            return Err(ApiError::Session(SessionError::ExecutorMismatch {
                expected,
                actual,
            }));
        }
    }

    // A "bare" request config (executor identity only) inherits the session's
    // last-used config so backend-driven resumes keep their model and variant
    // instead of silently dropping to the executor default. See
    // `resolve_followup_executor_config`.
    let executor_config =
        resolve_followup_executor_config(payload.executor_config, latest_executor_config);
    let executor_profile_id = executor_config.profile_id();

    if session.executor.is_none() {
        Session::update_executor(pool, session.id, &executor_profile_id.executor.to_string())
            .await?;
        session.executor = Some(executor_profile_id.executor.to_string());
        if seed_auto_resume_default(pool, session.id, &executor_profile_id).await? {
            session.auto_resume_enabled = true;
        }
    }

    if let Some(proc_id) = payload.retry_process_id {
        let force_when_dirty = payload.force_when_dirty.unwrap_or(false);
        let perform_git_reset = payload.perform_git_reset.unwrap_or(true);
        deployment
            .container()
            .reset_session_to_process(session.id, proc_id, perform_git_reset, force_when_dirty)
            .await?;
    }

    let latest_session_info = CodingAgentTurn::find_latest_session_info(pool, session.id).await?;

    let prompt = payload.prompt;

    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let cleanup_action = deployment.container().cleanup_actions_for_repos(&repos);

    let working_dir = session
        .agent_working_dir
        .as_ref()
        .filter(|dir| !dir.is_empty())
        .cloned();

    let action_type = if let Some(info) = latest_session_info {
        let is_reset = payload.retry_process_id.is_some();
        ExecutorActionType::CodingAgentFollowUpRequest(CodingAgentFollowUpRequest {
            prompt: prompt.clone(),
            session_id: info.session_id,
            reset_to_message_id: if is_reset { info.message_id } else { None },
            executor_config: executor_config.clone(),
            working_dir: working_dir.clone(),
        })
    } else {
        ExecutorActionType::CodingAgentInitialRequest(CodingAgentInitialRequest {
            prompt,
            executor_config: executor_config.clone(),
            working_dir,
            handoff_from: None,
            handoff_session_id: None,
            handoff_user_prompt: None,
        })
    };

    let action = ExecutorAction::new(action_type, cleanup_action.map(Box::new));

    // Blocker gating: if the workspace is linked to an upstream issue (task_id)
    // and that issue has unresolved blockers, create the execution_process row
    // but defer the actual spawn. A background watcher resumes the spawn once
    // every blocker reaches a resolved status (Done / In review).
    let gated_blocker = match workspace.task_id {
        Some(task_id) => match deployment.remote_client() {
            Ok(client) => match issue_gating::unresolved_blockers(&client, task_id).await {
                Ok(blockers) if !blockers.is_empty() => Some((task_id, blockers.len())),
                Ok(_) => None,
                Err(e) => {
                    tracing::warn!(
                        "Failed to evaluate blockers for task {} (proceeding with spawn): {}",
                        task_id,
                        e
                    );
                    None
                }
            },
            Err(_) => None,
        },
        None => None,
    };

    let execution_process = if let Some((task_id, blocker_count)) = gated_blocker {
        let record = deployment
            .container()
            .create_execution_record(
                &workspace,
                &session,
                &action,
                &ExecutionProcessRunReason::CodingAgent,
            )
            .await?;

        match PendingExecutionStart::create(pool, record.id, workspace.id, session.id, task_id)
            .await
        {
            Ok(_) => {
                tracing::info!(
                    "Deferred execution {} for workspace {} due to {} unresolved blocker(s)",
                    record.id,
                    workspace.id,
                    blocker_count
                );
            }
            Err(e) => {
                tracing::error!(
                    "Failed to register pending execution for process {} (spawning immediately): {}",
                    record.id,
                    e
                );
                deployment
                    .container()
                    .finish_execution_spawn(&workspace, &session, &record, &action)
                    .await?;
            }
        }

        record
    } else {
        deployment
            .container()
            .start_execution(
                &workspace,
                &session,
                &action,
                &ExecutionProcessRunReason::CodingAgent,
            )
            .await?
    };

    // A successfully-started manual follow-up supersedes any scheduled
    // usage-limit auto-resume for this session.
    let _ = PendingRateLimitResume::delete_by_session_id(pool, session.id).await;

    // Clear the draft follow-up scratch on successful spawn
    // This ensures the scratch is wiped even if the user navigates away quickly
    if let Err(e) = Scratch::delete(pool, session.id, &ScratchType::DraftFollowUp).await {
        // Log but don't fail the request - scratch deletion is best-effort
        tracing::debug!(
            "Failed to delete draft follow-up scratch for session {}: {}",
            session.id,
            e
        );
    }

    Ok(ResponseJson(ApiResponse::success(execution_process)))
}

pub async fn handoff(
    Extension(mut session): Extension<Session>,
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<CreateHandoffAttempt>,
) -> Result<ResponseJson<ApiResponse<ExecutionProcess>>, ApiError> {
    let pool = &deployment.db().pool;
    let user_prompt = payload.prompt.trim();
    if user_prompt.is_empty() {
        return Err(ApiError::BadRequest(
            "Handoff prompt must not be empty".to_string(),
        ));
    }
    let workspace = Workspace::find_by_id(pool, session.workspace_id)
        .await?
        .ok_or(ApiError::Workspace(WorkspaceError::ValidationError(
            "Workspace not found".to_string(),
        )))?;

    if ExecutionProcess::has_running_non_dev_server_processes_for_workspace(pool, workspace.id)
        .await?
    {
        return Err(ApiError::BadRequest(
            "Stop the running process before handing off this workspace session".to_string(),
        ));
    }

    deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;

    let latest_executor_config =
        ExecutionProcess::latest_executor_config_for_session(pool, session.id).await?;
    let source_executor = latest_executor_config
        .as_ref()
        .map(|config| config.executor)
        .or_else(|| {
            session
                .executor
                .as_deref()
                .and_then(|value| BaseCodingAgent::from_str(value).ok())
        })
        .ok_or(ApiError::BadRequest(
            "Session has no executor to hand off from".to_string(),
        ))?;

    if source_executor == payload.executor_config.executor {
        return Err(ApiError::BadRequest(
            "Handoff target must be a different executor".to_string(),
        ));
    }

    let latest_session_info = CodingAgentTurn::find_latest_session_info(pool, session.id).await?;
    let source_native_session_id = latest_session_info.map(|info| info.session_id);
    let working_dir = session
        .agent_working_dir
        .as_ref()
        .filter(|dir| !dir.is_empty())
        .cloned();
    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let cleanup_action = deployment.container().cleanup_actions_for_repos(&repos);
    let prompt = format!(
        "You are taking over an existing Vibe Kanban workspace session from {source_executor}. \
Continue the work in place without restarting or discarding existing changes. The prior conversation \
remains visible to the user in Vibe Kanban, but is not replayed into your native session. Inspect the \
repository state, git diff, and relevant files before proceeding. Vibe session ID: {}. Previous agent \
session ID: {}. Working directory: {}.\n\nUser request:\n{}",
        session.id,
        source_native_session_id.as_deref().unwrap_or("unavailable"),
        working_dir.as_deref().unwrap_or("workspace root"),
        user_prompt
    );
    let action = ExecutorAction::new(
        ExecutorActionType::CodingAgentInitialRequest(CodingAgentInitialRequest {
            prompt,
            executor_config: payload.executor_config.clone(),
            working_dir,
            handoff_from: Some(source_executor),
            handoff_session_id: source_native_session_id,
            handoff_user_prompt: Some(user_prompt.to_string()),
        }),
        cleanup_action.map(Box::new),
    );

    let execution_process = deployment
        .container()
        .start_execution(
            &workspace,
            &session,
            &action,
            &ExecutionProcessRunReason::CodingAgent,
        )
        .await?;

    let target = payload.executor_config.executor.to_string();
    Session::update_executor(pool, session.id, &target).await?;
    session.executor = Some(target);
    let _ = PendingRateLimitResume::delete_by_session_id(pool, session.id).await;

    Ok(ResponseJson(ApiResponse::success(execution_process)))
}

pub async fn reset_process(
    Extension(session): Extension<Session>,
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<ResetProcessRequest>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    let force_when_dirty = payload.force_when_dirty.unwrap_or(false);
    let perform_git_reset = payload.perform_git_reset.unwrap_or(true);

    deployment
        .container()
        .reset_session_to_process(
            session.id,
            payload.process_id,
            perform_git_reset,
            force_when_dirty,
        )
        .await?;

    Ok(ResponseJson(ApiResponse::success(())))
}

pub async fn run_setup_script(
    Extension(session): Extension<Session>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<ExecutionProcess, RunScriptError>>, ApiError> {
    let pool = &deployment.db().pool;

    let workspace = Workspace::find_by_id(pool, session.workspace_id)
        .await?
        .ok_or(ApiError::Workspace(WorkspaceError::ValidationError(
            "Workspace not found".to_string(),
        )))?;

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
    let executor_action = match deployment.container().setup_actions_for_repos(&repos) {
        Some(action) => action,
        None => {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                RunScriptError::NoScriptConfigured,
            )));
        }
    };

    let execution_process = deployment
        .container()
        .start_execution(
            &workspace,
            &session,
            &executor_action,
            &ExecutionProcessRunReason::SetupScript,
        )
        .await?;

    Ok(ResponseJson(ApiResponse::success(execution_process)))
}

pub fn router(deployment: &DeploymentImpl) -> Router<DeploymentImpl> {
    let session_id_router = Router::new()
        .route(
            "/",
            get(get_session).put(update_session).delete(delete_session),
        )
        .route("/follow-up", post(follow_up))
        .route("/handoff", post(handoff))
        .route("/auto-resume", get(get_auto_resume).post(set_auto_resume))
        .route("/reset", post(reset_process))
        .route("/setup", post(run_setup_script))
        .route("/review", post(review::start_review))
        .route("/vibe-review", post(review::vibe_review))
        .layer(from_fn_with_state(
            deployment.clone(),
            load_session_middleware,
        ));

    let sessions_router = Router::new()
        .route("/", get(get_sessions).post(create_session))
        .nest("/{session_id}", session_id_router)
        .nest("/{session_id}/queue", queue::router(deployment));

    Router::new().nest("/sessions", sessions_router)
}

#[cfg(test)]
mod tests {
    use executors::{executors::BaseCodingAgent, profile::ExecutorConfig};

    use super::resolve_followup_executor_config;

    /// A session whose last turn ran Opus on the PLAN variant with high reasoning.
    fn opus_plan_config() -> ExecutorConfig {
        ExecutorConfig {
            executor: BaseCodingAgent::ClaudeCode,
            variant: Some("PLAN".to_string()),
            model_id: Some("claude-opus-4".to_string()),
            agent_id: None,
            reasoning_id: Some("high".to_string()),
            permission_policy: None,
        }
    }

    #[test]
    fn bare_request_inherits_latest_full_config() {
        // `run_session_prompt` sends executor-only: it must inherit the session's
        // model and variant rather than fall back to the executor default.
        let requested = ExecutorConfig::new(BaseCodingAgent::ClaudeCode);
        let resolved = resolve_followup_executor_config(requested, Some(opus_plan_config()));
        assert_eq!(resolved, opus_plan_config());
    }

    #[test]
    fn request_with_model_override_is_left_untouched() {
        // The web UI sends a fully-resolved config; never override the caller.
        let requested = ExecutorConfig {
            model_id: Some("claude-sonnet-4".to_string()),
            ..ExecutorConfig::new(BaseCodingAgent::ClaudeCode)
        };
        let resolved =
            resolve_followup_executor_config(requested.clone(), Some(opus_plan_config()));
        assert_eq!(resolved, requested);
    }

    #[test]
    fn request_with_explicit_variant_is_left_untouched() {
        // An explicit variant (even the default) means the caller chose a profile.
        let requested = ExecutorConfig {
            variant: Some("DEFAULT".to_string()),
            ..ExecutorConfig::new(BaseCodingAgent::ClaudeCode)
        };
        let resolved =
            resolve_followup_executor_config(requested.clone(), Some(opus_plan_config()));
        assert_eq!(resolved, requested);
    }

    #[test]
    fn bare_request_with_no_history_keeps_executor_default() {
        // First turn of a session: nothing to inherit, so the bare config stands.
        let requested = ExecutorConfig::new(BaseCodingAgent::ClaudeCode);
        let resolved = resolve_followup_executor_config(requested.clone(), None);
        assert_eq!(resolved, requested);
    }

    #[test]
    fn does_not_inherit_across_executors() {
        // Executor mismatch is rejected upstream; defensively never graft a
        // different executor's model onto the request even if we reach here.
        let requested = ExecutorConfig::new(BaseCodingAgent::Codex);
        let resolved =
            resolve_followup_executor_config(requested.clone(), Some(opus_plan_config()));
        assert_eq!(resolved, requested);
    }
}
