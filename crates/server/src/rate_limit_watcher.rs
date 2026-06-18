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
};
use deployment::Deployment;
use executors::actions::{
    ExecutorAction, ExecutorActionType, coding_agent_follow_up::CodingAgentFollowUpRequest,
};
use services::services::container::ContainerService;
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
    let _ = PendingRateLimitResume::touch_checked(pool, row.session_id).await;

    let session = match Session::find_by_id(pool, row.session_id).await? {
        Some(s) => s,
        None => {
            let _ = PendingRateLimitResume::delete_by_session_id(pool, row.session_id).await;
            return Ok(());
        }
    };

    // Respect the per-session toggle: if auto-resume was turned off after the
    // schedule was created, drop the pending row without resuming.
    if !session.auto_resume_enabled {
        let _ = PendingRateLimitResume::delete_by_session_id(pool, row.session_id).await;
        return Ok(());
    }

    // Don't start a duplicate execution if the session already has a
    // (non-dev-server) process running — e.g. the user manually resumed it
    // after the limit reset, or a previous resume is still in flight. Leave the
    // pending row in place and retry on a later tick; it is cleared once the
    // session goes idle and resumes, or when a manual follow-up supersedes it.
    if ExecutionProcess::has_running_non_dev_server_processes_for_session(pool, row.session_id)
        .await?
    {
        return Ok(());
    }

    let workspace = match Workspace::find_by_id(pool, session.workspace_id).await? {
        Some(w) => w,
        None => {
            let _ = PendingRateLimitResume::delete_by_session_id(pool, row.session_id).await;
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
            let _ = PendingRateLimitResume::delete_by_session_id(pool, row.session_id).await;
            return Ok(());
        }
    };
    let executor_config = match last_agent.executor_action() {
        Ok(action) => match action.typ() {
            ExecutorActionType::CodingAgentInitialRequest(r) => r.executor_config.clone(),
            ExecutorActionType::CodingAgentFollowUpRequest(r) => r.executor_config.clone(),
            _ => {
                let _ = PendingRateLimitResume::delete_by_session_id(pool, row.session_id).await;
                return Ok(());
            }
        },
        Err(_) => {
            let _ = PendingRateLimitResume::delete_by_session_id(pool, row.session_id).await;
            return Ok(());
        }
    };

    // Resuming requires an existing agent session id to continue from.
    let session_info = match CodingAgentTurn::find_latest_session_info(pool, session.id).await? {
        Some(info) => info,
        None => {
            let _ = PendingRateLimitResume::delete_by_session_id(pool, row.session_id).await;
            return Ok(());
        }
    };

    let working_dir = session
        .agent_working_dir
        .as_ref()
        .filter(|d| !d.is_empty())
        .cloned();

    let action = ExecutorAction::new(
        ExecutorActionType::CodingAgentFollowUpRequest(CodingAgentFollowUpRequest {
            prompt: row.resume_prompt.clone(),
            session_id: session_info.session_id,
            reset_to_message_id: None,
            executor_config,
            working_dir,
        }),
        None,
    );

    // Clear the pending row before spawning so a spawn failure can't loop.
    PendingRateLimitResume::delete_by_session_id(pool, row.session_id).await?;

    deployment
        .container()
        .start_execution(
            &workspace,
            &session,
            &action,
            &ExecutionProcessRunReason::CodingAgent,
        )
        .await?;

    tracing::info!(
        "rate_limit_watcher: resumed session {} after rate-limit reset",
        session.id
    );

    Ok(())
}
