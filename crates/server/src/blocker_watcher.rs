//! Background poller that resumes deferred agent spawns when the upstream
//! issue's blockers reach a resolved status.
//!
//! When a session's follow-up is initiated while the linked issue has open
//! blockers, the `follow_up` route creates an `execution_processes` row but
//! skips the actual spawn and records a `pending_execution_starts` row.
//! This task polls those rows; once every blocker is in a resolved status
//! (Done / In review), it calls `finish_execution_spawn` to start the
//! deferred agent run.

use std::{path::Path, time::Duration};

use db::models::{
    execution_process::{ExecutionProcess, ExecutionProcessStatus},
    pending_execution_start::PendingExecutionStart,
    session::Session,
    workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
use deployment::Deployment;
use services::services::{container::ContainerService, issue_gating};
use tokio::{process::Command, time::sleep};

use crate::DeploymentImpl;

const POLL_INTERVAL: Duration = Duration::from_secs(10);

/// Refreshes the local `<base_branch>` ref of the main repo so that any
/// downstream rebase picks up commits that landed while we were blocked,
/// whether those came from a remote PR merge (origin push) or from the user
/// merging into the local base manually.
///
/// Best-effort: failures are logged but not raised — the rebase still runs
/// against whatever sha the local ref already points to.
async fn refresh_main_repo_base(main_repo_path: &Path, base_branch: &str) {
    let out = Command::new("git")
        .arg("-C")
        .arg(main_repo_path)
        .arg("pull")
        .arg("--ff-only")
        .arg("origin")
        .arg(base_branch)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .await;
    match out {
        Ok(o) if o.status.success() => {
            tracing::info!(
                "blocker_watcher: pulled --ff-only {} in {}",
                base_branch,
                main_repo_path.display()
            );
        }
        Ok(o) => {
            // Not-fast-forward is the common case when base isn't checked out
            // in the main repo, or when the user has local commits ahead of
            // origin; log at debug because it's not actionable.
            tracing::debug!(
                "blocker_watcher: pull --ff-only {} in {} did not fast-forward: {}",
                base_branch,
                main_repo_path.display(),
                String::from_utf8_lossy(&o.stderr).trim()
            );
        }
        Err(e) => {
            tracing::warn!(
                "blocker_watcher: spawn git pull failed in {}: {}",
                main_repo_path.display(),
                e
            );
        }
    }
}

/// Whether `sha` is an ancestor of the local `<base_branch>` (after
/// `refresh_main_repo_base` has had a chance to update it). Best-effort:
/// any failure returns `false` so the caller retries.
async fn is_ancestor_of_base(worktree_path: &Path, sha: &str, base_branch: &str) -> bool {
    let out = Command::new("git")
        .arg("-C")
        .arg(worktree_path)
        .arg("merge-base")
        .arg("--is-ancestor")
        .arg(sha)
        .arg(base_branch)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .await;
    matches!(out, Ok(o) if o.status.success())
}

/// Rebase the worktree's current branch onto the local `<base_branch>` ref
/// so it picks up any commit that landed while we were waiting on a blocker
/// — whether that commit came from a GitHub PR merge (refreshed via
/// `refresh_main_repo_base`) or from the user merging directly into the
/// local base.
///
/// On rebase failure (conflict / non-trivial divergence) we abort to leave
/// the worktree clean. Best-effort: errors are logged and ignored.
async fn rebase_worktree_onto_base(worktree_path: &Path, base_branch: &str) {
    let rebase = Command::new("git")
        .arg("-C")
        .arg(worktree_path)
        .arg("rebase")
        .arg(base_branch)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .await;

    match rebase {
        Ok(out) if out.status.success() => {
            tracing::info!(
                "blocker_watcher: rebased {} onto {}",
                worktree_path.display(),
                base_branch
            );
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            tracing::warn!(
                "blocker_watcher: rebase onto {} failed in {} (stderr: {}; stdout: {}); aborting",
                base_branch,
                worktree_path.display(),
                stderr,
                stdout
            );
            let _ = Command::new("git")
                .arg("-C")
                .arg(worktree_path)
                .arg("rebase")
                .arg("--abort")
                .env("GIT_TERMINAL_PROMPT", "0")
                .output()
                .await;
        }
        Err(e) => {
            tracing::warn!(
                "blocker_watcher: failed to spawn git rebase in {}: {}",
                worktree_path.display(),
                e
            );
        }
    }
}

/// Spawns the watcher loop. Returns immediately; the loop runs for the lifetime
/// of the process. A short initial delay lets server startup finish before the
/// first poll.
pub fn spawn(deployment: DeploymentImpl) {
    tokio::spawn(async move {
        loop {
            sleep(POLL_INTERVAL).await;
            if let Err(e) = tick(&deployment).await {
                tracing::warn!("blocker_watcher tick failed: {}", e);
            }
        }
    });
}

async fn tick(deployment: &DeploymentImpl) -> anyhow::Result<()> {
    let pool = &deployment.db().pool;
    let pending = PendingExecutionStart::find_all(pool).await?;
    if pending.is_empty() {
        return Ok(());
    }

    let client = match deployment.remote_client() {
        Ok(c) => c,
        Err(e) => {
            tracing::debug!("blocker_watcher: remote_client unavailable: {}", e);
            return Ok(());
        }
    };

    for row in pending {
        if let Err(e) = process_one(deployment, &client, &row, pool).await {
            tracing::warn!(
                "blocker_watcher: error processing pending row for process {}: {}",
                row.execution_process_id,
                e
            );
        }
    }

    Ok(())
}

async fn process_one(
    deployment: &DeploymentImpl,
    client: &services::services::remote_client::RemoteClient,
    row: &PendingExecutionStart,
    pool: &sqlx::SqlitePool,
) -> anyhow::Result<()> {
    let blockers = issue_gating::unresolved_blockers(client, row.task_id).await?;

    // Always record that we've checked, even if still blocked.
    let _ = PendingExecutionStart::touch_checked(pool, row.execution_process_id).await;

    if !blockers.is_empty() {
        return Ok(());
    }

    let execution_process =
        match ExecutionProcess::find_by_id(pool, row.execution_process_id).await? {
            Some(p) => p,
            None => {
                tracing::warn!(
                    "blocker_watcher: execution_process {} missing; removing pending row",
                    row.execution_process_id
                );
                let _ = PendingExecutionStart::delete_by_process_id(pool, row.execution_process_id)
                    .await;
                return Ok(());
            }
        };

    let workspace = match Workspace::find_by_id(pool, row.workspace_id).await? {
        Some(w) => w,
        None => {
            tracing::warn!(
                "blocker_watcher: workspace {} missing for pending process {}",
                row.workspace_id,
                row.execution_process_id
            );
            let _ =
                PendingExecutionStart::delete_by_process_id(pool, row.execution_process_id).await;
            return Ok(());
        }
    };

    // The worktree was created when the workspace was first set up (while
    // blocked). Now that the gate lifted, fetch the latest base from origin
    // and rebase the worktree onto it so the blocker's merge commit is
    // present before the coding agent runs.
    //
    // Before rebasing, verify that the merge commits of every merged blocker
    // PR are actually present on `origin/<base>`. The status change can race
    // ahead of GitHub's branch push (or the user may have flipped status
    // manually without merging); spawning before the commit lands defeats
    // the whole purpose of the gating. When verification fails we leave the
    // pending row in place and try again on the next tick.
    let workspace_root = match workspace.container_ref.as_deref() {
        Some(container_ref) => std::path::PathBuf::from(container_ref),
        None => {
            tracing::warn!(
                "blocker_watcher: workspace {} has no container_ref; skipping",
                workspace.id
            );
            return Ok(());
        }
    };
    let repo_targets =
        WorkspaceRepo::find_repos_with_target_branch_for_workspace(pool, workspace.id).await?;

    // Refresh the local base ref in each source repo so any commit landed via
    // a remote PR merge is available. Local-only merges (user merged into the
    // base directly without pushing) are already present in the local ref and
    // need no fetch.
    for entry in &repo_targets {
        refresh_main_repo_base(&entry.repo.path, &entry.target_branch).await;
    }

    // PR ancestry guard: when a blocker exposes a merged-PR sha, require it
    // to be reachable from the local base before resuming. If not, leave the
    // pending row in place and retry on the next tick. Blockers without any
    // tracked merged PR (manual status flip, or user merging locally) skip
    // this check.
    let merge_shas = issue_gating::blocker_merge_commit_shas(client, row.task_id).await?;
    if !merge_shas.is_empty() {
        let mut all_landed = true;
        'outer: for entry in &repo_targets {
            let worktree_path = workspace_root.join(&entry.repo.name);
            for sha in &merge_shas {
                if !is_ancestor_of_base(&worktree_path, sha, &entry.target_branch).await {
                    tracing::info!(
                        "blocker_watcher: merge commit {} not yet reachable from {} in {}; will retry",
                        sha,
                        entry.target_branch,
                        worktree_path.display()
                    );
                    all_landed = false;
                    break 'outer;
                }
            }
        }
        if !all_landed {
            return Ok(());
        }
    }

    for entry in &repo_targets {
        let worktree_path = workspace_root.join(&entry.repo.name);
        rebase_worktree_onto_base(&worktree_path, &entry.target_branch).await;
    }

    let session = match Session::find_by_id(pool, row.session_id).await? {
        Some(s) => s,
        None => {
            tracing::warn!(
                "blocker_watcher: session {} missing for pending process {}",
                row.session_id,
                row.execution_process_id
            );
            let _ =
                PendingExecutionStart::delete_by_process_id(pool, row.execution_process_id).await;
            return Ok(());
        }
    };

    let executor_action = execution_process
        .executor_action()
        .map_err(|e| {
            anyhow::anyhow!(
                "invalid executor_action on process {}: {}",
                execution_process.id,
                e
            )
        })?
        .clone();

    tracing::info!(
        "blocker_watcher: resuming deferred execution {} for workspace {} (task {})",
        execution_process.id,
        workspace.id,
        row.task_id
    );

    // Remove the pending row before spawning so a follow-up tick cannot
    // double-spawn. `finish_execution_spawn` itself marks the row as Failed on
    // spawn errors, so leaving the pending row would risk repeated retries on
    // a permanently-broken executor_action.
    PendingExecutionStart::delete_by_process_id(pool, row.execution_process_id).await?;

    // A user may have stopped this waiting session between the blocker check and
    // now: `stop_execution` cancels the deferred start and marks the process
    // Killed. Re-read the status right before spawning and bail if we positively
    // observe it is no longer Running, otherwise we'd spawn an unsupervised
    // orphan agent whose exit would overwrite the Killed status. On a read error
    // we fall through to spawn to avoid stranding the session on a transient DB
    // hiccup. This narrows — but does not fully close — the resume/stop race; a
    // complete fix needs per-process serialization of the two paths.
    if let Ok(Some(p)) = ExecutionProcess::find_by_id(pool, row.execution_process_id).await
        && p.status != ExecutionProcessStatus::Running
    {
        tracing::info!(
            "blocker_watcher: skipping resume of {}; no longer running (stopped?)",
            row.execution_process_id
        );
        return Ok(());
    }

    if let Err(e) = deployment
        .container()
        .finish_execution_spawn(&workspace, &session, &execution_process, &executor_action)
        .await
    {
        tracing::error!(
            "blocker_watcher: spawn failed for execution {}: {}",
            execution_process.id,
            e
        );
    }

    Ok(())
}
