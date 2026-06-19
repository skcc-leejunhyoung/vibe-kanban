//! Orphan-recovery safety net for the automated `vibe` workflow.
//!
//! The workflow normally advances from the in-process `vibe_on_finalize`
//! callback fired after each agent turn. If the server restarts mid-run, or a
//! decided follow-up could not be spawned (e.g. the session's executor profile
//! was gone), no callback fires again and the `vibe_run` would sit in a
//! non-terminal phase forever. This watcher periodically scans non-terminal
//! runs and escalates any that have no live execution and have not advanced for
//! a while to `Blocked` (+ the `vibe-block` tag), so a human is signalled
//! instead of the run stalling silently.

use std::{collections::HashSet, time::Duration};

use chrono::{DateTime, Utc};
use db::models::{execution_process::ExecutionProcess, session::Session, vibe_run::VibeRun};
use deployment::Deployment;
use services::services::{
    vibe_orchestrator::{TAG_BLOCK, VibePhase},
    vibe_tags,
};
use tokio::time::sleep;
use uuid::Uuid;

use crate::DeploymentImpl;

const POLL_INTERVAL: Duration = Duration::from_secs(60);

/// A non-terminal run with no live execution that has not advanced for at least
/// this long is treated as orphaned. Deliberately generous: a single long agent
/// turn keeps a `Running` execution_process (so the run is skipped anyway via
/// `is_active`), and the gap between consecutive turns is sub-second, so only a
/// genuinely stuck run trips this.
const STALE_AFTER_MINUTES: i64 = 15;

/// Spawns the watcher loop. Returns immediately; runs for the process lifetime.
pub fn spawn(deployment: DeploymentImpl) {
    tokio::spawn(async move {
        loop {
            sleep(POLL_INTERVAL).await;
            if let Err(e) = tick(&deployment).await {
                tracing::warn!("vibe_run_watcher tick failed: {}", e);
            }
        }
    });
}

async fn tick(deployment: &DeploymentImpl) -> anyhow::Result<()> {
    let pool = &deployment.db().pool;
    let runs = VibeRun::find_non_terminal(pool).await?;
    if runs.is_empty() {
        return Ok(());
    }

    // Workspaces with a live (running) execution are actively progressing and
    // must never be escalated.
    let running = ExecutionProcess::find_running(pool).await?;
    let mut active_workspaces: HashSet<Uuid> = HashSet::new();
    for ep in running {
        if let Some(session) = Session::find_by_id(pool, ep.session_id).await? {
            active_workspaces.insert(session.workspace_id);
        }
    }

    let client = deployment.remote_client().ok();
    let now = Utc::now();

    for run in runs {
        let is_active = active_workspaces.contains(&run.workspace_id);
        if !should_escalate(is_active, run.updated_at, now) {
            continue;
        }
        tracing::warn!(
            "vibe: workspace {} orphaned in phase '{}' (no live execution since {}); escalating to blocked",
            run.workspace_id,
            run.phase,
            run.updated_at
        );
        if let Err(e) =
            VibeRun::set_phase(pool, run.workspace_id, VibePhase::Blocked.as_str()).await
        {
            tracing::error!(
                "vibe: orphan set_phase(blocked) failed for {}: {}",
                run.workspace_id,
                e
            );
            continue;
        }
        if let Some(client) = &client
            && let Err(e) = vibe_tags::add_issue_tag_by_name(client, run.task_id, TAG_BLOCK).await
        {
            tracing::warn!(
                "vibe: orphan vibe-block tag failed for issue {}: {}",
                run.task_id,
                e
            );
        }
    }
    Ok(())
}

/// Pure escalation predicate: a run with no live execution that has not been
/// updated within the staleness window is orphaned. Kept pure so the time-based
/// boundary is unit-testable without a database.
fn should_escalate(is_active: bool, updated_at: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    if is_active {
        return false;
    }
    now.signed_duration_since(updated_at) >= chrono::Duration::minutes(STALE_AFTER_MINUTES)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn active_run_is_never_escalated() {
        let now = ts("2026-06-19T12:00:00Z");
        // Stale by time, but a live execution is running → leave it alone.
        assert!(!should_escalate(true, ts("2026-06-19T10:00:00Z"), now));
    }

    #[test]
    fn idle_recent_run_is_not_escalated() {
        let now = ts("2026-06-19T12:00:00Z");
        // No live execution but updated 5 min ago (within the window).
        assert!(!should_escalate(false, ts("2026-06-19T11:55:00Z"), now));
    }

    #[test]
    fn idle_stale_run_is_escalated() {
        let now = ts("2026-06-19T12:00:00Z");
        // No live execution and last advanced 30 min ago → orphaned.
        assert!(should_escalate(false, ts("2026-06-19T11:30:00Z"), now));
    }

    #[test]
    fn exactly_at_threshold_escalates() {
        let now = ts("2026-06-19T12:00:00Z");
        assert!(should_escalate(false, ts("2026-06-19T11:45:00Z"), now));
    }
}
