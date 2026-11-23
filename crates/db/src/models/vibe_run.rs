use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};

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
    /// The run goes on to a PR after its merge: asked for by "Review and
    /// create PR", or set when the worker's `publish-pr` starts the push
    /// (`pushing`) and the draft PR (`creating_pr`).
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
    /// The latest `vibe.*` event the automation worker has not acted on yet
    /// (its payload, with an `id` the answering action names). The worker
    /// decides the next step; nothing in the server does.
    pub pending: Option<Json<serde_json::Value>>,
    /// The kind of the prompt the worker last sent into the run, until the
    /// turn it started is reported (`plan_review`, ...); `None` for a turn
    /// nobody prompted.
    pub last_prompt: Option<String>,
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
    /// Serialize generation changes with Git/PR effects and recheck the run
    /// under this guard. If a checkout lock is needed too, acquire it first.
    pub async fn lock_generation(workspace_id: Uuid) -> tokio::sync::OwnedMutexGuard<()> {
        static LOCKS: OnceLock<Mutex<HashMap<Uuid, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
        let lock = LOCKS
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .entry(workspace_id)
            .or_default()
            .clone();
        lock.lock_owned().await
    }

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
         pending, last_prompt, created_at, updated_at";

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
    /// watcher to find merges whose scheduled retry is due.
    pub async fn find_non_terminal(pool: &SqlitePool) -> Result<Vec<Self>, VibeRunError> {
        let rows = sqlx::query_as::<_, Self>(&format!(
            "SELECT {} FROM vibe_runs WHERE phase NOT IN ('blocked', 'done')",
            Self::COLUMNS
        ))
        .fetch_all(pool)
        .await?;
        Ok(rows)
    }

    /// What the automation worker reconciles: every run still under way, and
    /// any run with an event it has not acted on.
    pub async fn find_for_automation(pool: &SqlitePool) -> Result<Vec<Self>, VibeRunError> {
        let rows = sqlx::query_as::<_, Self>(&format!(
            "SELECT {} FROM vibe_runs \
             WHERE phase NOT IN ('blocked', 'done') OR pending IS NOT NULL",
            Self::COLUMNS
        ))
        .fetch_all(pool)
        .await?;
        Ok(rows)
    }

    /// The id of the event awaiting a decision, if any.
    pub fn pending_id(&self) -> Option<&str> {
        self.pending.as_ref()?.0.get("id")?.as_str()
    }

    /// Record `event` (a `vibe.*` payload with an `id`) as the decision the
    /// worker owes this run, if the run is still at `generation`: an outcome
    /// of a run a newer review took over is nobody's to decide on. A newer
    /// event replaces an unanswered one. `updated_at` keeps meaning when the
    /// run entered its phase.
    pub async fn set_pending(
        pool: &SqlitePool,
        workspace_id: Uuid,
        generation: i64,
        event: &serde_json::Value,
    ) -> Result<bool, VibeRunError> {
        let done = sqlx::query(
            "UPDATE vibe_runs SET pending = ? WHERE workspace_id = ? AND generation = ?",
        )
        .bind(Json(event))
        .bind(workspace_id)
        .bind(generation)
        .execute(pool)
        .await?;
        Ok(done.rows_affected() > 0)
    }

    /// Take the decision an action answers: the run must still stand at
    /// `generation` and `phase` with event `pending_id` unanswered (`None`:
    /// with nothing unanswered). `false` leaves the run alone: the action
    /// came late, or for another run's state.
    pub async fn take_pending(
        pool: &SqlitePool,
        workspace_id: Uuid,
        generation: i64,
        phase: &str,
        pending_id: Option<&str>,
    ) -> Result<bool, VibeRunError> {
        let done = sqlx::query(
            "UPDATE vibe_runs SET pending = NULL \
             WHERE workspace_id = ? AND generation = ? AND phase = ? \
               AND ((? IS NULL AND pending IS NULL) OR json_extract(pending, '$.id') = ?)",
        )
        .bind(workspace_id)
        .bind(generation)
        .bind(phase)
        .bind(pending_id)
        .bind(pending_id)
        .execute(pool)
        .await?;
        Ok(done.rows_affected() > 0)
    }

    /// Put back a decision whose action failed before it changed anything, so
    /// the worker's reconciliation asks again; a newer event wins.
    pub async fn restore_pending(
        pool: &SqlitePool,
        workspace_id: Uuid,
        event: &serde_json::Value,
    ) -> Result<(), VibeRunError> {
        sqlx::query("UPDATE vibe_runs SET pending = ? WHERE workspace_id = ? AND pending IS NULL")
            .bind(Json(event))
            .bind(workspace_id)
            .execute(pool)
            .await?;
        Ok(())
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
        let _generation = Self::lock_generation(workspace_id).await;
        sqlx::query(
            "UPDATE vibe_runs \
             SET phase = 'review', generation = generation + 1, review_session_id = ?, review_turns = 0, \
                 last_result = NULL, last_error = NULL, merge_wait_since = NULL, \
                 merge_wait_attempts = 0, merge_retry_at = NULL, \
                 pr_requested = ?, pr_executor_config = ?, pr_bases = ?, failed_phase = NULL, \
                 pending = NULL, last_prompt = NULL, updated_at = datetime('now','subsec') \
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

    /// The merge landed, with the failure and any wait cleared. What comes
    /// after it (the issue to In review, or the push and the PR) is the
    /// automation worker's call.
    pub async fn finish_merge(
        pool: &SqlitePool,
        workspace_id: Uuid,
        generation: i64,
    ) -> Result<bool, VibeRunError> {
        let done = sqlx::query(
            "UPDATE vibe_runs \
             SET phase = 'done', \
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

    /// Start the push / PR follow-up of a merged run at `generation`. A run
    /// started as "review and create PR" keeps the bases it confirmed then;
    /// any other takes `bases`. `false` when the run moved on meanwhile.
    pub async fn begin_follow_up(
        pool: &SqlitePool,
        workspace_id: Uuid,
        generation: i64,
        bases: Option<&[PrBase]>,
    ) -> Result<bool, VibeRunError> {
        let _generation = Self::lock_generation(workspace_id).await;
        let done = sqlx::query(
            "UPDATE vibe_runs SET phase = 'pushing', pr_requested = 1, \
                 pr_bases = COALESCE(pr_bases, ?), last_error = NULL, failed_phase = NULL, \
                 updated_at = datetime('now','subsec') \
             WHERE workspace_id = ? AND generation = ? AND phase = 'done'",
        )
        .bind(bases.map(Json))
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

    /// A merge that was to end in a pull request was not started: the PR could
    /// not come from where it would merge (a workspace that targets the PR
    /// base itself). Blocked with `last_error`, and marked as a PR run so that
    /// Retry checks the destination again before it merges. `false` when the
    /// run moved on.
    pub async fn block_pr_merge(
        pool: &SqlitePool,
        workspace_id: Uuid,
        generation: i64,
        last_error: &str,
    ) -> Result<bool, VibeRunError> {
        let _generation = Self::lock_generation(workspace_id).await;
        let done = sqlx::query(
            "UPDATE vibe_runs SET phase = 'blocked', last_error = ?, pr_requested = 1, \
                 failed_phase = NULL, updated_at = datetime('now','subsec') \
             WHERE workspace_id = ? AND generation = ?",
        )
        .bind(last_error)
        .bind(workspace_id)
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
    /// neither replace the winner's bases nor resume an already claimed step,
    /// and a caller that saw no pending event does not drop one that arrived since.
    pub async fn retry(
        pool: &SqlitePool,
        expected: &Self,
        bases: Option<&[PrBase]>,
    ) -> Result<bool, VibeRunError> {
        let _generation = Self::lock_generation(expected.workspace_id).await;
        let done = sqlx::query(
            "UPDATE vibe_runs SET phase = COALESCE(failed_phase, 'merging'), \
                 pr_bases = CASE WHEN ? THEN ? ELSE pr_bases END, \
                 generation = generation + 1, last_error = NULL, failed_phase = NULL, \
                 merge_retry_at = NULL, pending = NULL, updated_at = datetime('now','subsec') \
             WHERE workspace_id = ? AND generation = ? AND phase = ? \
                 AND phase IN ('blocked', 'merging') AND last_error IS NOT NULL \
                 AND review_session_id IS NOT NULL AND (? OR pending IS NULL)",
        )
        .bind(bases.is_some())
        .bind(bases.map(Json))
        .bind(expected.workspace_id)
        .bind(expected.generation)
        .bind(&expected.phase)
        .bind(expected.pending.is_some())
        .execute(pool)
        .await?;
        Ok(done.rows_affected() > 0)
    }

    /// Record (or clear, with `None`) the kind of the prompt just sent into
    /// the run; the turn it started reports it.
    pub async fn set_last_prompt(
        pool: &SqlitePool,
        workspace_id: Uuid,
        last_prompt: Option<&str>,
    ) -> Result<(), VibeRunError> {
        sqlx::query("UPDATE vibe_runs SET last_prompt = ? WHERE workspace_id = ?")
            .bind(last_prompt)
            .bind(workspace_id)
            .execute(pool)
            .await?;
        Ok(())
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

    // A PR run whose destination was refused before its merge can be retried
    // (it has an error and a review), and Retry knows it is a PR run.
    #[tokio::test]
    async fn a_pr_merge_refused_before_merging_is_a_retryable_pr_run() {
        let (pool, id) = run_in_review(None).await;
        let reviewed = run(&pool, id).await;
        assert!(
            !VibeRun::block_pr_merge(&pool, id, reviewed.generation - 1, "stale")
                .await
                .unwrap()
        );
        assert!(
            VibeRun::block_pr_merge(&pool, id, reviewed.generation, "synthetic head is base")
                .await
                .unwrap()
        );
        let blocked = run(&pool, id).await;
        assert_eq!(blocked.phase, "blocked");
        assert_eq!(
            blocked.last_error.as_deref(),
            Some("synthetic head is base")
        );
        assert!(blocked.pr_requested && blocked.pr_bases.is_none());
        assert_eq!(blocked.failed_phase, None);
        // Retry merges again (no failed follow-up step to resume).
        assert!(VibeRun::retry(&pool, &blocked, None).await.unwrap());
        assert_eq!(run(&pool, id).await.phase, "merging");
    }

    #[tokio::test]
    async fn reviews_and_retries_wait_for_git_effects_in_their_workspace() {
        use std::time::Duration;

        use tokio::time::timeout;

        let (pool, id) = run_in_review(None).await;
        let original = run(&pool, id).await;
        let held = VibeRun::lock_generation(id).await;
        let other = timeout(
            Duration::from_secs(1),
            VibeRun::lock_generation(Uuid::new_v4()),
        )
        .await
        .expect("another workspace must remain independent");
        drop(other);
        let review = VibeRun::begin_review(&pool, id, original.review_session_id.unwrap(), None);
        tokio::pin!(review);
        assert!(
            timeout(Duration::from_millis(50), &mut review)
                .await
                .is_err()
        );
        assert_eq!(run(&pool, id).await.generation, original.generation);
        drop(held);
        timeout(Duration::from_secs(1), review)
            .await
            .unwrap()
            .unwrap();

        let reviewed = run(&pool, id).await;
        VibeRun::record_merge_failure(
            &pool,
            id,
            reviewed.generation,
            "blocked",
            "synthetic failure",
            None,
        )
        .await
        .unwrap();
        let blocked = run(&pool, id).await;
        // An event that arrived after the caller looked is not dropped by its
        // retry; one the caller saw is answered by it.
        let event = serde_json::json!({ "id": "e" });
        assert!(
            VibeRun::set_pending(&pool, id, blocked.generation, &event)
                .await
                .unwrap()
        );
        assert!(!VibeRun::retry(&pool, &blocked, None).await.unwrap());
        let blocked = run(&pool, id).await;
        assert!(blocked.pending.is_some());
        let held = VibeRun::lock_generation(id).await;
        let retry = VibeRun::retry(&pool, &blocked, None);
        tokio::pin!(retry);
        assert!(
            timeout(Duration::from_millis(50), &mut retry)
                .await
                .is_err()
        );
        assert_eq!(run(&pool, id).await.generation, blocked.generation);
        drop(held);
        assert!(
            timeout(Duration::from_secs(1), retry)
                .await
                .unwrap()
                .unwrap()
        );
        assert_eq!(run(&pool, id).await.generation, blocked.generation + 1);
    }

    /// A merge ends at `done` whatever the run asked for: whether the push and
    /// the PR follow is the worker's call, and its start keeps the bases the
    /// run confirmed (a run that confirmed none takes the given ones).
    #[tokio::test]
    async fn a_merge_ends_at_done_and_the_follow_up_starts_only_when_asked() {
        let (pool, plain) = run_in_review(None).await;
        VibeRun::finish_merge(&pool, plain, run(&pool, plain).await.generation)
            .await
            .unwrap();
        let done = run(&pool, plain).await;
        assert_eq!(done.phase, "done");
        assert!(!done.pr_requested && done.pr_bases.is_none());

        let given = vec![PrBase {
            repo_id: Uuid::nil(),
            base_branch: "main".into(),
            target_branch: "feature/example".into(),
        }];
        // A stale generation, or a run not merged yet, does not move.
        assert!(
            !VibeRun::begin_follow_up(&pool, plain, done.generation + 1, Some(&given))
                .await
                .unwrap()
        );
        assert!(
            VibeRun::begin_follow_up(&pool, plain, done.generation, Some(&given))
                .await
                .unwrap()
        );
        let pushing = run(&pool, plain).await;
        assert_eq!(pushing.phase, "pushing");
        assert!(pushing.pr_requested);
        assert_eq!(pushing.pr_bases.unwrap().0, given);
        assert_eq!(VibeRun::find_in_follow_up(&pool).await.unwrap().len(), 1);

        let confirmed = vec![PrBase {
            base_branch: "integration".into(),
            ..given[0].clone()
        }];
        let request = PrRequest {
            executor_config: Some(ExecutorConfig::new(BaseCodingAgent::ClaudeCode)),
            bases: confirmed.clone(),
        };
        let (pool, with_pr) = run_in_review(Some(&request)).await;
        let generation = run(&pool, with_pr).await.generation;
        VibeRun::finish_merge(&pool, with_pr, generation)
            .await
            .unwrap();
        assert_eq!(run(&pool, with_pr).await.phase, "done");
        assert!(
            VibeRun::begin_follow_up(&pool, with_pr, generation, Some(&given))
                .await
                .unwrap()
        );
        let pushing = run(&pool, with_pr).await;
        assert_eq!(pushing.pr_bases.as_ref().unwrap().0, confirmed);
        assert_eq!(
            pushing.pr_draft_config().map(|config| config.executor),
            Some(BaseCodingAgent::ClaudeCode)
        );
    }

    /// An action answers one event: a late or repeated answer, or one for
    /// another generation or phase, leaves the run alone. A newer event
    /// replaces an unanswered one, and a failed action puts its event back
    /// only when nothing newer arrived.
    #[tokio::test]
    async fn an_action_takes_only_the_event_it_answers() {
        let (pool, id) = run_in_review(None).await;
        let generation = run(&pool, id).await.generation;
        let first = serde_json::json!({ "id": "first", "kind": "vibe.turn_ended" });
        let second = serde_json::json!({ "id": "second", "kind": "vibe.turn_ended" });
        assert!(
            VibeRun::set_pending(&pool, id, generation, &first)
                .await
                .unwrap()
        );
        assert!(
            VibeRun::set_pending(&pool, id, generation, &second)
                .await
                .unwrap()
        );
        assert_eq!(run(&pool, id).await.pending_id(), Some("second"));
        // An outcome of an older generation does not land.
        assert!(
            !VibeRun::set_pending(&pool, id, generation - 1, &first)
                .await
                .unwrap()
        );
        assert_eq!(run(&pool, id).await.pending_id(), Some("second"));

        for (generation, phase, pending) in [
            (generation, "review", Some("first")),
            (generation, "review", None),
            (generation + 1, "review", Some("second")),
            (generation, "merging", Some("second")),
        ] {
            assert!(
                !VibeRun::take_pending(&pool, id, generation, phase, pending)
                    .await
                    .unwrap()
            );
        }
        assert!(
            VibeRun::take_pending(&pool, id, generation, "review", Some("second"))
                .await
                .unwrap()
        );
        assert!(run(&pool, id).await.pending.is_none());
        assert!(
            !VibeRun::take_pending(&pool, id, generation, "review", Some("second"))
                .await
                .unwrap()
        );
        // With nothing unanswered, an action that names no event may run.
        assert!(
            VibeRun::take_pending(&pool, id, generation, "review", None)
                .await
                .unwrap()
        );

        VibeRun::restore_pending(&pool, id, &second).await.unwrap();
        assert_eq!(run(&pool, id).await.pending_id(), Some("second"));
        VibeRun::restore_pending(&pool, id, &first).await.unwrap();
        assert_eq!(run(&pool, id).await.pending_id(), Some("second"));

        // A new review starts with nothing owed.
        let session = run(&pool, id).await.review_session_id.unwrap();
        VibeRun::begin_review(&pool, id, session, None)
            .await
            .unwrap();
        assert!(run(&pool, id).await.pending.is_none());
        assert_eq!(VibeRun::find_for_automation(&pool).await.unwrap().len(), 1);
        VibeRun::set_phase(&pool, id, "done").await.unwrap();
        assert!(
            VibeRun::find_for_automation(&pool)
                .await
                .unwrap()
                .is_empty()
        );
        let generation = run(&pool, id).await.generation;
        VibeRun::set_pending(&pool, id, generation, &first)
            .await
            .unwrap();
        assert_eq!(VibeRun::find_for_automation(&pool).await.unwrap().len(), 1);
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

        let generation = run(&pool, id).await.generation;
        VibeRun::finish_merge(&pool, id, generation).await.unwrap();
        assert!(
            VibeRun::begin_follow_up(&pool, id, generation, Some(&[]))
                .await
                .unwrap()
        );
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
        let generation = run(&pool, id).await.generation;
        VibeRun::finish_merge(&pool, id, generation).await.unwrap();
        VibeRun::begin_follow_up(&pool, id, generation, Some(&[]))
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
