use chrono::{DateTime, Utc};
use executors::profile::ExecutorConfig;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool, types::Json};
use thiserror::Error;
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum VibeRunError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

/// Per-workspace orchestration state for the automated `vibe` workflow.
///
/// `phase` is one of `coding | review | merging | pushing | creating_pr |
/// blocked | done` (kept as a plain string here so the `db` crate stays free of
/// the `services`-level `VibePhase` enum; the orchestrator maps between them).
#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct VibeRun {
    pub workspace_id: Uuid,
    pub task_id: Uuid,
    pub phase: String,
    /// A new review or claimed retry invalidates older workers and requests.
    pub generation: i64,
    pub review_session_id: Option<Uuid>,
    pub coding_turns: i64,
    pub review_turns: i64,
    pub merge_retries: i64,
    /// Canonical sentinel token (done/blocked/continue/approve) captured from
    /// the agent's full final message at coding completion; consumed and cleared
    /// by the next finalize.
    pub last_result: Option<String>,
    /// Why the last merge attempt failed (git's message plus who holds the
    /// blocking checkout), kept until the merge lands; or why the follow-up
    /// named by `failed_phase` stopped.
    pub last_error: Option<String>,
    /// First failure of the current merge wait; `None` when not waiting.
    pub merge_wait_since: Option<DateTime<Utc>>,
    pub merge_wait_attempts: i64,
    /// When the waiting merge is tried again.
    pub merge_retry_at: Option<DateTime<Utc>>,
    /// "Review and create PR": once the merge lands the server pushes the
    /// target branch (`pushing`) and opens a draft PR (`creating_pr`).
    pub pr_requested: bool,
    /// Agent config the PR text is drafted with, as the `ExecutorConfig` JSON
    /// recorded when the review began; read it with
    /// [`Self::pr_draft_config`]. Kept untyped so that a config written before
    /// an executor or a policy was renamed still loads: a row that failed to
    /// decode would take every read of the run down with it.
    pub pr_executor_config: Option<Json<serde_json::Value>>,
    pub pr_bases: Option<Json<Vec<PrBase>>>,
    /// The follow-up phase (`pushing` / `creating_pr`) a blocked run stopped
    /// in, where a retry resumes. `None` for every other block.
    pub failed_phase: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// What a review is asked to do after its merge: push the target branch and
/// open a draft PR whose text `executor_config` drafts (`None`: the workspace's
/// latest agent config).
#[derive(Debug, Clone, Default)]
pub struct PrRequest {
    pub executor_config: Option<ExecutorConfig>,
    pub bases: Vec<PrBase>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
pub struct PrBaseSelection {
    pub repo_id: Uuid,
    pub base_branch: String,
}

/// The final PR base and the independently confirmed local merge destination.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
pub struct PrBase {
    pub repo_id: Uuid,
    pub base_branch: String,
    pub target_branch: String,
}

/// A merge waiting for its next try.
#[derive(Debug, Clone, Copy)]
pub struct MergeWait {
    pub since: DateTime<Utc>,
    pub attempts: i64,
    pub retry_at: DateTime<Utc>,
}

impl VibeRun {
    /// The agent config the PR text is drafted with. `None` — nothing was
    /// recorded, or what was no longer names a known config — drafts with the
    /// workspace's latest.
    pub fn pr_draft_config(&self) -> Option<ExecutorConfig> {
        let config = self.pr_executor_config.as_ref()?;
        serde_json::from_value(config.0.clone()).ok()
    }

    const COLUMNS: &'static str = "workspace_id, task_id, phase, generation, review_session_id, \
         coding_turns, review_turns, merge_retries, last_result, last_error, merge_wait_since, \
         merge_wait_attempts, merge_retry_at, pr_requested, pr_executor_config, pr_bases, failed_phase, \
         created_at, updated_at";

    /// Fetch-or-initialize the run row for a workspace. New rows start in the
    /// `coding` phase. Idempotent: an existing row is returned unchanged.
    pub async fn get_or_create(
        pool: &SqlitePool,
        workspace_id: Uuid,
        task_id: Uuid,
    ) -> Result<Self, VibeRunError> {
        sqlx::query("INSERT OR IGNORE INTO vibe_runs (workspace_id, task_id) VALUES (?, ?)")
            .bind(workspace_id)
            .bind(task_id)
            .execute(pool)
            .await?;

        Self::find_by_workspace_id(pool, workspace_id)
            .await?
            .ok_or(VibeRunError::Database(sqlx::Error::RowNotFound))
    }

    pub async fn find_by_workspace_id(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<Option<Self>, VibeRunError> {
        let row = sqlx::query_as::<_, Self>(&format!(
            "SELECT {} FROM vibe_runs WHERE workspace_id = ?",
            Self::COLUMNS
        ))
        .bind(workspace_id)
        .fetch_optional(pool)
        .await?;
        Ok(row)
    }

    /// Row behind a SQLite update hook notification.
    pub async fn find_by_rowid(
        pool: &SqlitePool,
        rowid: i64,
    ) -> Result<Option<Self>, VibeRunError> {
        let row = sqlx::query_as::<_, Self>(&format!(
            "SELECT {} FROM vibe_runs WHERE rowid = ?",
            Self::COLUMNS
        ))
        .bind(rowid)
        .fetch_optional(pool)
        .await?;
        Ok(row)
    }

    /// All runs not in a terminal phase (`blocked`/`done`). Used by the
    /// orphan-recovery watcher to detect runs that may have stalled.
    pub async fn find_non_terminal(pool: &SqlitePool) -> Result<Vec<Self>, VibeRunError> {
        let rows = sqlx::query_as::<_, Self>(&format!(
            "SELECT {} FROM vibe_runs WHERE phase NOT IN ('blocked', 'done')",
            Self::COLUMNS
        ))
        .fetch_all(pool)
        .await?;
        Ok(rows)
    }

    /// Runs whose merge landed and whose push / PR follow-up is still owed.
    pub async fn find_in_follow_up(pool: &SqlitePool) -> Result<Vec<Self>, VibeRunError> {
        let rows = sqlx::query_as::<_, Self>(&format!(
            "SELECT {} FROM vibe_runs WHERE phase IN ('pushing', 'creating_pr')",
            Self::COLUMNS
        ))
        .fetch_all(pool)
        .await?;
        Ok(rows)
    }

    /// Move to `phase`. Not for a follow-up failure, which keeps the phase it
    /// stopped in ([`Self::block_follow_up`]): this clears it.
    pub async fn set_phase(
        pool: &SqlitePool,
        workspace_id: Uuid,
        phase: &str,
    ) -> Result<(), VibeRunError> {
        sqlx::query(
            "UPDATE vibe_runs SET phase = ?, failed_phase = NULL, \
                 updated_at = datetime('now','subsec') \
             WHERE workspace_id = ?",
        )
        .bind(phase)
        .bind(workspace_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Move to the review phase and record the dedicated review session. Also
    /// clears `last_result` so the fresh review verdict drives the merge
    /// decision — a stale token (e.g. an earlier `approve`) must not survive into
    /// the new review and short-circuit it straight to a merge. An earlier
    /// merge failure and its wait end with it. `pr` is what this review is
    /// asked to do once its merge lands; an earlier review's request ends too.
    pub async fn begin_review(
        pool: &SqlitePool,
        workspace_id: Uuid,
        review_session_id: Uuid,
        pr: Option<&PrRequest>,
    ) -> Result<(), VibeRunError> {
        sqlx::query(
            "UPDATE vibe_runs \
             SET phase = 'review', generation = generation + 1, review_session_id = ?, review_turns = 0, \
                 last_result = NULL, last_error = NULL, merge_wait_since = NULL, \
                 merge_wait_attempts = 0, merge_retry_at = NULL, \
                 pr_requested = ?, pr_executor_config = ?, pr_bases = ?, failed_phase = NULL, \
                 updated_at = datetime('now','subsec') \
             WHERE workspace_id = ?",
        )
        .bind(review_session_id)
        .bind(pr.is_some())
        .bind(
            pr.and_then(|pr| pr.executor_config.as_ref())
                .and_then(|config| serde_json::to_value(config).ok())
                .map(Json),
        )
        .bind(pr.map(|pr| Json(&pr.bases)))
        .bind(workspace_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn set_coding_turns(
        pool: &SqlitePool,
        workspace_id: Uuid,
        coding_turns: i64,
    ) -> Result<(), VibeRunError> {
        sqlx::query(
            "UPDATE vibe_runs SET coding_turns = ?, updated_at = datetime('now','subsec') \
             WHERE workspace_id = ?",
        )
        .bind(coding_turns)
        .bind(workspace_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn set_review_turns(
        pool: &SqlitePool,
        workspace_id: Uuid,
        review_turns: i64,
    ) -> Result<(), VibeRunError> {
        sqlx::query(
            "UPDATE vibe_runs SET review_turns = ?, updated_at = datetime('now','subsec') \
             WHERE workspace_id = ?",
        )
        .bind(review_turns)
        .bind(workspace_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Start only the attempt that still owns this review/retry generation.
    pub async fn begin_merge(
        pool: &SqlitePool,
        run: &Self,
        retries: i64,
    ) -> Result<bool, VibeRunError> {
        let done = sqlx::query(
            "UPDATE vibe_runs SET phase = 'merging', failed_phase = NULL, merge_retries = ?, \
                 updated_at = datetime('now','subsec') \
             WHERE workspace_id = ? AND generation = ? AND phase = ?",
        )
        .bind(retries)
        .bind(run.workspace_id)
        .bind(run.generation)
        .bind(&run.phase)
        .execute(pool)
        .await?;
        Ok(done.rows_affected() > 0)
    }

    pub async fn set_merge_retries(
        pool: &SqlitePool,
        workspace_id: Uuid,
        generation: i64,
        merge_retries: i64,
    ) -> Result<(), VibeRunError> {
        sqlx::query(
            "UPDATE vibe_runs SET merge_retries = ?, updated_at = datetime('now','subsec') \
             WHERE workspace_id = ? AND generation = ?",
        )
        .bind(merge_retries)
        .bind(workspace_id)
        .bind(generation)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Record a failed merge attempt in `phase`. With `wait` the run waits for
    /// another try; without it any wait is over.
    pub async fn record_merge_failure(
        pool: &SqlitePool,
        workspace_id: Uuid,
        generation: i64,
        phase: &str,
        last_error: &str,
        wait: Option<&MergeWait>,
    ) -> Result<bool, VibeRunError> {
        let done = sqlx::query(
            "UPDATE vibe_runs SET phase = ?, last_error = ?, merge_wait_since = ?, \
                 merge_wait_attempts = ?, merge_retry_at = ?, failed_phase = NULL, \
                 updated_at = datetime('now','subsec') \
             WHERE workspace_id = ? AND generation = ?",
        )
        .bind(phase)
        .bind(last_error)
        .bind(wait.map(|w| w.since))
        .bind(wait.map_or(0, |w| w.attempts))
        .bind(wait.map(|w| w.retry_at))
        .bind(workspace_id)
        .bind(generation)
        .execute(pool)
        .await?;
        Ok(done.rows_affected() > 0)
    }

    /// The merge landed, with the failure and any wait cleared: done, or on to
    /// `pushing` when the run was asked for a PR.
    pub async fn finish_merge(
        pool: &SqlitePool,
        workspace_id: Uuid,
        generation: i64,
    ) -> Result<bool, VibeRunError> {
        let done = sqlx::query(
            "UPDATE vibe_runs \
             SET phase = CASE WHEN pr_requested THEN 'pushing' ELSE 'done' END, \
                 last_error = NULL, merge_wait_since = NULL, \
                 merge_wait_attempts = 0, merge_retry_at = NULL, failed_phase = NULL, \
                 updated_at = datetime('now','subsec') \
             WHERE workspace_id = ? AND generation = ?",
        )
        .bind(workspace_id)
        .bind(generation)
        .execute(pool)
        .await?;
        Ok(done.rows_affected() > 0)
    }

    /// A follow-up step finished: move from `from` to `to`. `false` when the
    /// run is no longer in `from` (a new review took it over) and was left
    /// alone.
    pub async fn advance_follow_up(
        pool: &SqlitePool,
        workspace_id: Uuid,
        from: &str,
        generation: i64,
        to: &str,
    ) -> Result<bool, VibeRunError> {
        let done = sqlx::query(
            "UPDATE vibe_runs SET phase = ?, last_error = NULL, failed_phase = NULL, \
                 updated_at = datetime('now','subsec') \
             WHERE workspace_id = ? AND phase = ? AND generation = ?",
        )
        .bind(to)
        .bind(workspace_id)
        .bind(from)
        .bind(generation)
        .execute(pool)
        .await?;
        Ok(done.rows_affected() > 0)
    }

    /// The follow-up step `from` failed: blocked, remembering the step and why.
    /// `false` when the run is no longer in `from` and was left alone.
    pub async fn block_follow_up(
        pool: &SqlitePool,
        workspace_id: Uuid,
        from: &str,
        generation: i64,
        last_error: &str,
    ) -> Result<bool, VibeRunError> {
        let done = sqlx::query(
            "UPDATE vibe_runs SET phase = 'blocked', last_error = ?, failed_phase = ?, \
                 updated_at = datetime('now','subsec') \
             WHERE workspace_id = ? AND phase = ? AND generation = ?",
        )
        .bind(last_error)
        .bind(from)
        .bind(workspace_id)
        .bind(from)
        .bind(generation)
        .execute(pool)
        .await?;
        Ok(done.rows_affected() > 0)
    }

    /// Claim one retry and its destinations together. A competing request must
    /// neither replace the winner's bases nor resume an already claimed step.
    pub async fn retry(
        pool: &SqlitePool,
        expected: &Self,
        bases: Option<&[PrBase]>,
    ) -> Result<bool, VibeRunError> {
        let done = sqlx::query(
            "UPDATE vibe_runs SET phase = COALESCE(failed_phase, 'merging'), \
                 pr_bases = CASE WHEN ? THEN ? ELSE pr_bases END, \
                 generation = generation + 1, last_error = NULL, failed_phase = NULL, \
                 merge_retry_at = NULL, updated_at = datetime('now','subsec') \
             WHERE workspace_id = ? AND generation = ? AND phase = ? \
                 AND phase IN ('blocked', 'merging') AND last_error IS NOT NULL \
                 AND review_session_id IS NOT NULL",
        )
        .bind(bases.is_some())
        .bind(bases.map(Json))
        .bind(expected.workspace_id)
        .bind(expected.generation)
        .bind(&expected.phase)
        .execute(pool)
        .await?;
        Ok(done.rows_affected() > 0)
    }

    /// Record (or clear, with `None`) the agent's latest sentinel token.
    pub async fn set_last_result(
        pool: &SqlitePool,
        workspace_id: Uuid,
        last_result: Option<&str>,
    ) -> Result<(), VibeRunError> {
        sqlx::query(
            "UPDATE vibe_runs SET last_result = ?, updated_at = datetime('now','subsec') \
             WHERE workspace_id = ?",
        )
        .bind(last_result)
        .bind(workspace_id)
        .execute(pool)
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use executors::executors::BaseCodingAgent;
    use sqlx::sqlite::SqlitePoolOptions;

    use super::*;

    async fn run_in_review(pr: Option<&PrRequest>) -> (SqlitePool, Uuid) {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let (workspace_id, session_id) = (Uuid::new_v4(), Uuid::new_v4());
        sqlx::query("INSERT INTO workspaces (id, branch) VALUES (?, 'vk/test')")
            .bind(workspace_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sessions (id, workspace_id) VALUES (?, ?)")
            .bind(session_id)
            .bind(workspace_id)
            .execute(&pool)
            .await
            .unwrap();
        VibeRun::get_or_create(&pool, workspace_id, Uuid::new_v4())
            .await
            .unwrap();
        VibeRun::begin_review(&pool, workspace_id, session_id, pr)
            .await
            .unwrap();
        (pool, workspace_id)
    }

    async fn run(pool: &SqlitePool, workspace_id: Uuid) -> VibeRun {
        VibeRun::find_by_workspace_id(pool, workspace_id)
            .await
            .unwrap()
            .unwrap()
    }

    /// The merge of a "review and create PR" run is not its end: it goes on to
    /// the push, with the agent config the PR is to be drafted with. A plain
    /// review ends at its merge, as before.
    #[tokio::test]
    async fn a_merge_ends_the_run_unless_a_pr_was_asked_for() {
        let (pool, plain) = run_in_review(None).await;
        VibeRun::finish_merge(&pool, plain, run(&pool, plain).await.generation)
            .await
            .unwrap();
        let done = run(&pool, plain).await;
        assert_eq!(done.phase, "done");
        assert!(!done.pr_requested && done.pr_executor_config.is_none());

        let request = PrRequest {
            executor_config: Some(ExecutorConfig::new(BaseCodingAgent::ClaudeCode)),
            bases: vec![],
        };
        let (pool, with_pr) = run_in_review(Some(&request)).await;
        VibeRun::finish_merge(&pool, with_pr, run(&pool, with_pr).await.generation)
            .await
            .unwrap();
        let pushing = run(&pool, with_pr).await;
        assert_eq!(pushing.phase, "pushing");
        assert!(pushing.pr_requested);
        assert_eq!(
            pushing.pr_draft_config().map(|config| config.executor),
            Some(BaseCodingAgent::ClaudeCode)
        );
        assert_eq!(
            VibeRun::find_in_follow_up(&pool).await.unwrap().len(),
            1,
            "the follow-up finds it by its phase"
        );

        // The next review of the workspace is a plain one again.
        let session = run(&pool, with_pr).await.review_session_id.unwrap();
        VibeRun::begin_review(&pool, with_pr, session, None)
            .await
            .unwrap();
        VibeRun::finish_merge(&pool, with_pr, run(&pool, with_pr).await.generation)
            .await
            .unwrap();
        let done = run(&pool, with_pr).await;
        assert_eq!(done.phase, "done");
        assert!(!done.pr_requested && done.pr_executor_config.is_none());
    }

    /// A recorded config that no longer parses (an executor or a policy was
    /// renamed since) must not make the run unreadable: every read of it, the
    /// watcher's and the follow-up's scans included, would fail with it. The
    /// PR is then drafted with the workspace's latest config.
    #[tokio::test]
    async fn a_run_survives_a_draft_config_it_can_no_longer_read() {
        let (pool, id) = run_in_review(Some(&PrRequest::default())).await;
        sqlx::query(
            "UPDATE vibe_runs SET phase = 'pushing', \
                 pr_executor_config = '{\"executor\":\"AGENT_SINCE_REMOVED\"}'",
        )
        .execute(&pool)
        .await
        .unwrap();

        let stale = run(&pool, id).await;
        assert!(stale.pr_requested);
        assert_eq!(stale.pr_draft_config(), None);
        assert_eq!(VibeRun::find_in_follow_up(&pool).await.unwrap().len(), 1);
        assert_eq!(VibeRun::find_non_terminal(&pool).await.unwrap().len(), 1);
    }

    /// A follow-up step only moves the run it started on, and a block there
    /// remembers the step so the retry resumes it. Any other change of phase —
    /// a new merge attempt, its failure, a block by the review — forgets that
    /// step: such a run must merge again first.
    #[tokio::test]
    async fn only_a_follow_up_block_is_resumed_at_its_step() {
        let (pool, id) = run_in_review(Some(&PrRequest::default())).await;
        // Not in the follow-up yet: its transitions leave the run alone.
        assert!(
            !VibeRun::advance_follow_up(
                &pool,
                id,
                "pushing",
                run(&pool, id).await.generation,
                "creating_pr"
            )
            .await
            .unwrap()
        );
        assert!(
            !VibeRun::block_follow_up(
                &pool,
                id,
                "pushing",
                run(&pool, id).await.generation,
                "nope"
            )
            .await
            .unwrap()
        );
        assert!(
            !VibeRun::retry(&pool, &run(&pool, id).await, None)
                .await
                .unwrap()
        );
        assert_eq!(run(&pool, id).await.phase, "review");

        VibeRun::finish_merge(&pool, id, run(&pool, id).await.generation)
            .await
            .unwrap();
        assert!(
            VibeRun::block_follow_up(
                &pool,
                id,
                "pushing",
                run(&pool, id).await.generation,
                "diverged"
            )
            .await
            .unwrap()
        );
        let blocked = run(&pool, id).await;
        assert_eq!(
            (
                blocked.phase.as_str(),
                blocked.last_error.as_deref(),
                blocked.failed_phase.as_deref()
            ),
            ("blocked", Some("diverged"), Some("pushing"))
        );
        assert!(
            VibeRun::retry(&pool, &run(&pool, id).await, None)
                .await
                .unwrap()
        );
        assert_eq!(run(&pool, id).await.phase, "pushing");
        assert!(
            VibeRun::advance_follow_up(
                &pool,
                id,
                "pushing",
                run(&pool, id).await.generation,
                "creating_pr"
            )
            .await
            .unwrap()
        );

        // Blocked at the PR, then re-approved: the merge runs again and fails.
        // The retry must merge, not skip to the PR.
        assert!(
            VibeRun::block_follow_up(
                &pool,
                id,
                "creating_pr",
                run(&pool, id).await.generation,
                "gh: not logged in"
            )
            .await
            .unwrap()
        );
        VibeRun::set_phase(&pool, id, "merging").await.unwrap();
        assert!(run(&pool, id).await.failed_phase.is_none());
        VibeRun::record_merge_failure(
            &pool,
            id,
            run(&pool, id).await.generation,
            "blocked",
            "merge conflict",
            None,
        )
        .await
        .unwrap();
        assert!(
            VibeRun::retry(&pool, &run(&pool, id).await, None)
                .await
                .unwrap()
        );
        let merge_blocked = run(&pool, id).await;
        assert_eq!(merge_blocked.phase, "merging");
        assert_eq!(merge_blocked.last_error, None);
    }
    #[tokio::test]
    async fn concurrent_retries_cannot_replace_the_winners_bases_or_claim_a_later_failure() {
        let (pool, id) = run_in_review(Some(&PrRequest::default())).await;
        VibeRun::finish_merge(&pool, id, run(&pool, id).await.generation)
            .await
            .unwrap();
        let pushing = run(&pool, id).await;
        VibeRun::block_follow_up(
            &pool,
            id,
            "pushing",
            pushing.generation,
            "synthetic failure",
        )
        .await
        .unwrap();
        let expected = run(&pool, id).await;
        let base = |branch: &str| {
            vec![PrBase {
                repo_id: Uuid::nil(),
                base_branch: branch.into(),
                target_branch: "feature/example".into(),
            }]
        };
        let first = base("integration");
        let second = base("release/example");
        let (a, b) = tokio::join!(
            VibeRun::retry(&pool, &expected, Some(&first)),
            VibeRun::retry(&pool, &expected, Some(&second))
        );
        let (a, b) = (a.unwrap(), b.unwrap());
        assert_ne!(a, b);
        let winner = run(&pool, id).await;
        assert!(!VibeRun::begin_merge(&pool, &expected, 0).await.unwrap());
        assert!(
            !VibeRun::finish_merge(&pool, id, expected.generation)
                .await
                .unwrap()
        );
        assert!(
            !VibeRun::record_merge_failure(
                &pool,
                id,
                expected.generation,
                "blocked",
                "stale validation",
                None
            )
            .await
            .unwrap()
        );
        assert_eq!(winner.phase, "pushing");
        assert_eq!(
            winner.pr_bases.as_ref().unwrap().0,
            if a { first } else { second }
        );
        assert!(
            !VibeRun::block_follow_up(&pool, id, "pushing", expected.generation, "stale worker")
                .await
                .unwrap()
        );
        VibeRun::block_follow_up(&pool, id, "pushing", winner.generation, "synthetic failure")
            .await
            .unwrap();
        assert!(
            !VibeRun::retry(&pool, &expected, Some(&base("stale")))
                .await
                .unwrap()
        );
        assert_eq!(run(&pool, id).await.pr_bases, winner.pr_bases);
    }
}
