//! Process-wide journal of the events an agent polls for: process ends,
//! approvals, status notes, vibe-run phases, workspace lifecycle, queue
//! changes, scheduled resumes and cloud notifications.
//!
//! Producers call [`publish`] (or one of the `observe_*` helpers that derive a
//! transition from a row re-read); `GET /api/events/journal` and
//! `GET /api/events/wait` read the ring buffer by cursor. The buffer is global
//! so the SQLite hook publisher, the approvals service and the watchers can
//! all feed it without plumbing a handle through every service.

use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicI64, Ordering},
    },
    time::Duration,
};

use chrono::{DateTime, Utc};
use db::models::{
    execution_process::{ExecutionProcess, ExecutionProcessStatus},
    vibe_run::VibeRun,
    workspace::Workspace,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::watch;
use ts_rs::TS;
use uuid::Uuid;

/// Events kept in memory; older ones fall off and `oldest_cursor` tells the
/// reader its cursor is too old.
const CAPACITY: usize = 4000;
/// Upper bound for a single long poll.
pub const MAX_WAIT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct JournalEvent {
    /// Monotonic position; pass the page's `cursor` back as `since`.
    pub cursor: u64,
    pub at: DateTime<Utc>,
    /// Dotted kind, e.g. `process.completed`, `approval.pending`,
    /// `workspace.status_note`, `vibe.phase`, `queue.changed`,
    /// `resume.fired`, `cloud.notification`.
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_id: Option<Uuid>,
    /// Paired host the event came from; absent for this machine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_id: Option<Uuid>,
    pub data: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct JournalPage {
    pub events: Vec<JournalEvent>,
    /// The next `since` to pass: the last returned event's cursor when the
    /// page hit `limit`, otherwise the latest cursor the journal has seen.
    pub cursor: u64,
    /// Cursor of the oldest event still buffered. A `since` below this means
    /// events were lost to the ring; callers should resync from a fresh list.
    pub oldest_cursor: u64,
}

#[derive(Default)]
struct Ring {
    events: VecDeque<JournalEvent>,
    next_cursor: u64,
}

struct Journal {
    ring: Mutex<Ring>,
    latest: watch::Sender<u64>,
    /// Last status and session seen per execution process, to turn row
    /// updates into start/end transitions.
    process_status: Mutex<HashMap<Uuid, (ExecutionProcessStatus, Uuid)>>,
    /// Session → workspace learned from process rows, to label events that
    /// only know their process or session (approvals, queue changes).
    session_workspace: Mutex<HashMap<Uuid, Uuid>>,
    /// (archived, status_note) per workspace, to publish only real changes.
    workspace_state: Mutex<HashMap<Uuid, (bool, Option<String>)>>,
    /// Last vibe phase per workspace.
    vibe_phase: Mutex<HashMap<Uuid, String>>,
}

static JOURNAL: OnceLock<Journal> = OnceLock::new();
/// Unix seconds of the last `list`/`wait`, so pollers feeding the journal can
/// idle while no agent reads it.
static LAST_READ: AtomicI64 = AtomicI64::new(0);

/// Whether an agent read the journal within `window`.
pub fn read_within(window: Duration) -> bool {
    Utc::now().timestamp() - LAST_READ.load(Ordering::Relaxed) <= window.as_secs() as i64
}

fn journal() -> &'static Journal {
    JOURNAL.get_or_init(|| Journal {
        ring: Mutex::new(Ring {
            events: VecDeque::new(),
            // Start from the clock so cursors keep growing across restarts and
            // a reader's old `since` never hides the new server's events.
            next_cursor: Utc::now().timestamp_millis().max(1) as u64,
        }),
        latest: watch::channel(0).0,
        process_status: Mutex::new(HashMap::new()),
        session_workspace: Mutex::new(HashMap::new()),
        workspace_state: Mutex::new(HashMap::new()),
        vibe_phase: Mutex::new(HashMap::new()),
    })
}

/// Append an event and wake long pollers. Missing session/workspace ids are
/// filled in from the process and session rows seen so far.
pub fn publish(
    kind: &str,
    workspace_id: Option<Uuid>,
    session_id: Option<Uuid>,
    execution_id: Option<Uuid>,
    data: Value,
) -> u64 {
    let journal = journal();
    let session_id = session_id.or_else(|| {
        let processes = journal
            .process_status
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        processes.get(&execution_id?).map(|(_, session)| *session)
    });
    let workspace_id = workspace_id.or_else(|| {
        let sessions = journal
            .session_workspace
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        sessions.get(&session_id?).copied()
    });
    let cursor = {
        let mut ring = journal
            .ring
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let cursor = ring.next_cursor;
        ring.next_cursor += 1;
        ring.events.push_back(JournalEvent {
            cursor,
            at: Utc::now(),
            kind: kind.to_string(),
            workspace_id,
            session_id,
            execution_id,
            host_id: None,
            data,
        });
        while ring.events.len() > CAPACITY {
            ring.events.pop_front();
        }
        cursor
    };
    journal.latest.send_replace(cursor);
    tracing::debug!(target: "agent_journal", kind, cursor, "journal event");
    cursor
}

fn kind_matches(kind: &str, filters: &[String]) -> bool {
    filters.is_empty()
        || filters.iter().any(|filter| {
            let filter = filter.trim_end_matches('*');
            kind == filter || kind.starts_with(filter)
        })
}

/// Events after `since` whose kind matches one of `kinds` (prefix match, so
/// `process` or `process.` selects every process event). Empty `kinds`
/// matches everything.
pub fn list(since: u64, kinds: &[String], limit: usize) -> JournalPage {
    LAST_READ.store(Utc::now().timestamp(), Ordering::Relaxed);
    page(since, kinds, limit)
}

fn page(since: u64, kinds: &[String], limit: usize) -> JournalPage {
    let ring = journal()
        .ring
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let oldest_cursor = ring.events.front().map(|e| e.cursor).unwrap_or(0);
    let limit = limit.max(1);
    let events: Vec<JournalEvent> = ring
        .events
        .iter()
        .filter(|event| event.cursor > since && kind_matches(&event.kind, kinds))
        .take(limit)
        .cloned()
        .collect();
    // A full page may have more matches behind it; resume right after it.
    let cursor = match events.last() {
        Some(last) if events.len() == limit => last.cursor,
        _ => ring.next_cursor - 1,
    };
    JournalPage {
        events,
        cursor,
        oldest_cursor,
    }
}

/// Like [`list`], but waits up to `timeout` (capped at [`MAX_WAIT`]) for a
/// matching event to arrive when none is pending.
pub async fn wait(since: u64, kinds: &[String], limit: usize, timeout: Duration) -> JournalPage {
    LAST_READ.store(Utc::now().timestamp(), Ordering::Relaxed);
    wait_page(since, kinds, limit, timeout).await
}

/// [`wait`] for in-process followers (the central push). It does not count as
/// an agent reading, so it keeps no read-gated watcher awake.
pub async fn follow(since: u64, limit: usize, timeout: Duration) -> JournalPage {
    wait_page(since, &[], limit, timeout).await
}

async fn wait_page(since: u64, kinds: &[String], limit: usize, timeout: Duration) -> JournalPage {
    let deadline = tokio::time::Instant::now() + timeout.min(MAX_WAIT);
    let mut latest = journal().latest.subscribe();
    loop {
        let page = page(since, kinds, limit);
        if !page.events.is_empty() {
            return page;
        }
        tokio::select! {
            changed = latest.changed() => {
                if changed.is_err() {
                    return page;
                }
            }
            _ = tokio::time::sleep_until(deadline) => return page,
        }
    }
}

/// Turn an execution-process row (fresh insert or later update) into a
/// `process.started` or `process.{completed,failed,killed}` event. Repeated
/// rows with the same status publish nothing, and neither does the first
/// update seen of an already finished row (e.g. marking old turns dropped
/// after a restart).
pub fn observe_process(process: &ExecutionProcess, workspace_id: Option<Uuid>, inserted: bool) {
    if let Some(workspace_id) = workspace_id {
        journal()
            .session_workspace
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(process.session_id, workspace_id);
    }
    let previous = journal()
        .process_status
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(process.id, (process.status.clone(), process.session_id))
        .map(|(status, _)| status);
    if previous.is_none() && !inserted && process.status != ExecutionProcessStatus::Running {
        return;
    }
    let changed = previous.as_ref() != Some(&process.status);
    let kind = match process.status {
        ExecutionProcessStatus::Running if inserted || previous.is_none() => "process.started",
        ExecutionProcessStatus::Running => return,
        ExecutionProcessStatus::Completed if changed => "process.completed",
        ExecutionProcessStatus::Failed if changed => "process.failed",
        ExecutionProcessStatus::Killed if changed => "process.killed",
        _ => return,
    };
    publish(
        kind,
        None,
        Some(process.session_id),
        Some(process.id),
        json!({
            "run_reason": process.run_reason,
            "exit_code": process.exit_code,
            "started_at": process.started_at,
            "completed_at": process.completed_at,
        }),
    );
}

/// Turn a workspace row into `workspace.created`, `workspace.archived`,
/// `workspace.unarchived` or `workspace.status_note` events.
pub fn observe_workspace(workspace: &Workspace, inserted: bool) {
    let current = (workspace.archived, workspace.status_note.clone());
    let previous = journal()
        .workspace_state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(workspace.id, current.clone());
    let base = json!({
        "name": workspace.name,
        "branch": workspace.branch,
        "in_place": workspace.in_place,
    });
    if inserted || previous.is_none() {
        if inserted {
            publish("workspace.created", Some(workspace.id), None, None, base);
        }
        return;
    }
    let (was_archived, old_note) = previous.unwrap_or_default();
    if was_archived != workspace.archived {
        let kind = if workspace.archived {
            "workspace.archived"
        } else {
            "workspace.unarchived"
        };
        publish(kind, Some(workspace.id), None, None, base.clone());
    }
    if old_note != workspace.status_note {
        publish(
            "workspace.status_note",
            Some(workspace.id),
            None,
            None,
            json!({
                "status_note": workspace.status_note,
                "status_updated_at": workspace.status_updated_at,
            }),
        );
    }
}

/// A workspace row was deleted (published from the pre-update hook, which is
/// the only place the old row is still readable).
pub fn observe_workspace_deleted(workspace_id: Uuid) {
    journal()
        .workspace_state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&workspace_id);
    publish(
        "workspace.deleted",
        Some(workspace_id),
        None,
        None,
        json!({}),
    );
}

/// Publish `vibe.phase` when a run's phase differs from the last one seen.
/// The first update seen of an existing run (after a restart) only records it.
pub fn observe_vibe_run(run: &VibeRun, inserted: bool) {
    let previous = journal()
        .vibe_phase
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(run.workspace_id, run.phase.clone());
    if previous.as_deref() == Some(run.phase.as_str()) || (previous.is_none() && !inserted) {
        return;
    }
    publish(
        "vibe.phase",
        Some(run.workspace_id),
        run.review_session_id,
        None,
        json!({
            "phase": run.phase,
            "previous_phase": previous,
            "task_id": run.task_id,
            "coding_turns": run.coding_turns,
            "review_turns": run.review_turns,
            "merge_retries": run.merge_retries,
            "last_result": run.last_result,
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn list_filters_by_cursor_and_kind_prefix() {
        let first = publish("list.alpha", None, None, None, json!({"n": 1}));
        let second = publish("list.beta", None, None, None, json!({"n": 2}));
        let page = list(first, &["list.".to_string()], 100);
        assert_eq!(
            page.events.iter().map(|e| e.cursor).collect::<Vec<_>>(),
            vec![second]
        );
        assert!(page.cursor >= second);
        let page = list(0, &["list.beta".to_string()], 100);
        assert!(page.events.iter().all(|e| e.kind == "list.beta"));
        assert!(page.events.iter().any(|e| e.cursor == second));
    }

    #[tokio::test]
    async fn a_full_page_resumes_after_its_last_event() {
        let since = list(0, &[], 1).cursor;
        let cursors: Vec<u64> = (0..3)
            .map(|n| publish("page.item", None, None, None, json!({ "n": n })))
            .collect();
        let kinds = ["page.".to_string()];
        let first = list(since, &kinds, 2);
        assert_eq!(first.events.len(), 2);
        assert_eq!(first.cursor, cursors[1]);
        let rest = list(first.cursor, &kinds, 2);
        assert_eq!(
            rest.events.iter().map(|e| e.cursor).collect::<Vec<_>>(),
            vec![cursors[2]]
        );
    }

    #[tokio::test]
    async fn wait_returns_as_soon_as_a_matching_event_lands() {
        let since = list(0, &[], 1).cursor;
        let waiter = tokio::spawn(async move {
            wait(
                since,
                &["test.wait".to_string()],
                10,
                Duration::from_secs(5),
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        let cursor = publish("test.wait", None, None, None, json!({}));
        let page = tokio::time::timeout(Duration::from_secs(2), waiter)
            .await
            .expect("waiter finished")
            .unwrap();
        assert_eq!(page.events.len(), 1);
        assert_eq!(page.events[0].cursor, cursor);
    }

    #[tokio::test]
    async fn wait_times_out_with_an_empty_page() {
        let since = list(0, &[], 1).cursor;
        let page = wait(
            since,
            &["test.never".to_string()],
            10,
            Duration::from_millis(30),
        )
        .await;
        assert!(page.events.is_empty());
    }

    #[test]
    fn process_transitions_publish_once() {
        let mut process = ExecutionProcess {
            id: Uuid::new_v4(),
            session_id: Uuid::new_v4(),
            run_reason: db::models::execution_process::ExecutionProcessRunReason::CodingAgent,
            executor_action: sqlx::types::Json(
                db::models::execution_process::ExecutorActionField::Other(json!({})),
            ),
            status: ExecutionProcessStatus::Running,
            exit_code: None,
            dropped: false,
            started_at: Utc::now(),
            completed_at: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        let workspace = Uuid::new_v4();
        let before = list(0, &[], 1).cursor;
        observe_process(&process, Some(workspace), true);
        observe_process(&process, Some(workspace), false);
        process.status = ExecutionProcessStatus::Completed;
        observe_process(&process, Some(workspace), false);
        observe_process(&process, Some(workspace), false);
        let events: Vec<JournalEvent> = list(before, &["process.".to_string()], 100)
            .events
            .into_iter()
            .filter(|e| e.execution_id == Some(process.id))
            .collect();
        assert_eq!(
            events.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(),
            vec!["process.started", "process.completed"]
        );
        assert!(events.iter().all(|e| e.workspace_id == Some(workspace)));
        // An approval only knows its process; the journal adds the rest.
        let cursor = publish("approval.pending", None, None, Some(process.id), json!({}));
        let approval = list(cursor - 1, &["approval.".to_string()], 1).events;
        assert_eq!(approval[0].session_id, Some(process.session_id));
        assert_eq!(approval[0].workspace_id, Some(workspace));

        // The first update seen of an already finished row stays silent.
        let mut old = process.clone();
        old.id = Uuid::new_v4();
        old.dropped = true;
        let before = list(0, &[], 1).cursor;
        observe_process(&old, None, false);
        assert!(
            list(before, &["process.".to_string()], 100)
                .events
                .iter()
                .all(|e| e.execution_id != Some(old.id))
        );
    }
}
