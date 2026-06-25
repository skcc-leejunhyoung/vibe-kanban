use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
};

use chrono::{DateTime, Utc};
use dashmap::{DashMap, mapref::entry::Entry};
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
/// several follow-ups stacked up. The `steering` map marks sessions whose
/// currently-running turn was interrupted by a "send now" request, and records
/// *which* queued message id that steer pinned — those sessions drain that
/// specific message even though the execution was killed, regardless of any
/// reorder/promote that landed in the meantime
/// (see `LocalContainerService::handle_execution_post_completion`).
#[derive(Clone)]
pub struct QueuedMessageService {
    queue: Arc<DashMap<Uuid, VecDeque<QueuedMessage>>>,
    /// session id -> the queued message id the in-flight steer kill must drain.
    steering: Arc<DashMap<Uuid, Uuid>>,
}

impl QueuedMessageService {
    pub fn new() -> Self {
        Self {
            queue: Arc::new(DashMap::new()),
            steering: Arc::new(DashMap::new()),
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

    /// Remove and return the steered message `message_id` if it's still queued,
    /// otherwise fall back to the front message. Used by the steer-kill exit
    /// handler so the interrupt drains the message the user actually steered
    /// regardless of its current queue position (a concurrent reorder/promote
    /// may have moved it), while still draining *something* — and thus
    /// preserving the rest of the queue — if the steered message was cancelled
    /// out from under us.
    pub fn take_steered_or_front(
        &self,
        session_id: Uuid,
        message_id: Uuid,
    ) -> Option<QueuedMessage> {
        let msg = self.queue.get_mut(&session_id).and_then(|mut q| {
            match q.iter().position(|m| m.id == message_id) {
                Some(pos) => q.remove(pos),
                None => q.pop_front(),
            }
        });
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

    /// Mark a session as being steered toward `message_id`: its currently-running
    /// turn is about to be killed by a "send now", and when that kill completes
    /// the exit handler must drain *this specific message* (by id) as the
    /// interrupting follow-up — not merely whatever sits at the queue front.
    /// Pinning the target by id means a concurrent reorder/promote/cancel can't
    /// divert the interrupt to a different message.
    ///
    /// Returns `true` only if this call set the target — i.e. no steer was
    /// already in flight for the session. Callers use this as a compare-and-set
    /// so the first steer owns the interrupt (kills the running turn) and
    /// concurrent steers queue behind it instead of starting a second kill.
    pub fn mark_steering(&self, session_id: Uuid, message_id: Uuid) -> bool {
        match self.steering.entry(session_id) {
            Entry::Occupied(_) => false,
            Entry::Vacant(e) => {
                e.insert(message_id);
                true
            }
        }
    }

    /// Whether a steer is currently in flight for the session — the target is set
    /// but not yet consumed by the drain. Non-consuming peek.
    pub fn is_steering(&self, session_id: Uuid) -> bool {
        self.steering.contains_key(&session_id)
    }

    /// Consume the steering target for a session, returning the steered message
    /// id if one was set.
    pub fn take_steering(&self, session_id: Uuid) -> Option<Uuid> {
        self.steering
            .remove(&session_id)
            .map(|(_, message_id)| message_id)
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
    fn take_steered_or_front_drains_pinned_id_then_falls_back() {
        let svc = QueuedMessageService::new();
        let session = Uuid::new_v4();

        let a = svc.enqueue(session, sample_data("a"));
        let b = svc.enqueue(session, sample_data("b"));
        let c = svc.enqueue(session, sample_data("c"));

        // The pinned id is drained regardless of its queue position (here the
        // middle), leaving the rest of the queue intact and in order — this is
        // what stops a concurrent reorder/promote from diverting the interrupt.
        assert_eq!(svc.take_steered_or_front(session, b.id).unwrap().id, b.id);
        let queued = svc.get_queued(session);
        assert_eq!(queued.len(), 2);
        assert_eq!(queued[0].id, a.id);
        assert_eq!(queued[1].id, c.id);

        // If the pinned id is gone (e.g. cancelled), fall back to the front so
        // the queue still drains rather than stranding the remaining messages.
        assert_eq!(
            svc.take_steered_or_front(session, Uuid::new_v4())
                .unwrap()
                .id,
            a.id
        );

        // Draining the last one cleans up the session entry.
        assert_eq!(svc.take_steered_or_front(session, c.id).unwrap().id, c.id);
        assert!(!svc.has_queued(session));

        // Empty/unknown session yields None (no panic, nothing to fall back to).
        assert!(svc.take_steered_or_front(Uuid::new_v4(), a.id).is_none());
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
        let msg = Uuid::new_v4();
        let other = Uuid::new_v4();

        assert!(!svc.is_steering(session));
        assert_eq!(svc.take_steering(session), None);

        // First mark wins (returns true) and pins the steered message id; a
        // concurrent mark loses (false) so it won't start a second kill — and it
        // does not overwrite the pinned target.
        assert!(svc.mark_steering(session, msg));
        assert!(svc.is_steering(session));
        assert!(!svc.mark_steering(session, other));

        // `take` consumes the target exactly once, returning the pinned id.
        assert_eq!(svc.take_steering(session), Some(msg));
        assert!(!svc.is_steering(session));
        assert_eq!(svc.take_steering(session), None);
    }
}
