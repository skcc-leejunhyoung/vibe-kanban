use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
};

use chrono::{DateTime, Utc};
use dashmap::{DashMap, DashSet};
use db::models::scratch::DraftFollowUpData;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

/// Represents a queued follow-up message for a session
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct QueuedMessage {
    /// Stable id so the frontend can cancel/reorder an individual message
    pub id: Uuid,
    /// The session this message is queued for
    pub session_id: Uuid,
    /// The follow-up data (message + variant)
    pub data: DraftFollowUpData,
    /// Timestamp when the message was queued
    pub queued_at: DateTime<Utc>,
}

/// Status of the queue for a session (for frontend display)
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum QueueStatus {
    /// No message queued
    Empty,
    /// One or more messages are queued and waiting for execution to complete.
    /// Ordered oldest-first; drained from the front, one per terminal turn.
    Queued { messages: Vec<QueuedMessage> },
}

/// In-memory service for managing queued follow-up messages.
///
/// Each session owns an ordered queue (oldest at the front). Messages are
/// drained one at a time as each terminal turn finishes, so a session can have
/// several follow-ups stacked up. The `steering` set marks sessions whose
/// currently-running turn was interrupted by a "send now" request — those
/// sessions drain their front message even though the execution was killed
/// (see `LocalContainerService::handle_execution_post_completion`).
#[derive(Clone)]
pub struct QueuedMessageService {
    queue: Arc<DashMap<Uuid, VecDeque<QueuedMessage>>>,
    steering: Arc<DashSet<Uuid>>,
}

impl QueuedMessageService {
    pub fn new() -> Self {
        Self {
            queue: Arc::new(DashMap::new()),
            steering: Arc::new(DashSet::new()),
        }
    }

    /// Append a message to the back of a session's queue.
    pub fn enqueue(&self, session_id: Uuid, data: DraftFollowUpData) -> QueuedMessage {
        let queued = Self::new_message(session_id, data);
        self.queue
            .entry(session_id)
            .or_default()
            .push_back(queued.clone());
        queued
    }

    /// Insert a message at the front of a session's queue. Used by "send now"
    /// (steer) so the interrupting message runs before any already-queued ones.
    pub fn enqueue_front(&self, session_id: Uuid, data: DraftFollowUpData) -> QueuedMessage {
        let queued = Self::new_message(session_id, data);
        self.queue
            .entry(session_id)
            .or_default()
            .push_front(queued.clone());
        queued
    }

    /// Remove and return the front (oldest) message for a session, if any.
    /// Used by the finalization flow to consume the next queued message.
    pub fn take_next(&self, session_id: Uuid) -> Option<QueuedMessage> {
        let msg = self
            .queue
            .get_mut(&session_id)
            .and_then(|mut q| q.pop_front());
        self.queue.remove_if(&session_id, |_, q| q.is_empty());
        msg
    }

    /// Cancel a single queued message by id. Returns the removed message if found.
    pub fn cancel_message(&self, session_id: Uuid, message_id: Uuid) -> Option<QueuedMessage> {
        let removed = self.queue.get_mut(&session_id).and_then(|mut q| {
            q.iter()
                .position(|m| m.id == message_id)
                .and_then(|pos| q.remove(pos))
        });
        self.queue.remove_if(&session_id, |_, q| q.is_empty());
        removed
    }

    /// Move an already-queued message to the front of its session's queue, so a
    /// "send now" on a queued item runs it next. Returns `true` if the message
    /// was found (and is now at the front), `false` if it isn't queued anymore.
    pub fn promote_to_front(&self, session_id: Uuid, message_id: Uuid) -> bool {
        let Some(mut q) = self.queue.get_mut(&session_id) else {
            return false;
        };
        let Some(pos) = q.iter().position(|m| m.id == message_id) else {
            return false;
        };
        if pos == 0 {
            return true; // already at the front
        }
        if let Some(msg) = q.remove(pos) {
            q.push_front(msg);
            true
        } else {
            false
        }
    }

    /// Reorder a session's queue to match `ordered_ids` (front first).
    ///
    /// Robust against a stale client view: ids in `ordered_ids` that are no
    /// longer queued are ignored, and queued messages whose id is *absent* from
    /// `ordered_ids` are kept and appended after the reordered ones (preserving
    /// their previous relative order) rather than silently dropped. Returns the
    /// resulting queue.
    pub fn reorder(&self, session_id: Uuid, ordered_ids: &[Uuid]) -> Vec<QueuedMessage> {
        let Some(mut q) = self.queue.get_mut(&session_id) else {
            return Vec::new();
        };
        // Desired position per id; first occurrence wins, duplicates ignored.
        let mut rank: HashMap<Uuid, usize> = HashMap::new();
        for (i, id) in ordered_ids.iter().enumerate() {
            rank.entry(*id).or_insert(i);
        }
        let mut items: Vec<QueuedMessage> = q.drain(..).collect();
        // Stable sort: known ids by their requested rank, unknown ids after
        // (kept in their original order because the sort is stable).
        items.sort_by_key(|m| rank.get(&m.id).copied().unwrap_or(usize::MAX));
        *q = items.iter().cloned().collect();
        items
    }

    /// Remove all queued messages for a session, returning them in order.
    pub fn clear_queue(&self, session_id: Uuid) -> Vec<QueuedMessage> {
        self.queue
            .remove(&session_id)
            .map(|(_, q)| q.into_iter().collect())
            .unwrap_or_default()
    }

    /// Get the queued messages for a session (oldest first).
    pub fn get_queued(&self, session_id: Uuid) -> Vec<QueuedMessage> {
        self.queue
            .get(&session_id)
            .map(|q| q.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Check if a session has at least one queued message.
    pub fn has_queued(&self, session_id: Uuid) -> bool {
        self.queue
            .get(&session_id)
            .map(|q| !q.is_empty())
            .unwrap_or(false)
    }

    /// Get queue status for frontend display.
    pub fn get_status(&self, session_id: Uuid) -> QueueStatus {
        let messages = self.get_queued(session_id);
        if messages.is_empty() {
            QueueStatus::Empty
        } else {
            QueueStatus::Queued { messages }
        }
    }

    /// Mark a session as being steered: its currently-running turn is about to be
    /// killed by a "send now" request, and the front queued message must still be
    /// drained when that kill completes (instead of being discarded).
    ///
    /// Returns `true` only if this call set the flag — i.e. no steer was already
    /// in flight for the session. Callers use this as a compare-and-set so the
    /// first steer owns the interrupt (kills the running turn) and concurrent
    /// steers queue behind it instead of starting a second kill.
    pub fn mark_steering(&self, session_id: Uuid) -> bool {
        self.steering.insert(session_id)
    }

    /// Whether a steer is currently in flight for the session — the flag is set
    /// but not yet consumed by the drain. Non-consuming peek.
    pub fn is_steering(&self, session_id: Uuid) -> bool {
        self.steering.contains(&session_id)
    }

    /// Consume the steering flag for a session, returning whether it was set.
    pub fn take_steering(&self, session_id: Uuid) -> bool {
        self.steering.remove(&session_id).is_some()
    }

    fn new_message(session_id: Uuid, data: DraftFollowUpData) -> QueuedMessage {
        QueuedMessage {
            id: Uuid::new_v4(),
            session_id,
            data,
            queued_at: Utc::now(),
        }
    }
}

impl Default for QueuedMessageService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use executors::{executors::BaseCodingAgent, profile::ExecutorConfig};

    use super::*;

    fn sample_data(message: &str) -> DraftFollowUpData {
        DraftFollowUpData {
            message: message.to_string(),
            executor_config: ExecutorConfig::new(BaseCodingAgent::ClaudeCode),
        }
    }

    #[test]
    fn enqueue_preserves_fifo_order_and_drains_from_front() {
        let svc = QueuedMessageService::new();
        let session = Uuid::new_v4();

        svc.enqueue(session, sample_data("first"));
        svc.enqueue(session, sample_data("second"));
        svc.enqueue(session, sample_data("third"));

        let queued = svc.get_queued(session);
        assert_eq!(queued.len(), 3);
        assert_eq!(queued[0].data.message, "first");
        assert_eq!(queued[2].data.message, "third");

        assert_eq!(svc.take_next(session).unwrap().data.message, "first");
        assert_eq!(svc.take_next(session).unwrap().data.message, "second");
        assert_eq!(svc.take_next(session).unwrap().data.message, "third");
        assert!(svc.take_next(session).is_none());
        assert!(!svc.has_queued(session));
    }

    #[test]
    fn enqueue_front_jumps_the_line() {
        let svc = QueuedMessageService::new();
        let session = Uuid::new_v4();

        svc.enqueue(session, sample_data("queued"));
        svc.enqueue_front(session, sample_data("steered"));

        assert_eq!(svc.take_next(session).unwrap().data.message, "steered");
        assert_eq!(svc.take_next(session).unwrap().data.message, "queued");
    }

    #[test]
    fn cancel_message_removes_only_the_targeted_id() {
        let svc = QueuedMessageService::new();
        let session = Uuid::new_v4();

        let a = svc.enqueue(session, sample_data("a"));
        let b = svc.enqueue(session, sample_data("b"));

        assert_eq!(svc.cancel_message(session, a.id).unwrap().id, a.id);
        let remaining = svc.get_queued(session);
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, b.id);

        // Cancelling the last one empties (and removes) the session entry.
        svc.cancel_message(session, b.id);
        assert!(!svc.has_queued(session));
        assert!(matches!(svc.get_status(session), QueueStatus::Empty));
    }

    #[test]
    fn promote_to_front_moves_existing_message() {
        let svc = QueuedMessageService::new();
        let session = Uuid::new_v4();

        svc.enqueue(session, sample_data("a"));
        let b = svc.enqueue(session, sample_data("b"));
        svc.enqueue(session, sample_data("c"));

        assert!(svc.promote_to_front(session, b.id));
        let queued = svc.get_queued(session);
        assert_eq!(queued[0].data.message, "b");
        assert_eq!(queued[1].data.message, "a");
        assert_eq!(queued[2].data.message, "c");

        // Promoting the front message is a no-op success.
        assert!(svc.promote_to_front(session, b.id));
        assert_eq!(svc.get_queued(session)[0].data.message, "b");

        // Unknown id (or empty session) returns false.
        assert!(!svc.promote_to_front(session, Uuid::new_v4()));
        assert!(!svc.promote_to_front(Uuid::new_v4(), b.id));
    }

    #[test]
    fn reorder_applies_requested_order_and_keeps_unlisted() {
        let svc = QueuedMessageService::new();
        let session = Uuid::new_v4();

        let a = svc.enqueue(session, sample_data("a"));
        let b = svc.enqueue(session, sample_data("b"));
        let c = svc.enqueue(session, sample_data("c"));

        // Reverse the order explicitly.
        svc.reorder(session, &[c.id, b.id, a.id]);
        let queued = svc.get_queued(session);
        assert_eq!(queued[0].data.message, "c");
        assert_eq!(queued[1].data.message, "b");
        assert_eq!(queued[2].data.message, "a");

        // A partial/stale list: only `a` is named (+ an unknown id). `a` goes to
        // the front; the unnamed ones (c, b) follow in their current order.
        svc.reorder(session, &[a.id, Uuid::new_v4()]);
        let queued = svc.get_queued(session);
        assert_eq!(queued[0].data.message, "a");
        assert_eq!(queued[1].data.message, "c");
        assert_eq!(queued[2].data.message, "b");

        // Reorder on an empty/unknown session is a harmless no-op.
        assert!(svc.reorder(Uuid::new_v4(), &[a.id]).is_empty());
    }

    #[test]
    fn clear_queue_returns_all_in_order() {
        let svc = QueuedMessageService::new();
        let session = Uuid::new_v4();
        svc.enqueue(session, sample_data("a"));
        svc.enqueue(session, sample_data("b"));

        let cleared = svc.clear_queue(session);
        assert_eq!(cleared.len(), 2);
        assert_eq!(cleared[0].data.message, "a");
        assert!(!svc.has_queued(session));
    }

    #[test]
    fn steering_flag_is_one_shot() {
        let svc = QueuedMessageService::new();
        let session = Uuid::new_v4();

        assert!(!svc.is_steering(session));
        assert!(!svc.take_steering(session));

        // First mark wins (returns true); a concurrent mark loses (false) so it
        // won't start a second kill.
        assert!(svc.mark_steering(session));
        assert!(svc.is_steering(session));
        assert!(!svc.mark_steering(session));

        // `take` consumes the flag exactly once.
        assert!(svc.take_steering(session));
        assert!(!svc.is_steering(session));
        assert!(!svc.take_steering(session));
    }
}
