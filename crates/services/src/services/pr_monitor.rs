use std::{
    collections::{HashMap, HashSet},
    future::Future,
    sync::Arc,
    time::Duration,
};

use api_types::{PullRequestStatus, UpdatePullRequestApiRequest, UpsertPullRequestRequest};
use chrono::Utc;
use db::{
    DBService,
    models::{
        merge::{MergeStatus, PullRequestInfo},
        pull_request::PullRequest,
        workspace::{Workspace, WorkspaceError},
    },
};
use git_host::{GitHostError, GitHostProvider, GitHostService};
use sqlx::{SqlitePool, error::Error as SqlxError};
use thiserror::Error;
use tokio::{
    sync::Notify,
    time::{Instant, Interval, MissedTickBehavior, interval, timeout},
};
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use crate::services::{
    container::ContainerService,
    remote_client::{RemoteClient, RemoteClientError},
    remote_sync,
};

#[derive(Debug, Error)]
enum PrMonitorError {
    #[error(transparent)]
    GitHostError(#[from] GitHostError),
    #[error(transparent)]
    WorkspaceError(#[from] WorkspaceError),
    #[error(transparent)]
    Sqlx(#[from] SqlxError),
    #[error("status check timed out after {0:?}")]
    Timeout(Duration),
}

impl PrMonitorError {
    fn is_environmental(&self) -> bool {
        matches!(
            self,
            PrMonitorError::GitHostError(
                GitHostError::CliNotInstalled { .. } | GitHostError::NotAGitRepository(_)
            )
        )
    }
}

/// Upper bound for one PR status probe, so a stalled host can't hold a round.
const PR_CHECK_TIMEOUT: Duration = Duration::from_secs(30);

/// Seconds from env var `name`, or `default` when unset, invalid or zero.
fn env_secs(name: &str, default: u64) -> Duration {
    let secs = std::env::var(name)
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .filter(|secs| *secs > 0)
        .unwrap_or(default);
    Duration::from_secs(secs)
}

/// Round timer. After a slow round it waits a full period instead of firing
/// the missed ticks back to back.
fn poll_timer(period: Duration) -> Interval {
    let mut timer = interval(period);
    timer.set_missed_tick_behavior(MissedTickBehavior::Delay);
    timer
}

/// When each unresolved PR is next due for a status probe, keyed by URL.
///
/// Open PRs (and closed ones whose workspace is still active) are probed every
/// `poll_interval`; closed PRs of archived workspaces every
/// `closed_archived_interval`. Intervals count from the round's tick, so a
/// failed or timed-out probe is retried at the PR's normal cadence, never
/// sooner. A PR whose stored status changed since its last probe (manual
/// refresh/re-link) is due immediately.
struct PollSchedule {
    poll_interval: Duration,
    closed_archived_interval: Duration,
    probe_timeout: Duration,
    next: HashMap<String, (Instant, MergeStatus)>,
}

impl PollSchedule {
    fn new(
        poll_interval: Duration,
        closed_archived_interval: Duration,
        probe_timeout: Duration,
    ) -> Self {
        Self {
            poll_interval,
            closed_archived_interval,
            probe_timeout,
            next: HashMap::new(),
        }
    }

    /// PRs due at `now`. Forgets PRs that left the unresolved set.
    fn due<'a>(&mut self, prs: &'a [PullRequest], now: Instant) -> Vec<&'a PullRequest> {
        let urls: HashSet<&str> = prs.iter().map(|pr| pr.pr_url.as_str()).collect();
        self.next.retain(|url, _| urls.contains(url.as_str()));
        prs.iter()
            .filter(|pr| {
                self.next
                    .get(&pr.pr_url)
                    .is_none_or(|(at, status)| *at <= now || *status != pr.pr_status)
            })
            .collect()
    }

    /// Record that `pr_url` was probed in the round ticked at `round`, ending
    /// with stored status `status`.
    fn probed(&mut self, pr_url: &str, status: MergeStatus, archived: bool, round: Instant) {
        let interval = if status == MergeStatus::Closed && archived {
            self.closed_archived_interval
        } else {
            self.poll_interval
        };
        self.next
            .insert(pr_url.to_string(), (round + interval, status));
    }
}

async fn probe_pr_status(pr_url: String) -> Result<PullRequestInfo, GitHostError> {
    GitHostService::from_url(&pr_url)?
        .poll_pr_status(&pr_url)
        .await
}

/// One monitor round: probes each due unresolved (non-merged) PR once, in
/// sequence, persists a changed status and reschedules it. Returns
/// `(workspace_id, pr_number)` for PRs that just merged.
async fn poll_round<F>(
    pool: &SqlitePool,
    schedule: &mut PollSchedule,
    round: Instant,
    mut probe: impl FnMut(String) -> F,
) -> Result<Vec<(Uuid, i64)>, PrMonitorError>
where
    F: Future<Output = Result<PullRequestInfo, GitHostError>>,
{
    let prs = PullRequest::get_unresolved(pool).await?;
    let due = schedule.due(&prs, round);
    let mut merged = Vec::new();

    if due.is_empty() {
        debug!("No unresolved PRs due ({} unresolved)", prs.len());
        return Ok(merged);
    }

    info!("Checking {} of {} unresolved PRs", due.len(), prs.len());
    for pr in due {
        let result = match timeout(schedule.probe_timeout, probe(pr.pr_url.clone())).await {
            Ok(Ok(info)) => persist_status(pool, pr, info).await,
            Ok(Err(e)) => Err(e.into()),
            Err(_) => Err(PrMonitorError::Timeout(schedule.probe_timeout)),
        };
        // On error or timeout keep the last known status; the schedule
        // retries it at its normal cadence.
        let status = match result {
            Ok(status) => status,
            Err(e) => {
                if e.is_environmental() {
                    warn!(
                        "Skipping PR #{} due to environmental error: {}",
                        pr.pr_number, e
                    );
                } else {
                    error!("Error checking PR #{}: {}", pr.pr_number, e);
                }
                pr.pr_status.clone()
            }
        };
        if status == MergeStatus::Merged
            && let Some(workspace_id) = pr.workspace_id
        {
            merged.push((workspace_id, pr.pr_number));
        }
        let archived = status == MergeStatus::Closed && workspace_archived(pool, pr).await;
        schedule.probed(&pr.pr_url, status, archived, round);
    }

    Ok(merged)
}

/// Persist a probed status if it changed. Returns the PR's stored status
/// afterwards.
async fn persist_status(
    pool: &SqlitePool,
    pr: &PullRequest,
    status: PullRequestInfo,
) -> Result<MergeStatus, PrMonitorError> {
    debug!(
        "PR #{} status: {:?} (was {:?})",
        pr.pr_number, status.status, pr.pr_status
    );

    // Ignore Unknown responses so a transient parse/API hiccup doesn't
    // clobber a known status.
    if matches!(&status.status, MergeStatus::Unknown) {
        return Ok(pr.pr_status.clone());
    }

    // No change since last poll: nothing to persist or re-sync.
    if status.status == pr.pr_status {
        return Ok(status.status);
    }

    let merged_at = if matches!(&status.status, MergeStatus::Merged) {
        Some(status.merged_at.unwrap_or_else(Utc::now))
    } else {
        None
    };

    PullRequest::update_status(
        pool,
        &pr.pr_url,
        &status.status,
        merged_at,
        status.merge_commit_sha.clone(),
    )
    .await?;

    info!("PR #{} status changed to {:?}", pr.pr_number, status.status);

    Ok(status.status)
}

async fn workspace_archived(pool: &SqlitePool, pr: &PullRequest) -> bool {
    let Some(workspace_id) = pr.workspace_id else {
        return false;
    };
    match Workspace::find_by_id(pool, workspace_id).await {
        Ok(workspace) => workspace.is_some_and(|workspace| workspace.archived),
        Err(e) => {
            warn!("Failed to load workspace {}: {}", workspace_id, e);
            false
        }
    }
}

/// Service to monitor PRs and update task status when they are merged
pub struct PrMonitorService<C: ContainerService> {
    db: DBService,
    poll_interval: Duration,
    closed_archived_interval: Duration,
    container: C,
    remote_client: Option<RemoteClient>,
    sync_notify: Arc<Notify>,
}

impl<C: ContainerService + Send + Sync + 'static> PrMonitorService<C> {
    pub async fn spawn(
        db: DBService,
        container: C,
        remote_client: Option<RemoteClient>,
        sync_notify: Arc<Notify>,
    ) -> tokio::task::JoinHandle<()> {
        let service = Self {
            db,
            poll_interval: env_secs("PR_MONITOR_POLL_INTERVAL_SECS", 60),
            closed_archived_interval: env_secs("PR_MONITOR_CLOSED_POLL_INTERVAL_SECS", 600),
            container,
            remote_client,
            sync_notify,
        };
        tokio::spawn(async move {
            service.start().await;
        })
    }

    async fn start(&self) {
        info!(
            "Starting PR monitoring service with interval {:?} (closed archived PRs: {:?})",
            self.poll_interval, self.closed_archived_interval
        );

        let mut timer = poll_timer(self.poll_interval);
        let mut schedule = PollSchedule::new(
            self.poll_interval,
            self.closed_archived_interval,
            PR_CHECK_TIMEOUT,
        );

        loop {
            tokio::select! {
                round = timer.tick() => {
                    match poll_round(&self.db.pool, &mut schedule, round, probe_pr_status).await {
                        Ok(merged) => {
                            for (workspace_id, pr_number) in merged {
                                if let Err(e) =
                                    self.try_archive_workspace(workspace_id, pr_number).await
                                {
                                    error!("Error archiving after PR #{}: {}", pr_number, e);
                                }
                            }
                        }
                        Err(e) => error!("Error checking open PRs: {}", e),
                    }
                }
                _ = self.sync_notify.notified() => {
                    debug!("PR sync triggered externally");
                }
            }
            self.sync_pending_to_remote().await;
        }
    }

    /// Archive workspace if all its PRs are merged/closed
    async fn try_archive_workspace(
        &self,
        workspace_id: Uuid,
        pr_number: i64,
    ) -> Result<(), PrMonitorError> {
        let Some(workspace) = Workspace::find_by_id(&self.db.pool, workspace_id).await? else {
            return Ok(());
        };

        let open_pr_count =
            PullRequest::count_open_for_workspace(&self.db.pool, workspace_id).await?;

        if open_pr_count == 0 {
            info!(
                "PR #{} was merged, archiving workspace {}",
                pr_number, workspace.id
            );
            if !workspace.pinned
                && let Err(e) = self.container.archive_workspace(workspace.id).await
            {
                error!("Failed to archive workspace {}: {}", workspace.id, e);
            }
        } else {
            info!(
                "PR #{} was merged, leaving workspace {} active with {} open PR(s)",
                pr_number, workspace.id, open_pr_count
            );
        }

        Ok(())
    }

    /// Sync pending PR status changes to remote server.
    async fn sync_pending_to_remote(&self) {
        let Some(client) = &self.remote_client else {
            return;
        };

        let pending = match PullRequest::get_pending_sync(&self.db.pool).await {
            Ok(prs) => prs,
            Err(e) => {
                error!("Failed to query pending sync PRs: {}", e);
                return;
            }
        };

        if pending.is_empty() {
            return;
        }

        debug!("Syncing {} pending PRs to remote", pending.len());

        for pr in &pending {
            let pr_api_status = match &pr.pr_status {
                MergeStatus::Open => PullRequestStatus::Open,
                MergeStatus::Merged => PullRequestStatus::Merged,
                MergeStatus::Closed => PullRequestStatus::Closed,
                MergeStatus::Unknown => continue,
            };

            let request = UpdatePullRequestApiRequest {
                url: pr.pr_url.clone(),
                status: Some(pr_api_status),
                merged_at: pr.merged_at.map(Some),
                merge_commit_sha: pr.merge_commit_sha.clone().map(Some),
            };

            match client.update_pull_request(request).await {
                Ok(_) => {
                    if let Err(e) = PullRequest::mark_synced(&self.db.pool, &pr.id).await {
                        error!("Failed to mark PR #{} as synced: {}", pr.pr_number, e);
                    }
                }
                Err(RemoteClientError::Http { status: 404, .. }) => {
                    if let Some(workspace_id) = pr.workspace_id {
                        let request = UpsertPullRequestRequest {
                            host_id: None,
                            url: pr.pr_url.clone(),
                            number: pr.pr_number as i32,
                            status: pr_api_status,
                            merged_at: pr.merged_at,
                            merge_commit_sha: pr.merge_commit_sha.clone(),
                            target_branch_name: pr.target_branch_name.clone(),
                            local_workspace_id: workspace_id,
                        };
                        remote_sync::sync_pr_to_remote(client, request).await;
                        if let Err(e) = PullRequest::mark_synced(&self.db.pool, &pr.id).await {
                            error!("Failed to mark PR #{} as synced: {}", pr.pr_number, e);
                        }
                    } else {
                        warn!(
                            "PR #{} not found on remote and has no workspace, removing local record",
                            pr.pr_number
                        );
                        if let Err(e) = PullRequest::delete(&self.db.pool, &pr.id).await {
                            error!("Failed to delete orphaned local PR: {}", e);
                        }
                    }
                }
                Err(RemoteClientError::Auth) => {
                    debug!("PR sync sweep stopped: not authenticated");
                    return;
                }
                Err(e) => {
                    error!(
                        "Failed to sync PR #{} status to remote: {}",
                        pr.pr_number, e
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use sqlx::sqlite::SqlitePoolOptions;

    use super::*;

    const MINUTE: Duration = Duration::from_secs(60);

    #[derive(Clone)]
    enum Reply {
        Status(MergeStatus),
        Fail,
        Hang,
    }

    fn url(n: i64) -> String {
        format!("https://github.com/acme/widgets/pull/{n}")
    }

    /// In-memory DB rows + a fake git host answering status probes.
    struct Fixture {
        pool: SqlitePool,
        schedule: PollSchedule,
        start: Instant,
        host: RefCell<HashMap<String, Reply>>,
        calls: RefCell<Vec<i64>>,
    }

    impl Fixture {
        /// 9 open PRs (#0-8, active workspaces) + 13 closed PRs of archived
        /// workspaces (#9-21); the host agrees with the stored statuses.
        async fn new(probe_timeout: Duration) -> Self {
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await
                .unwrap();
            sqlx::raw_sql(
                "CREATE TABLE pull_requests (
                    id TEXT PRIMARY KEY NOT NULL, workspace_id BLOB, repo_id BLOB,
                    pr_url TEXT NOT NULL UNIQUE, pr_number INTEGER NOT NULL,
                    pr_status TEXT NOT NULL, target_branch_name TEXT NOT NULL,
                    head_branch_name TEXT, merged_at TEXT, merge_commit_sha TEXT,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    synced_at DATETIME
                );
                CREATE TABLE workspaces (
                    id BLOB PRIMARY KEY, task_id BLOB, container_ref TEXT,
                    branch TEXT NOT NULL, setup_completed_at TEXT,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    archived INTEGER NOT NULL, pinned INTEGER NOT NULL,
                    name TEXT, worktree_deleted INTEGER NOT NULL,
                    ephemeral INTEGER NOT NULL, in_place INTEGER NOT NULL,
                    autopilot INTEGER NOT NULL DEFAULT 0,
                    cleanup_blocked_reason TEXT, status_note TEXT, status_updated_at TEXT
                );",
            )
            .execute(&pool)
            .await
            .unwrap();
            let fixture = Self {
                pool,
                schedule: PollSchedule::new(MINUTE, 10 * MINUTE, probe_timeout),
                start: Instant::now(),
                host: RefCell::new(HashMap::new()),
                calls: RefCell::new(Vec::new()),
            };
            for n in 0..22 {
                let status = if n < 9 {
                    MergeStatus::Open
                } else {
                    MergeStatus::Closed
                };
                fixture.add_pr(n, status, n >= 9).await;
            }
            fixture
        }

        async fn add_pr(&self, n: i64, status: MergeStatus, archived: bool) -> Uuid {
            let workspace_id = Uuid::new_v4();
            let now = Utc::now();
            sqlx::query(
                "INSERT INTO workspaces (id, branch, created_at, updated_at, archived, pinned,
                    worktree_deleted, ephemeral, in_place)
                 VALUES (?, 'vk/test', ?, ?, ?, 0, 0, 0, 0)",
            )
            .bind(workspace_id)
            .bind(now)
            .bind(now)
            .bind(archived)
            .execute(&self.pool)
            .await
            .unwrap();
            PullRequest::create_for_workspace(
                &self.pool,
                workspace_id,
                Uuid::new_v4(),
                "main",
                n,
                &url(n),
                None,
            )
            .await
            .unwrap();
            if status != MergeStatus::Open {
                self.store(n, status.clone()).await;
            }
            self.reply(n, Reply::Status(status));
            workspace_id
        }

        fn reply(&self, n: i64, reply: Reply) {
            self.host.borrow_mut().insert(url(n), reply);
        }

        /// Writes the stored status directly, like a manual refresh/re-link.
        async fn store(&self, n: i64, status: MergeStatus) {
            PullRequest::update_status(&self.pool, &url(n), &status, None, None)
                .await
                .unwrap();
        }

        async fn stored(&self, n: i64) -> PullRequest {
            PullRequest::find_by_url(&self.pool, &url(n))
                .await
                .unwrap()
                .unwrap()
        }

        /// Runs the round ticked `minutes` after start. Returns the probed PR
        /// numbers and the merged `(workspace_id, pr_number)` list.
        async fn round(&mut self, minutes: u32) -> (Vec<i64>, Vec<(Uuid, i64)>) {
            self.calls.borrow_mut().clear();
            let (host, calls) = (&self.host, &self.calls);
            let merged = poll_round(
                &self.pool,
                &mut self.schedule,
                self.start + minutes * MINUTE,
                |pr_url: String| {
                    let n = pr_url.rsplit('/').next().unwrap().parse().unwrap();
                    calls.borrow_mut().push(n);
                    let reply = host.borrow()[&pr_url].clone();
                    async move {
                        match reply {
                            Reply::Status(status) => Ok(PullRequestInfo {
                                number: n,
                                url: pr_url,
                                status,
                                merged_at: None,
                                merge_commit_sha: Some("deadbeef".to_string()),
                            }),
                            Reply::Fail => Err(GitHostError::PullRequest(
                                "net/http: TLS handshake timeout".to_string(),
                            )),
                            Reply::Hang => std::future::pending().await,
                        }
                    }
                },
            )
            .await
            .unwrap();
            (self.calls.borrow().clone(), merged)
        }
    }

    #[tokio::test]
    async fn ten_minutes_poll_open_prs_every_minute_and_closed_archived_once() {
        let mut fx = Fixture::new(PR_CHECK_TIMEOUT).await;
        let (initial, _) = fx.round(0).await;
        assert_eq!(initial.len(), 22);

        let (mut open, mut closed) = (0, 0);
        for minute in 1..=10 {
            let (probed, merged) = fx.round(minute).await;
            assert!(merged.is_empty());
            let unique: HashSet<_> = probed.iter().collect();
            assert_eq!(unique.len(), probed.len(), "duplicate probe in a round");
            open += probed.iter().filter(|n| **n < 9).count();
            closed += probed.iter().filter(|n| **n >= 9).count();
        }

        // Previously every unresolved PR was probed every round: 22 x 10 = 220.
        assert_eq!((open, closed), (90, 13));
    }

    #[tokio::test]
    async fn merged_pr_is_persisted_reported_for_archive_and_dropped() {
        let mut fx = Fixture::new(PR_CHECK_TIMEOUT).await;
        let workspace_id = fx.add_pr(22, MergeStatus::Open, false).await;
        fx.round(0).await;

        fx.reply(22, Reply::Status(MergeStatus::Merged));
        let (_, merged) = fx.round(1).await;
        assert_eq!(merged, vec![(workspace_id, 22)]);
        let stored = fx.stored(22).await;
        assert_eq!(stored.pr_status, MergeStatus::Merged);
        assert!(stored.merged_at.is_some());
        assert_eq!(stored.merge_commit_sha.as_deref(), Some("deadbeef"));
        assert!(
            stored.synced_at.is_none(),
            "change must be queued for cloud sync"
        );

        let (probed, _) = fx.round(2).await;
        assert!(!probed.contains(&22));
    }

    #[tokio::test]
    async fn failures_and_timeouts_neither_retry_nor_burst_and_recover() {
        let mut fx = Fixture::new(Duration::from_millis(50)).await;
        fx.round(0).await;

        // TLS errors for every open PR, and #1 hangs until the probe timeout.
        for n in 0..9 {
            fx.reply(n, Reply::Fail);
        }
        fx.reply(1, Reply::Hang);
        for minute in 1..=3 {
            let (probed, _) = fx.round(minute).await;
            assert_eq!(probed, (0..9).collect::<Vec<_>>());
        }
        for n in 0..9 {
            assert_eq!(fx.stored(n).await.pr_status, MergeStatus::Open);
        }

        // Recovery: one probe per open PR (no catch-up), and #2's close lands.
        for n in 0..9 {
            fx.reply(n, Reply::Status(MergeStatus::Open));
        }
        fx.reply(2, Reply::Status(MergeStatus::Closed));
        let (probed, _) = fx.round(4).await;
        assert_eq!(probed, (0..9).collect::<Vec<_>>());
        assert_eq!(fx.stored(2).await.pr_status, MergeStatus::Closed);
    }

    #[tokio::test]
    async fn unknown_response_keeps_stored_status() {
        let mut fx = Fixture::new(PR_CHECK_TIMEOUT).await;
        fx.reply(0, Reply::Status(MergeStatus::Unknown));
        fx.reply(9, Reply::Status(MergeStatus::Unknown));
        fx.round(0).await;
        assert_eq!(fx.stored(0).await.pr_status, MergeStatus::Open);
        assert_eq!(fx.stored(9).await.pr_status, MergeStatus::Closed);
    }

    #[tokio::test]
    async fn reopened_closed_pr_is_caught_by_slow_poll_or_manual_refresh() {
        // Without a manual refresh: detected by the 10-minute probe, then
        // polled every minute.
        let mut fx = Fixture::new(PR_CHECK_TIMEOUT).await;
        fx.round(0).await;
        fx.reply(9, Reply::Status(MergeStatus::Open));
        for minute in 1..=9 {
            assert!(!fx.round(minute).await.0.contains(&9));
        }
        assert!(fx.round(10).await.0.contains(&9));
        assert_eq!(fx.stored(9).await.pr_status, MergeStatus::Open);
        assert!(fx.round(11).await.0.contains(&9));

        // A manual refresh that stores `open` makes it due on the next round.
        let mut fx = Fixture::new(PR_CHECK_TIMEOUT).await;
        fx.round(0).await;
        fx.reply(10, Reply::Status(MergeStatus::Open));
        fx.store(10, MergeStatus::Open).await;
        assert!(fx.round(1).await.0.contains(&10));
    }

    #[tokio::test]
    async fn closed_pr_of_active_workspace_keeps_regular_cadence() {
        let mut fx = Fixture::new(PR_CHECK_TIMEOUT).await;
        fx.add_pr(22, MergeStatus::Closed, false).await;
        fx.round(0).await;
        assert!(fx.round(1).await.0.contains(&22));
    }

    #[tokio::test]
    async fn poll_timer_skips_missed_ticks_after_a_slow_round() {
        let period = Duration::from_millis(40);
        let mut timer = poll_timer(period);
        timer.tick().await;
        // A slow round spanning several periods.
        tokio::time::sleep(period * 4).await;
        timer.tick().await;
        let started = Instant::now();
        timer.tick().await;
        assert!(
            started.elapsed() >= period / 2,
            "missed ticks fired back to back"
        );
    }
}
