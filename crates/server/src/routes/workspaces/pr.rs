use std::{
    collections::{HashMap, HashSet},
    panic::AssertUnwindSafe,
    path::PathBuf,
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant},
};

use api_types::{PullRequestStatus, UpsertPullRequestRequest};
use axum::{
    Extension, Json, Router,
    extract::{Query, State},
    http::HeaderMap,
    response::Json as ResponseJson,
    routing::{get, post},
};
use db::models::{
    execution_process::{ExecutionProcess, ExecutionProcessRunReason, ExecutionProcessStatus},
    merge::{Merge, MergeStatus},
    pull_request::PullRequest,
    repo::{Repo, RepoError},
    requests::PrReviewInput,
    session::{CreateSession, Session},
    workspace::{CreateWorkspace, Workspace, WorkspaceError},
    workspace_repo::{CreateWorkspaceRepo, WorkspaceRepo},
};
use deployment::Deployment;
use executors::profile::ExecutorConfig;
use futures_util::FutureExt;
use git::{GitCliError, GitRemote, GitServiceError};
use git_host::{
    CreatePrRequest, GitHostError, GitHostProvider, GitHostService, ProviderKind, UnifiedPrComment,
    github::GhCli,
};
use serde::{Deserialize, Serialize};
use services::services::{
    config::DEFAULT_PR_DESCRIPTION_PROMPT,
    container::{ContainerService, assistant_message_in_store},
    remote_sync,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;
use ts_rs::TS;
use utils::response::ApiResponse;
use uuid::Uuid;
use workspace_manager::WorkspaceManager;

use crate::{
    DeploymentImpl, error::ApiError, routes::workspaces::review_mode::review_target_branch_ref,
};

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct CreatePrApiRequest {
    pub title: String,
    pub body: Option<String>,
    pub target_branch: Option<String>,
    /// The PR's head (source) branch. Defaults to the workspace's work branch
    /// when omitted, preserving the original behavior. Set this to an
    /// intermediate "feature" branch (one the work branch was merged into) to
    /// open a PR from feature -> base in a three-branch workflow.
    pub head_branch: Option<String>,
    pub draft: Option<bool>,
    pub repo_id: Uuid,
}

/// Request to generate a PR title + description by running a coding agent once,
/// read-only, in the workspace worktree that holds the branch's changes.
#[derive(Debug, Deserialize, Serialize, TS)]
pub struct GeneratePrDescriptionRequest {
    pub repo_id: Uuid,
    /// The PR's base (target) branch. Falls back to the repo's configured target
    /// branch when omitted. Used to compute the diff the agent summarizes.
    pub target_branch: Option<String>,
    /// The PR's head (source) branch. Defaults to the workspace's work branch.
    pub head_branch: Option<String>,
    /// Optional one-off agent configuration selected in the Create PR dialog.
    /// When absent, generation reuses the workspace's most recently used agent.
    pub executor_config: Option<ExecutorConfig>,
}

/// Generated PR title + description to pre-fill the Create PR dialog for review.
#[derive(Debug, Serialize, Deserialize, TS)]
pub struct GeneratePrDescriptionResponse {
    pub title: String,
    pub description: String,
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct StartPrDescriptionGenerationResponse {
    pub job_id: Uuid,
}

#[derive(Debug, Deserialize, TS)]
pub struct PrDescriptionGenerationQuery {
    pub job_id: Uuid,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PrDescriptionGenerationStatus {
    Running,
    Completed { title: String, description: String },
    Failed { error: String },
}

struct PrDescriptionGenerationJob {
    workspace_id: Uuid,
    status: PrDescriptionGenerationStatus,
    cancel_token: CancellationToken,
    execution_process_id: Option<Uuid>,
    created_at: Instant,
}

static PR_DESCRIPTION_GENERATION_JOBS: LazyLock<
    tokio::sync::RwLock<HashMap<Uuid, PrDescriptionGenerationJob>>,
> = LazyLock::new(|| tokio::sync::RwLock::new(HashMap::new()));

const PR_GENERATE_GLOBAL_CONCURRENCY: usize = 2;

struct PrGenerationScheduler {
    active_workspaces: Arc<Mutex<HashSet<Uuid>>>,
    semaphore: Arc<Semaphore>,
}

impl PrGenerationScheduler {
    fn new(global_concurrency: usize) -> Self {
        Self {
            active_workspaces: Arc::new(Mutex::new(HashSet::new())),
            semaphore: Arc::new(Semaphore::new(global_concurrency)),
        }
    }

    fn try_acquire(
        &self,
        workspace_id: Uuid,
    ) -> Result<PrGenerationAdmission, PrGenerationAdmissionError> {
        let mut active_workspaces = self
            .active_workspaces
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if active_workspaces.contains(&workspace_id) {
            return Err(PrGenerationAdmissionError::WorkspaceBusy);
        }

        let global_permit = self
            .semaphore
            .clone()
            .try_acquire_owned()
            .map_err(|_| PrGenerationAdmissionError::GlobalLimitReached)?;
        active_workspaces.insert(workspace_id);

        Ok(PrGenerationAdmission {
            workspace_id,
            active_workspaces: self.active_workspaces.clone(),
            global_permit: Some(global_permit),
        })
    }
}

enum PrGenerationAdmissionError {
    WorkspaceBusy,
    GlobalLimitReached,
}

impl From<PrGenerationAdmissionError> for ApiError {
    fn from(error: PrGenerationAdmissionError) -> Self {
        match error {
            PrGenerationAdmissionError::WorkspaceBusy => ApiError::Conflict(
                "PR description generation is already running for this workspace.".to_string(),
            ),
            PrGenerationAdmissionError::GlobalLimitReached => ApiError::TooManyRequests(
                "Too many PR description generation jobs are running. Try again later.".to_string(),
            ),
        }
    }
}

struct PrGenerationAdmission {
    workspace_id: Uuid,
    active_workspaces: Arc<Mutex<HashSet<Uuid>>>,
    global_permit: Option<OwnedSemaphorePermit>,
}

impl Drop for PrGenerationAdmission {
    fn drop(&mut self) {
        let mut active_workspaces = self
            .active_workspaces
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        active_workspaces.remove(&self.workspace_id);
        self.global_permit.take();
    }
}

static PR_GENERATION_SCHEDULER: LazyLock<PrGenerationScheduler> =
    LazyLock::new(|| PrGenerationScheduler::new(PR_GENERATE_GLOBAL_CONCURRENCY));

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct PrDraft {
    pub repo_id: Uuid,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Deserialize, TS)]
pub struct PrDraftQuery {
    pub repo_id: Uuid,
}

async fn save_pr_draft(
    pool: &sqlx::SqlitePool,
    workspace_id: Uuid,
    draft: &PrDraft,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO workspace_pr_drafts (workspace_id, repo_id, title, body) VALUES (?, ?, ?, ?) \
         ON CONFLICT(workspace_id, repo_id) DO UPDATE SET title = excluded.title, \
         body = excluded.body, updated_at = datetime('now', 'subsec')",
    )
    .bind(workspace_id)
    .bind(draft.repo_id)
    .bind(&draft.title)
    .bind(&draft.body)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_pr_draft(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<PrDraftQuery>,
) -> Result<ResponseJson<ApiResponse<Option<PrDraft>>>, ApiError> {
    let draft = sqlx::query_as::<_, (Uuid, String, String)>(
        "SELECT repo_id, title, body FROM workspace_pr_drafts WHERE workspace_id = ? AND repo_id = ?",
    )
    .bind(workspace.id)
    .bind(query.repo_id)
    .fetch_optional(&deployment.db().pool)
    .await?
    .map(|(repo_id, title, body)| PrDraft { repo_id, title, body });
    Ok(ResponseJson(ApiResponse::success(draft)))
}

pub async fn put_pr_draft(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(draft): Json<PrDraft>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    WorkspaceRepo::find_by_workspace_and_repo_id(
        &deployment.db().pool,
        workspace.id,
        draft.repo_id,
    )
    .await?
    .ok_or(RepoError::NotFound)?;
    save_pr_draft(&deployment.db().pool, workspace.id, &draft).await?;
    Ok(ResponseJson(ApiResponse::success(())))
}

pub async fn delete_pr_draft(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<PrDraftQuery>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    sqlx::query("DELETE FROM workspace_pr_drafts WHERE workspace_id = ? AND repo_id = ?")
        .bind(workspace.id)
        .bind(query.repo_id)
        .execute(&deployment.db().pool)
        .await?;
    Ok(ResponseJson(ApiResponse::success(())))
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum PrError {
    CliNotInstalled { provider: ProviderKind },
    CliNotLoggedIn { provider: ProviderKind },
    GitCliNotLoggedIn,
    GitCliNotInstalled,
    TargetBranchNotFound { branch: String },
    UnsupportedProvider,
}

#[derive(Debug, Serialize, TS)]
pub struct AttachPrResponse {
    pub pr_attached: bool,
    pub pr_url: Option<String>,
    pub pr_number: Option<i64>,
    pub pr_status: Option<MergeStatus>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct AttachExistingPrRequest {
    pub repo_id: Uuid,
    /// The PR's head (source) branch to search for. Defaults to the workspace's
    /// work branch when omitted. Set this to an intermediate "feature" branch to
    /// link a feature -> base PR in a three-branch workflow.
    pub head_branch: Option<String>,
}

#[derive(Debug, Serialize, TS)]
pub struct PrCommentsResponse {
    pub comments: Vec<UnifiedPrComment>,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum GetPrCommentsError {
    NoPrAttached,
    CliNotInstalled { provider: ProviderKind },
    CliNotLoggedIn { provider: ProviderKind },
}

#[derive(Debug, Deserialize, TS)]
pub struct GetPrCommentsQuery {
    pub repo_id: Uuid,
}

/// Whole-request budget for PR title/description generation: container reuse +
/// agent run + capture. The client timeout must strictly exceed this.
const PR_GENERATE_TIMEOUT: Duration = Duration::from_secs(120);
const PR_GENERATE_RUNNING_JOB_TTL: Duration = Duration::from_secs(150);
const PR_GENERATE_FINISHED_JOB_TTL: Duration = Duration::from_secs(10 * 60);
/// How often to poll the execution-process status while waiting for the agent.
const PR_GENERATE_POLL_INTERVAL: Duration = Duration::from_millis(750);

fn prune_pr_description_generation_jobs(jobs: &mut HashMap<Uuid, PrDescriptionGenerationJob>) {
    jobs.retain(|_, job| {
        let ttl = if matches!(job.status, PrDescriptionGenerationStatus::Running) {
            PR_GENERATE_RUNNING_JOB_TTL
        } else {
            PR_GENERATE_FINISHED_JOB_TTL
        };
        let keep = job.created_at.elapsed() < ttl;
        if !keep {
            job.cancel_token.cancel();
        }
        keep
    });
}

/// Run a coding agent ONCE, read-only, in the workspace worktree that holds the
/// branch's changes, and return a generated PR title + description for the user
/// to review in the Create PR dialog. Uses the settings prompt (or the built-in
/// default) and the workspace's own executor profile, mirroring the spec-intake
/// "Generate spec" flow.
pub async fn generate_pr_description(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    headers: HeaderMap,
    Json(request): Json<GeneratePrDescriptionRequest>,
) -> Result<ResponseJson<ApiResponse<GeneratePrDescriptionResponse>>, ApiError> {
    if headers.contains_key("x-vk-relayed") {
        return Err(ApiError::Forbidden(
            "Use the asynchronous PR generation endpoint over a remote relay connection."
                .to_string(),
        ));
    }
    let _admission = PR_GENERATION_SCHEDULER.try_acquire(workspace.id)?;
    let response = generate_pr_description_inner(
        &deployment,
        &workspace,
        request,
        CancellationToken::new(),
        None,
    )
    .await?;
    Ok(ResponseJson(ApiResponse::success(response)))
}

/// Start generation without keeping a relay request open for the full agent run.
pub async fn start_pr_description_generation(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<GeneratePrDescriptionRequest>,
) -> Result<ResponseJson<ApiResponse<StartPrDescriptionGenerationResponse>>, ApiError> {
    WorkspaceRepo::find_by_workspace_and_repo_id(
        &deployment.db().pool,
        workspace.id,
        request.repo_id,
    )
    .await?
    .ok_or(RepoError::NotFound)?;

    let mut jobs = PR_DESCRIPTION_GENERATION_JOBS.write().await;
    prune_pr_description_generation_jobs(&mut jobs);
    drop(jobs);

    let admission = PR_GENERATION_SCHEDULER.try_acquire(workspace.id)?;
    let job_id = Uuid::new_v4();
    let cancel_token = CancellationToken::new();
    let mut jobs = PR_DESCRIPTION_GENERATION_JOBS.write().await;
    jobs.insert(
        job_id,
        PrDescriptionGenerationJob {
            workspace_id: workspace.id,
            status: PrDescriptionGenerationStatus::Running,
            cancel_token: cancel_token.clone(),
            execution_process_id: None,
            created_at: Instant::now(),
        },
    );
    drop(jobs);

    tokio::spawn(async move {
        let _admission = admission;
        let generation_cancel_token = cancel_token.clone();
        let result = AssertUnwindSafe(generate_pr_description_inner(
            &deployment,
            &workspace,
            request,
            generation_cancel_token,
            Some(job_id),
        ))
        .catch_unwind()
        .await;

        let status = match result {
            Ok(Ok(result)) => PrDescriptionGenerationStatus::Completed {
                title: result.title,
                description: result.description,
            },
            Ok(Err(error)) => PrDescriptionGenerationStatus::Failed {
                error: error.to_string(),
            },
            Err(_) => {
                cleanup_tracked_pr_generation_execution(&deployment, job_id).await;
                PrDescriptionGenerationStatus::Failed {
                    error: "PR description generation stopped unexpectedly.".to_string(),
                }
            }
        };
        if cancel_token.is_cancelled() {
            PR_DESCRIPTION_GENERATION_JOBS.write().await.remove(&job_id);
            return;
        }
        if let Some(job) = PR_DESCRIPTION_GENERATION_JOBS
            .write()
            .await
            .get_mut(&job_id)
        {
            job.status = status;
        }
    });

    Ok(ResponseJson(ApiResponse::success(
        StartPrDescriptionGenerationResponse { job_id },
    )))
}

pub async fn cancel_pr_description_generation(
    Extension(workspace): Extension<Workspace>,
    Query(query): Query<PrDescriptionGenerationQuery>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    let jobs = PR_DESCRIPTION_GENERATION_JOBS.read().await;
    let cancel_token = jobs
        .get(&query.job_id)
        .filter(|job| job.workspace_id == workspace.id)
        .map(|job| job.cancel_token.clone());
    drop(jobs);
    if let Some(cancel_token) = cancel_token {
        cancel_token.cancel();
    }
    Ok(ResponseJson(ApiResponse::success(())))
}

pub async fn get_pr_description_generation(
    Extension(workspace): Extension<Workspace>,
    Query(query): Query<PrDescriptionGenerationQuery>,
) -> Result<ResponseJson<ApiResponse<PrDescriptionGenerationStatus>>, ApiError> {
    let jobs = PR_DESCRIPTION_GENERATION_JOBS.read().await;
    let job = jobs
        .get(&query.job_id)
        .filter(|job| job.workspace_id == workspace.id)
        .ok_or_else(|| ApiError::BadRequest("PR generation job not found.".to_string()))?;

    let status = match &job.status {
        PrDescriptionGenerationStatus::Running => PrDescriptionGenerationStatus::Running,
        PrDescriptionGenerationStatus::Completed { title, description } => {
            PrDescriptionGenerationStatus::Completed {
                title: title.clone(),
                description: description.clone(),
            }
        }
        PrDescriptionGenerationStatus::Failed { error } => PrDescriptionGenerationStatus::Failed {
            error: error.clone(),
        },
    };
    Ok(ResponseJson(ApiResponse::success(status)))
}

async fn generate_pr_description_inner(
    deployment: &DeploymentImpl,
    workspace: &Workspace,
    request: GeneratePrDescriptionRequest,
    cancel_token: CancellationToken,
    job_id: Option<Uuid>,
) -> Result<GeneratePrDescriptionResponse, ApiError> {
    let pool = &deployment.db().pool;

    let workspace_repo =
        WorkspaceRepo::find_by_workspace_and_repo_id(pool, workspace.id, request.repo_id)
            .await?
            .ok_or(RepoError::NotFound)?;

    let base_branch = request
        .target_branch
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| workspace_repo.target_branch.clone());

    let head_branch = request
        .head_branch
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| workspace.branch.clone());

    // Build the prompt in code. The JSON output contract and the "PR doesn't
    // exist yet" framing are ALWAYS enforced by the built-in template; a custom
    // settings prompt is folded in only as supplementary style/convention
    // context. This is deliberate: legacy custom prompts were written for the old
    // "edit the PR after it's created" flow (with `{pr_number}`/`{pr_url}` and
    // `gh pr edit` instructions), and letting one drive the whole request made
    // the agent hunt for a non-existent PR and emit prose instead of JSON.
    let prompt = {
        let config = deployment.config().read().await;
        build_pr_generation_prompt(
            &base_branch,
            &head_branch,
            config.pr_auto_description_prompt.as_deref(),
        )
    };

    let executor_config =
        resolve_generation_executor_config(deployment, workspace, request.executor_config.clone())
            .await?;

    let (title, description) = run_pr_generation(
        deployment,
        workspace,
        executor_config,
        prompt,
        &cancel_token,
        job_id,
    )
    .await?;

    if cancel_token.is_cancelled() {
        return Err(pr_generation_cancelled_error());
    }

    save_pr_draft(
        pool,
        workspace.id,
        &PrDraft {
            repo_id: request.repo_id,
            title: title.clone(),
            body: description.clone(),
        },
    )
    .await?;

    Ok(GeneratePrDescriptionResponse { title, description })
}

/// Prefer the workspace session's executor config (model / reasoning / agent
/// overrides) so generation matches the agent the user is already using. Fall
/// back to the global default profile so it still runs for a workspace with no
/// prior coding-agent process (e.g. an imported PR review workspace).
async fn resolve_generation_executor_config(
    deployment: &DeploymentImpl,
    workspace: &Workspace,
    requested_config: Option<ExecutorConfig>,
) -> Result<ExecutorConfig, ApiError> {
    if let Some(config) = requested_config {
        return Ok(config);
    }
    let pool = &deployment.db().pool;
    if let Some(session) = Session::find_latest_by_workspace_id(pool, workspace.id).await?
        && let Some(config) =
            ExecutionProcess::latest_executor_config_for_session(pool, session.id).await?
    {
        return Ok(config);
    }
    let default_profile = deployment.config().read().await.executor_profile.clone();
    Ok(default_profile.into())
}

/// Assemble the generation prompt. The built-in template (JSON contract + the
/// "PR doesn't exist yet" framing) always wins; a settings prompt is folded in
/// only as supplementary style/convention context, placed BEFORE the template so
/// the strict JSON contract stays last (and dominant), with legacy placeholders
/// and "edit the existing PR" instructions explicitly neutralized.
fn build_pr_generation_prompt(
    base_branch: &str,
    head_branch: &str,
    custom: Option<&str>,
) -> String {
    let template = DEFAULT_PR_DESCRIPTION_PROMPT
        .replace("{base_branch}", base_branch)
        .replace("{head_branch}", head_branch);

    match custom.map(str::trim).filter(|c| !c.is_empty()) {
        Some(custom) => {
            let sanitized = custom
                .replace("{pr_number}", "(the PR does not exist yet)")
                .replace("{pr_url}", "(the PR does not exist yet)");
            format!(
                "The following are project conventions for reference only. Use them for \
                 style, title format, and commit/naming conventions. IGNORE any instruction \
                 in them about updating/editing an already-created PR or running `gh pr` / \
                 `az repos pr` — the PR does not exist yet.\n\n{sanitized}\n\n---\n\n{template}"
            )
        }
        None => template,
    }
}

/// How many times to run the agent before giving up. A run that produces no
/// parseable `{title, description}` JSON is retried once (agents occasionally
/// wrap the JSON in prose or forget it); if the last attempt still fails we
/// return an error rather than shoving unstructured prose into the fields.
const PR_GENERATE_MAX_ATTEMPTS: usize = 2;

/// Run the agent (up to [`PR_GENERATE_MAX_ATTEMPTS`] times), returning the parsed
/// (title, description). Each attempt runs in the real workspace worktree and its
/// throwaway session is deleted afterward so no conversation is left behind. If
/// no attempt yields parseable JSON, an error is returned.
async fn run_pr_generation(
    deployment: &DeploymentImpl,
    workspace: &Workspace,
    executor_config: ExecutorConfig,
    prompt: String,
    cancel_token: &CancellationToken,
    job_id: Option<Uuid>,
) -> Result<(String, String), ApiError> {
    let deadline = tokio::time::Instant::now() + PR_GENERATE_TIMEOUT;

    for attempt in 1..=PR_GENERATE_MAX_ATTEMPTS {
        if cancel_token.is_cancelled() {
            return Err(pr_generation_cancelled_error());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(pr_generation_timeout_error());
        }

        // Starting an execution mutates both the DB and the child-process tracker.
        // Let that operation reach a consistent state before honoring cancellation;
        // dropping it inside select! could orphan a partially registered process.
        let ep = deployment
            .container()
            .start_oneshot_coding_agent_reusing_container(
                workspace,
                executor_config.clone(),
                prompt.clone(),
                Some("create-pr".to_string()),
            )
            .await?;
        set_tracked_pr_generation_execution(job_id, Some(ep.id)).await;

        // Capture, then tear down the throwaway session regardless of outcome so
        // PR generation never adds a visible session/turn to the workspace.
        // Deletion cascades to the execution process + turn.
        let outcome = tokio::select! {
            biased;
            _ = cancel_token.cancelled() => {
                terminate_pr_generation_execution(deployment, ep.id).await;
                set_tracked_pr_generation_execution(job_id, None).await;
                return Err(pr_generation_cancelled_error());
            }
            _ = tokio::time::sleep_until(deadline) => {
                terminate_pr_generation_execution(deployment, ep.id).await;
                set_tracked_pr_generation_execution(job_id, None).await;
                return Err(pr_generation_timeout_error());
            }
            outcome = capture_pr_generation(deployment, &ep) => outcome,
        };
        delete_pr_generation_session(deployment, ep.session_id).await;
        set_tracked_pr_generation_execution(job_id, None).await;

        match outcome {
            Ok(Some(pr)) => return Ok(pr),
            Ok(None) => tracing::warn!(
                "PR generation attempt {attempt}/{PR_GENERATE_MAX_ATTEMPTS} produced no parseable JSON{}",
                if attempt < PR_GENERATE_MAX_ATTEMPTS {
                    "; retrying"
                } else {
                    ""
                }
            ),
            // Infra/agent failure: retry while attempts remain, else surface it.
            Err(e) if attempt < PR_GENERATE_MAX_ATTEMPTS => tracing::warn!(
                "PR generation attempt {attempt}/{PR_GENERATE_MAX_ATTEMPTS} failed: {e}; retrying"
            ),
            Err(e) => return Err(e),
        }
    }

    Err(ApiError::BadGateway(
        "The agent couldn't produce a valid PR title and description. Please try again or write them manually.".to_string(),
    ))
}

fn pr_generation_cancelled_error() -> ApiError {
    ApiError::BadRequest("PR description generation was cancelled.".to_string())
}

fn pr_generation_timeout_error() -> ApiError {
    ApiError::BadGateway(
        "PR description generation timed out. Try again or write it manually.".to_string(),
    )
}

async fn set_tracked_pr_generation_execution(
    job_id: Option<Uuid>,
    execution_process_id: Option<Uuid>,
) {
    let Some(job_id) = job_id else {
        return;
    };
    if let Some(job) = PR_DESCRIPTION_GENERATION_JOBS
        .write()
        .await
        .get_mut(&job_id)
    {
        job.execution_process_id = execution_process_id;
    }
}

async fn cleanup_tracked_pr_generation_execution(deployment: &DeploymentImpl, job_id: Uuid) {
    let execution_process_id = PR_DESCRIPTION_GENERATION_JOBS
        .read()
        .await
        .get(&job_id)
        .and_then(|job| job.execution_process_id);
    if let Some(execution_process_id) = execution_process_id {
        terminate_pr_generation_execution(deployment, execution_process_id).await;
        set_tracked_pr_generation_execution(Some(job_id), None).await;
    }
}

async fn terminate_pr_generation_execution(
    deployment: &DeploymentImpl,
    execution_process_id: Uuid,
) {
    let execution_process = match ExecutionProcess::find_by_id(
        &deployment.db().pool,
        execution_process_id,
    )
    .await
    {
        Ok(Some(execution_process)) => execution_process,
        Ok(None) => return,
        Err(error) => {
            tracing::warn!(
                "Failed to load PR-generation execution {execution_process_id} for termination: {error}"
            );
            return;
        }
    };

    if execution_process.status == ExecutionProcessStatus::Running
        && let Err(error) = deployment
            .container()
            .stop_execution(&execution_process, ExecutionProcessStatus::Killed)
            .await
    {
        tracing::warn!("Failed to stop PR-generation execution {execution_process_id}: {error}");
        return;
    }

    delete_pr_generation_session(deployment, execution_process.session_id).await;
}

async fn delete_pr_generation_session(deployment: &DeploymentImpl, session_id: Uuid) {
    if let Err(error) = Session::delete(&deployment.db().pool, session_id).await {
        tracing::warn!("Failed to delete throwaway PR-generation session {session_id}: {error}");
    }
}

/// Poll the one-shot agent to completion and parse its final message. Mirrors
/// the spec-intake capture loop (see `spec_intake::run_intake`). Returns
/// `Ok(None)` when the agent finished but produced nothing parseable (a
/// retryable condition); `Err` only for infra/process failures.
async fn capture_pr_generation(
    deployment: &DeploymentImpl,
    ep: &ExecutionProcess,
) -> Result<Option<(String, String)>, ApiError> {
    let pool = &deployment.db().pool;
    // Hold our own Arc to the agent's MsgStore so the exit-monitor teardown
    // (which drops the store shortly after marking the process Completed) can't
    // race our post-completion read and yield "no output".
    let mut msg_store = deployment.container().get_msg_store_by_id(&ep.id).await;
    loop {
        if msg_store.is_none() {
            msg_store = deployment.container().get_msg_store_by_id(&ep.id).await;
        }
        let current = ExecutionProcess::find_by_id(pool, ep.id)
            .await?
            .ok_or_else(|| {
                ApiError::BadGateway("PR generation process disappeared.".to_string())
            })?;
        match current.status {
            ExecutionProcessStatus::Running => tokio::time::sleep(PR_GENERATE_POLL_INTERVAL).await,
            ExecutionProcessStatus::Completed => break,
            ExecutionProcessStatus::Failed | ExecutionProcessStatus::Killed => {
                return Err(ApiError::BadGateway(
                    "The agent failed while generating the PR description.".to_string(),
                ));
            }
        }
    }

    // No message, or a message with no parseable JSON → retryable (Ok(None)).
    Ok(msg_store
        .as_deref()
        .and_then(assistant_message_in_store)
        .filter(|m| !m.trim().is_empty())
        .as_deref()
        .and_then(parse_pr_description))
}

#[derive(Deserialize)]
struct PrDescriptionJson {
    title: String,
    description: String,
}

/// Parse the agent's final message into (title, description), or `None` if it
/// contains no parseable `{title, description}` JSON.
///
/// Contract: a single fenced ```json block. Fallback (for a non-empty but
/// unfenced message): the last brace-balanced JSON object anywhere in the
/// message. There is deliberately no prose fallback — an unparseable message
/// triggers a retry / error upstream rather than filling the fields with a raw
/// conversational reply.
fn parse_pr_description(message: &str) -> Option<(String, String)> {
    parse_pr_json_fence(message)
        .or_else(|| extract_last_json_object(message))
        .map(|pr| (pr.title, pr.description))
}

/// Extract and parse the last ```json fenced block in `message`.
fn parse_pr_json_fence(message: &str) -> Option<PrDescriptionJson> {
    let open = message.rfind("```json")?;
    let after = &message[open + "```json".len()..];
    let end = after.find("```")?;
    let body = after[..end].trim();
    serde_json::from_str::<PrDescriptionJson>(body).ok()
}

/// Find the last brace-balanced `{...}` object in `message` that deserializes to
/// `{title, description}`. Robust to an agent that emits the object without a
/// fence or with surrounding prose. String contents (including `{`/`}` and
/// escaped quotes) are respected while scanning.
fn extract_last_json_object(message: &str) -> Option<PrDescriptionJson> {
    let chars: Vec<char> = message.chars().collect();
    let opens: Vec<usize> = chars
        .iter()
        .enumerate()
        .filter(|&(_, &c)| c == '{')
        .map(|(i, _)| i)
        .collect();
    for &start in opens.iter().rev() {
        let mut depth = 0i32;
        let mut in_str = false;
        let mut escaped = false;
        for (offset, &c) in chars[start..].iter().enumerate() {
            if in_str {
                if escaped {
                    escaped = false;
                } else if c == '\\' {
                    escaped = true;
                } else if c == '"' {
                    in_str = false;
                }
                continue;
            }
            match c {
                '"' => in_str = true,
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        let candidate: String = chars[start..=start + offset].iter().collect();
                        if let Ok(pr) = serde_json::from_str::<PrDescriptionJson>(&candidate) {
                            return Some(pr);
                        }
                        break; // this object didn't parse; try an earlier '{'
                    }
                }
                _ => {}
            }
        }
    }
    None
}

pub async fn create_pr(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<CreatePrApiRequest>,
) -> Result<ResponseJson<ApiResponse<String, PrError>>, ApiError> {
    let pool = &deployment.db().pool;

    let workspace_repo =
        WorkspaceRepo::find_by_workspace_and_repo_id(pool, workspace.id, request.repo_id)
            .await?
            .ok_or(RepoError::NotFound)?;

    let repo = Repo::find_by_id(pool, workspace_repo.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    let repo_path = repo.path.clone();
    let target_branch = if let Some(branch) = request.target_branch {
        branch
    } else {
        workspace_repo.target_branch.clone()
    };

    // The PR's head (source) branch. Defaults to the workspace's work branch,
    // but can be an intermediate "feature" branch the work branch was merged
    // into (three-branch workflow: work -> feature -> base via this PR).
    let head_branch = request
        .head_branch
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| workspace.branch.clone());

    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let workspace_path = PathBuf::from(&container_ref);
    let worktree_path = workspace_path.join(&repo.name);

    let git = deployment.git();
    let push_remote = git.resolve_remote_for_branch(&repo_path, &head_branch)?;

    // Try to get the remote from the branch name (works for remote-tracking branches like "upstream/main").
    // Fall back to push_remote if the branch doesn't exist locally or isn't a remote-tracking branch.
    let (target_remote, base_branch) =
        match git.get_remote_from_branch_name(&repo_path, &target_branch) {
            Ok(remote) => {
                let branch = target_branch
                    .strip_prefix(&format!("{}/", remote.name))
                    .unwrap_or(&target_branch);
                (remote, branch.to_string())
            }
            Err(_) => (push_remote.clone(), target_branch.clone()),
        };

    match git.check_remote_branch_exists(&repo_path, &target_remote.url, &base_branch) {
        Ok(false) => {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                PrError::TargetBranchNotFound {
                    branch: target_branch.clone(),
                },
            )));
        }
        Err(GitServiceError::GitCLI(GitCliError::AuthFailed(_))) => {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                PrError::GitCliNotLoggedIn,
            )));
        }
        Err(GitServiceError::GitCLI(GitCliError::NotAvailable)) => {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                PrError::GitCliNotInstalled,
            )));
        }
        Err(e) => return Err(ApiError::GitService(e)),
        Ok(true) => {}
    }

    let no_verify = deployment.config().read().await.git_push_no_verify;
    if let Err(e) = git.push_to_remote(&worktree_path, &head_branch, false, no_verify) {
        tracing::error!("Failed to push branch to remote: {}", e);
        match e {
            GitServiceError::GitCLI(GitCliError::AuthFailed(_)) => {
                return Ok(ResponseJson(ApiResponse::error_with_data(
                    PrError::GitCliNotLoggedIn,
                )));
            }
            GitServiceError::GitCLI(GitCliError::NotAvailable) => {
                return Ok(ResponseJson(ApiResponse::error_with_data(
                    PrError::GitCliNotInstalled,
                )));
            }
            _ => return Err(ApiError::GitService(e)),
        }
    }

    let git_host = match GitHostService::from_url(&target_remote.url) {
        Ok(host) => host,
        Err(GitHostError::UnsupportedProvider) => {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                PrError::UnsupportedProvider,
            )));
        }
        Err(GitHostError::CliNotInstalled { provider }) => {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                PrError::CliNotInstalled { provider },
            )));
        }
        Err(e) => return Err(ApiError::GitHost(e)),
    };

    let provider = git_host.provider_kind();

    // Create the PR
    let pr_request = CreatePrRequest {
        title: request.title.clone(),
        body: request.body.clone(),
        head_branch: head_branch.clone(),
        base_branch: base_branch.clone(),
        draft: request.draft,
        head_repo_url: Some(push_remote.url.clone()),
    };

    match git_host
        .create_pr(&repo_path, &target_remote.url, &pr_request)
        .await
    {
        Ok(pr_info) => {
            // Track the PR locally
            if let Err(e) = PullRequest::create_for_workspace(
                pool,
                workspace.id,
                workspace_repo.repo_id,
                &base_branch,
                pr_info.number,
                &pr_info.url,
                Some(&head_branch),
            )
            .await
            {
                tracing::error!("Failed to create local PR record: {}", e);
            }

            if let Ok(client) = deployment.remote_client() {
                let request = UpsertPullRequestRequest {
                    url: pr_info.url.clone(),
                    number: pr_info.number as i32,
                    status: PullRequestStatus::Open,
                    merged_at: None,
                    merge_commit_sha: None,
                    target_branch_name: base_branch.clone(),
                    local_workspace_id: workspace.id,
                };
                tokio::spawn(async move {
                    remote_sync::sync_pr_to_remote(&client, request).await;
                });
            }

            deployment
                .track_if_analytics_allowed(
                    "pr_created",
                    serde_json::json!({
                        "workspace_id": workspace.id.to_string(),
                        "provider": format!("{:?}", provider),
                    }),
                )
                .await;

            // A successfully opened PR consumes this dialog draft. Do this on
            // the server so cleanup is reliable even if the client navigated
            // away before receiving the create response.
            if let Err(e) = sqlx::query(
                "DELETE FROM workspace_pr_drafts WHERE workspace_id = ? AND repo_id = ?",
            )
            .bind(workspace.id)
            .bind(request.repo_id)
            .execute(pool)
            .await
            {
                // The external PR already exists, so a cleanup failure must not
                // turn this successful, non-idempotent operation into an error
                // that invites the client to retry and create a duplicate PR.
                tracing::warn!(
                    workspace_id = %workspace.id,
                    repo_id = %request.repo_id,
                    error = %e,
                    "Failed to delete consumed PR draft"
                );
            }

            Ok(ResponseJson(ApiResponse::success(pr_info.url)))
        }
        Err(e) => {
            tracing::error!(
                "Failed to create PR for attempt {} using {:?}: {}",
                workspace.id,
                provider,
                e
            );
            match &e {
                GitHostError::CliNotInstalled { provider } => Ok(ResponseJson(
                    ApiResponse::error_with_data(PrError::CliNotInstalled {
                        provider: *provider,
                    }),
                )),
                GitHostError::AuthFailed(_) => Ok(ResponseJson(ApiResponse::error_with_data(
                    PrError::CliNotLoggedIn { provider },
                ))),
                _ => Err(ApiError::GitHost(e)),
            }
        }
    }
}

pub async fn attach_existing_pr(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<AttachExistingPrRequest>,
) -> Result<ResponseJson<ApiResponse<AttachPrResponse, PrError>>, ApiError> {
    let pool = &deployment.db().pool;

    let workspace_repo =
        WorkspaceRepo::find_by_workspace_and_repo_id(pool, workspace.id, request.repo_id)
            .await?
            .ok_or(RepoError::NotFound)?;

    let repo = Repo::find_by_id(pool, workspace_repo.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    // Check if PR already attached for this repo
    let merges = Merge::find_by_workspace_and_repo_id(pool, workspace.id, request.repo_id).await?;
    if let Some(Merge::Pr(pr_merge)) = merges.into_iter().next() {
        return Ok(ResponseJson(ApiResponse::success(AttachPrResponse {
            pr_attached: true,
            pr_url: Some(pr_merge.pr_info.url.clone()),
            pr_number: Some(pr_merge.pr_info.number),
            pr_status: Some(pr_merge.pr_info.status.clone()),
        })));
    }

    // The PR's head (source) branch to search for. Defaults to the work branch,
    // but can be an intermediate "feature" branch in a three-branch workflow.
    let head_branch = request
        .head_branch
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| workspace.branch.clone());

    let git = deployment.git();

    // A remote-tracking head branch (e.g. "origin/feature" — used when the link
    // candidate is the repo's remote target branch) must be reduced to its bare
    // branch name. `gh pr list --head` matches GitHub's headRefName, which
    // carries no remote prefix, so "origin/feature" would never match a PR.
    let head_branch = match git.get_remote_from_branch_name(&repo.path, &head_branch) {
        Ok(remote) => head_branch
            .strip_prefix(&format!("{}/", remote.name))
            .unwrap_or(&head_branch)
            .to_string(),
        Err(_) => head_branch,
    };

    let remote = git.resolve_remote_for_branch(&repo.path, &workspace_repo.target_branch)?;

    let git_host = match GitHostService::from_url(&remote.url) {
        Ok(host) => host,
        Err(GitHostError::UnsupportedProvider) => {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                PrError::UnsupportedProvider,
            )));
        }
        Err(GitHostError::CliNotInstalled { provider }) => {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                PrError::CliNotInstalled { provider },
            )));
        }
        Err(e) => return Err(ApiError::GitHost(e)),
    };

    let provider = git_host.provider_kind();

    // List all PRs for branch (open, closed, and merged)
    let prs = match git_host
        .list_prs_for_branch(&repo.path, &remote.url, &head_branch)
        .await
    {
        Ok(prs) => prs,
        Err(GitHostError::CliNotInstalled { provider }) => {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                PrError::CliNotInstalled { provider },
            )));
        }
        Err(GitHostError::AuthFailed(_)) => {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                PrError::CliNotLoggedIn { provider },
            )));
        }
        Err(e) => return Err(ApiError::GitHost(e)),
    };

    // Take the first PR (prefer open, but also accept merged/closed)
    if let Some(pr_info) = prs.into_iter().next() {
        // Save PR info locally. Use the PR's actual base/head from the host
        // rather than the workspace's target_branch — in a three-branch flow the
        // PR's base (e.g. `develop`) differs from the work branch's merge target
        // (the feature branch).
        PullRequest::create_for_workspace(
            pool,
            workspace.id,
            workspace_repo.repo_id,
            &pr_info.base_branch,
            pr_info.number,
            &pr_info.url,
            Some(&pr_info.head_branch),
        )
        .await?;

        // Update status if not open
        if !matches!(pr_info.status, MergeStatus::Open) {
            let merged_at = if matches!(&pr_info.status, MergeStatus::Merged) {
                pr_info.merged_at
            } else {
                None
            };
            PullRequest::update_status(
                pool,
                &pr_info.url,
                &pr_info.status,
                merged_at,
                pr_info.merge_commit_sha.clone(),
            )
            .await?;
        }

        if let Ok(client) = deployment.remote_client() {
            let pr_status = match pr_info.status {
                MergeStatus::Open => PullRequestStatus::Open,
                MergeStatus::Merged => PullRequestStatus::Merged,
                MergeStatus::Closed => PullRequestStatus::Closed,
                MergeStatus::Unknown => PullRequestStatus::Open,
            };
            let request = UpsertPullRequestRequest {
                url: pr_info.url.clone(),
                number: pr_info.number as i32,
                status: pr_status,
                merged_at: None,
                merge_commit_sha: pr_info.merge_commit_sha.clone(),
                target_branch_name: pr_info.base_branch.clone(),
                local_workspace_id: workspace.id,
            };
            tokio::spawn(async move {
                remote_sync::sync_pr_to_remote(&client, request).await;
            });
        }

        // If PR is merged, archive workspace
        if matches!(pr_info.status, MergeStatus::Merged) {
            let open_pr_count = PullRequest::count_open_for_workspace(pool, workspace.id).await?;

            if open_pr_count == 0 {
                if !workspace.pinned
                    && let Err(e) = deployment.container().archive_workspace(workspace.id).await
                {
                    tracing::error!("Failed to archive workspace {}: {}", workspace.id, e);
                }
            } else {
                tracing::info!(
                    "PR #{} was merged, leaving workspace {} active with {} open PR(s)",
                    pr_info.number,
                    workspace.id,
                    open_pr_count
                );
            }
        }

        Ok(ResponseJson(ApiResponse::success(AttachPrResponse {
            pr_attached: true,
            pr_url: Some(pr_info.url),
            pr_number: Some(pr_info.number),
            pr_status: Some(pr_info.status),
        })))
    } else {
        Ok(ResponseJson(ApiResponse::success(AttachPrResponse {
            pr_attached: false,
            pr_url: None,
            pr_number: None,
            pr_status: None,
        })))
    }
}

pub async fn get_pr_comments(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<GetPrCommentsQuery>,
) -> Result<ResponseJson<ApiResponse<PrCommentsResponse, GetPrCommentsError>>, ApiError> {
    let pool = &deployment.db().pool;

    // Look up the specific repo using the multi-repo pattern
    let workspace_repo =
        WorkspaceRepo::find_by_workspace_and_repo_id(pool, workspace.id, query.repo_id)
            .await?
            .ok_or(RepoError::NotFound)?;

    let repo = Repo::find_by_id(pool, workspace_repo.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    // Find the merge/PR for this specific repo
    let merges = Merge::find_by_workspace_and_repo_id(pool, workspace.id, query.repo_id).await?;

    // Ensure there's an attached PR for this repo
    let pr_info = match merges.into_iter().next() {
        Some(Merge::Pr(pr_merge)) => pr_merge.pr_info,
        _ => {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                GetPrCommentsError::NoPrAttached,
            )));
        }
    };

    let git = deployment.git();
    let remote = git.resolve_remote_for_branch(&repo.path, &workspace_repo.target_branch)?;

    let git_host = match GitHostService::from_url(&remote.url) {
        Ok(host) => host,
        Err(GitHostError::CliNotInstalled { provider }) => {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                GetPrCommentsError::CliNotInstalled { provider },
            )));
        }
        Err(e) => return Err(ApiError::GitHost(e)),
    };

    let provider = git_host.provider_kind();

    match git_host
        .get_pr_comments(&repo.path, &remote.url, pr_info.number)
        .await
    {
        Ok(comments) => Ok(ResponseJson(ApiResponse::success(PrCommentsResponse {
            comments,
        }))),
        Err(e) => {
            tracing::error!(
                "Failed to fetch PR comments for attempt {}, PR #{}: {}",
                workspace.id,
                pr_info.number,
                e
            );
            match &e {
                GitHostError::CliNotInstalled { provider } => Ok(ResponseJson(
                    ApiResponse::error_with_data(GetPrCommentsError::CliNotInstalled {
                        provider: *provider,
                    }),
                )),
                GitHostError::AuthFailed(_) => Ok(ResponseJson(ApiResponse::error_with_data(
                    GetPrCommentsError::CliNotLoggedIn { provider },
                ))),
                _ => Err(ApiError::GitHost(e)),
            }
        }
    }
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct CreateWorkspaceFromPrBody {
    pub repo_id: Uuid,
    pub pr_number: i64,
    pub pr_title: String,
    pub pr_url: String,
    pub head_branch: String,
    pub base_branch: String,
    pub run_setup: bool,
    pub remote_name: Option<String>,
}

#[derive(Debug, Serialize, TS)]
pub struct CreateWorkspaceFromPrResponse {
    pub workspace: Workspace,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum CreateFromPrError {
    PrNotFound,
    BranchFetchFailed { message: String },
    CliNotInstalled { provider: ProviderKind },
    AuthFailed { message: String },
    UnsupportedProvider,
}

/// Best-effort cleanup of partially-created workspace resources.
/// Used when workspace creation from PR fails after DB records and filesystem
/// resources have already been created.
///
/// DB records are deleted synchronously (fast). Filesystem cleanup is spawned
/// as a background task to avoid blocking the error response.
async fn cleanup_failed_pr_workspace(pool: &sqlx::SqlitePool, workspace: &Workspace) {
    let workspace_id = workspace.id;

    // Gather data needed for background filesystem cleanup before deleting DB records
    let workspace_dir = workspace.container_ref.clone().map(PathBuf::from);
    let repositories = match WorkspaceRepo::find_repos_for_workspace(pool, workspace_id).await {
        Ok(repos) => repos,
        Err(e) => {
            tracing::warn!(
                "Failed to find repos for workspace {} during cleanup: {}",
                workspace_id,
                e
            );
            vec![]
        }
    };

    // Delete the workspace — FK CASCADE handles workspace_repos, sessions, merges, etc.
    if let Err(e) = Workspace::delete(pool, workspace_id).await {
        tracing::warn!(
            "Failed to delete workspace {} during cleanup: {}",
            workspace_id,
            e
        );
    }

    // Spawn background cleanup for filesystem resources (worktrees, workspace dir)
    if let Some(workspace_dir) = workspace_dir {
        tokio::spawn(async move {
            if let Err(e) = WorkspaceManager::cleanup_workspace(&workspace_dir, &repositories).await
            {
                tracing::error!(
                    "Background cleanup failed for workspace {} at {}: {}",
                    workspace_id,
                    workspace_dir.display(),
                    e
                );
            }
        });
    }
}

/// A failure to fetch or check out the PR's head branch (gh repo-info lookup or
/// `gh pr checkout`). Surfaced separately from infra errors so callers can
/// present it as a typed outcome instead of a 500.
pub(crate) struct BranchFetchFailure {
    pub message: String,
}

/// Shared workspace setup for the "work on an existing PR branch" flows:
/// create-from-PR (command bar) and review-mode create-and-start.
///
/// Creates the workspace + single repo on the PR base ref, materializes the
/// worktree, then `gh pr checkout`s the PR head branch and links the PR. Keeping
/// the repo `target_branch` at the base ref means later merges / new PRs target
/// the base. On a branch-fetch failure the partially-created workspace is
/// cleaned up and `Ok(Err(BranchFetchFailure))` is returned; infra failures
/// propagate as `Err(ApiError)`.
pub(crate) async fn setup_pr_review_workspace(
    deployment: &DeploymentImpl,
    workspace_name: Option<String>,
    pr: &PrReviewInput,
) -> Result<Result<Workspace, BranchFetchFailure>, ApiError> {
    let pool = &deployment.db().pool;

    let repo = Repo::find_by_id(pool, pr.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    let remote = match &pr.remote_name {
        Some(name) => GitRemote {
            url: deployment.git().get_remote_url(&repo.path, name)?,
            name: name.clone(),
        },
        None => deployment.git().get_default_remote(&repo.path)?,
    };

    // Start the worktree on the PR base ref; gh pr checkout switches it to the
    // head branch below.
    let target_branch_ref = review_target_branch_ref(&remote.name, &pr.base_branch);

    let workspace_id = Uuid::new_v4();
    let mut workspace = Workspace::create(
        pool,
        &CreateWorkspace {
            branch: target_branch_ref.clone(),
            name: workspace_name,
        },
        workspace_id,
    )
    .await?;

    WorkspaceRepo::create_many(
        pool,
        workspace.id,
        &[CreateWorkspaceRepo {
            repo_id: pr.repo_id,
            target_branch: target_branch_ref.clone(),
        }],
    )
    .await?;

    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;

    // Needed so cleanup_failed_pr_workspace can locate the worktree dir on error.
    workspace.container_ref = Some(container_ref.clone());

    // gh pr checkout handles SSH/HTTPS auth correctly regardless of fork URL.
    let worktree_path = PathBuf::from(&container_ref).join(&repo.name);
    match GhCli::new().get_repo_info(&remote.url, &worktree_path) {
        Ok(repo_info) => {
            if let Err(e) = GhCli::new().pr_checkout(
                &worktree_path,
                &repo_info.owner,
                &repo_info.repo_name,
                pr.pr_number,
            ) {
                tracing::error!("Failed to checkout PR branch: {e}");
                cleanup_failed_pr_workspace(pool, &workspace).await;
                return Ok(Err(BranchFetchFailure {
                    message: e.to_string(),
                }));
            }
            Workspace::update_branch_name(pool, workspace.id, &pr.head_branch).await?;
            workspace.branch = pr.head_branch.clone();
        }
        Err(e) => {
            tracing::error!(
                "Failed to get repo info for PR checkout (gh CLI may not be installed): {e}"
            );
            cleanup_failed_pr_workspace(pool, &workspace).await;
            return Ok(Err(BranchFetchFailure {
                message: format!("Failed to get repository info: {e}"),
            }));
        }
    }

    PullRequest::create_for_workspace(
        pool,
        workspace.id,
        pr.repo_id,
        &target_branch_ref,
        pr.pr_number,
        &pr.pr_url,
        Some(&pr.head_branch),
    )
    .await?;

    let workspace = Workspace::find_by_id(pool, workspace.id)
        .await?
        .ok_or(WorkspaceError::WorkspaceNotFound)?;

    Ok(Ok(workspace))
}

#[axum::debug_handler]
pub async fn create_workspace_from_pr(
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<CreateWorkspaceFromPrBody>,
) -> Result<ResponseJson<ApiResponse<CreateWorkspaceFromPrResponse, CreateFromPrError>>, ApiError> {
    let pool = &deployment.db().pool;

    let pr_input = PrReviewInput {
        repo_id: payload.repo_id,
        pr_number: payload.pr_number,
        pr_title: payload.pr_title.clone(),
        pr_url: payload.pr_url.clone(),
        head_branch: payload.head_branch.clone(),
        base_branch: payload.base_branch.clone(),
        remote_name: payload.remote_name.clone(),
    };

    let workspace =
        match setup_pr_review_workspace(&deployment, Some(payload.pr_title.clone()), &pr_input)
            .await?
        {
            Ok(workspace) => workspace,
            Err(BranchFetchFailure { message }) => {
                return Ok(ResponseJson(ApiResponse::error_with_data(
                    CreateFromPrError::BranchFetchFailed { message },
                )));
            }
        };

    if payload.run_setup {
        let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
        if let Some(setup_action) = deployment.container().setup_actions_for_repos(&repos) {
            let session = Session::create(
                pool,
                &CreateSession {
                    executor: None,
                    name: None,
                },
                Uuid::new_v4(),
                workspace.id,
            )
            .await?;

            if let Err(e) = deployment
                .container()
                .start_execution(
                    &workspace,
                    &session,
                    &setup_action,
                    &ExecutionProcessRunReason::SetupScript,
                )
                .await
            {
                tracing::error!("Failed to run setup script: {}", e);
            }
        }
    }

    deployment
        .track_if_analytics_allowed(
            "workspace_created_from_pr",
            serde_json::json!({
                "workspace_id": workspace.id.to_string(),
                "pr_number": payload.pr_number,
                "run_setup": payload.run_setup,
            }),
        )
        .await;

    tracing::info!(
        "Created workspace {} from PR #{}",
        workspace.id,
        payload.pr_number,
    );

    Ok(ResponseJson(ApiResponse::success(
        CreateWorkspaceFromPrResponse { workspace },
    )))
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/", post(create_pr))
        .route("/generate", post(generate_pr_description))
        .route("/generate/start", post(start_pr_description_generation))
        .route(
            "/generate/status",
            get(get_pr_description_generation).delete(cancel_pr_description_generation),
        )
        .route(
            "/draft",
            get(get_pr_draft).put(put_pr_draft).delete(delete_pr_draft),
        )
        .route("/attach", post(attach_existing_pr))
        .route("/comments", get(get_pr_comments))
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, time::Instant};

    use sqlx::SqlitePool;
    use tokio_util::sync::CancellationToken;
    use uuid::Uuid;

    use super::{
        PR_GENERATE_FINISHED_JOB_TTL, PR_GENERATE_RUNNING_JOB_TTL, PrDescriptionGenerationJob,
        PrDescriptionGenerationStatus, PrDraft, PrGenerationAdmissionError, PrGenerationScheduler,
        build_pr_generation_prompt, parse_pr_description, prune_pr_description_generation_jobs,
        save_pr_draft,
    };

    #[test]
    fn pr_generation_scheduler_allows_only_one_job_per_workspace() {
        let scheduler = PrGenerationScheduler::new(2);
        let workspace_id = Uuid::new_v4();

        let first = scheduler
            .try_acquire(workspace_id)
            .unwrap_or_else(|_| panic!("first admission should succeed"));
        assert!(matches!(
            scheduler.try_acquire(workspace_id),
            Err(PrGenerationAdmissionError::WorkspaceBusy)
        ));

        drop(first);
        assert!(scheduler.try_acquire(workspace_id).is_ok());
    }

    #[test]
    fn pr_generation_scheduler_rejects_instead_of_queueing_at_global_limit() {
        let scheduler = PrGenerationScheduler::new(1);
        let first = scheduler
            .try_acquire(Uuid::new_v4())
            .unwrap_or_else(|_| panic!("first admission should succeed"));

        assert!(matches!(
            scheduler.try_acquire(Uuid::new_v4()),
            Err(PrGenerationAdmissionError::GlobalLimitReached)
        ));
        assert_eq!(scheduler.semaphore.available_permits(), 0);

        drop(first);
        assert!(scheduler.try_acquire(Uuid::new_v4()).is_ok());
    }

    #[test]
    fn stale_pr_generation_jobs_are_cancelled_and_removed() {
        let stale_running_token = CancellationToken::new();
        let stale_finished_token = CancellationToken::new();
        let fresh_token = CancellationToken::new();
        let mut jobs = HashMap::from([
            (
                Uuid::new_v4(),
                PrDescriptionGenerationJob {
                    workspace_id: Uuid::new_v4(),
                    status: PrDescriptionGenerationStatus::Running,
                    cancel_token: stale_running_token.clone(),
                    execution_process_id: None,
                    created_at: Instant::now() - PR_GENERATE_RUNNING_JOB_TTL,
                },
            ),
            (
                Uuid::new_v4(),
                PrDescriptionGenerationJob {
                    workspace_id: Uuid::new_v4(),
                    status: PrDescriptionGenerationStatus::Failed {
                        error: "failed".to_string(),
                    },
                    cancel_token: stale_finished_token.clone(),
                    execution_process_id: None,
                    created_at: Instant::now() - PR_GENERATE_FINISHED_JOB_TTL,
                },
            ),
            (
                Uuid::new_v4(),
                PrDescriptionGenerationJob {
                    workspace_id: Uuid::new_v4(),
                    status: PrDescriptionGenerationStatus::Running,
                    cancel_token: fresh_token.clone(),
                    execution_process_id: None,
                    created_at: Instant::now(),
                },
            ),
        ]);

        prune_pr_description_generation_jobs(&mut jobs);

        assert_eq!(jobs.len(), 1);
        assert!(stale_running_token.is_cancelled());
        assert!(stale_finished_token.is_cancelled());
        assert!(!fresh_token.is_cancelled());
    }

    #[tokio::test]
    async fn generated_pr_draft_is_upserted_by_workspace_and_repo() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        // Mirror the migration schema (NOT NULL + defaults) so the upsert's
        // `updated_at = datetime('now', 'subsec')` path is exercised against the
        // real NOT NULL constraint rather than a permissive test-only table.
        sqlx::query(
            "CREATE TABLE workspace_pr_drafts (workspace_id BLOB NOT NULL, repo_id BLOB NOT NULL, \
             title TEXT NOT NULL, body TEXT NOT NULL, \
             created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, \
             updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, \
             PRIMARY KEY (workspace_id, repo_id))",
        )
        .execute(&pool)
        .await
        .unwrap();
        let workspace_id = Uuid::new_v4();
        let repo_id = Uuid::new_v4();

        save_pr_draft(
            &pool,
            workspace_id,
            &PrDraft {
                repo_id,
                title: "First".into(),
                body: "Old body".into(),
            },
        )
        .await
        .unwrap();
        save_pr_draft(
            &pool,
            workspace_id,
            &PrDraft {
                repo_id,
                title: "Final".into(),
                body: "Generated body".into(),
            },
        )
        .await
        .unwrap();

        let stored = sqlx::query_as::<_, (String, String)>(
            "SELECT title, body FROM workspace_pr_drafts WHERE workspace_id = ? AND repo_id = ?",
        )
        .bind(workspace_id)
        .bind(repo_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(stored, ("Final".into(), "Generated body".into()));
    }

    #[test]
    fn parses_json_fence() {
        let msg = "Here you go:\n```json\n{\"title\": \"Add retry to sender\", \"description\": \"## Changes\\nRetries added.\"}\n```\n";
        let (title, desc) = parse_pr_description(msg).unwrap();
        assert_eq!(title, "Add retry to sender");
        assert_eq!(desc, "## Changes\nRetries added.");
    }

    #[test]
    fn parses_last_json_fence_when_multiple() {
        let msg = "```json\n{\"title\": \"first\", \"description\": \"a\"}\n```\nreconsidering...\n```json\n{\"title\": \"final\", \"description\": \"b\"}\n```";
        let (title, _) = parse_pr_description(msg).unwrap();
        assert_eq!(title, "final");
    }

    #[test]
    fn parses_bare_json_object() {
        let msg = "{\"title\": \"Bare\", \"description\": \"desc\"}";
        let (title, desc) = parse_pr_description(msg).unwrap();
        assert_eq!(title, "Bare");
        assert_eq!(desc, "desc");
    }

    #[test]
    fn extracts_unfenced_json_object_amid_prose() {
        // No fence, JSON object surrounded by prose — the field-filling must still
        // recover clean title/description rather than dumping the whole message.
        let msg = "Sure, here's the PR:\n{\"title\": \"feat(x): 개선\", \"description\": \"본문 {중괄호} 포함\"}\nLet me know!";
        let (title, desc) = parse_pr_description(msg).unwrap();
        assert_eq!(title, "feat(x): 개선");
        assert_eq!(desc, "본문 {중괄호} 포함");
    }

    #[test]
    fn picks_last_valid_json_object() {
        let msg = "{\"title\": \"first\", \"description\": \"a\"}\nthen\n{\"title\": \"second\", \"description\": \"b\"}";
        let (title, _) = parse_pr_description(msg).unwrap();
        assert_eq!(title, "second");
    }

    #[test]
    fn returns_none_when_no_parseable_json() {
        // Prose with no JSON must NOT be shoved into the fields — it yields None,
        // which triggers a retry / error upstream.
        assert!(parse_pr_description("# Fix the webhook retry\n\nSome body text.").is_none());
        assert!(parse_pr_description("브랜치 상태는 확인됐습니다. 정리하면:").is_none());
        assert!(parse_pr_description("").is_none());
    }

    #[test]
    fn prompt_substitutes_branches_without_custom() {
        let p = build_pr_generation_prompt("develop", "1821-x", None);
        assert!(p.contains("`1821-x`") && p.contains("`develop`"));
        assert!(p.contains("```json"));
        // No leftover legacy PR placeholders from the built-in template.
        assert!(!p.contains("{pr_number}") && !p.contains("{pr_url}"));
    }

    #[test]
    fn prompt_neutralizes_legacy_custom_and_keeps_contract_last() {
        let legacy = "Update the PR that was just created. The PR number is #{pr_number} and the URL is {pr_url}. Use gh pr edit.";
        let p = build_pr_generation_prompt("develop", "feat", Some(legacy));
        assert!(!p.contains("{pr_number}") && !p.contains("{pr_url}"));
        // The strict JSON contract from the template stays at the end.
        assert!(p.trim_end().ends_with("encode newlines as \\n."));
        // Custom text is included as reference context.
        assert!(p.contains("gh pr edit"));
    }
}
