//! Background poller that resumes coding-agent sessions whose usage rate limit
//! has reset.
//!
//! When an execution stops because a usage limit was reached and the session
//! has auto-resume enabled, the exit monitor records a
//! `pending_rate_limit_resumes` row with the estimated reset time. This task
//! polls those rows; once the reset time has passed — and the session still has
//! auto-resume enabled — it sends a `resume_prompt` (e.g. "continue") follow-up
//! to resume the session, then clears the row.

use std::time::Duration;

use chrono::Utc;
use db::models::{
    coding_agent_turn::CodingAgentTurn,
    execution_process::{ExecutionProcess, ExecutionProcessRunReason},
    pending_rate_limit_resume::PendingRateLimitResume,
    session::Session,
    workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
use deployment::Deployment;
use executors::actions::{ExecutorAction, ExecutorActionType};
use services::services::container::{ContainerService, coding_turn_request};
use tokio::time::sleep;

use crate::DeploymentImpl;

const POLL_INTERVAL: Duration = Duration::from_secs(10);

/// Spawns the watcher loop. Returns immediately; the loop runs for the lifetime
/// of the process.
pub fn spawn(deployment: DeploymentImpl) {
    tokio::spawn(async move {
        loop {
            sleep(POLL_INTERVAL).await;
            if let Err(e) = tick(&deployment).await {
                tracing::warn!("rate_limit_watcher tick failed: {}", e);
            }
        }
    });
}

async fn tick(deployment: &DeploymentImpl) -> anyhow::Result<()> {
    let pool = &deployment.db().pool;
    let pending = PendingRateLimitResume::find_all(pool).await?;
    if pending.is_empty() {
        return Ok(());
    }

    let now = Utc::now();
    for row in pending {
        if row.resume_at > now {
            continue; // reset time not reached yet
        }
        if let Err(e) = process_one(deployment, &row, pool).await {
            tracing::warn!(
                "rate_limit_watcher: error resuming session {}: {}",
                row.session_id,
                e
            );
        }
    }

    Ok(())
}

async fn process_one(
    deployment: &DeploymentImpl,
    row: &PendingRateLimitResume,
    pool: &sqlx::SqlitePool,
) -> anyhow::Result<()> {
    let container = deployment.container();
    let mut stops = container.watch_session_stops(row.session_id);
    let _ = PendingRateLimitResume::touch_checked(pool, row.session_id).await;

    let session = match Session::find_by_id(pool, row.session_id).await? {
        Some(s) => s,
        None => {
            // Session is gone; there's nothing left to finalize. Just drop the row.
            let _ = PendingRateLimitResume::delete_by_session_id(pool, row.session_id).await;
            return Ok(());
        }
    };

    // Don't act while the session has a (non-dev-server) process running — e.g.
    // the user manually resumed it after the limit reset, or a previous resume
    // is still in flight. Leave the pending row in place and retry on a later
    // tick; it is cleared once the session goes idle and resumes, or when a
    // manual follow-up supersedes it. Checked before the auto-resume toggle so
    // that abandon_resume (below) only runs when the session is idle, where its
    // deferred finalization can actually proceed instead of being skipped by the
    // running-process guard inside finalize_cancelled_rate_limit_resume.
    if ExecutionProcess::has_running_non_dev_server_processes_for_session(pool, row.session_id)
        .await?
    {
        return Ok(());
    }
    deployment
        .container()
        .wait_for_session_ready(row.session_id)
        .await;

    // Respect the per-session toggle: if auto-resume was turned off after the
    // schedule was created, drop the pending row and run the deferred
    // finalization without resuming.
    if !session.auto_resume_enabled {
        abandon_resume(deployment, pool, row).await;
        return Ok(());
    }

    let workspace = match Workspace::find_by_id(pool, session.workspace_id).await? {
        // A paused Autopilot would refuse the start on every tick.
        Some(w) if !(w.autopilot && w.archived) => w,
        _ => {
            abandon_resume(deployment, pool, row).await;
            return Ok(());
        }
    };

    // Recover the executor config from the most recent coding-agent execution of
    // this session.
    let processes = ExecutionProcess::find_by_session_id(pool, session.id, false).await?;
    let last_agent = processes
        .iter()
        .rev()
        .find(|p| matches!(p.run_reason, ExecutionProcessRunReason::CodingAgent));
    let last_agent = match last_agent {
        Some(p) => p,
        None => {
            abandon_resume(deployment, pool, row).await;
            return Ok(());
        }
    };
    let executor_config = match last_agent.executor_action() {
        Ok(action) => match action.typ() {
            ExecutorActionType::CodingAgentInitialRequest(r) => r.executor_config.clone(),
            ExecutorActionType::CodingAgentFollowUpRequest(r) => r.executor_config.clone(),
            _ => {
                abandon_resume(deployment, pool, row).await;
                return Ok(());
            }
        },
        Err(_) => {
            abandon_resume(deployment, pool, row).await;
            return Ok(());
        }
    };

    // Resuming requires an existing agent session id to continue from.
    if CodingAgentTurn::find_latest_session_info(pool, session.id)
        .await?
        .is_none()
    {
        abandon_resume(deployment, pool, row).await;
        return Ok(());
    }

    // The reset is typically hours out, so the worktree may have been cleaned up
    // in the meantime. Recreate it before resuming, matching
    // `scheduled_resume_watcher` and the manual follow-up path; without this
    // `start_execution` spawns against a missing worktree and fails.
    deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;

    let starting = container.lock_session_start(session.id).await;
    if stops.has_changed().unwrap_or(false)
        || ExecutionProcess::has_running_non_dev_server_processes_for_session(pool, session.id)
            .await?
    {
        return Ok(());
    }
    let executor_config = if workspace.autopilot {
        let Some(current) =
            ExecutionProcess::latest_executor_config_for_session(pool, session.id).await?
        else {
            return Ok(());
        };
        tokio::select! {
            biased;
            Ok(()) = stops.changed() => return Ok(()),
            config = container.select_autopilot_executor(session.id, current) => config?,
        }
    } else {
        executor_config
    };
    if PendingRateLimitResume::find_by_session_id(pool, session.id)
        .await?
        .is_none_or(|pending| {
            pending.id != row.id
                || pending.resume_at != row.resume_at
                || pending.execution_process_id != row.execution_process_id
        })
        || !Session::find_by_id(pool, session.id)
            .await?
            .is_some_and(|session| session.auto_resume_enabled)
        || stops.has_changed().unwrap_or(false)
    {
        return Ok(());
    }
    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let cleanup_action = deployment.container().cleanup_actions_for_repos(&repos);

    // A due resume may take the Autopilot's official handoff. It never
    // resumes another executor's native session.
    let action = ExecutorAction::new(
        coding_turn_request(pool, &session, &row.resume_prompt, &executor_config, false).await?,
        cleanup_action.map(Box::new),
    );

    let record = container
        .create_execution_record(
            &workspace,
            &session,
            &action,
            &ExecutionProcessRunReason::CodingAgent,
        )
        .await?;
    if workspace.autopilot
        && let Err(error) =
            Session::update_executor(pool, session.id, &executor_config.executor.to_string()).await
    {
        tracing::warn!(%error, "Could not record the Autopilot resume executor");
    }
    drop(starting);
    container
        .finish_execution_spawn(&workspace, &session, &record, &action)
        .await?;

    PendingRateLimitResume::delete_by_session_id(pool, row.session_id).await?;

    tracing::info!(
        "rate_limit_watcher: resumed session {} after rate-limit reset",
        session.id
    );

    Ok(())
}

/// Give up on a pending resume that can no longer be honored: drop the row and
/// run the finalization the exit monitor deferred when the limit was hit. When a
/// limit is reached the exit monitor skips finalization (commit / auto-merge /
/// mark-unseen) on the assumption the resume will run it later; if we instead
/// abandon the resume, that finalization must still happen or the original
/// execution is stranded half-finalized forever. Best-effort: a failure here is
/// logged, not propagated, so one bad row can't wedge the whole tick.
async fn abandon_resume(
    deployment: &DeploymentImpl,
    pool: &sqlx::SqlitePool,
    row: &PendingRateLimitResume,
) {
    // Claim the row by deleting it, and only finalize if this call actually
    // removed it. A concurrent set_auto_resume(false) deletes + finalizes the
    // same row; making the delete the claim ensures exactly one of them runs the
    // (non-idempotent) finalization.
    match PendingRateLimitResume::delete_by_session_id(pool, row.session_id).await {
        Ok(n) if n > 0 => {}
        _ => return,
    }
    if let Err(e) = deployment
        .container()
        .finalize_cancelled_rate_limit_resume(row.execution_process_id)
        .await
    {
        tracing::warn!(
            "rate_limit_watcher: failed to finalize abandoned resume for session {}: {}",
            row.session_id,
            e
        );
    }
}
