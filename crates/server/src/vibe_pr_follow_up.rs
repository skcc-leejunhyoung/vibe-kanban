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
    agent_journal,
    container::ContainerService,
    vibe_orchestrator::{PR_FOLLOW_UP, VibePhase},
    vibe_pr_bases,
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
        git, git_events,
        pr::{self, CreatePrApiRequest, GeneratePrDescriptionRequest},
    },
};

/// How often runs owing their follow-up are looked for when nothing rang
/// [`PR_FOLLOW_UP`] (a run from before a restart, a start that failed).
const POLL_INTERVAL: Duration = Duration::from_secs(60);
/// Warn about slow git/PR calls without releasing their workspace claim.
const GIT_STEP_WARN_AFTER: Duration = Duration::from_secs(10 * 60);
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
        run: &VibeRun,
    ) -> impl Future<Output = Result<(), String>> + Send;

    /// Open an AI-drafted draft PR for every repo whose head has none open yet;
    /// what became of each repo's PR.
    fn create_prs(
        &self,
        workspace: &Workspace,
        run: &VibeRun,
    ) -> impl Future<Output = Result<Vec<PrOutcome>, String>> + Send;

    /// The step `run.phase` failed and blocked the run.
    fn blocked(
        &self,
        workspace: &Workspace,
        run: &VibeRun,
        reason: &str,
    ) -> impl Future<Output = ()> + Send;

    /// The follow-up is done, with these outcomes.
    fn finished(
        &self,
        workspace: &Workspace,
        run: &VibeRun,
        prs: &[PrOutcome],
    ) -> impl Future<Output = ()> + Send;
}

/// What became of one repo's PR in a finished follow-up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PrOutcome {
    /// A draft PR was opened at this URL.
    Opened(String),
    /// The head already had this PR open, so none was opened.
    AlreadyOpen(i64),
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
        // The journal publishes a phase only when it differs from the last one
        // it saw, and after a restart it has seen none: tell it where the run
        // stands, so the step's outcome (done, or blocked) is an event too.
        agent_journal::observe_vibe_run(&run, false);
        let from = phase.as_str();
        let failure = match phase {
            VibePhase::Pushing => match steps.push_targets(&workspace, &run).await {
                Ok(()) => {
                    let next = VibePhase::CreatingPr.as_str();
                    if !VibeRun::advance_follow_up(pool, workspace_id, from, run.generation, next)
                        .await?
                    {
                        return Ok(());
                    }
                    tracing::info!("vibe: workspace {} pushed → creating PR", workspace_id);
                    continue;
                }
                Err(reason) => reason,
            },
            VibePhase::CreatingPr => match steps.create_prs(&workspace, &run).await {
                Ok(prs) => {
                    let next = VibePhase::Done.as_str();
                    if VibeRun::advance_follow_up(pool, workspace_id, from, run.generation, next)
                        .await?
                    {
                        tracing::info!(
                            "vibe: workspace {} follow-up done: {:?}",
                            workspace_id,
                            prs
                        );
                        steps.finished(&workspace, &run, &prs).await;
                    }
                    return Ok(());
                }
                Err(reason) => reason,
            },
            _ => return Ok(()),
        };
        let failure = cap(&failure);
        if VibeRun::block_follow_up(pool, workspace_id, from, run.generation, &failure).await? {
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

/// The actual merge determines the head; only the run's confirmed base is used.
fn pr_plan(merges: &[Merge], work_branch: &str, confirmed_base: &str) -> PrPlan {
    let merged_into = merges.iter().find_map(|merge| match merge {
        Merge::Direct(direct) => Some(direct.target_branch_name.as_str()),
        Merge::Pr(_) => None,
    });
    PrPlan {
        head: merged_into.unwrap_or(work_branch).to_string(),
        base: confirmed_base.to_string(),
        head_is_work_branch: merged_into.is_none(),
    }
}

/// What to do about one repo's PR once its target is pushed.
#[derive(Debug, PartialEq, Eq)]
enum PrDecision {
    /// Draft it and open it.
    Open(PrPlan),
    /// The head already has this PR open; another would be a duplicate.
    AlreadyOpen(i64),
    /// It cannot be opened as things stand; the reason blocks the run.
    Refuse(String),
}

/// The checks "Create PR from AI" makes, in its order, before an agent run is
/// spent on the draft: a base that is the head itself, a PR already open for
/// the head, and a work-branch head with nothing on it (`work_commits_ahead`
/// counts its commits over the target; `None` when that cannot be told).
fn decide_pr(
    repo_name: &str,
    merges: &[Merge],
    work_branch: &str,
    confirmed_base: &str,
    work_commits_ahead: impl FnOnce() -> Option<usize>,
) -> PrDecision {
    let plan = pr_plan(merges, work_branch, confirmed_base);
    if plan.head == plan.base {
        return PrDecision::Refuse(format!(
            "{repo_name}: the pull request's base would be its own head branch '{}'. Select a \
             different PR base for this run, then retry.",
            plan.head
        ));
    }
    if let Some(open) = open_pr_for_head(merges, &plan.head, work_branch) {
        return PrDecision::AlreadyOpen(open.pr_info.number);
    }
    if plan.head_is_work_branch && work_commits_ahead() == Some(0) {
        return PrDecision::Refuse(format!(
            "{repo_name}: there are no commits to open a pull request for"
        ));
    }
    PrDecision::Open(plan)
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
/// calls inside block. A slow call retains its claim until its real outcome.
async fn run_git_step<F>(warn_after: Duration, what: &str, handler: F) -> Result<F::Output, String>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    let runtime = tokio::runtime::Handle::current();
    let mut task = tokio::task::spawn_blocking(move || runtime.block_on(handler));
    let result = match tokio::time::timeout(warn_after, &mut task).await {
        Ok(result) => result,
        Err(_) => {
            // Blocking git/gh calls cannot be cancelled by dropping their handle.
            tracing::warn!(
                what,
                "git step is still running; keeping its workspace claim"
            );
            task.await
        }
    };
    result.map_err(|e| format!("{what} stopped unexpectedly: {e}"))
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

/// What to tell the user when the follow-up is done: the PRs it opened, or —
/// when it opened none — that the PR was already open, as "Create PR from AI"
/// says in that case. Nothing when there was no PR to speak of.
fn finished_notice(prs: &[PrOutcome]) -> Option<(&'static str, String)> {
    let opened: Vec<&str> = prs
        .iter()
        .filter_map(|pr| match pr {
            PrOutcome::Opened(url) => Some(url.as_str()),
            PrOutcome::AlreadyOpen(_) => None,
        })
        .collect();
    if !opened.is_empty() {
        return Some(("Draft PR created", opened.join(" ")));
    }
    let kept: Vec<String> = prs
        .iter()
        .filter_map(|pr| match pr {
            PrOutcome::AlreadyOpen(number) => Some(format!("#{number}")),
            PrOutcome::Opened(_) => None,
        })
        .collect();
    (!kept.is_empty()).then(|| {
        (
            "Pull request already open",
            format!(
                "PR {} is already open for this branch; no new pull request was created",
                kept.join(", ")
            ),
        )
    })
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
                // Not local-only: unlike the merge's notices, nothing in the
                // cloud (an issue comment, a status change) tells the user's
                // other devices about a push or a PR.
                false,
            )
            .await;
    }
}

impl FollowUpSteps for Live {
    async fn push_targets(&self, workspace: &Workspace, run: &VibeRun) -> Result<(), String> {
        let deployment = &self.0;
        let pool = &deployment.db().pool;
        let _generation = VibeRun::lock_generation(workspace.id).await;
        let bases = vibe_pr_bases::validate(pool, deployment.git(), workspace, run, true).await?;
        let repos =
            vibe_pr_bases::confirmed_merge_repos(pool, deployment.git(), workspace, &bases).await?;
        let no_verify = deployment.config().read().await.git_push_no_verify;
        for workspace_repo in repos {
            let repo = workspace_repo.repo;
            let target = workspace_repo.target_branch;
            if deployment
                .git()
                .is_remote_branch(&repo.path, &target)
                .map_err(|e| format!("{}: {e}", repo.name))?
            {
                continue;
            }
            let repo_id = repo.id;
            let name = repo.name.clone();
            let what = format!("{name}: pushing target branch '{target}'");
            let git = deployment.git().clone();
            let answer = run_git_step(GIT_STEP_WARN_AFTER, "the push", async move {
                git::push_target_branch_to(&git, &repo, &target, false, no_verify)
            })
            .await
            .map_err(|e| format!("{what}: {e}"))?;
            settle(
                pool,
                workspace,
                "target_push",
                &json!({ "repo_id": repo_id }),
                answer,
            )
            .await
            .map_err(|e| format!("{what} failed: {e}"))?;
        }
        Ok(())
    }

    async fn create_prs(
        &self,
        workspace: &Workspace,
        run: &VibeRun,
    ) -> Result<Vec<PrOutcome>, String> {
        let deployment = &self.0;
        let pool = &deployment.db().pool;
        let bases = vibe_pr_bases::validate(pool, deployment.git(), workspace, run, true).await?;
        let workspace_repos = WorkspaceRepo::find_by_workspace_id(pool, workspace.id)
            .await
            .map_err(db_error)?;
        let mut outcomes = Vec::new();
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
            let base = bases
                .iter()
                .find(|base| base.repo_id == repo.id)
                .ok_or_else(|| {
                    format!(
                        "{}: PR base is not confirmed; confirm all repositories and retry",
                        repo.name
                    )
                })?;
            let decision = decide_pr(
                &repo.name,
                &merges,
                &workspace.branch,
                &base.base_branch,
                || {
                    deployment
                        .git()
                        .get_branch_status(
                            &repo.path,
                            &workspace.branch,
                            &workspace_repo.target_branch,
                        )
                        .ok()
                        .map(|(ahead, _)| ahead)
                },
            );
            let plan = match decision {
                PrDecision::Open(plan) => plan,
                PrDecision::AlreadyOpen(number) => {
                    tracing::info!(
                        "vibe: workspace {} already has PR #{} open for this head in {}; not opening another",
                        workspace.id,
                        number,
                        repo.name
                    );
                    outcomes.push(PrOutcome::AlreadyOpen(number));
                    continue;
                }
                PrDecision::Refuse(reason) => return Err(reason),
            };

            let head_branch = (!plan.head_is_work_branch).then(|| plan.head.clone());
            let generated = pr::generate_pr_description_when_free(
                deployment,
                workspace,
                GeneratePrDescriptionRequest {
                    repo_id: repo.id,
                    target_branch: Some(plan.base.clone()),
                    head_branch: head_branch.clone(),
                    executor_config: run.pr_draft_config(),
                },
            )
            .await
            .map_err(|e| format!("{}: drafting the pull request failed: {e}", repo.name))?;

            // Drafting can take minutes; a target changed meanwhile needs confirmation.
            let _generation = VibeRun::lock_generation(workspace.id).await;
            vibe_pr_bases::validate(pool, deployment.git(), workspace, run, true).await?;
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
            let answer = run_git_step(
                GIT_STEP_WARN_AFTER,
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
            outcomes.extend(url.map(PrOutcome::Opened));
        }
        Ok(outcomes)
    }

    async fn blocked(&self, workspace: &Workspace, run: &VibeRun, reason: &str) {
        let title = if run.phase == VibePhase::Pushing.as_str() {
            "Target push failed"
        } else {
            "PR creation failed"
        };
        self.notify(workspace, run, title, reason).await;
    }

    async fn finished(&self, workspace: &Workspace, run: &VibeRun, prs: &[PrOutcome]) {
        if let Some((title, detail)) = finished_notice(prs) {
            self.notify(workspace, run, title, &detail).await;
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

    #[tokio::test]
    async fn a_slow_git_step_keeps_its_claim_and_reports_its_real_outcome() {
        for outcome in [Ok("pushed"), Err("remote refused")] {
            let workspace_id = Uuid::new_v4();
            let claim = Claim::take(workspace_id).unwrap();
            let (started, ready) = tokio::sync::oneshot::channel();
            let (release, released) = tokio::sync::oneshot::channel();
            let task = tokio::spawn(async move {
                let _claim = claim;
                run_git_step(Duration::from_millis(1), "test push", async move {
                    started.send(()).unwrap();
                    released.await.unwrap();
                    outcome
                })
                .await
            });
            ready.await.unwrap();
            tokio::time::sleep(Duration::from_millis(20)).await;
            assert!(!task.is_finished());
            assert!(Claim::take(workspace_id).is_none());
            release.send(()).unwrap();
            assert_eq!(task.await.unwrap().unwrap(), outcome);
            assert!(Claim::take(workspace_id).is_some());
        }
    }

    #[tokio::test]
    async fn a_follow_up_push_uses_the_confirmed_target_after_a_concurrent_change() {
        use ::git::{GitCli, GitService};
        use db::models::{
            vibe_run::{PrBaseSelection, PrRequest},
            workspace_repo::CreateWorkspaceRepo,
        };

        fn git(path: &std::path::Path, args: &[&str]) -> String {
            GitCli::new().git(path, args).unwrap()
        }
        let dir = tempfile::tempdir().unwrap();
        let local = dir.path().join("widgets");
        let origin = dir.path().join("origin.git");
        git(dir.path(), &["init", "-b", "integration", "widgets"]);
        git(&local, &["config", "user.name", "Example"]);
        git(&local, &["config", "user.email", "example@example.invalid"]);
        git(
            &local,
            &["commit", "--allow-empty", "-m", "Synthetic initial work"],
        );
        for branch in ["feature/example", "other"] {
            git(&local, &["branch", branch]);
        }
        git(
            dir.path(),
            &[
                "clone",
                "--bare",
                local.to_str().unwrap(),
                origin.to_str().unwrap(),
            ],
        );
        git(
            &local,
            &["remote", "add", "origin", origin.to_str().unwrap()],
        );
        git(&local, &["fetch", "origin"]);
        git(&local, &["checkout", "feature/example"]);
        std::fs::write(local.join("head.txt"), "synthetic reviewed work").unwrap();
        git(&local, &["add", "head.txt"]);
        git(&local, &["commit", "-m", "Synthetic reviewed change"]);
        let service = GitService::new();
        let expected = service.get_branch_oid(&local, "feature/example").unwrap();
        let untouched = service.get_branch_oid(&local, "other").unwrap();
        let pool = pool().await;
        let (workspace_id, review_session) = seed(&pool, "pushing").await;
        let workspace = Workspace::find_by_id(&pool, workspace_id)
            .await
            .unwrap()
            .unwrap();
        git(&local, &["branch", &workspace.branch]);
        let repo = Repo::find_or_create(&pool, &local, "widgets")
            .await
            .unwrap();
        WorkspaceRepo::create_many(
            &pool,
            workspace.id,
            &[CreateWorkspaceRepo {
                repo_id: repo.id,
                target_branch: "feature/example".into(),
            }],
        )
        .await
        .unwrap();
        Merge::create_direct(&pool, workspace.id, repo.id, "feature/example", &expected)
            .await
            .unwrap();
        let bases = vibe_pr_bases::resolve(
            &pool,
            &service,
            &workspace,
            Some(&[PrBaseSelection {
                repo_id: repo.id,
                base_branch: "integration".into(),
            }]),
            None,
            true,
        )
        .await
        .unwrap();
        VibeRun::begin_review(
            &pool,
            workspace.id,
            review_session,
            Some(&PrRequest {
                bases,
                executor_config: None,
            }),
        )
        .await
        .unwrap();
        let run = run(&pool, workspace.id).await;
        VibeRun::finish_merge(&pool, workspace.id, run.generation)
            .await
            .unwrap();
        let bases = vibe_pr_bases::validate(&pool, &service, &workspace, &run, true)
            .await
            .unwrap();
        let repos = vibe_pr_bases::confirmed_merge_repos(&pool, &service, &workspace, &bases)
            .await
            .unwrap();
        WorkspaceRepo::update_target_branch(&pool, workspace.id, repo.id, "other")
            .await
            .unwrap();
        let pushed = git::push_target_branch_to(
            &service,
            &repos[0].repo,
            &repos[0].target_branch,
            false,
            true,
        )
        .unwrap();
        assert_eq!(
            pushed.0.into_data().unwrap().target_branch,
            "feature/example"
        );
        assert_eq!(
            git(&origin, &["rev-parse", "refs/heads/feature/example"]).trim(),
            expected
        );
        assert_eq!(
            git(&origin, &["rev-parse", "refs/heads/other"]).trim(),
            untouched
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let hooks = local.join(".git/hooks");
            std::fs::create_dir_all(&hooks).unwrap();
            git(
                &local,
                &["config", "core.hooksPath", hooks.to_str().unwrap()],
            );
            let hook = hooks.join("pre-push");
            std::fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
            git(
                &local,
                &["update-ref", "-d", "refs/remotes/origin/feature/example"],
            );
            let repeated = git::push_target_branch_to(
                &service,
                &repos[0].repo,
                &repos[0].target_branch,
                false,
                false,
            )
            .unwrap();
            let status = repeated.0.into_data().unwrap();
            assert!(status.remote_branch_exists);
            assert_eq!((status.ahead, status.behind), (0, 0));
        }

        assert!(
            vibe_pr_bases::validate(&pool, &service, &workspace, &run, true)
                .await
                .unwrap_err()
                .contains("Restore the workspace target")
        );
    }

    /// Steps that answer from a script (success once it runs out) and log what
    /// the follow-up asked of them.
    #[derive(Default)]
    struct Scripted {
        log: Mutex<Vec<String>>,
        pushes: Mutex<VecDeque<Result<(), String>>>,
        prs: Mutex<VecDeque<Result<Vec<PrOutcome>, String>>>,
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
        async fn push_targets(&self, _: &Workspace, _: &VibeRun) -> Result<(), String> {
            self.note("push");
            if let Some((pool, workspace, session)) = &self.review_during_push {
                VibeRun::begin_review(pool, *workspace, *session, None)
                    .await
                    .unwrap();
            }
            let scripted = self.pushes.lock().unwrap().pop_front();
            scripted.unwrap_or(Ok(()))
        }

        async fn create_prs(&self, _: &Workspace, _: &VibeRun) -> Result<Vec<PrOutcome>, String> {
            self.note("pr");
            let scripted = self.prs.lock().unwrap().pop_front();
            scripted.unwrap_or_else(|| Ok(vec![PrOutcome::Opened(PR_URL.to_string())]))
        }

        async fn blocked(&self, _: &Workspace, run: &VibeRun, reason: &str) {
            self.note(format!("blocked in {}: {reason}", run.phase));
        }

        async fn finished(&self, _: &Workspace, _: &VibeRun, prs: &[PrOutcome]) {
            let told = finished_notice(prs).map(|(_, detail)| detail);
            self.note(format!("finished: {}", told.unwrap_or_default()));
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

        assert!(
            VibeRun::retry(&pool, &run(&pool, workspace).await, None)
                .await
                .unwrap()
        );
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
        assert!(
            !VibeRun::retry(&pool, &run(&pool, workspace).await, None)
                .await
                .unwrap()
        );
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

        assert!(
            VibeRun::retry(&pool, &run(&pool, workspace).await, None)
                .await
                .unwrap()
        );
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

    /// What the reused handlers answer is all that tells a failed push or PR
    /// from one that went through: a typed error (`diverged`), a plain message
    /// (no remote, the PR host's rejection), an internal error. Each must stop
    /// the step with its reason — read as a success, the run would go on to
    /// open a PR for a target that was never pushed — and be published as the
    /// route's own middleware publishes it.
    #[tokio::test]
    async fn a_handler_answer_that_failed_stops_the_step_with_its_reason() {
        type Answer = Result<ResponseJson<ApiResponse<String, git::PushError>>, ApiError>;
        let pool = pool().await;
        let (workspace_id, _) = seed(&pool, "pushing").await;
        let workspace = Workspace::find_by_id(&pool, workspace_id)
            .await
            .unwrap()
            .unwrap();
        let since = agent_journal::list(0, &[], 1).cursor;
        let input = json!({});

        let diverged: Answer = Ok(ResponseJson(ApiResponse::error_with_data(
            git::PushError::Diverged {
                ahead: 1,
                behind: 2,
            },
        )));
        let reason = settle(&pool, &workspace, "target_push", &input, diverged)
            .await
            .unwrap_err();
        assert!(
            reason.contains("2 remote-only commit(s), 1 local-only"),
            "{reason}"
        );

        let no_remote: Answer = Ok(ResponseJson(ApiResponse::error(
            "No remote configured for this repository",
        )));
        assert_eq!(
            settle(&pool, &workspace, "target_push", &input, no_remote).await,
            Err("No remote configured for this repository".to_string())
        );

        let refused: Answer = Err(ApiError::BadRequest(
            "Commit tracked changes before creating a pull request".to_string(),
        ));
        let reason = settle(&pool, &workspace, "create_pr", &input, refused)
            .await
            .unwrap_err();
        assert!(reason.contains("Commit tracked changes"), "{reason}");

        let pushed: Answer = Ok(ResponseJson(ApiResponse::success("pushed".to_string())));
        assert_eq!(
            settle(&pool, &workspace, "target_push", &input, pushed).await,
            Ok(Some("pushed".to_string()))
        );

        let published: Vec<String> = agent_journal::list(since, &["git.".to_string()], 1000)
            .events
            .into_iter()
            .filter(|event| event.workspace_id == Some(workspace_id))
            .map(|event| event.kind)
            .collect();
        assert_eq!(
            published,
            [
                "git.operation_failed",
                "git.operation_failed",
                "git.operation_failed",
                "git.operation_succeeded"
            ]
        );
    }

    /// After a restart the journal has seen none of the run's phases, and it
    /// publishes a phase only when it differs from the last one it saw. The
    /// follow-up tells it where the run stands before moving it, so the outcome
    /// of a resumed run is an event like any other.
    #[tokio::test]
    async fn the_outcome_of_a_resumed_run_is_published_as_an_event() {
        let pool = pool().await;
        let steps = Arc::new(Scripted::default());
        let (workspace, _) = seed(&pool, "creating_pr").await;
        let since = agent_journal::list(0, &[], 1).cursor;

        pass(&pool, &steps).await;

        // What the database hook does with the row the step wrote.
        agent_journal::observe_vibe_run(&run(&pool, workspace).await, false);
        let phases: Vec<String> = agent_journal::list(since, &["vibe.phase".to_string()], 1000)
            .events
            .into_iter()
            .filter(|event| event.workspace_id == Some(workspace))
            .map(|event| event.data["phase"].as_str().unwrap_or_default().to_string())
            .collect();
        assert_eq!(phases, ["done"]);
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
    fn the_pr_combines_the_actual_merge_head_with_the_confirmed_base() {
        let plan = |merges: &[Merge], base| pr_plan(merges, "vk/work", base);
        assert_eq!(
            plan(&[direct("feature")], "main"),
            PrPlan {
                head: "feature".into(),
                base: "main".into(),
                head_is_work_branch: false
            }
        );
        // The newest direct merge (they come newest first) names the head.
        assert_eq!(
            plan(&[direct("feature-2"), direct("feature")], "main").head,
            "feature-2"
        );
        // The merge skipped the repo (it has an open PR): the work branch.
        assert_eq!(
            plan(&[pr(Some("feature"), MergeStatus::Open)], "main"),
            PrPlan {
                head: "vk/work".into(),
                base: "main".into(),
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
    fn a_pr_already_open_for_the_head_is_not_opened_again() {
        let decide = |merges: &[Merge]| {
            decide_pr("widgets", merges, "vk/work", "main", || {
                panic!("only a work-branch head is counted")
            })
        };
        // The usual run: merged into `feature`, a PR to the default target.
        assert_eq!(
            decide(&[direct("feature")]),
            PrDecision::Open(PrPlan {
                head: "feature".into(),
                base: "main".into(),
                head_is_work_branch: false
            })
        );
        // Reviewed again with that PR still open: no draft is written for a
        // second one.
        assert_eq!(
            decide(&[direct("feature"), pr(Some("feature"), MergeStatus::Open)]),
            PrDecision::AlreadyOpen(7)
        );
        // Once it is merged or closed, a new one may be opened.
        for status in [MergeStatus::Merged, MergeStatus::Closed] {
            assert!(matches!(
                decide(&[direct("feature"), pr(Some("feature"), status)]),
                PrDecision::Open(_)
            ));
        }
    }

    #[test]
    fn a_pr_that_cannot_be_opened_is_refused_with_what_to_change() {
        // Even after preflight, keep the final same-branch defense before drafting.
        let no_base = decide_pr(
            "widgets",
            &[direct("feature"), pr(Some("feature"), MergeStatus::Open)],
            "vk/work",
            "feature",
            || None,
        );
        match no_base {
            PrDecision::Refuse(reason) => {
                assert!(reason.starts_with("widgets: "), "{reason}");
                assert!(reason.contains("different PR base"), "{reason}");
            }
            other => panic!("expected a refusal, got {other:?}"),
        }

        // The merge skipped the repo (its open PR has another head), so the
        // PR would come from the work branch: not when nothing is on it.
        let skipped = [pr(Some("other"), MergeStatus::Open)];
        let from_work_branch =
            |ahead: Option<usize>| decide_pr("widgets", &skipped, "vk/work", "main", || ahead);
        assert!(matches!(
            from_work_branch(Some(0)),
            PrDecision::Refuse(reason) if reason.contains("no commits")
        ));
        for ahead in [Some(2), None] {
            assert_eq!(
                from_work_branch(ahead),
                PrDecision::Open(PrPlan {
                    head: "vk/work".into(),
                    base: "main".into(),
                    head_is_work_branch: true
                })
            );
        }
    }

    // Every finished run says what became of the PR: the browser-driven flow
    // told the user "already open" instead of staying silent.
    #[test]
    fn a_finished_run_says_what_became_of_the_pr() {
        let opened = PrOutcome::Opened(PR_URL.to_string());
        assert_eq!(
            finished_notice(&[opened.clone(), PrOutcome::AlreadyOpen(3)]),
            Some(("Draft PR created", PR_URL.to_string()))
        );
        let (title, detail) = finished_notice(&[PrOutcome::AlreadyOpen(7)]).unwrap();
        assert_eq!(title, "Pull request already open");
        assert!(detail.contains("#7") && detail.contains("no new pull request"));
        assert_eq!(finished_notice(&[]), None);
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
