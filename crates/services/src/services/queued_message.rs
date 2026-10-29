use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
};

use chrono::{DateTime, Utc};
use dashmap::{DashMap, mapref::entry::Entry};
use db::models::{scratch::DraftFollowUpData, session_queued_messages::SessionQueuedMessages};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tokio::sync::{mpsc, oneshot};
use ts_rs::TS;
use uuid::Uuid;

/// Why a queue restored at startup waits for the user: the turn it was queued
/// behind died with the server, so nothing will drain it on its own.
const RESTART_HOLD_REASON: &str = "the server restarted before it was sent";

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
    /// Why the last attempt to start this message failed. Set when a drain or
    /// steer took it off the queue and could not start it; while it heads the
    /// queue, the queue waits for the user (send now / edit / remove).
    pub start_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub artifact_request: Option<super::artifact_interactions::ArtifactInteractionRef>,
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

/// Service for managing queued follow-up messages: kept in memory, written
/// behind to the DB (see [`Self::load`]) so a restart doesn't lose them.
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
    /// session id -> live [`DrainHold`]s: processes that will drain (or
    /// discard) the queue themselves when they finish.
    drain_holds: Arc<DashMap<Uuid, usize>>,
    /// Sessions whose queue changed, for the DB writer. `None` keeps the
    /// queue in memory only.
    persist: Option<mpsc::UnboundedSender<QueueWrite>>,
}

struct QueueWrite {
    session_id: Uuid,
    acknowledgement: Option<oneshot::Sender<Result<(), String>>>,
}

/// While alive, an enqueue for the session leaves its message to the holder
/// (see [`QueuedMessageService::hold_drain`]).
pub struct DrainHold {
    holds: Arc<DashMap<Uuid, usize>>,
    session_id: Uuid,
}

impl Drop for DrainHold {
    fn drop(&mut self) {
        if let Entry::Occupied(mut holds) = self.holds.entry(self.session_id) {
            *holds.get_mut() -= 1;
            if *holds.get() == 0 {
                holds.remove();
            }
        }
    }
}

impl QueuedMessageService {
    pub fn new() -> Self {
        Self {
            queue: Arc::new(DashMap::new()),
            steering: Arc::new(DashMap::new()),
            drain_holds: Arc::new(DashMap::new()),
            persist: None,
        }
    }

    /// Restore the queues persisted before the last shutdown and keep writing
    /// every change back to `pool`. A restored queue's front waits for the user
    /// like a failed start (see [`Self::hold_front`]).
    pub async fn load(pool: SqlitePool) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let svc = Self {
            persist: Some(tx),
            ..Self::new()
        };
        match SessionQueuedMessages::find_all(&pool).await {
            Ok(rows) => {
                for row in rows {
                    match serde_json::from_str::<VecDeque<QueuedMessage>>(&row.messages) {
                        Ok(q) if !q.is_empty() => {
                            svc.queue.insert(row.session_id, q);
                            svc.hold_front(row.session_id, RESTART_HOLD_REASON.to_string());
                        }
                        Ok(_) => {}
                        // The row stays until the session's queue changes, and
                        // the log keeps the text either way.
                        Err(e) => tracing::warn!(
                            session_id = %row.session_id,
                            error = %e,
                            messages = %row.messages,
                            "Could not restore persisted queued messages"
                        ),
                    }
                }
            }
            Err(e) => tracing::error!(error = %e, "Failed to load persisted queued messages"),
        }
        tokio::spawn(write_queues(svc.queue.clone(), pool, rx));
        svc
    }

    /// Tell the DB writer `session_id`'s queue changed. Call after the change.
    fn changed(&self, session_id: Uuid) {
        if let Some(tx) = &self.persist {
            let _ = tx.send(QueueWrite {
                session_id,
                acknowledgement: None,
            });
        }
        let size = self.queue.get(&session_id).map(|q| q.len()).unwrap_or(0);
        crate::services::agent_journal::publish(
            "queue.changed",
            None,
            Some(session_id),
            None,
            serde_json::json!({ "size": size }),
        );
    }

    /// A queue HTTP acknowledgement must survive a crash, not just a JSON/cache write.
    pub async fn flush(&self, session_id: Uuid) -> std::io::Result<()> {
        let writer = self
            .persist
            .as_ref()
            .ok_or_else(|| std::io::Error::other("durable queue is not configured"))?;
        let (send, receive) = oneshot::channel();
        writer
            .send(QueueWrite {
                session_id,
                acknowledgement: Some(send),
            })
            .map_err(|_| std::io::Error::other("queue writer stopped"))?;
        receive
            .await
            .map_err(|_| std::io::Error::other("queue writer stopped before acknowledgement"))?
            .map_err(std::io::Error::other)
    }

    async fn persist_cancellations(
        &self,
        messages: Vec<QueuedMessage>,
    ) -> anyhow::Result<Vec<QueuedMessage>> {
        for message in &messages {
            if let Some(reference) = &message.artifact_request
                && let Err(error) = super::artifact_interactions::mark_cancelled(reference).await
            {
                // Keep an unconfirmed cancellation visible and held for the user.
                for message in messages.iter().rev() {
                    self.restore_failed(message.clone(), error.to_string());
                }
                return Err(error);
            }
        }
        Ok(messages)
    }

    /// Append a message to the back of a session's queue.
    pub fn enqueue(&self, session_id: Uuid, data: DraftFollowUpData) -> QueuedMessage {
        let queued = Self::new_message(session_id, data);
        self.queue
            .entry(session_id)
            .or_default()
            .push_back(queued.clone());
        self.changed(session_id);
        queued
    }

    pub fn enqueue_artifact(
        &self,
        session_id: Uuid,
        data: DraftFollowUpData,
        reference: super::artifact_interactions::ArtifactInteractionRef,
    ) -> QueuedMessage {
        let mut queued = Self::new_message(session_id, data);
        queued.artifact_request = Some(reference);
        self.queue
            .entry(session_id)
            .or_default()
            .push_back(queued.clone());
        self.changed(session_id);
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
        self.changed(session_id);
        queued
    }

    /// Return an interrupted attempt to dequeue without changing its identity.
    pub fn requeue_front(&self, mut msg: QueuedMessage) {
        msg.start_error = None;
        let session_id = msg.session_id;
        self.queue.entry(session_id).or_default().push_front(msg);
        self.changed(session_id);
    }

    /// Put a message that was taken off the queue but failed to start back at
    /// the front, keeping its id and recording why. The queue then stops
    /// draining on its own until the user acts on it, so the failure is neither
    /// lost nor retried behind the user's back.
    pub fn restore_failed(&self, mut msg: QueuedMessage, error: String) {
        msg.start_error = Some(error);
        let session_id = msg.session_id;
        self.queue.entry(session_id).or_default().push_front(msg);
        self.changed(session_id);
    }

    /// Hold the queue behind a failure that is not its front message's own
    /// (e.g. the cleanup ahead of it failed): the front waits with `reason`
    /// exactly like a message that failed to start. Keeps an earlier reason.
    pub fn hold_front(&self, session_id: Uuid, reason: String) {
        if let Some(mut q) = self.queue.get_mut(&session_id)
            && let Some(front) = q.front_mut()
            && front.start_error.is_none()
        {
            front.start_error = Some(reason);
            drop(q);
            self.changed(session_id);
        }
    }

    /// After claiming an artifact, an uncertain start needs a new request,
    /// never another execution of the same response from the queue.
    pub async fn restore_failed_dispatch(&self, message: QueuedMessage, error: String) {
        if let Some(reference) = &message.artifact_request
            && let Ok(receipt) = super::artifact_interactions::load(reference).await
            && receipt.dispatch_claimed
        {
            match super::artifact_interactions::mark_dispatch_failed(reference, &error).await {
                Ok(()) => return,
                Err(cause) => tracing::warn!(%cause, "Could not record artifact start failure"),
            }
        }
        self.restore_failed(message, error);
    }

    /// Pop the front message unless it failed to start (see
    /// [`Self::restore_failed`]); that one waits for an explicit retry.
    fn pop_ready(q: &mut VecDeque<QueuedMessage>) -> Option<QueuedMessage> {
        if q.front()?.start_error.is_some() {
            return None;
        }
        q.pop_front()
    }

    /// Remove and return the front (oldest) message for a session, if any.
    /// Used by the finalization flow to consume the next queued message.
    pub fn take_next(&self, session_id: Uuid) -> Option<QueuedMessage> {
        let msg = self
            .queue
            .get_mut(&session_id)
            .and_then(|mut q| Self::pop_ready(&mut q));
        self.queue.remove_if(&session_id, |_, q| q.is_empty());
        if msg.is_some() {
            self.changed(session_id);
        }
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
                None => Self::pop_ready(&mut q),
            }
        });
        self.queue.remove_if(&session_id, |_, q| q.is_empty());
        if msg.is_some() {
            self.changed(session_id);
        }
        msg
    }

    /// Update a queued message's content in place, preserving its queue
    /// position. Returns the updated message, or `None` if it's no longer
    /// queued (already drained or cancelled).
    pub fn update_message(
        &self,
        session_id: Uuid,
        message_id: Uuid,
        data: DraftFollowUpData,
    ) -> Option<QueuedMessage> {
        let updated = self.queue.get_mut(&session_id).and_then(|mut q| {
            q.iter_mut()
                .find(|m| m.id == message_id && m.artifact_request.is_none())
                .map(|m| {
                    m.data = data;
                    m.clone()
                })
        });
        if updated.is_some() {
            self.changed(session_id);
        }
        updated
    }

    /// Cancel a single queued message by id. Returns the removed message if found.
    pub async fn cancel_message(
        &self,
        session_id: Uuid,
        message_id: Uuid,
    ) -> anyhow::Result<Option<QueuedMessage>> {
        let _hold = self.hold_drain(session_id);
        let removed = self.queue.get_mut(&session_id).and_then(|mut q| {
            q.iter()
                .position(|m| m.id == message_id)
                .and_then(|pos| q.remove(pos))
        });
        self.queue.remove_if(&session_id, |_, q| q.is_empty());
        if removed.is_some() {
            self.changed(session_id);
        }
        Ok(self
            .persist_cancellations(removed.into_iter().collect())
            .await?
            .pop())
    }

    /// Move an already-queued message to the front of its session's queue, so a
    /// "send now" on a queued item retries it next. Returns `true` if the message
    /// was found (and is now at the front), `false` if it isn't queued anymore.
    pub fn promote_to_front(&self, session_id: Uuid, message_id: Uuid) -> bool {
        let Some(mut q) = self.queue.get_mut(&session_id) else {
            return false;
        };
        let Some(pos) = q.iter().position(|m| m.id == message_id) else {
            return false;
        };
        if let Some(mut msg) = q.remove(pos) {
            msg.start_error = None;
            q.push_front(msg);
            drop(q);
            self.changed(session_id);
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
        drop(q);
        self.changed(session_id);
        items
    }

    /// Remove all queued messages for a session, returning them in order.
    pub async fn clear_queue(&self, session_id: Uuid) -> anyhow::Result<Vec<QueuedMessage>> {
        let _hold = self.hold_drain(session_id);
        let cleared: Vec<QueuedMessage> = self
            .queue
            .remove(&session_id)
            .map(|(_, q)| q.into_iter().collect())
            .unwrap_or_default();
        if !cleared.is_empty() {
            self.changed(session_id);
        }
        self.persist_cancellations(cleared).await
    }

    /// Remove the messages queued by the time a failed or stopped turn ended —
    /// the ones it would have run — and keep those sent after it ended (the
    /// follow-up route queues a send while the turn finishes), which the
    /// turn's drain then starts. `None` (end unknown) removes them all.
    pub async fn discard_queued_by(
        &self,
        session_id: Uuid,
        ended_at: Option<DateTime<Utc>>,
    ) -> anyhow::Result<Vec<QueuedMessage>> {
        let _hold = self.hold_drain(session_id);
        let Some(ended_at) = ended_at else {
            return self.clear_queue(session_id).await;
        };
        let discarded: Vec<QueuedMessage> = self
            .queue
            .get_mut(&session_id)
            .map(|mut q| {
                let (discarded, kept): (VecDeque<_>, VecDeque<_>) =
                    q.drain(..).partition(|m| m.queued_at <= ended_at);
                *q = kept;
                discarded.into()
            })
            .unwrap_or_default();
        self.queue.remove_if(&session_id, |_, q| q.is_empty());
        if !discarded.is_empty() {
            self.changed(session_id);
        }
        self.persist_cancellations(discarded).await
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

    /// Claim the session's queue drain for a process that will drain (or
    /// discard) it when it finishes, so an enqueue meanwhile doesn't start a
    /// turn of its own. Once the hold is dropped, the holder must run
    /// `ContainerService::drain_queue_if_idle`: a message that landed after
    /// its own drain looked at the queue has nobody else to start it.
    pub fn hold_drain(&self, session_id: Uuid) -> DrainHold {
        *self.drain_holds.entry(session_id).or_default() += 1;
        DrainHold {
            holds: self.drain_holds.clone(),
            session_id,
        }
    }

    /// Whether some process holds the session's drain (see [`Self::hold_drain`]).
    pub fn is_drain_held(&self, session_id: Uuid) -> bool {
        self.drain_holds.contains_key(&session_id)
    }

    /// Whether this caller may start the session's next queued message itself:
    /// the front message is ready (not a failed start waiting for the user),
    /// no steer is in flight, and no process holds the drain. The caller still
    /// has to check for running processes.
    pub fn can_drain_now(&self, session_id: Uuid) -> bool {
        self.queue
            .get(&session_id)
            .is_some_and(|q| q.front().is_some_and(|m| m.start_error.is_none()))
            && !self.is_steering(session_id)
            && !self.is_drain_held(session_id)
    }

    fn new_message(session_id: Uuid, data: DraftFollowUpData) -> QueuedMessage {
        QueuedMessage {
            id: Uuid::new_v4(),
            session_id,
            data,
            queued_at: Utc::now(),
            start_error: None,
            artifact_request: None,
        }
    }
}

/// Write each changed session's queue as it is *now*, not as it was when it
/// changed, so the stored copy converges on the latest state whatever order
/// the notifications arrive in.
// shortcut: background edits still converge asynchronously; HTTP queue acceptance
// uses flush, and any other caller promising durable acceptance must do the same.
async fn write_queues(
    queue: Arc<DashMap<Uuid, VecDeque<QueuedMessage>>>,
    pool: SqlitePool,
    mut changed: mpsc::UnboundedReceiver<QueueWrite>,
) {
    while let Some(write) = changed.recv().await {
        let session_id = write.session_id;
        let messages: Vec<QueuedMessage> = queue
            .get(&session_id)
            .map(|q| q.iter().cloned().collect())
            .unwrap_or_default();
        let result = if messages.is_empty() {
            SessionQueuedMessages::delete(&pool, session_id)
                .await
                .map_err(|e| e.to_string())
        } else {
            match serde_json::to_string(&messages) {
                Ok(json) => SessionQueuedMessages::upsert(&pool, session_id, &json)
                    .await
                    .map_err(|e| e.to_string()),
                Err(e) => Err(e.to_string()),
            }
        };
        if let Err(error) = &result {
            tracing::warn!(%session_id, %error, "Failed to persist queued messages");
        }
        if let Some(acknowledgement) = write.acknowledgement {
            let _ = acknowledgement.send(result);
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

    #[tokio::test]
    async fn cancel_message_removes_only_the_targeted_id() {
        let svc = QueuedMessageService::new();
        let session = Uuid::new_v4();

        let a = svc.enqueue(session, sample_data("a"));
        let b = svc.enqueue(session, sample_data("b"));

        assert_eq!(
            svc.cancel_message(session, a.id).await.unwrap().unwrap().id,
            a.id
        );
        let remaining = svc.get_queued(session);
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, b.id);

        // Cancelling the last one empties (and removes) the session entry.
        svc.cancel_message(session, b.id).await.unwrap();
        assert!(!svc.has_queued(session));
        assert!(matches!(svc.get_status(session), QueueStatus::Empty));
    }

    #[test]
    fn update_message_edits_in_place_preserving_position() {
        let svc = QueuedMessageService::new();
        let session = Uuid::new_v4();

        svc.enqueue(session, sample_data("a"));
        let b = svc.enqueue(session, sample_data("b"));
        svc.enqueue(session, sample_data("c"));

        let updated = svc
            .update_message(session, b.id, sample_data("b-edited"))
            .unwrap();
        assert_eq!(updated.id, b.id);
        assert_eq!(updated.data.message, "b-edited");

        // Position and neighbors unchanged.
        let queued = svc.get_queued(session);
        assert_eq!(queued[0].data.message, "a");
        assert_eq!(queued[1].data.message, "b-edited");
        assert_eq!(queued[2].data.message, "c");

        // Unknown id (or session) is a no-op returning None.
        assert!(
            svc.update_message(session, Uuid::new_v4(), sample_data("x"))
                .is_none()
        );
        assert!(
            svc.update_message(Uuid::new_v4(), b.id, sample_data("x"))
                .is_none()
        );
    }

    #[test]
    fn artifact_response_keeps_its_payload_and_request_when_queued() {
        let svc = QueuedMessageService::new();
        let session = Uuid::new_v4();
        let reference = super::super::artifact_interactions::ArtifactInteractionRef {
            session_id: session,
            execution_id: Uuid::new_v4(),
            request_id: Uuid::new_v4(),
        };
        let queued = svc.enqueue_artifact(session, sample_data("accepted"), reference.clone());
        assert!(
            svc.update_message(session, queued.id, sample_data("edited"))
                .is_none()
        );
        let encoded = serde_json::to_string(&svc.get_queued(session)[0]).unwrap();
        let restored: QueuedMessage = serde_json::from_str(&encoded).unwrap();
        assert_eq!(restored.data.message, "accepted");
        assert_eq!(restored.artifact_request, Some(reference));
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
    fn promoting_a_failed_message_retries_it_without_changing_its_identity() {
        for already_front in [false, true] {
            let svc = QueuedMessageService::new();
            let session = Uuid::new_v4();
            let failed = svc.enqueue(session, sample_data("retry"));
            let taken = svc.take_next(session).unwrap();
            svc.restore_failed(taken, "spawn failed".into());
            let other = svc.enqueue(session, sample_data("other"));
            if !already_front {
                svc.promote_to_front(session, other.id);
            }

            assert!(svc.promote_to_front(session, failed.id));
            let retry = svc.take_next(session).unwrap();
            assert_eq!(retry.id, failed.id);
            assert_eq!(retry.queued_at, failed.queued_at);
            assert!(retry.start_error.is_none());
            assert_eq!(svc.take_next(session).unwrap().id, other.id);
        }
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
    fn restore_failed_keeps_id_and_order_and_pauses_auto_drain() {
        let svc = QueuedMessageService::new();
        let session = Uuid::new_v4();

        let a = svc.enqueue(session, sample_data("a"));
        let b = svc.enqueue(session, sample_data("b"));

        // A drain takes `a`, then fails to start it.
        let taken = svc.take_next(session).unwrap();
        assert_eq!(taken.id, a.id);
        svc.restore_failed(taken, "executor mismatch".to_string());

        // Same id, back in front of `b`, with the reason.
        let queued = svc.get_queued(session);
        assert_eq!(
            queued.iter().map(|m| m.id).collect::<Vec<_>>(),
            [a.id, b.id]
        );
        assert_eq!(queued[0].start_error.as_deref(), Some("executor mismatch"));
        assert_eq!(queued[0].queued_at, a.queued_at);

        // Automatic drains (next turn, or a steer whose target is gone) don't
        // retry it, and don't jump `b` ahead of it.
        assert!(svc.take_next(session).is_none());
        assert!(svc.take_steered_or_front(session, Uuid::new_v4()).is_none());
        assert_eq!(svc.get_queued(session).len(), 2);

        // An explicit "send now" on it still takes it.
        assert_eq!(svc.take_steered_or_front(session, a.id).unwrap().id, a.id);
        assert_eq!(svc.take_next(session).unwrap().id, b.id);
        assert!(!svc.has_queued(session));
    }

    #[test]
    fn hold_front_pauses_auto_drain_until_the_front_is_sent() {
        let svc = QueuedMessageService::new();
        let session = Uuid::new_v4();

        // Nothing queued: nothing to hold, and a later message is not held.
        svc.hold_front(session, "cleanup failed".into());
        let a = svc.enqueue(session, sample_data("a"));
        svc.enqueue(session, sample_data("b"));
        assert!(svc.get_queued(session)[0].start_error.is_none());

        svc.hold_front(session, "cleanup failed".into());
        svc.hold_front(session, "later".into());
        let queued = svc.get_queued(session);
        assert_eq!(queued[0].start_error.as_deref(), Some("cleanup failed"));
        assert!(queued[1].start_error.is_none());
        assert!(svc.take_next(session).is_none());

        // "Send now" on the held front releases the rest.
        assert_eq!(svc.take_steered_or_front(session, a.id).unwrap().id, a.id);
        assert_eq!(svc.take_next(session).unwrap().data.message, "b");
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

    #[tokio::test]
    async fn clear_queue_returns_all_in_order() {
        let svc = QueuedMessageService::new();
        let session = Uuid::new_v4();
        svc.enqueue(session, sample_data("a"));
        svc.enqueue(session, sample_data("b"));

        let cleared = svc.clear_queue(session).await.unwrap();
        assert_eq!(cleared.len(), 2);
        assert_eq!(cleared[0].data.message, "a");
        assert!(!svc.has_queued(session));
    }

    #[tokio::test]
    async fn discard_queued_by_keeps_messages_sent_after_the_turn_ended() {
        let svc = QueuedMessageService::new();
        let session = Uuid::new_v4();
        svc.enqueue(session, sample_data("behind"));
        std::thread::sleep(std::time::Duration::from_millis(5));
        let ended_at = Utc::now();
        std::thread::sleep(std::time::Duration::from_millis(5));
        svc.enqueue(session, sample_data("after"));

        let discarded = svc
            .discard_queued_by(session, Some(ended_at))
            .await
            .unwrap();
        assert_eq!(discarded.len(), 1);
        assert_eq!(discarded[0].data.message, "behind");
        assert_eq!(svc.get_queued(session)[0].data.message, "after");

        assert_eq!(svc.discard_queued_by(session, None).await.unwrap().len(), 1);
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

    async fn stored(pool: &SqlitePool, session: Uuid) -> Option<Vec<QueuedMessage>> {
        // The writer runs behind the queue; wait for it to settle.
        let mut last = None;
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            last = SessionQueuedMessages::find_all(pool)
                .await
                .unwrap()
                .into_iter()
                .find(|r| r.session_id == session)
                .map(|r| serde_json::from_str(&r.messages).unwrap());
        }
        last
    }

    #[tokio::test]
    async fn queue_survives_a_restart_with_its_front_held() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
        let (workspace, session) = (Uuid::new_v4(), Uuid::new_v4());
        sqlx::query("INSERT INTO workspaces (id, branch, name) VALUES ($1, 'vk/test', 'q')")
            .bind(workspace)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sessions (id, workspace_id) VALUES ($1, $2)")
            .bind(session)
            .bind(workspace)
            .execute(&pool)
            .await
            .unwrap();

        let before = QueuedMessageService::load(pool.clone()).await;
        let a = before.enqueue(session, sample_data("a"));
        let b = before.enqueue(session, sample_data("b"));
        before.update_message(session, b.id, sample_data("b-edited"));
        assert_eq!(stored(&pool, session).await.unwrap().len(), 2);
        drop(before);

        let after = QueuedMessageService::load(pool.clone()).await;
        let queued = after.get_queued(session);
        assert_eq!(
            queued.iter().map(|m| m.id).collect::<Vec<_>>(),
            [a.id, b.id]
        );
        assert_eq!(queued[1].data.message, "b-edited");
        assert_eq!(queued[0].start_error.as_deref(), Some(RESTART_HOLD_REASON));
        assert!(queued[1].start_error.is_none());
        assert!(
            !after.can_drain_now(session),
            "restored queue waits for the user"
        );

        // "Send now" on the held front releases it; emptying deletes the row.
        assert_eq!(after.take_steered_or_front(session, a.id).unwrap().id, a.id);
        assert_eq!(after.take_next(session).unwrap().id, b.id);
        assert!(stored(&pool, session).await.is_none());
    }

    #[test]
    fn drain_is_free_only_without_holds_or_steer() {
        let svc = QueuedMessageService::new();
        let session = Uuid::new_v4();
        assert!(!svc.can_drain_now(session), "nothing queued");

        let msg = svc.enqueue(session, sample_data("a"));
        assert!(svc.can_drain_now(session));

        let first = svc.hold_drain(session);
        let second = svc.hold_drain(session);
        assert!(!svc.can_drain_now(session));
        drop(first);
        assert!(!svc.can_drain_now(session), "one hold still alive");
        drop(second);
        assert!(svc.can_drain_now(session));

        svc.mark_steering(session, msg.id);
        assert!(!svc.can_drain_now(session));
        svc.take_steering(session);

        // A failed start in front waits for the user.
        let taken = svc.take_next(session).unwrap();
        svc.restore_failed(taken, "spawn failed".to_string());
        assert!(!svc.can_drain_now(session));
    }
    #[tokio::test]
    async fn flush_acknowledges_storage_and_rejects_a_failed_writer() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
        let workspace = Uuid::new_v4();
        let session = Uuid::new_v4();
        sqlx::query("INSERT INTO workspaces(id,branch) VALUES(?,'vk/synthetic-queue')")
            .bind(workspace)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sessions(id,workspace_id) VALUES(?,?)")
            .bind(session)
            .bind(workspace)
            .execute(&pool)
            .await
            .unwrap();
        let service = QueuedMessageService::load(pool.clone()).await;
        let message = service.enqueue(session, sample_data("synthetic durable message"));
        service.flush(session).await.unwrap();
        // No polling or sleep: the successful acknowledgement already includes DB storage.
        let restored = QueuedMessageService::load(pool.clone()).await;
        assert_eq!(restored.get_queued(session)[0].id, message.id);
        pool.close().await;
        assert!(service.flush(session).await.is_err());
        assert!(QueuedMessageService::new().flush(session).await.is_err());
    }
}
