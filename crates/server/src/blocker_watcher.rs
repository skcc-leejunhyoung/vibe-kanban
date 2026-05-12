//! Background poller that resumes deferred agent spawns when the upstream
//! issue's blockers reach a resolved status.
//!
//! When a session's follow-up is initiated while the linked issue has open
//! blockers, the `follow_up` route creates an `execution_processes` row but
//! skips the actual spawn and records a `pending_execution_starts` row.
//! This task polls those rows; once every blocker is in a resolved status
//! (Done / In review), it calls `finish_execution_spawn` to start the
//! deferred agent run.

use std::time::Duration;

use db::models::{
    execution_process::ExecutionProcess, pending_execution_start::PendingExecutionStart,
    session::Session, workspace::Workspace,
};
use deployment::Deployment;
use services::services::{container::ContainerService, issue_gating};
use tokio::time::sleep;

use crate::DeploymentImpl;

const POLL_INTERVAL: Duration = Duration::from_secs(10);

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
