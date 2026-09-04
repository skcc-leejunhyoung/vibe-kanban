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

use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

use chrono::{DateTime, Utc};
use db::models::{execution_process::ExecutionProcess, session::Session, vibe_run::VibeRun};
use deployment::Deployment;
use services::services::{
    remote_client::RemoteClient,
    vibe_orchestrator::{TAG_BLOCK, VibePhase},
    vibe_tags,
};
use sqlx::SqlitePool;
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
    let client = deployment.remote_client().ok();
    block_orphaned_runs(pool, Utc::now(), client.as_ref()).await
}

async fn block_orphaned_runs(
    pool: &SqlitePool,
    now: DateTime<Utc>,
    client: Option<&RemoteClient>,
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
        let latest_execution_activity_at =
            latest_execution_activity.get(&run.workspace_id).cloned();
        if !should_escalate(is_active, run.updated_at, latest_execution_activity_at, now) {
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

        block_orphaned_runs(&pool, now, None).await.unwrap();

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
                bounds: VibeBounds::default(),
            }),
            VibeAction::AttemptMerge { retry: 0 }
        );
    }

    #[tokio::test]
    async fn stale_run_without_recent_execution_is_blocked() {
        let pool = test_pool().await;
        let now = ts("2026-06-19T12:00:00Z");
        let (workspace_id, _) = seed_review_run(&pool, ts("2026-06-19T11:30:00Z")).await;

        block_orphaned_runs(&pool, now, None).await.unwrap();
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
