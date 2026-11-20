//! Keeps a `vibe` run's own steps going when no turn ends to move them.
//!
//! A merge waiting on a failure that may clear by itself (another checkout's
//! edits, a git lock) is tried again when its `merge_retry_at` comes due; the
//! schedule lives in the row, so a wait survives restarts. A push / PR step
//! with no worker of [`crate::vibe_pr_follow_up`] on it that has not moved for
//! a while is stopped with its reason, at the step a retry resumes.
//!
//! What a run that stopped moving does next is not decided here: the
//! automation worker's reconciliation reads every run and blocks the ones
//! that stalled.

use std::{collections::HashSet, time::Duration};

use chrono::{DateTime, Utc};
use db::models::{
    execution_process::ExecutionProcess, session::Session, vibe_run::VibeRun, workspace::Workspace,
};
use deployment::Deployment;
use services::services::{container::ContainerService, vibe_orchestrator::VibePhase};
use sqlx::SqlitePool;
use tokio::time::sleep;
use uuid::Uuid;

use crate::{DeploymentImpl, routes::vibe_actions::latest_execution_activity, vibe_pr_follow_up};

const POLL_INTERVAL: Duration = Duration::from_secs(60);

/// A push / PR step with no worker and no activity for at least this long
/// has stopped (its loop is not running, or died mid-step).
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
    retry_due_merges(deployment, Utc::now()).await?;
    block_stalled_follow_ups(
        &deployment.db().pool,
        Utc::now(),
        vibe_pr_follow_up::in_flight,
    )
    .await
}

/// Try again every waiting merge whose retry is due. A workspace with a live
/// execution (someone is talking to its review session) waits a tick.
async fn retry_due_merges(deployment: &DeploymentImpl, now: DateTime<Utc>) -> anyhow::Result<()> {
    let pool = &deployment.db().pool;
    for run in VibeRun::find_non_terminal(pool).await? {
        // An event the worker has not answered yet (the review session spoke
        // up during the wait) goes first: a retry would start a new
        // generation and drop it.
        let due = run.phase == VibePhase::Merging.as_str()
            && run.merge_retry_at.is_some_and(|at| at <= now)
            && run.pending.is_none();
        if !due
            || ExecutionProcess::has_running_non_dev_server_processes_for_workspace(
                pool,
                run.workspace_id,
            )
            .await?
        {
            continue;
        }
        let Some(workspace) = Workspace::find_by_id(pool, run.workspace_id).await? else {
            continue;
        };
        // Archiving abandons the wait: a retry would merge or un-archive it.
        // The worker's reconciliation blocks the archived run.
        if workspace.archived {
            continue;
        }
        if let Err(e) = deployment
            .container()
            .vibe_retry_merge(&workspace, run.generation, false)
            .await
        {
            tracing::warn!("vibe: merge retry for {} failed: {}", run.workspace_id, e);
        }
    }
    Ok(())
}

/// Stop the push / PR follow-ups that stalled, with a reason, at the step a
/// retry resumes; one the follow-up is still working on is left to it,
/// however long its step takes.
async fn block_stalled_follow_ups(
    pool: &SqlitePool,
    now: DateTime<Utc>,
    follow_up_in_flight: impl Fn(Uuid) -> bool,
) -> anyhow::Result<()> {
    let runs = VibeRun::find_in_follow_up(pool).await?;
    if runs.is_empty() {
        return Ok(());
    }
    let mut active_workspaces: HashSet<Uuid> = HashSet::new();
    for ep in ExecutionProcess::find_running(pool).await? {
        if let Some(session) = Session::find_by_id(pool, ep.session_id).await? {
            active_workspaces.insert(session.workspace_id);
        }
    }
    let activity = latest_execution_activity(pool).await?;
    for run in runs {
        if follow_up_in_flight(run.workspace_id)
            || !should_escalate(
                active_workspaces.contains(&run.workspace_id),
                run.updated_at,
                activity.get(&run.workspace_id).copied(),
                now,
            )
        {
            continue;
        }
        let reason = format!(
            "The server made no progress in this step for {STALE_AFTER_MINUTES} minutes \
             (it may have restarted). Retry to resume."
        );
        if let Err(e) = vibe_pr_follow_up::block(pool, &run, &run.phase, &reason).await {
            tracing::error!(
                "vibe: blocking stalled follow-up failed for {}: {}",
                run.workspace_id,
                e
            );
        }
    }
    Ok(())
}

/// Pure escalation predicate: a run with no live execution and no recent run
/// or execution activity has stalled. Kept pure so the time-based boundary is
/// unit-testable without a database.
fn should_escalate(
    is_active: bool,
    run_updated_at: DateTime<Utc>,
    latest_execution_activity_at: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> bool {
    if is_active {
        return false;
    }
    let last_activity_at = latest_execution_activity_at
        .map(|execution_activity_at| execution_activity_at.max(run_updated_at))
        .unwrap_or(run_updated_at);
    now.signed_duration_since(last_activity_at) >= chrono::Duration::minutes(STALE_AFTER_MINUTES)
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::SqlitePoolOptions;

    use super::*;

    fn ts(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn active_run_is_never_escalated() {
        let now = ts("2026-06-19T12:00:00Z");
        // Stale by time, but a live execution is running → leave it alone.
        assert!(!should_escalate(
            true,
            ts("2026-06-19T10:00:00Z"),
            None,
            now
        ));
    }

    #[test]
    fn idle_recent_run_is_not_escalated() {
        let now = ts("2026-06-19T12:00:00Z");
        // No live execution but updated 5 min ago (within the window).
        assert!(!should_escalate(
            false,
            ts("2026-06-19T11:55:00Z"),
            None,
            now
        ));
    }

    #[test]
    fn recently_completed_long_execution_is_not_escalated() {
        let now = ts("2026-06-19T12:00:00Z");
        assert!(!should_escalate(
            false,
            ts("2026-06-19T10:00:00Z"),
            Some(ts("2026-06-19T11:59:00Z")),
            now
        ));
    }

    #[test]
    fn idle_stale_run_is_escalated() {
        let now = ts("2026-06-19T12:00:00Z");
        // No live execution and last advanced 30 min ago → orphaned.
        assert!(should_escalate(
            false,
            ts("2026-06-19T11:30:00Z"),
            None,
            now
        ));
    }

    #[test]
    fn exactly_at_threshold_escalates() {
        let now = ts("2026-06-19T12:00:00Z");
        assert!(should_escalate(
            false,
            ts("2026-06-19T11:45:00Z"),
            None,
            now
        ));
    }

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
        pool
    }

    async fn seed_review_run(pool: &SqlitePool, updated_at: DateTime<Utc>) -> (Uuid, Uuid) {
        let workspace_id = Uuid::new_v4();
        let session_id = Uuid::new_v4();
        sqlx::query("INSERT INTO workspaces (id, branch) VALUES (?, ?)")
            .bind(workspace_id)
            .bind(format!("vk/{workspace_id}"))
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sessions (id, workspace_id) VALUES (?, ?)")
            .bind(session_id)
            .bind(workspace_id)
            .execute(pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO vibe_runs \
             (workspace_id, task_id, phase, review_session_id, last_result, updated_at) \
             VALUES (?, ?, 'review', ?, 'approve', ?)",
        )
        .bind(workspace_id)
        .bind(Uuid::new_v4())
        .bind(session_id)
        .bind(updated_at)
        .execute(pool)
        .await
        .unwrap();
        (workspace_id, session_id)
    }

    // The merge landed, and the push / PR follow-up has no worker (its loop is
    // not running, or died mid-step). The run must not sit there silently: it
    // is blocked with a reason, at the step a retry resumes. One the follow-up
    // is still working on is left to it, however long its step takes.
    #[tokio::test]
    async fn a_stalled_follow_up_is_blocked_with_a_reason_at_its_step() {
        let pool = test_pool().await;
        let now = ts("2026-06-19T12:00:00Z");
        let (stalled, _) = seed_review_run(&pool, ts("2026-06-19T11:30:00Z")).await;
        let (at_work, _) = seed_review_run(&pool, ts("2026-06-19T11:30:00Z")).await;
        // `updated_at` stays as seeded: half an hour without a move.
        sqlx::query("UPDATE vibe_runs SET phase = 'creating_pr', pr_requested = 1")
            .execute(&pool)
            .await
            .unwrap();

        block_stalled_follow_ups(&pool, now, |workspace| workspace == at_work)
            .await
            .unwrap();

        let run = |workspace_id| {
            let pool = pool.clone();
            async move {
                VibeRun::find_by_workspace_id(&pool, workspace_id)
                    .await
                    .unwrap()
                    .unwrap()
            }
        };
        let blocked = run(stalled).await;
        assert_eq!(blocked.phase, "blocked");
        assert_eq!(blocked.failed_phase.as_deref(), Some("creating_pr"));
        let reason = blocked.last_error.unwrap();
        assert!(reason.contains("no progress"), "{reason}");
        assert_eq!(run(at_work).await.phase, "creating_pr");

        // The retry puts it back in its step; the merge is not redone.
        assert!(
            VibeRun::retry(
                &pool,
                &VibeRun::find_by_workspace_id(&pool, stalled)
                    .await
                    .unwrap()
                    .unwrap(),
                None
            )
            .await
            .unwrap()
        );
        assert_eq!(run(stalled).await.phase, "creating_pr");
    }

    // Deciding what a stalled run does next is the automation worker's: a
    // run under review that stopped moving is left as it is here.
    #[tokio::test]
    async fn a_stalled_run_outside_the_follow_up_is_left_to_the_worker() {
        let pool = test_pool().await;
        let now = ts("2026-06-19T12:00:00Z");
        let (workspace_id, _) = seed_review_run(&pool, ts("2026-06-19T11:00:00Z")).await;

        block_stalled_follow_ups(&pool, now, |_| false)
            .await
            .unwrap();
        assert_eq!(
            VibeRun::find_by_workspace_id(&pool, workspace_id)
                .await
                .unwrap()
                .unwrap()
                .phase,
            VibePhase::Review.as_str()
        );
    }
}
