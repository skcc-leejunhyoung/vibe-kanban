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
    sync::{Mutex, OnceLock},
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
    /// Latest cursor the journal has seen; the next `since` to pass.
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
    /// Last status seen per execution process, to turn row updates into
    /// start/end transitions.
    process_status: Mutex<HashMap<Uuid, ExecutionProcessStatus>>,
    /// (archived, status_note) per workspace, to publish only real changes.
    workspace_state: Mutex<HashMap<Uuid, (bool, Option<String>)>>,
    /// Last vibe phase per workspace.
    vibe_phase: Mutex<HashMap<Uuid, String>>,
}

static JOURNAL: OnceLock<Journal> = OnceLock::new();

fn journal() -> &'static Journal {
    JOURNAL.get_or_init(|| Journal {
        ring: Mutex::new(Ring {
            events: VecDeque::new(),
            next_cursor: 1,
        }),
        latest: watch::channel(0).0,
        process_status: Mutex::new(HashMap::new()),
        workspace_state: Mutex::new(HashMap::new()),
        vibe_phase: Mutex::new(HashMap::new()),
    })
}

/// Append an event and wake long pollers.
pub fn publish(
    kind: &str,
    workspace_id: Option<Uuid>,
    session_id: Option<Uuid>,
    execution_id: Option<Uuid>,
    data: Value,
) -> u64 {
    let journal = journal();
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
    let ring = journal()
        .ring
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let oldest_cursor = ring.events.front().map(|e| e.cursor).unwrap_or(0);
    let cursor = ring.next_cursor - 1;
    let events = ring
        .events
        .iter()
        .filter(|event| event.cursor > since && kind_matches(&event.kind, kinds))
        .take(limit.max(1))
        .cloned()
        .collect();
    JournalPage {
        events,
        cursor,
        oldest_cursor,
    }
}

/// Like [`list`], but waits up to `timeout` (capped at [`MAX_WAIT`]) for a
/// matching event to arrive when none is pending.
pub async fn wait(since: u64, kinds: &[String], limit: usize, timeout: Duration) -> JournalPage {
    let deadline = tokio::time::Instant::now() + timeout.min(MAX_WAIT);
    let mut latest = journal().latest.subscribe();
    loop {
        let page = list(since, kinds, limit);
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
/// rows with the same status publish nothing.
pub fn observe_process(process: &ExecutionProcess, inserted: bool) {
    let previous = journal()
        .process_status
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(process.id, process.status.clone());
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
pub fn observe_vibe_run(run: &VibeRun) {
    let previous = journal()
        .vibe_phase
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(run.workspace_id, run.phase.clone());
    if previous.as_deref() == Some(run.phase.as_str()) {
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
        let first = publish("test.alpha", None, None, None, json!({"n": 1}));
        let second = publish("test.beta", None, None, None, json!({"n": 2}));
        let page = list(first, &["test.".to_string()], 100);
        assert_eq!(
            page.events.iter().map(|e| e.cursor).collect::<Vec<_>>(),
            vec![second]
        );
        assert!(page.cursor >= second);
        let page = list(0, &["test.beta".to_string()], 100);
        assert!(page.events.iter().all(|e| e.kind == "test.beta"));
        assert!(page.events.iter().any(|e| e.cursor == second));
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
        let before = list(0, &[], 1).cursor;
        observe_process(&process, true);
        observe_process(&process, false);
        process.status = ExecutionProcessStatus::Completed;
        observe_process(&process, false);
        observe_process(&process, false);
        let kinds: Vec<String> = list(before, &["process.".to_string()], 100)
            .events
            .into_iter()
            .filter(|e| e.execution_id == Some(process.id))
            .map(|e| e.kind)
            .collect();
        assert_eq!(kinds, vec!["process.started", "process.completed"]);
    }
}
