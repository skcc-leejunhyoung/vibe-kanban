//! The server's half of "review and create PR" after the merge.
//!
//! A review started with `create_pr` leaves its run in `pushing` once the merge
//! lands. From there this module pushes each repo's target branch, has the
//! agent draft a PR title and body, and opens the draft PR — the steps a
//! browser tab used to drive, which stalled whenever that tab was closed,
//! reloaded or suspended. The phase lives in `vibe_runs`, so a run a restart
//! interrupted is picked up again at startup, and a step that fails blocks the
//! run with its reason and the phase a retry resumes in.

use std::{
    collections::HashSet,
    future::Future,
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};

use axum::{
    Extension, Json,
    body::to_bytes,
    extract::State,
    http::HeaderMap,
    response::{IntoResponse, Json as ResponseJson},
};
use db::models::{
    merge::{Merge, MergeStatus, PrMerge},
    repo::Repo,
    vibe_run::{VibeRun, VibeRunError},
    workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
use deployment::Deployment;
use serde::Serialize;
use serde_json::{Value, json};
use services::services::{
    container::ContainerService,
    vibe_orchestrator::{PR_FOLLOW_UP, VibePhase},
};
use sqlx::SqlitePool;
use tokio::task::JoinHandle;
use utils::{
    git_ops::{self, GitFailure, Target},
    response::ApiResponse,
};
use uuid::Uuid;

use crate::{
    DeploymentImpl,
    error::ApiError,
    routes::workspaces::{
        git::{self, PushTargetBranchRequest},
        git_events,
        pr::{self, CreatePrApiRequest, GeneratePrDescriptionRequest},
    },
};

/// How often runs owing their follow-up are looked for when nothing rang
/// [`PR_FOLLOW_UP`] (a run from before a restart, a start that failed).
const POLL_INTERVAL: Duration = Duration::from_secs(60);
/// A push runs the repo's pre-push hook, which may build or test. Past this
/// the run is blocked with the reason rather than left waiting on a remote
/// that never answers.
const GIT_STEP_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Title of a PR whose draft came back without one.
const FALLBACK_TITLE: &str = "Pull request";

/// What the follow-up does outside `vibe_runs`: git, the agent, the PR host,
/// and telling the user. Behind a trait so the phase machine is tested without
/// a deployment.
pub(crate) trait FollowUpSteps: Send + Sync + 'static {
    /// Push every repo's local target branch to its remote.
    fn push_targets(
        &self,
        workspace: &Workspace,
    ) -> impl Future<Output = Result<(), String>> + Send;

    /// Open an AI-drafted draft PR for every repo whose head has none open yet;
    /// the URLs of the ones opened.
    fn create_prs(
        &self,
        workspace: &Workspace,
        run: &VibeRun,
    ) -> impl Future<Output = Result<Vec<String>, String>> + Send;

    /// The step `run.phase` failed and blocked the run.
    fn blocked(
        &self,
        workspace: &Workspace,
        run: &VibeRun,
        reason: &str,
    ) -> impl Future<Output = ()> + Send;

    /// The follow-up is done, having opened `pr_urls`.
    fn finished(
        &self,
        workspace: &Workspace,
        run: &VibeRun,
        pr_urls: &[String],
    ) -> impl Future<Output = ()> + Send;
}

static IN_FLIGHT: LazyLock<Mutex<HashSet<Uuid>>> = LazyLock::new(Default::default);

/// Whether the follow-up is at work on this workspace's run right now (so it
/// is not stalled, however long its step takes).
pub(crate) fn in_flight(workspace_id: Uuid) -> bool {
    IN_FLIGHT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .contains(&workspace_id)
}

/// One worker per run: held while a run's follow-up is at work.
struct Claim(Uuid);

impl Claim {
    fn take(workspace_id: Uuid) -> Option<Self> {
        let free = IN_FLIGHT
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(workspace_id);
        // Built only once the run is ours: a claim dropped for a run someone
        // else holds would release theirs.
        free.then(|| Self(workspace_id))
    }
}

impl Drop for Claim {
    fn drop(&mut self) {
        IN_FLIGHT
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.0);
    }
}

/// Spawns the follow-up loop. Returns immediately; runs for the process
/// lifetime. Its first pass resumes the runs a restart left mid-follow-up.
pub fn spawn(deployment: DeploymentImpl) {
    tokio::spawn(async move {
        let pool = deployment.db().pool.clone();
        let steps = Arc::new(Live(deployment));
        loop {
            if let Err(e) = start_pending(&pool, &steps).await {
                tracing::warn!("vibe PR follow-up: listing runs failed: {}", e);
            }
            tokio::select! {
                _ = PR_FOLLOW_UP.notified() => {}
                _ = tokio::time::sleep(POLL_INTERVAL) => {}
            }
        }
    });
}

/// Start, in the background, every run that owes its follow-up and has no
/// worker yet.
async fn start_pending<S: FollowUpSteps>(
    pool: &SqlitePool,
    steps: &Arc<S>,
) -> Result<Vec<JoinHandle<()>>, VibeRunError> {
    let mut started = Vec::new();
    for run in VibeRun::find_in_follow_up(pool).await? {
        let Some(claim) = Claim::take(run.workspace_id) else {
            continue;
        };
        let (pool, steps) = (pool.clone(), steps.clone());
        started.push(tokio::spawn(async move {
            let _claim = claim;
            if let Err(e) = advance(&pool, &*steps, run.workspace_id).await {
                tracing::error!(
                    "vibe PR follow-up for workspace {} failed: {}",
                    run.workspace_id,
                    e
                );
            }
        }));
    }
    Ok(started)
}

/// Take a run from wherever its follow-up stands to `done`, or to `blocked` at
/// the first step that fails. Every transition is conditional on the phase it
/// started from: a review begun meanwhile owns the run and is left alone.
async fn advance<S: FollowUpSteps>(
    pool: &SqlitePool,
    steps: &S,
    workspace_id: Uuid,
) -> anyhow::Result<()> {
    loop {
        let Some(run) = VibeRun::find_by_workspace_id(pool, workspace_id).await? else {
            return Ok(());
        };
        let Some(phase) = VibePhase::from_db_str(&run.phase) else {
            return Ok(());
        };
        let Some(workspace) = Workspace::find_by_id(pool, workspace_id).await? else {
            return Ok(());
        };
        let from = phase.as_str();
        let failure = match phase {
            VibePhase::Pushing => match steps.push_targets(&workspace).await {
                Ok(()) => {
                    let next = VibePhase::CreatingPr.as_str();
                    if !VibeRun::advance_follow_up(pool, workspace_id, from, next).await? {
                        return Ok(());
                    }
                    tracing::info!("vibe: workspace {} pushed → creating PR", workspace_id);
                    continue;
                }
                Err(reason) => reason,
            },
            VibePhase::CreatingPr => match steps.create_prs(&workspace, &run).await {
                Ok(pr_urls) => {
                    let next = VibePhase::Done.as_str();
                    if VibeRun::advance_follow_up(pool, workspace_id, from, next).await? {
                        tracing::info!(
                            "vibe: workspace {} follow-up done ({} PR(s) opened)",
                            workspace_id,
                            pr_urls.len()
                        );
                        steps.finished(&workspace, &run, &pr_urls).await;
                    }
                    return Ok(());
                }
                Err(reason) => reason,
            },
            _ => return Ok(()),
        };
        let failure = cap(&failure);
        if VibeRun::block_follow_up(pool, workspace_id, from, &failure).await? {
            tracing::warn!(
                "vibe: workspace {} blocked in {}: {}",
                workspace_id,
                from,
                failure
            );
            steps.blocked(&workspace, &run, &failure).await;
        }
        return Ok(());
    }
}

/// Keep `last_error`, the notification and the journal event small.
fn cap(reason: &str) -> String {
    const MAX_CHARS: usize = 2000;
    if reason.chars().count() <= MAX_CHARS {
        reason.to_string()
    } else {
        format!("{}…", reason.chars().take(MAX_CHARS).collect::<String>())
    }
}

/// The PR a repo gets once the merge has landed.
#[derive(Debug, PartialEq, Eq)]
struct PrPlan {
    head: String,
    base: String,
    /// The merge skipped this repo, so its PR would come from the work branch.
    head_is_work_branch: bool,
}

/// Head and base as the "Create PR from AI" command picked them: from the
/// branch the work was merged into (its latest direct merge) to the repo's
/// default target branch, falling back to the workspace's target. A repo the
/// merge skipped — it already has an open PR — has no direct merge: its PR
/// would go from the work branch to the workspace's target.
fn pr_plan(
    merges: &[Merge],
    work_branch: &str,
    target_branch: &str,
    default_target_branch: Option<&str>,
) -> PrPlan {
    let merged_into = merges.iter().find_map(|merge| match merge {
        Merge::Direct(direct) => Some(direct.target_branch_name.as_str()),
        Merge::Pr(_) => None,
    });
    match merged_into {
        Some(feature) => PrPlan {
            head: feature.to_string(),
            base: default_target_branch
                .map(str::trim)
                .filter(|branch| !branch.is_empty())
                .unwrap_or(target_branch)
                .to_string(),
            head_is_work_branch: false,
        },
        None => PrPlan {
            head: work_branch.to_string(),
            base: target_branch.to_string(),
            head_is_work_branch: true,
        },
    }
}

/// The workspace's open PR whose head is `head`, if any: a second one for the
/// same head would be a duplicate. A PR recorded before heads were tracked
/// came from the work branch.
fn open_pr_for_head<'a>(merges: &'a [Merge], head: &str, work_branch: &str) -> Option<&'a PrMerge> {
    merges.iter().find_map(|merge| match merge {
        Merge::Pr(pr)
            if pr.pr_info.status == MergeStatus::Open
                && pr.head_branch_name.as_deref().unwrap_or(work_branch) == head =>
        {
            Some(pr)
        }
        _ => None,
    })
}

/// Run a route handler to its end on a blocking thread — the git and `gh`
/// calls inside block — and stop waiting after `limit`.
async fn bounded<F>(limit: Duration, what: &str, handler: F) -> Result<F::Output, String>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    let runtime = tokio::runtime::Handle::current();
    let task = tokio::task::spawn_blocking(move || runtime.block_on(handler));
    match tokio::time::timeout(limit, task).await {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(e)) => Err(format!("{what} stopped unexpectedly: {e}")),
        Err(_) => Err(format!(
            "{what} did not finish within {} minutes",
            limit.as_secs() / 60
        )),
    }
}

/// What a `/git` or `/pull-requests` handler answered, for a caller with no
/// client behind it: publish the `git.operation_*` journal event the route's
/// middleware would have, and turn a failure into the reason the run stops
/// with.
async fn settle<T: Serialize, E: Serialize>(
    pool: &SqlitePool,
    workspace: &Workspace,
    op_id: &str,
    input: &Value,
    answer: Result<ResponseJson<ApiResponse<T, E>>, ApiError>,
) -> Result<Option<T>, String> {
    let op = git_ops::op_by_id(op_id).expect("a known git operation");
    // The envelope hides internal errors behind a generic message; the run's
    // reason keeps what actually went wrong.
    let (status, envelope, data, detail) = match answer {
        Ok(ResponseJson(body)) => {
            let envelope = serde_json::to_value(&body).unwrap_or(Value::Null);
            (200, envelope, body.into_data(), None)
        }
        Err(error) => {
            let detail = error.to_string();
            let response = error.into_response();
            let status = response.status().as_u16();
            let bytes = to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap_or_default();
            let envelope = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            (status, envelope, None, Some(detail))
        }
    };
    git_events::record(
        Some(pool),
        workspace.id,
        &workspace.branch,
        op,
        status,
        input,
        &envelope,
        false,
    )
    .await;
    let workspace_id = workspace.id.to_string();
    let target = Target {
        workspace: &workspace_id,
        repo: None,
        retry_args: "",
    };
    match git_ops::classify(op, status, &envelope, &target) {
        None => Ok(data),
        Some(failure) => {
            let stated = envelope.get("message").and_then(Value::as_str).is_some();
            Err(failure_reason(&failure, stated, detail))
        }
    }
}

/// A failure in words. A typed error (`diverged`, `cli_not_logged_in`, ...)
/// answers with no message (`stated` is false), so its category is spelled
/// out; otherwise `detail` (the error itself) or the answer's message says it.
fn failure_reason(failure: &GitFailure, stated: bool, detail: Option<String>) -> String {
    match failure.category.as_str() {
        "diverged" => format!(
            "the branch diverged from its remote ({} remote-only commit(s), {} local-only). \
             Pull or reconcile it, then retry.",
            failure.behind.unwrap_or(0),
            failure.ahead.unwrap_or(0)
        ),
        "force_push_required" => {
            "the remote rejected the push; it would take a force push".to_string()
        }
        "auth" if !stated => "not logged in to the git host. Check `gh auth status` and your \
                              git credentials, then retry."
            .to_string(),
        "cli_missing" if !stated => "the git host's CLI is not installed".to_string(),
        _ => detail.unwrap_or_else(|| failure.message.clone()),
    }
}

fn db_error(error: impl std::fmt::Display) -> String {
    format!("database error: {error}")
}

/// The steps against the real deployment: the same handlers the UI's push and
/// "Create PR from AI" call, so their rules (which checkout a push runs from,
/// the pre-checks of a PR) hold here too.
struct Live(DeploymentImpl);

impl Live {
    async fn notify(&self, workspace: &Workspace, run: &VibeRun, title: &str, detail: &str) {
        let name = workspace.name.as_deref().unwrap_or(&workspace.branch);
        // Git output is multi-line and long; flatten and cap it for a push body.
        let mut detail = detail.split_whitespace().collect::<Vec<_>>().join(" ");
        if detail.chars().count() > 300 {
            detail = format!("{}…", detail.chars().take(300).collect::<String>());
        }
        self.0
            .container()
            .notification_service()
            .notify_raw(
                title,
                &format!("'{name}': {detail}"),
                workspace.id,
                format!(
                    "pr-follow-up:{}:{}:{}",
                    workspace.id,
                    run.phase,
                    run.updated_at.timestamp_micros()
                ),
                true,
            )
            .await;
    }
}

impl FollowUpSteps for Live {
    async fn push_targets(&self, workspace: &Workspace) -> Result<(), String> {
        let deployment = &self.0;
        let pool = &deployment.db().pool;
        let workspace_repos = WorkspaceRepo::find_by_workspace_id(pool, workspace.id)
            .await
            .map_err(db_error)?;
        for workspace_repo in workspace_repos {
            let Some(repo) = Repo::find_by_id(pool, workspace_repo.repo_id)
                .await
                .map_err(db_error)?
            else {
                continue;
            };
            let target = &workspace_repo.target_branch;
            // A remote-only target (`origin/main`) has nothing local to push.
            if deployment
                .git()
                .is_remote_branch(&repo.path, target)
                .map_err(|e| format!("{}: {e}", repo.name))?
            {
                continue;
            }
            let answer = bounded(
                GIT_STEP_TIMEOUT,
                "the push",
                git::push_target_branch(
                    Extension(workspace.clone()),
                    State(deployment.clone()),
                    HeaderMap::new(),
                    Json(PushTargetBranchRequest {
                        repo_id: repo.id,
                        force: false,
                    }),
                ),
            )
            .await
            .map_err(|e| format!("{}: pushing target branch '{target}': {e}", repo.name))?;
            settle(
                pool,
                workspace,
                "target_push",
                &json!({ "repo_id": repo.id }),
                answer,
            )
            .await
            .map_err(|e| {
                format!(
                    "{}: pushing target branch '{target}' failed: {e}",
                    repo.name
                )
            })?;
        }
        Ok(())
    }

    async fn create_prs(
        &self,
        workspace: &Workspace,
        run: &VibeRun,
    ) -> Result<Vec<String>, String> {
        let deployment = &self.0;
        let pool = &deployment.db().pool;
        let workspace_repos = WorkspaceRepo::find_by_workspace_id(pool, workspace.id)
            .await
            .map_err(db_error)?;
        let mut created = Vec::new();
        for workspace_repo in workspace_repos {
            let Some(repo) = Repo::find_by_id(pool, workspace_repo.repo_id)
                .await
                .map_err(db_error)?
            else {
                continue;
            };
            let merges = Merge::find_by_workspace_and_repo_id(pool, workspace.id, repo.id)
                .await
                .map_err(db_error)?;
            let plan = pr_plan(
                &merges,
                &workspace.branch,
                &workspace_repo.target_branch,
                repo.default_target_branch.as_deref(),
            );
            // The host rejects head == base; say what to change before an
            // agent run is spent on the draft.
            if plan.head == plan.base {
                return Err(format!(
                    "{}: the pull request's base would be its own head branch '{}'. Set the \
                     repository's default target branch, then retry.",
                    repo.name, plan.head
                ));
            }
            if let Some(open) = open_pr_for_head(&merges, &plan.head, &workspace.branch) {
                tracing::info!(
                    "vibe: workspace {} already has PR #{} open for '{}' in {}; not opening another",
                    workspace.id,
                    open.pr_info.number,
                    plan.head,
                    repo.name
                );
                continue;
            }
            if plan.head_is_work_branch
                && matches!(
                    deployment.git().get_branch_status(
                        &repo.path,
                        &workspace.branch,
                        &workspace_repo.target_branch
                    ),
                    Ok((0, _))
                )
            {
                return Err(format!(
                    "{}: there are no commits to open a pull request for",
                    repo.name
                ));
            }

            let head_branch = (!plan.head_is_work_branch).then(|| plan.head.clone());
            let generated = pr::generate_pr_description_when_free(
                deployment,
                workspace,
                GeneratePrDescriptionRequest {
                    repo_id: repo.id,
                    target_branch: Some(plan.base.clone()),
                    head_branch: head_branch.clone(),
                    executor_config: run.pr_executor_config.as_ref().map(|c| c.0.clone()),
                },
                // The run entered this step at `updated_at`.
                run.updated_at,
            )
            .await
            .map_err(|e| format!("{}: drafting the pull request failed: {e}", repo.name))?;

            let title = generated.title.trim();
            let request = CreatePrApiRequest {
                title: if title.is_empty() {
                    FALLBACK_TITLE.to_string()
                } else {
                    title.to_string()
                },
                body: Some(generated.description).filter(|body| !body.is_empty()),
                target_branch: Some(plan.base.clone()),
                head_branch,
                draft: Some(true),
                repo_id: repo.id,
            };
            let input = serde_json::to_value(&request).unwrap_or(Value::Null);
            let what = format!(
                "{}: creating the pull request ({} → {})",
                repo.name, plan.head, plan.base
            );
            let answer = bounded(
                GIT_STEP_TIMEOUT,
                "the request",
                pr::create_pr(
                    Extension(workspace.clone()),
                    State(deployment.clone()),
                    Json(request),
                ),
            )
            .await
            .map_err(|e| format!("{what}: {e}"))?;
            let url = settle(pool, workspace, "create_pr", &input, answer)
                .await
                .map_err(|e| format!("{what} failed: {e}"))?;
            created.extend(url);
        }
        Ok(created)
    }

    async fn blocked(&self, workspace: &Workspace, run: &VibeRun, reason: &str) {
        let title = if run.phase == VibePhase::Pushing.as_str() {
            "Target push failed"
        } else {
            "PR creation failed"
        };
        self.notify(workspace, run, title, reason).await;
    }

    async fn finished(&self, workspace: &Workspace, run: &VibeRun, pr_urls: &[String]) {
        // Nothing new to announce when every head already had its PR open.
        if !pr_urls.is_empty() {
            self.notify(workspace, run, "Draft PR created", &pr_urls.join(" "))
                .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use chrono::Utc;
    use db::models::merge::{DirectMerge, PullRequestInfo};
    use sqlx::sqlite::SqlitePoolOptions;

    use super::*;

    const PR_URL: &str = "https://github.com/acme/widgets/pull/7";
    /// What `finished` logs once the scripted PR is open.
    const FINISHED: &str = "finished: https://github.com/acme/widgets/pull/7";

    /// Steps that answer from a script (success once it runs out) and log what
    /// the follow-up asked of them.
    #[derive(Default)]
    struct Scripted {
        log: Mutex<Vec<String>>,
        pushes: Mutex<VecDeque<Result<(), String>>>,
        prs: Mutex<VecDeque<Result<Vec<String>, String>>>,
        /// A review to begin (pool, workspace, session) while the push runs.
        review_during_push: Option<(SqlitePool, Uuid, Uuid)>,
    }

    impl Scripted {
        fn note(&self, entry: impl Into<String>) {
            self.log.lock().unwrap().push(entry.into());
        }

        fn take_log(&self) -> Vec<String> {
            std::mem::take(&mut *self.log.lock().unwrap())
        }
    }

    impl FollowUpSteps for Scripted {
        async fn push_targets(&self, _: &Workspace) -> Result<(), String> {
            self.note("push");
            if let Some((pool, workspace, session)) = &self.review_during_push {
                VibeRun::begin_review(pool, *workspace, *session, None)
                    .await
                    .unwrap();
            }
            let scripted = self.pushes.lock().unwrap().pop_front();
            scripted.unwrap_or(Ok(()))
        }

        async fn create_prs(&self, _: &Workspace, _: &VibeRun) -> Result<Vec<String>, String> {
            self.note("pr");
            let scripted = self.prs.lock().unwrap().pop_front();
            scripted.unwrap_or_else(|| Ok(vec![PR_URL.to_string()]))
        }

        async fn blocked(&self, _: &Workspace, run: &VibeRun, reason: &str) {
            self.note(format!("blocked in {}: {reason}", run.phase));
        }

        async fn finished(&self, _: &Workspace, _: &VibeRun, pr_urls: &[String]) {
            self.note(format!("finished: {}", pr_urls.join(",")));
        }
    }

    async fn pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
        pool
    }

    /// A workspace whose "review and create PR" run stands in `phase` after two
    /// review turns. Returns the workspace and its review session.
    async fn seed(pool: &SqlitePool, phase: &str) -> (Uuid, Uuid) {
        let workspace = Uuid::new_v4();
        let review_session = Uuid::new_v4();
        sqlx::query("INSERT INTO workspaces (id, branch) VALUES (?, ?)")
            .bind(workspace)
            .bind(format!("vk/{workspace}"))
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sessions (id, workspace_id) VALUES (?, ?)")
            .bind(review_session)
            .bind(workspace)
            .execute(pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO vibe_runs \
             (workspace_id, task_id, phase, review_session_id, review_turns, pr_requested) \
             VALUES (?, ?, ?, ?, 2, 1)",
        )
        .bind(workspace)
        .bind(Uuid::new_v4())
        .bind(phase)
        .bind(review_session)
        .execute(pool)
        .await
        .unwrap();
        (workspace, review_session)
    }

    async fn run(pool: &SqlitePool, workspace: Uuid) -> VibeRun {
        VibeRun::find_by_workspace_id(pool, workspace)
            .await
            .unwrap()
            .unwrap()
    }

    /// One pass of the follow-up loop, waited out.
    async fn pass(pool: &SqlitePool, steps: &Arc<Scripted>) {
        for worker in start_pending(pool, steps).await.unwrap() {
            worker.await.unwrap();
        }
    }

    /// The reported stall: the review approved and merged, then nothing pushed
    /// the target or opened the PR until the workspace's page was opened again,
    /// because a browser tab drove those steps. The server now takes the merged
    /// run to its PR by itself — no request from any client is involved here.
    #[tokio::test]
    async fn a_merged_run_is_pushed_and_gets_its_pr_without_any_client() {
        let pool = pool().await;
        let steps = Arc::new(Scripted::default());
        let (workspace, review_session) = seed(&pool, "pushing").await;

        pass(&pool, &steps).await;

        let done = run(&pool, workspace).await;
        assert_eq!(done.phase, "done");
        assert!(done.last_error.is_none() && done.failed_phase.is_none());
        assert_eq!(steps.take_log(), ["push", "pr", FINISHED]);
        // The review that approved it is still the run's review.
        assert_eq!(
            (done.review_session_id, done.review_turns),
            (Some(review_session), 2)
        );
        // Done is done: a later pass finds nothing to do.
        pass(&pool, &steps).await;
        assert!(steps.take_log().is_empty());
    }

    /// A diverged target cannot be decided by the server: the run blocks with
    /// the reason, and the retry starts at the push — no review, no merge.
    #[tokio::test]
    async fn a_failed_push_blocks_with_its_reason_and_a_retry_resumes_at_the_push() {
        let pool = pool().await;
        let reason = "widgets: pushing target branch 'feature' failed: the branch diverged \
                      from its remote (2 remote-only commit(s), 1 local-only). Pull or \
                      reconcile it, then retry.";
        let steps = Arc::new(Scripted::default());
        steps.pushes.lock().unwrap().push_back(Err(reason.into()));
        let (workspace, review_session) = seed(&pool, "pushing").await;

        pass(&pool, &steps).await;

        let blocked = run(&pool, workspace).await;
        assert_eq!(blocked.phase, "blocked");
        assert_eq!(blocked.last_error.as_deref(), Some(reason));
        assert_eq!(blocked.failed_phase.as_deref(), Some("pushing"));
        // No PR for a target that was not pushed, and the user was told why.
        let told = format!("blocked in pushing: {reason}");
        assert_eq!(steps.take_log(), ["push", told.as_str()]);
        // Blocked stays blocked until someone retries.
        pass(&pool, &steps).await;
        assert!(steps.take_log().is_empty());

        assert!(VibeRun::retry_follow_up(&pool, workspace).await.unwrap());
        let retried = run(&pool, workspace).await;
        assert_eq!(retried.phase, "pushing");
        assert!(retried.last_error.is_none() && retried.failed_phase.is_none());
        pass(&pool, &steps).await;

        let done = run(&pool, workspace).await;
        assert_eq!(done.phase, "done");
        assert_eq!(steps.take_log(), ["push", "pr", FINISHED]);
        assert_eq!(
            (done.review_session_id, done.review_turns),
            (Some(review_session), 2)
        );
        // Nothing is left to retry.
        assert!(!VibeRun::retry_follow_up(&pool, workspace).await.unwrap());
    }

    /// The push went through and the PR did not: the retry opens the PR and
    /// does not push the target a second time.
    #[tokio::test]
    async fn a_failed_pr_blocks_and_its_retry_does_not_push_again() {
        let pool = pool().await;
        let reason = "widgets: creating the pull request (feature → main) failed: not logged \
                      in to the git host. Check `gh auth status` and your git credentials, \
                      then retry.";
        let steps = Arc::new(Scripted::default());
        steps.prs.lock().unwrap().push_back(Err(reason.into()));
        let (workspace, _) = seed(&pool, "pushing").await;

        pass(&pool, &steps).await;

        let blocked = run(&pool, workspace).await;
        assert_eq!(blocked.phase, "blocked");
        assert_eq!(blocked.last_error.as_deref(), Some(reason));
        assert_eq!(blocked.failed_phase.as_deref(), Some("creating_pr"));
        let told = format!("blocked in creating_pr: {reason}");
        assert_eq!(steps.take_log(), ["push", "pr", told.as_str()]);

        assert!(VibeRun::retry_follow_up(&pool, workspace).await.unwrap());
        assert_eq!(run(&pool, workspace).await.phase, "creating_pr");
        pass(&pool, &steps).await;

        assert_eq!(run(&pool, workspace).await.phase, "done");
        assert_eq!(steps.take_log(), ["pr", FINISHED]);
    }

    /// The server stopped mid-follow-up. The phase is in the database, so the
    /// first pass after the restart resumes each run at its own step.
    #[tokio::test]
    async fn runs_a_restart_interrupted_resume_at_their_step() {
        let pool = pool().await;
        let steps = Arc::new(Scripted::default());
        let (pushing, _) = seed(&pool, "pushing").await;
        let (creating_pr, _) = seed(&pool, "creating_pr").await;
        // Not the follow-up's: still under review, blocked by its review, done.
        let (reviewing, _) = seed(&pool, "review").await;
        let (blocked, _) = seed(&pool, "blocked").await;
        let (finished, _) = seed(&pool, "done").await;

        pass(&pool, &steps).await;

        assert_eq!(run(&pool, pushing).await.phase, "done");
        assert_eq!(run(&pool, creating_pr).await.phase, "done");
        assert_eq!(run(&pool, reviewing).await.phase, "review");
        assert_eq!(run(&pool, blocked).await.phase, "blocked");
        assert_eq!(run(&pool, finished).await.phase, "done");
        // Only the run that had not pushed yet pushed.
        let mut log = steps.take_log();
        log.sort();
        assert_eq!(log, [FINISHED, FINISHED, "pr", "pr", "push"]);
    }

    /// A step can take minutes, and the loop wakes every minute: it must not
    /// start the same run twice.
    #[tokio::test]
    async fn a_run_has_one_worker_at_a_time() {
        let pool = pool().await;
        let steps = Arc::new(Scripted::default());
        let (workspace, _) = seed(&pool, "pushing").await;

        let at_work = Claim::take(workspace).unwrap();
        assert!(in_flight(workspace));
        assert!(start_pending(&pool, &steps).await.unwrap().is_empty());
        assert_eq!(run(&pool, workspace).await.phase, "pushing");

        drop(at_work);
        assert!(!in_flight(workspace));
        pass(&pool, &steps).await;
        assert_eq!(run(&pool, workspace).await.phase, "done");
        assert!(!in_flight(workspace));
    }

    /// A review started while a step was running owns the run from then on:
    /// the step's result must not push it past that review.
    #[tokio::test]
    async fn a_review_begun_during_a_step_keeps_the_run() {
        let pool = pool().await;
        let (workspace, review_session) = seed(&pool, "pushing").await;
        let steps = Arc::new(Scripted {
            review_during_push: Some((pool.clone(), workspace, review_session)),
            ..Default::default()
        });

        pass(&pool, &steps).await;

        let reviewing = run(&pool, workspace).await;
        assert_eq!(reviewing.phase, "review");
        // The new review did not ask for a PR, and none was opened.
        assert!(!reviewing.pr_requested);
        assert_eq!(steps.take_log(), ["push"]);
    }

    fn direct(target: &str) -> Merge {
        Merge::Direct(DirectMerge {
            id: Uuid::new_v4(),
            workspace_id: Uuid::nil(),
            repo_id: Uuid::nil(),
            merge_commit: "abc123".to_string(),
            target_branch_name: target.to_string(),
            created_at: Utc::now(),
        })
    }

    fn pr(head: Option<&str>, status: MergeStatus) -> Merge {
        Merge::Pr(PrMerge {
            id: Uuid::new_v4(),
            workspace_id: Uuid::nil(),
            repo_id: Uuid::nil(),
            created_at: Utc::now(),
            target_branch_name: "main".to_string(),
            head_branch_name: head.map(str::to_string),
            head_commits_ahead: None,
            head_commits_behind: None,
            pr_info: PullRequestInfo {
                number: 7,
                url: PR_URL.to_string(),
                status,
                merged_at: None,
                merge_commit_sha: None,
            },
        })
    }

    #[test]
    fn the_pr_goes_from_the_branch_merged_into_to_the_default_target() {
        let plan = |merges: &[Merge], default_target| {
            pr_plan(merges, "vk/work", "feature", default_target)
        };
        assert_eq!(
            plan(&[direct("feature")], Some("main")),
            PrPlan {
                head: "feature".into(),
                base: "main".into(),
                head_is_work_branch: false
            }
        );
        // The newest direct merge (they come newest first) names the head.
        assert_eq!(
            plan(&[direct("feature-2"), direct("feature")], Some("main")).head,
            "feature-2"
        );
        // No default target: the base falls back to the workspace's target,
        // which is the head itself — the caller stops on that.
        for unset in [None, Some(""), Some("  ")] {
            let fallback = plan(&[direct("feature")], unset);
            assert_eq!(fallback.base, fallback.head);
        }
        // The merge skipped the repo (it has an open PR): the work branch.
        assert_eq!(
            plan(&[pr(Some("feature"), MergeStatus::Open)], Some("main")),
            PrPlan {
                head: "vk/work".into(),
                base: "feature".into(),
                head_is_work_branch: true
            }
        );
    }

    #[test]
    fn an_open_pr_for_the_same_head_is_not_duplicated() {
        let open = [pr(Some("feature"), MergeStatus::Open)];
        assert!(open_pr_for_head(&open, "feature", "vk/work").is_some());
        // Another head's PR does not stand in for this one.
        assert!(open_pr_for_head(&open, "vk/work", "vk/work").is_none());
        // A PR recorded before heads were tracked came from the work branch.
        let legacy = [pr(None, MergeStatus::Open)];
        assert!(open_pr_for_head(&legacy, "vk/work", "vk/work").is_some());
        assert!(open_pr_for_head(&legacy, "feature", "vk/work").is_none());
        // A closed or merged PR is over; a new one may be opened.
        for status in [MergeStatus::Merged, MergeStatus::Closed] {
            let over = [pr(Some("feature"), status), direct("feature")];
            assert!(open_pr_for_head(&over, "feature", "vk/work").is_none());
        }
    }

    #[test]
    fn a_failure_is_put_in_words_a_person_can_act_on() {
        let failure = |category: &str, message: &str| GitFailure {
            op: "target_push".to_string(),
            category: category.to_string(),
            message: message.to_string(),
            ahead: Some(1),
            behind: Some(2),
            conflicted_files: Vec::new(),
            choices: Vec::new(),
        };
        let diverged = failure_reason(&failure("diverged", "diverged"), false, None);
        assert!(
            diverged.contains("2 remote-only commit(s), 1 local-only"),
            "{diverged}"
        );
        // A typed error has no message, only its kind.
        let auth = failure_reason(&failure("auth", "cli not logged in"), false, None);
        assert!(auth.contains("gh auth status"), "{auth}");
        // A stated message is the reason, and the error itself beats the
        // generic text an internal error is answered with.
        assert_eq!(
            failure_reason(&failure("auth", "Authentication failed."), true, None),
            "Authentication failed."
        );
        assert_eq!(
            failure_reason(
                &failure("other", "An internal error occurred. Please try again."),
                true,
                Some("gh: could not resolve host".to_string())
            ),
            "gh: could not resolve host"
        );
        assert_eq!(cap(&"x".repeat(2500)).chars().count(), 2001);
    }
}
