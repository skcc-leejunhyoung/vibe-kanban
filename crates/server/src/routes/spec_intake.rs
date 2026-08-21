//! "Generate spec" intake endpoint.
//!
//! Turns a rough one-line brief into a development-ready technical task by
//! running a coding agent ONCE, read-only, in a throwaway (ephemeral) multi-repo
//! workspace so it can explore the codebase. The agent's final JSON-fenced
//! message is parsed into a title + markdown spec used to pre-fill the New Issue
//! dialog. The ephemeral workspace is always torn down afterward.

use std::{
    collections::{HashMap, HashSet},
    panic::AssertUnwindSafe,
    sync::LazyLock,
    time::{Duration, Instant},
};

use axum::{
    Json, Router,
    extract::{Query, State},
    http::HeaderMap,
    response::Json as ResponseJson,
    routing::{get, post},
};
use db::models::{
    execution_process::{ExecutionProcess, ExecutionProcessStatus},
    requests::{GenerateSpecRequest, GenerateSpecResponse},
    session::Session,
    workspace::{CreateWorkspace, Workspace},
};
use deployment::Deployment;
use executors::profile::ExecutorConfig;
use futures_util::FutureExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use services::services::{
    config::DEFAULT_SPEC_INTAKE_PROMPT,
    container::{ContainerService, assistant_message_in_store},
};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;
use utils::response::ApiResponse;
use uuid::Uuid;
use workspace_manager::WorkspaceManager;

use crate::{DeploymentImpl, error::ApiError};

/// Whole-request budget. Covers workspace setup + agent run + capture; the
/// client timeout must strictly exceed this.
const SPEC_INTAKE_TIMEOUT: Duration = Duration::from_secs(120);
/// How often to poll the execution-process status while waiting for the agent.
const POLL_INTERVAL: Duration = Duration::from_millis(750);
const JOB_TTL: Duration = Duration::from_secs(10 * 60);

struct SpecGenerationJob {
    status: SpecGenerationStatus,
    cancel_token: CancellationToken,
    created_at: Instant,
}

#[derive(Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum SpecGenerationStatus {
    Running,
    Completed {
        title: String,
        description: String,
        intake_metadata: serde_json::Value,
    },
    Failed {
        error: String,
    },
}

#[derive(Serialize)]
struct StartSpecGenerationResponse {
    job_id: Uuid,
}

#[derive(Deserialize)]
struct SpecGenerationQuery {
    job_id: Uuid,
}

static SPEC_GENERATION_JOBS: LazyLock<RwLock<HashMap<Uuid, SpecGenerationJob>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

fn prune_spec_generation_jobs(jobs: &mut HashMap<Uuid, SpecGenerationJob>) {
    jobs.retain(|_, job| {
        let keep = job.created_at.elapsed() < JOB_TTL;
        if !keep {
            job.cancel_token.cancel();
        }
        keep
    });
}

pub fn router(deployment: &DeploymentImpl) -> Router<DeploymentImpl> {
    let _ = deployment;
    Router::new()
        .route("/spec/generate", post(generate_spec))
        .route("/spec/generate/start", post(start_spec_generation))
        .route(
            "/spec/generate/status",
            get(get_spec_generation).delete(cancel_spec_generation),
        )
}

pub async fn generate_spec(
    State(deployment): State<DeploymentImpl>,
    headers: HeaderMap,
    Json(payload): Json<GenerateSpecRequest>,
) -> Result<ResponseJson<ApiResponse<GenerateSpecResponse>>, ApiError> {
    // Reject relayed calls: generation can take 20-60s, well past the relay's
    // 30s HTTP timeout. Both relay transports (WebRTC data-channel proxy and the
    // relay-tunnel) inject a trusted `x-vk-relayed` marker after stripping any
    // client-provided value, so its presence reliably means "relayed". The
    // remote web app proxies these calls through the host relay, so this also
    // keeps the feature local-app-only as intended.
    if headers.contains_key("x-vk-relayed") {
        return Err(ApiError::Forbidden(
            "Spec generation isn't available over a remote relay connection (it can exceed the relay timeout). Run it from the local app.".to_string(),
        ));
    }

    generate_spec_inner(&deployment, payload).await
}

async fn generate_spec_inner(
    deployment: &DeploymentImpl,
    payload: GenerateSpecRequest,
) -> Result<ResponseJson<ApiResponse<GenerateSpecResponse>>, ApiError> {
    let GenerateSpecRequest {
        project_id,
        brief,
        executor_config,
        repos,
    } = payload;

    let brief = brief.trim().to_string();
    if brief.is_empty() {
        return Err(ApiError::BadRequest(
            "A task brief is required.".to_string(),
        ));
    }
    if repos.is_empty() {
        return Err(ApiError::BadRequest(
            "At least one repository is required.".to_string(),
        ));
    }
    if repos.iter().any(|r| r.target_branch.trim().is_empty()) {
        return Err(ApiError::BadRequest(
            "Each repository needs a target branch.".to_string(),
        ));
    }

    let prompt = DEFAULT_SPEC_INTAKE_PROMPT.replace("{brief}", &brief);

    // Create the throwaway workspace and arm the teardown guard BEFORE attaching
    // repos, so a failure in any later step (or a cancelled request) still cleans
    // up. The guard runs cleanup on every drop (success, error, panic, cancel).
    let workspace_id = Uuid::new_v4();
    let branch = deployment
        .container()
        .git_branch_from_workspace(&workspace_id, "spec-intake")
        .await;
    let workspace = Workspace::create_ephemeral(
        &deployment.db().pool,
        &CreateWorkspace {
            branch,
            name: Some("spec-intake".to_string()),
        },
        workspace_id,
    )
    .await?;
    let _guard = EphemeralWorkspaceGuard {
        deployment: deployment.clone(),
        workspace_id,
    };

    let mut managed = deployment
        .workspace_manager()
        .load_managed_workspace(workspace)
        .await?;
    for repo in &repos {
        managed
            .add_repository(repo, deployment.git())
            .await
            .map_err(ApiError::from)?;
    }
    let workspace = managed.workspace.clone();

    let (title, description) = tokio::time::timeout(
        SPEC_INTAKE_TIMEOUT,
        run_intake(&deployment, &workspace, executor_config.clone(), prompt),
    )
    .await
    .map_err(|_| {
        ApiError::BadGateway("Spec generation timed out. Try a simpler brief.".to_string())
    })??;

    let intake_metadata = json!({
        "intake": {
            "brief": brief,
            "executor_config": executor_config,
            "repos": repos,
            "project_id": project_id,
        }
    });

    Ok(ResponseJson(ApiResponse::success(GenerateSpecResponse {
        title,
        description,
        intake_metadata,
    })))
}

async fn start_spec_generation(
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<GenerateSpecRequest>,
) -> Result<ResponseJson<ApiResponse<StartSpecGenerationResponse>>, ApiError> {
    let job_id = Uuid::new_v4();
    let cancel_token = CancellationToken::new();
    let mut jobs = SPEC_GENERATION_JOBS.write().await;
    prune_spec_generation_jobs(&mut jobs);
    jobs.insert(
        job_id,
        SpecGenerationJob {
            status: SpecGenerationStatus::Running,
            cancel_token: cancel_token.clone(),
            created_at: Instant::now(),
        },
    );
    drop(jobs);

    tokio::spawn(async {
        tokio::time::sleep(JOB_TTL).await;
        let mut jobs = SPEC_GENERATION_JOBS.write().await;
        prune_spec_generation_jobs(&mut jobs);
    });

    tokio::spawn(async move {
        let result = tokio::select! {
            result = AssertUnwindSafe(generate_spec_inner(&deployment, payload)).catch_unwind() => Some(result),
            _ = cancel_token.cancelled() => None,
        };
        let Some(result) = result else {
            SPEC_GENERATION_JOBS.write().await.remove(&job_id);
            return;
        };
        let status = match result {
            Ok(Ok(ResponseJson(response))) => match response.into_data() {
                Some(result) => SpecGenerationStatus::Completed {
                    title: result.title,
                    description: result.description,
                    intake_metadata: result.intake_metadata,
                },
                None => SpecGenerationStatus::Failed {
                    error: "Spec generation returned no result.".to_string(),
                },
            },
            Ok(Err(error)) => SpecGenerationStatus::Failed {
                error: error.to_string(),
            },
            Err(_) => SpecGenerationStatus::Failed {
                error: "Spec generation stopped unexpectedly.".to_string(),
            },
        };
        if let Some(job) = SPEC_GENERATION_JOBS.write().await.get_mut(&job_id) {
            job.status = status;
        }
    });

    Ok(ResponseJson(ApiResponse::success(
        StartSpecGenerationResponse { job_id },
    )))
}

async fn cancel_spec_generation(
    Query(query): Query<SpecGenerationQuery>,
) -> ResponseJson<ApiResponse<()>> {
    if let Some(job) = SPEC_GENERATION_JOBS.read().await.get(&query.job_id) {
        job.cancel_token.cancel();
    }
    ResponseJson(ApiResponse::success(()))
}

async fn get_spec_generation(
    Query(query): Query<SpecGenerationQuery>,
) -> Result<ResponseJson<ApiResponse<SpecGenerationStatus>>, ApiError> {
    let mut jobs = SPEC_GENERATION_JOBS.write().await;
    let status = jobs
        .get(&query.job_id)
        .map(|job| job.status.clone())
        .ok_or_else(|| ApiError::BadRequest("Spec generation job not found.".to_string()))?;
    if !matches!(status, SpecGenerationStatus::Running) {
        jobs.remove(&query.job_id);
    }
    Ok(ResponseJson(ApiResponse::success(status)))
}

/// Run the agent and return the parsed (title, description). Hard-errors on
/// agent failure / no output; never falls back for those.
async fn run_intake(
    deployment: &DeploymentImpl,
    workspace: &Workspace,
    executor_config: ExecutorConfig,
    prompt: String,
) -> Result<(String, String), ApiError> {
    let ep = deployment
        .container()
        .start_oneshot_coding_agent(workspace, executor_config, prompt, None)
        .await?;

    let pool = &deployment.db().pool;
    // Hold our own Arc to the agent's MsgStore. The exit-monitor teardown
    // removes the store from the live `msg_stores` map almost immediately after
    // marking the process Completed, which would race our post-completion read
    // and yield "no spec output". Keeping our own Arc makes the final message
    // readable regardless of teardown timing. The store is created when the
    // agent starts (before any output), but we also re-grab it inside the loop
    // in case it isn't registered the instant we first look.
    let mut msg_store = deployment.container().get_msg_store_by_id(&ep.id).await;
    loop {
        if msg_store.is_none() {
            msg_store = deployment.container().get_msg_store_by_id(&ep.id).await;
        }
        let current = ExecutionProcess::find_by_id(pool, ep.id)
            .await?
            .ok_or_else(|| {
                ApiError::BadGateway("Spec generation process disappeared.".to_string())
            })?;
        match current.status {
            ExecutionProcessStatus::Running => tokio::time::sleep(POLL_INTERVAL).await,
            ExecutionProcessStatus::Completed => break,
            ExecutionProcessStatus::Failed | ExecutionProcessStatus::Killed => {
                return Err(ApiError::BadGateway(
                    "The agent failed while generating the spec.".to_string(),
                ));
            }
        }
    }

    let message = msg_store
        .as_deref()
        .and_then(assistant_message_in_store)
        .filter(|m| !m.trim().is_empty())
        .ok_or_else(|| ApiError::BadGateway("The agent produced no spec output.".to_string()))?;

    Ok(parse_spec(&message))
}

#[derive(Deserialize)]
struct SpecJson {
    title: String,
    description: String,
}

/// Parse the agent's final message into (title, description).
///
/// Primary contract: a single fenced ```json block. Fallbacks (only for
/// malformed-but-non-empty output): whole message as JSON, then first
/// heading/line as the title with the whole message as the description.
fn parse_spec(message: &str) -> (String, String) {
    if let Some(spec) = parse_json_fence(message) {
        return (spec.title, spec.description);
    }
    if let Ok(spec) = serde_json::from_str::<SpecJson>(message.trim()) {
        return (spec.title, spec.description);
    }
    let title = message
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.trim_start_matches('#').trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "Untitled task".to_string());
    (title, message.trim().to_string())
}

/// Extract and parse the last ```json fenced block in `message`.
fn parse_json_fence(message: &str) -> Option<SpecJson> {
    let open = message.rfind("```json")?;
    let after = &message[open + "```json".len()..];
    let end = after.find("```")?;
    let body = after[..end].trim();
    serde_json::from_str::<SpecJson>(body).ok()
}

/// Tears down the ephemeral workspace on drop (success, error, panic, or
/// cancelled request). Cleanup is best-effort and runs in the background.
struct EphemeralWorkspaceGuard {
    deployment: DeploymentImpl,
    workspace_id: Uuid,
}

impl Drop for EphemeralWorkspaceGuard {
    fn drop(&mut self) {
        let deployment = self.deployment.clone();
        let workspace_id = self.workspace_id;
        tokio::spawn(async move {
            cleanup_ephemeral_workspace(&deployment, workspace_id).await;
        });
    }
}

/// Stop any running process for the workspace, then delete the record and its
/// worktrees/branches. Reloads the workspace from the DB so it picks up the
/// `container_ref` persisted during container creation.
async fn cleanup_ephemeral_workspace(deployment: &DeploymentImpl, workspace_id: Uuid) {
    let pool = &deployment.db().pool;

    if let Ok(sessions) = Session::find_by_workspace_id(pool, workspace_id).await {
        let session_ids: HashSet<Uuid> = sessions.iter().map(|s| s.id).collect();
        if let Ok(running) = ExecutionProcess::find_running(pool).await {
            for ep in running
                .into_iter()
                .filter(|ep| session_ids.contains(&ep.session_id))
            {
                if let Err(e) = deployment
                    .container()
                    .stop_execution(&ep, ExecutionProcessStatus::Killed)
                    .await
                {
                    tracing::warn!(
                        "Failed to stop process {} for ephemeral workspace {}: {}",
                        ep.id,
                        workspace_id,
                        e
                    );
                }
            }
        }
    }

    match Workspace::find_by_id(pool, workspace_id).await {
        Ok(Some(workspace)) => match deployment
            .workspace_manager()
            .load_managed_workspace(workspace)
            .await
        {
            Ok(managed) => match managed.prepare_deletion_context().await {
                Ok(ctx) => {
                    if let Err(e) = managed.delete_record().await {
                        tracing::warn!(
                            "Failed to delete ephemeral workspace record {}: {}",
                            workspace_id,
                            e
                        );
                    }
                    WorkspaceManager::spawn_workspace_deletion_cleanup(ctx, true);
                }
                Err(e) => tracing::warn!(
                    "Failed to prepare deletion for ephemeral workspace {}: {}",
                    workspace_id,
                    e
                ),
            },
            Err(e) => tracing::warn!(
                "Failed to load ephemeral workspace {} for cleanup: {}",
                workspace_id,
                e
            ),
        },
        Ok(None) => {}
        Err(e) => tracing::warn!(
            "Failed to find ephemeral workspace {} for cleanup: {}",
            workspace_id,
            e
        ),
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, time::Instant};

    use tokio_util::sync::CancellationToken;
    use uuid::Uuid;

    use super::{
        JOB_TTL, SPEC_GENERATION_JOBS, SpecGenerationJob, SpecGenerationQuery,
        SpecGenerationStatus, get_spec_generation, parse_spec, prune_spec_generation_jobs,
    };

    #[test]
    fn pruning_expired_job_cancels_it() {
        let cancel_token = CancellationToken::new();
        let mut jobs = HashMap::from([(
            Uuid::new_v4(),
            SpecGenerationJob {
                status: SpecGenerationStatus::Running,
                cancel_token: cancel_token.clone(),
                created_at: Instant::now() - JOB_TTL,
            },
        )]);

        prune_spec_generation_jobs(&mut jobs);

        assert!(jobs.is_empty());
        assert!(cancel_token.is_cancelled());
    }

    #[tokio::test]
    async fn completed_job_is_consumed() {
        let job_id = Uuid::new_v4();
        SPEC_GENERATION_JOBS.write().await.insert(
            job_id,
            SpecGenerationJob {
                status: SpecGenerationStatus::Completed {
                    title: String::new(),
                    description: String::new(),
                    intake_metadata: serde_json::Value::Null,
                },
                cancel_token: CancellationToken::new(),
                created_at: Instant::now(),
            },
        );

        let _ = get_spec_generation(axum::extract::Query(SpecGenerationQuery { job_id }))
            .await
            .unwrap();

        assert!(!SPEC_GENERATION_JOBS.read().await.contains_key(&job_id));
    }

    #[test]
    fn parses_json_fence() {
        let msg = "Here is the spec:\n```json\n{\"title\": \"Add retry\", \"description\": \"## Outcome\\nRetries happen\"}\n```\n";
        let (title, desc) = parse_spec(msg);
        assert_eq!(title, "Add retry");
        assert_eq!(desc, "## Outcome\nRetries happen");
    }

    #[test]
    fn parses_last_json_fence_when_multiple() {
        let msg = "```json\n{\"title\": \"first\", \"description\": \"a\"}\n```\nthinking...\n```json\n{\"title\": \"final\", \"description\": \"b\"}\n```";
        let (title, _) = parse_spec(msg);
        assert_eq!(title, "final");
    }

    #[test]
    fn falls_back_to_whole_json() {
        let msg = "{\"title\": \"Bare\", \"description\": \"desc\"}";
        let (title, desc) = parse_spec(msg);
        assert_eq!(title, "Bare");
        assert_eq!(desc, "desc");
    }

    #[test]
    fn falls_back_to_first_heading_for_unfenced_markdown() {
        let msg = "# Add a retry to the webhook sender\n\nSome body text.";
        let (title, desc) = parse_spec(msg);
        assert_eq!(title, "Add a retry to the webhook sender");
        assert!(desc.contains("Some body text."));
    }
}
