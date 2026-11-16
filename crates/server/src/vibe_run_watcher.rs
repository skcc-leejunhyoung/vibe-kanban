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
//!
//! It also drives merges waiting on a retryable failure: when a waiting run's
//! `merge_retry_at` comes due, it tries the merge again. The schedule lives in
//! the row, so a wait survives restarts.
//!
//! A run in the push / PR follow-up after its merge belongs to
//! [`crate::vibe_pr_follow_up`], which holds a claim until each step finishes.
//! One that has no worker there and has not moved for a while is blocked here
//! with the reason and the step a retry resumes in.

use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

use chrono::{DateTime, Utc};
use db::models::{
    execution_process::ExecutionProcess, session::Session, vibe_run::VibeRun, workspace::Workspace,
};
use deployment::Deployment;
use services::services::{
    container::ContainerService,
    remote_client::RemoteClient,
    vibe_orchestrator::{TAG_BLOCK, VibePhase},
    vibe_tags,
};
use sqlx::SqlitePool;
use tokio::time::sleep;
use uuid::Uuid;

use crate::{DeploymentImpl, vibe_pr_follow_up};

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
    // Retries first: a wait that came due while the server was down counts as
    // stale below until it has been retried.
    retry_due_merges(deployment, Utc::now()).await?;
    let pool = &deployment.db().pool;
    let client = deployment.remote_client().ok();
    block_orphaned_runs(
        pool,
        Utc::now(),
        client.as_ref(),
        vibe_pr_follow_up::in_flight,
    )
    .await
}

/// Try again every waiting merge whose retry is due. A workspace with a live
/// execution (someone is talking to its review session) waits a tick.
async fn retry_due_merges(deployment: &DeploymentImpl, now: DateTime<Utc>) -> anyhow::Result<()> {
    let pool = &deployment.db().pool;
    for run in VibeRun::find_non_terminal(pool).await? {
        let due = run.phase == VibePhase::Merging.as_str()
            && run.merge_retry_at.is_some_and(|at| at <= now);
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
        // The orphan check below blocks it once the retry is overdue.
        if workspace.archived {
            continue;
        }
        if let Err(e) = deployment
            .container()
            .vibe_retry_merge(&workspace, false)
            .await
        {
            tracing::warn!("vibe: merge retry for {} failed: {}", run.workspace_id, e);
        }
    }
    Ok(())
}

async fn block_orphaned_runs(
    pool: &SqlitePool,
    now: DateTime<Utc>,
    client: Option<&RemoteClient>,
    follow_up_in_flight: impl Fn(Uuid) -> bool,
) -> anyhow::Result<()> {
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

    // Completion is persisted before output draining and `vibe_on_finalize`.
    // Use the newest activity across all related executions, not merely the
    // most recently created row: setup and coding processes can overlap.
    let latest_execution_activity = latest_execution_activity_by_workspace(pool).await?;

    for run in runs {
        let is_active = active_workspaces.contains(&run.workspace_id);
        // A scheduled merge retry is activity to come: not stale until it is
        // overdue (the retry above keeps failing to run).
        let latest_execution_activity_at = latest_execution_activity
            .get(&run.workspace_id)
            .cloned()
            .max(run.merge_retry_at);
        if !should_escalate(is_active, run.updated_at, latest_execution_activity_at, now) {
            continue;
        }
        // The merge already landed: no review verdict is at stake and the
        // issue is not blocked. Stop the follow-up where it stands, with a
        // reason, so a retry resumes there instead of the run sitting silent.
        if matches!(
            VibePhase::from_db_str(&run.phase),
            Some(VibePhase::Pushing | VibePhase::CreatingPr)
        ) {
            if follow_up_in_flight(run.workspace_id) {
                continue;
            }
            tracing::warn!(
                "vibe: workspace {} stalled in '{}' (run updated {}); blocking",
                run.workspace_id,
                run.phase,
                run.updated_at
            );
            let reason = format!(
                "The server made no progress in this step for {STALE_AFTER_MINUTES} minutes \
                 (it may have restarted). Retry to resume."
            );
            if let Err(e) =
                VibeRun::block_follow_up(pool, run.workspace_id, &run.phase, &reason).await
            {
                tracing::error!(
                    "vibe: blocking stalled follow-up failed for {}: {}",
                    run.workspace_id,
                    e
                );
            }
            continue;
        }
        tracing::warn!(
            "vibe: workspace {} orphaned in phase '{}' (run updated {}, latest execution activity {:?}); escalating to blocked",
            run.workspace_id,
            run.phase,
            run.updated_at,
            latest_execution_activity_at
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

async fn latest_execution_activity_by_workspace(
    pool: &SqlitePool,
) -> Result<HashMap<Uuid, DateTime<Utc>>, sqlx::Error> {
    let rows = sqlx::query_as::<_, (Uuid, DateTime<Utc>)>(
        r#"
        SELECT
            s.workspace_id,
            MAX(COALESCE(ep.completed_at, ep.updated_at, ep.started_at))
        FROM execution_processes ep
        JOIN sessions s ON ep.session_id = s.id
        WHERE ep.run_reason IN ('codingagent', 'setupscript', 'cleanupscript')
          AND ep.dropped = FALSE
        GROUP BY s.workspace_id
        "#,
    )
    .fetch_all(pool)
    .await?;

    Ok(rows.into_iter().collect())
}

/// Pure escalation predicate: a run with no live execution and no recent run
/// or execution activity is orphaned. Kept pure so the time-based boundary is
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
    use services::services::vibe_orchestrator::{
        FinalizeInput, VibeAction, VibeBounds, VibeResult, decide_finalize_action,
    };
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

    async fn seed_completed_execution(
        pool: &SqlitePool,
        session_id: Uuid,
        created_at: DateTime<Utc>,
        completed_at: DateTime<Utc>,
    ) -> Uuid {
        let process_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO execution_processes \
             (id, session_id, run_reason, status, started_at, completed_at, created_at, updated_at) \
             VALUES (?, ?, 'codingagent', 'completed', ?, ?, ?, ?)",
        )
        .bind(process_id)
        .bind(session_id)
        .bind(created_at)
        .bind(completed_at)
        .bind(created_at)
        .bind(created_at)
        .execute(pool)
        .await
        .unwrap();
        process_id
    }

    #[tokio::test]
    async fn completion_finalize_race_preserves_approve_merge() {
        let pool = test_pool().await;
        let now = ts("2026-06-19T12:00:00Z");
        let (workspace_id, session_id) = seed_review_run(&pool, ts("2026-06-19T10:00:00Z")).await;

        // The older-created review finishes most recently. A lookup ordered by
        // creation time would incorrectly select the stale, newer-created row.
        let review_process_id = seed_completed_execution(
            &pool,
            session_id,
            ts("2026-06-19T10:00:00Z"),
            ts("2026-06-19T11:59:00Z"),
        )
        .await;
        seed_completed_execution(
            &pool,
            session_id,
            ts("2026-06-19T10:01:00Z"),
            ts("2026-06-19T11:30:00Z"),
        )
        .await;

        block_orphaned_runs(&pool, now, None, |_| false)
            .await
            .unwrap();

        let run = VibeRun::find_by_workspace_id(&pool, workspace_id)
            .await
            .unwrap()
            .unwrap();
        let process = ExecutionProcess::find_by_id(&pool, review_process_id)
            .await
            .unwrap()
            .unwrap();
        let phase = VibePhase::from_db_str(&run.phase).unwrap();
        let result = run
            .last_result
            .as_deref()
            .map(VibeResult::from_token)
            .unwrap_or(VibeResult::None);

        assert_eq!(
            decide_finalize_action(&FinalizeInput {
                run_reason: process.run_reason,
                status: process.status,
                phase,
                session_is_review: run.review_session_id == Some(session_id),
                result,
                coding_turns: run.coding_turns as u32,
                review_turns: run.review_turns as u32,
                merge_retries: run.merge_retries as u32,
                merge_failed: run.last_error.is_some(),
                bounds: VibeBounds::default(),
            }),
            VibeAction::AttemptMerge { retry: 0 }
        );
    }

    // A merge waiting on another checkout's edits is not orphaned while its
    // retry is scheduled; one whose retry never ran is.
    #[tokio::test]
    async fn waiting_merge_is_left_alone_until_its_retry_is_overdue() {
        let pool = test_pool().await;
        let now = ts("2026-06-19T12:00:00Z");
        let (waiting, _) = seed_review_run(&pool, ts("2026-06-19T11:30:00Z")).await;
        let (overdue, _) = seed_review_run(&pool, ts("2026-06-19T11:00:00Z")).await;
        for (workspace_id, retry_at) in [
            (waiting, ts("2026-06-19T12:05:00Z")),
            (overdue, ts("2026-06-19T11:40:00Z")),
        ] {
            sqlx::query(
                "UPDATE vibe_runs SET phase = 'merging', merge_retry_at = ? \
                 WHERE workspace_id = ?",
            )
            .bind(retry_at)
            .bind(workspace_id)
            .execute(&pool)
            .await
            .unwrap();
        }

        block_orphaned_runs(&pool, now, None, |_| false)
            .await
            .unwrap();

        let phase = |workspace_id| {
            let pool = pool.clone();
            async move {
                VibeRun::find_by_workspace_id(&pool, workspace_id)
                    .await
                    .unwrap()
                    .unwrap()
                    .phase
            }
        };
        assert_eq!(phase(waiting).await, "merging");
        assert_eq!(phase(overdue).await, "blocked");
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

        block_orphaned_runs(&pool, now, None, |workspace| workspace == at_work)
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
        assert!(VibeRun::retry_follow_up(&pool, stalled).await.unwrap());
        assert_eq!(run(stalled).await.phase, "creating_pr");
    }

    #[tokio::test]
    async fn stale_run_without_recent_execution_is_blocked() {
        let pool = test_pool().await;
        let now = ts("2026-06-19T12:00:00Z");
        let (workspace_id, _) = seed_review_run(&pool, ts("2026-06-19T11:30:00Z")).await;

        block_orphaned_runs(&pool, now, None, |_| false)
            .await
            .unwrap();
        assert_eq!(
            VibeRun::find_by_workspace_id(&pool, workspace_id)
                .await
                .unwrap()
                .unwrap()
                .phase,
            VibePhase::Blocked.as_str()
        );
    }
}
