//! Background poller that resumes a session when an agent-scheduled wakeup
//! (claude `ScheduleWakeup`, surfaced as a `session_crons` entry) reaches its
//! fire time.
//!
//! This implements the CLI's "the harness re-invokes you when the wakeup fires"
//! contract that vibe-kanban must fulfil itself: the agent ends its turn, the
//! Stop hook forwards its crons, the storage consumer persists them as
//! `scheduled_resumes` rows, and this watcher spawns a follow-up with the
//! cron's prompt once due. Unlike `run_in_background` (handled in-process by
//! keeping the Stop hook blocked), wakeups can be minutes-to-hours out, so the
//! process is allowed to exit and we re-spawn via the normal follow-up path.

use std::time::Duration;

use chrono::Utc;
use db::models::{
    coding_agent_turn::CodingAgentTurn,
    execution_process::{ExecutionProcess, ExecutionProcessRunReason},
    scheduled_resume::ScheduledResume,
    session::Session,
    workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
use deployment::Deployment;
use executors::{
    actions::{
        ExecutorAction, ExecutorActionType, coding_agent_follow_up::CodingAgentFollowUpRequest,
    },
    profile::ExecutorConfig,
};
use services::services::container::ContainerService;
use sqlx::SqlitePool;
use tokio::time::sleep;
use uuid::Uuid;

use crate::DeploymentImpl;

const POLL_INTERVAL: Duration = Duration::from_secs(15);

/// Spawns the watcher loop. Returns immediately; the loop runs for the lifetime
/// of the process.
pub fn spawn(deployment: DeploymentImpl) {
    tokio::spawn(async move {
        loop {
            sleep(POLL_INTERVAL).await;
            if let Err(e) = tick(&deployment).await {
                tracing::warn!("scheduled_resume_watcher tick failed: {}", e);
            }
        }
    });
}

async fn tick(deployment: &DeploymentImpl) -> anyhow::Result<()> {
    let pool = &deployment.db().pool;
    let due = ScheduledResume::find_due(pool, Utc::now()).await?;
    for row in due {
        if let Err(e) = process_one(deployment, &row).await {
            tracing::warn!(
                "scheduled_resume_watcher: error firing resume {} for session {}: {}",
                row.id,
                row.session_id,
                e
            );
        }
    }
    Ok(())
}

async fn process_one(deployment: &DeploymentImpl, row: &ScheduledResume) -> anyhow::Result<()> {
    let pool = &deployment.db().pool;

    // Don't resume on top of a live run; leave the row pending and retry next
    // tick once the session goes idle. Use the broader "any non-dev-server
    // process" check (matching rate_limit_watcher) so a setup/cleanup script
    // mid-run also defers the resume instead of racing it in the same worktree.
    if ExecutionProcess::has_running_non_dev_server_processes_for_session(pool, row.session_id)
        .await?
    {
        tracing::debug!(
            "scheduled_resume_watcher: session {} busy, deferring resume {}",
            row.session_id,
            row.id
        );
        return Ok(());
    }

    let Some(session) = Session::find_by_id(pool, row.session_id).await? else {
        ScheduledResume::mark_fired(pool, row.id).await?;
        return Ok(());
    };
    let Some(workspace) = Workspace::find_by_id(pool, session.workspace_id).await? else {
        ScheduledResume::mark_fired(pool, row.id).await?;
        return Ok(());
    };

    // Recover the agent session id (for --resume / thread_fork) and the executor
    // config from the session's most recent coding-agent run, so the resume
    // continues the same conversation with the same agent/model.
    let Some(info) = CodingAgentTurn::find_latest_session_info(pool, session.id).await? else {
        tracing::warn!(
            "scheduled_resume_watcher: no prior agent session for {}; dropping resume {}",
            session.id,
            row.id
        );
        ScheduledResume::mark_fired(pool, row.id).await?;
        return Ok(());
    };
    let Some(executor_config) = latest_executor_config(pool, session.id).await? else {
        tracing::warn!(
            "scheduled_resume_watcher: no executor config for session {}; dropping resume {}",
            session.id,
            row.id
        );
        ScheduledResume::mark_fired(pool, row.id).await?;
        return Ok(());
    };

    deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;

    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let cleanup_action = deployment.container().cleanup_actions_for_repos(&repos);
    let working_dir = session
        .agent_working_dir
        .as_ref()
        .filter(|d| !d.is_empty())
        .cloned();

    let action = ExecutorAction::new(
        ExecutorActionType::CodingAgentFollowUpRequest(CodingAgentFollowUpRequest {
            prompt: row.prompt.clone(),
            session_id: info.session_id,
            reset_to_message_id: None,
            executor_config,
            working_dir,
        }),
        cleanup_action.map(Box::new),
    );

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
        "scheduled_resume_watcher: resumed session {} from scheduled wakeup {} (cron {})",
        session.id,
        row.id,
        row.cron_id
    );

    // Recurring wakeups roll forward to their next fire time; one-shots are done.
    if row.recurring
        && let Some(next) = ScheduledResume::next_fire_after(&row.schedule, Utc::now())
    {
        ScheduledResume::reschedule(pool, row.id, next).await?;
    } else {
        ScheduledResume::mark_fired(pool, row.id).await?;
    }

    Ok(())
}

/// Pull the executor config from the session's most recent coding-agent run.
async fn latest_executor_config(
    pool: &SqlitePool,
    session_id: Uuid,
) -> anyhow::Result<Option<ExecutorConfig>> {
    let processes = ExecutionProcess::find_by_session_id(pool, session_id, false).await?;
    for process in processes.iter().rev() {
        if !matches!(process.run_reason, ExecutionProcessRunReason::CodingAgent) {
            continue;
        }
        if let Ok(action) = process.executor_action() {
            match action.typ() {
                ExecutorActionType::CodingAgentInitialRequest(r) => {
                    return Ok(Some(r.executor_config.clone()));
                }
                ExecutorActionType::CodingAgentFollowUpRequest(r) => {
                    return Ok(Some(r.executor_config.clone()));
                }
                _ => {}
            }
        }
    }
    Ok(None)
}
