use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};

use api_types::{PullRequestStatus, UpdatePullRequestApiRequest, UpsertPullRequestRequest};
use chrono::Utc;
use db::{
    DBService,
    models::{
        merge::MergeStatus,
        pull_request::PullRequest,
        workspace::{Workspace, WorkspaceError},
    },
};
use git_host::{GitHostError, GitHostProvider, GitHostService};
use sqlx::error::Error as SqlxError;
use thiserror::Error;
use tokio::{
    sync::Notify,
    time::{Instant, MissedTickBehavior, interval, timeout},
};
use tracing::{debug, error, info, warn};

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
    next: HashMap<String, (Instant, MergeStatus)>,
}

impl PollSchedule {
    fn new(poll_interval: Duration, closed_archived_interval: Duration) -> Self {
        Self {
            poll_interval,
            closed_archived_interval,
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

        let mut interval = interval(self.poll_interval);
        // After a slow round, wait a full period instead of firing the missed
        // ticks back to back.
        interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let mut schedule = PollSchedule::new(self.poll_interval, self.closed_archived_interval);

        loop {
            tokio::select! {
                round = interval.tick() => {
                    if let Err(e) = self.check_due_prs(&mut schedule, round).await {
                        error!("Error checking open PRs: {}", e);
                    }
                }
                _ = self.sync_notify.notified() => {
                    debug!("PR sync triggered externally");
                }
            }
            self.sync_pending_to_remote().await;
        }
    }

    /// Check the unresolved (non-merged) PRs that are due this round, one
    /// probe each, in sequence.
    async fn check_due_prs(
        &self,
        schedule: &mut PollSchedule,
        round: Instant,
    ) -> Result<(), PrMonitorError> {
        let prs = PullRequest::get_unresolved(&self.db.pool).await?;
        let due = schedule.due(&prs, round);

        if due.is_empty() {
            debug!("No unresolved PRs due ({} unresolved)", prs.len());
            return Ok(());
        }

        info!("Checking {} of {} unresolved PRs", due.len(), prs.len());
        for pr in due {
            // On error or timeout keep the last known status; the schedule
            // retries it at its normal cadence.
            let status = match self.check_open_pr(pr).await {
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
            let archived = status == MergeStatus::Closed && self.workspace_archived(pr).await;
            schedule.probed(&pr.pr_url, status, archived, round);
        }

        Ok(())
    }

    async fn workspace_archived(&self, pr: &PullRequest) -> bool {
        let Some(workspace_id) = pr.workspace_id else {
            return false;
        };
        match Workspace::find_by_id(&self.db.pool, workspace_id).await {
            Ok(workspace) => workspace.is_some_and(|workspace| workspace.archived),
            Err(e) => {
                warn!("Failed to load workspace {}: {}", workspace_id, e);
                false
            }
        }
    }

    /// Check the status of a single unresolved PR and handle state changes.
    /// Returns the PR's stored status afterwards.
    async fn check_open_pr(&self, pr: &PullRequest) -> Result<MergeStatus, PrMonitorError> {
        let git_host = GitHostService::from_url(&pr.pr_url)?;
        let status = timeout(PR_CHECK_TIMEOUT, git_host.poll_pr_status(&pr.pr_url))
            .await
            .map_err(|_| PrMonitorError::Timeout(PR_CHECK_TIMEOUT))??;

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
            &self.db.pool,
            &pr.pr_url,
            &status.status,
            merged_at,
            status.merge_commit_sha.clone(),
        )
        .await?;

        // If this is a workspace PR and it was merged, try to archive
        if matches!(&status.status, MergeStatus::Merged)
            && let Some(workspace_id) = pr.workspace_id
        {
            self.try_archive_workspace(workspace_id, pr.pr_number)
                .await?;
        }

        info!("PR #{} status changed to {:?}", pr.pr_number, status.status);

        Ok(status.status)
    }

    /// Archive workspace if all its PRs are merged/closed
    async fn try_archive_workspace(
        &self,
        workspace_id: uuid::Uuid,
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
    use super::*;

    const MINUTE: Duration = Duration::from_secs(60);

    fn pr(n: i64, status: MergeStatus) -> PullRequest {
        PullRequest {
            id: n.to_string(),
            workspace_id: None,
            repo_id: None,
            pr_url: format!("https://github.com/acme/widgets/pull/{n}"),
            pr_number: n,
            pr_status: status,
            target_branch_name: "main".to_string(),
            head_branch_name: None,
            merged_at: None,
            merge_commit_sha: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            synced_at: None,
        }
    }

    /// 9 open PRs (#0-8) + 13 closed PRs of archived workspaces (#9-21).
    fn fixture() -> Vec<PullRequest> {
        (0..22)
            .map(|n| {
                pr(
                    n,
                    if n < 9 {
                        MergeStatus::Open
                    } else {
                        MergeStatus::Closed
                    },
                )
            })
            .collect()
    }

    /// One monitor round against a fake host: mirrors `check_due_prs`, with
    /// `prs` as the stored rows. `host` returns the probed status (`None` =
    /// error/timeout). Every closed PR counts as archived. Returns the
    /// probed PR numbers.
    fn round(
        schedule: &mut PollSchedule,
        prs: &mut Vec<PullRequest>,
        now: Instant,
        mut host: impl FnMut(&PullRequest) -> Option<MergeStatus>,
    ) -> Vec<i64> {
        prs.retain(|pr| pr.pr_status != MergeStatus::Merged);
        let due: Vec<PullRequest> = schedule.due(prs, now).into_iter().cloned().collect();
        for pr in &due {
            let status = host(pr)
                .filter(|status| *status != MergeStatus::Unknown)
                .unwrap_or_else(|| pr.pr_status.clone());
            if let Some(row) = prs.iter_mut().find(|row| row.pr_url == pr.pr_url) {
                row.pr_status = status.clone();
            }
            schedule.probed(&pr.pr_url, status, true, now);
        }
        due.iter().map(|pr| pr.pr_number).collect()
    }

    #[test]
    fn ten_minutes_poll_open_prs_every_minute_and_closed_archived_once() {
        let mut schedule = PollSchedule::new(MINUTE, 10 * MINUTE);
        let mut prs = fixture();
        let start = Instant::now();

        let initial = round(&mut schedule, &mut prs, start, |pr| {
            Some(pr.pr_status.clone())
        });
        assert_eq!(initial.len(), 22);

        let (mut open, mut closed) = (0, 0);
        for minute in 1..=10 {
            let probed = round(&mut schedule, &mut prs, start + minute * MINUTE, |pr| {
                Some(pr.pr_status.clone())
            });
            let unique: HashSet<_> = probed.iter().collect();
            assert_eq!(unique.len(), probed.len(), "duplicate probe in a round");
            open += probed.iter().filter(|n| **n < 9).count();
            closed += probed.iter().filter(|n| **n >= 9).count();
        }

        // Previously every unresolved PR was probed every round: 22 x 10 = 220.
        assert_eq!((open, closed), (90, 13));
    }

    #[test]
    fn failed_probes_retry_at_normal_cadence_and_recover() {
        let mut schedule = PollSchedule::new(MINUTE, 10 * MINUTE);
        let mut prs = fixture();
        let start = Instant::now();
        round(&mut schedule, &mut prs, start, |pr| {
            Some(pr.pr_status.clone())
        });

        // TLS errors / timeouts for minutes 1-3: one probe per open PR per
        // round, closed PRs untouched, stored statuses kept.
        for minute in 1..=3 {
            let probed = round(&mut schedule, &mut prs, start + minute * MINUTE, |_| None);
            assert_eq!(probed, (0..9).collect::<Vec<_>>());
        }
        assert!(prs[..9].iter().all(|pr| pr.pr_status == MergeStatus::Open));

        // Recovery: no catch-up burst, and #0's merge lands.
        let probed = round(&mut schedule, &mut prs, start + 4 * MINUTE, |pr| {
            Some(if pr.pr_number == 0 {
                MergeStatus::Merged
            } else {
                pr.pr_status.clone()
            })
        });
        assert_eq!(probed.len(), 9);
        assert_eq!(prs[0].pr_status, MergeStatus::Merged);

        // A merged PR leaves the monitor.
        let probed = round(&mut schedule, &mut prs, start + 5 * MINUTE, |pr| {
            Some(pr.pr_status.clone())
        });
        assert_eq!(probed, (1..9).collect::<Vec<_>>());
    }

    #[test]
    fn unknown_response_keeps_stored_status() {
        let mut schedule = PollSchedule::new(MINUTE, 10 * MINUTE);
        let mut prs = fixture();
        round(&mut schedule, &mut prs, Instant::now(), |_| {
            Some(MergeStatus::Unknown)
        });
        let statuses = |prs: &[PullRequest]| -> Vec<MergeStatus> {
            prs.iter().map(|pr| pr.pr_status.clone()).collect()
        };
        assert_eq!(statuses(&prs), statuses(&fixture()));
    }

    #[test]
    fn reopened_closed_pr_is_caught_by_slow_poll_or_manual_refresh() {
        let start = Instant::now();
        let reopened = |pr: &PullRequest| {
            Some(if pr.pr_number == 9 {
                MergeStatus::Open
            } else {
                pr.pr_status.clone()
            })
        };

        // Without a manual refresh: detected by the 10-minute probe, then
        // polled every minute.
        let mut schedule = PollSchedule::new(MINUTE, 10 * MINUTE);
        let mut prs = fixture();
        round(&mut schedule, &mut prs, start, |pr| {
            Some(pr.pr_status.clone())
        });
        for minute in 1..=9 {
            let probed = round(&mut schedule, &mut prs, start + minute * MINUTE, reopened);
            assert!(!probed.contains(&9));
        }
        let probed = round(&mut schedule, &mut prs, start + 10 * MINUTE, reopened);
        assert!(probed.contains(&9));
        assert_eq!(prs[9].pr_status, MergeStatus::Open);
        let probed = round(&mut schedule, &mut prs, start + 11 * MINUTE, reopened);
        assert!(probed.contains(&9));

        // A manual refresh that stores `open` makes it due on the next round.
        let mut schedule = PollSchedule::new(MINUTE, 10 * MINUTE);
        let mut prs = fixture();
        round(&mut schedule, &mut prs, start, |pr| {
            Some(pr.pr_status.clone())
        });
        prs[9].pr_status = MergeStatus::Open;
        let probed = round(&mut schedule, &mut prs, start + MINUTE, reopened);
        assert!(probed.contains(&9));
    }

    #[test]
    fn closed_pr_of_active_workspace_keeps_regular_cadence() {
        let mut schedule = PollSchedule::new(MINUTE, 10 * MINUTE);
        let closed = vec![pr(1, MergeStatus::Closed)];
        let start = Instant::now();
        schedule.probed(&closed[0].pr_url, MergeStatus::Closed, false, start);
        assert_eq!(schedule.due(&closed, start + MINUTE).len(), 1);
    }
}
