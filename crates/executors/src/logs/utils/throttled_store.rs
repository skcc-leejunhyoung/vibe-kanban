//! Per-entry throttling of cumulative streaming `replace` patches.
//!
//! Normalizers re-send the whole entry on every token / output delta, so the
//! bytes pushed for one entry grow quadratically with its length. Routing
//! those replaces through [`ThrottledMsgStore`] keeps at most one in-flight
//! snapshot per entry and spaces them by [`STREAM_REPLACE_INTERVAL`], while
//! every other patch (adds, completions, removals) still goes out at once and
//! carries any held snapshot with it — the final state of an entry is never
//! lost, only intermediate ones are skipped.

use std::{
    collections::{BTreeMap, HashMap},
    ops::Deref,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use json_patch::{Patch, PatchOperation};
use workspace_utils::msg_store::MsgStore;

use crate::logs::{
    NormalizedEntry,
    utils::patch::{ConversationPatch, PatchSink},
};

/// Minimum spacing between two cumulative `replace` patches of the same
/// streaming entry (~12 updates/s, more than a reader can follow).
pub const STREAM_REPLACE_INTERVAL: Duration = Duration::from_millis(80);

#[derive(Default)]
struct Gate {
    /// Newest held replace per path; older held snapshots are overwritten.
    pending: BTreeMap<String, Patch>,
    last_sent: HashMap<String, Instant>,
}

/// [`MsgStore`] wrapper that defers streaming replaces. Derefs to the store
/// for everything that is not a conversation patch.
pub struct ThrottledMsgStore {
    inner: Arc<MsgStore>,
    interval: Duration,
    gate: Mutex<Gate>,
}

impl ThrottledMsgStore {
    pub fn new(inner: Arc<MsgStore>) -> Self {
        Self::with_interval(inner, STREAM_REPLACE_INTERVAL)
    }

    pub fn with_interval(inner: Arc<MsgStore>, interval: Duration) -> Self {
        Self {
            inner,
            interval,
            gate: Mutex::new(Gate::default()),
        }
    }

    /// Push right away. Held replaces of other paths go out first so the store
    /// never sees an older snapshot after a newer one; a held replace of this
    /// same path is dropped because this patch supersedes it.
    pub fn push_patch(&self, patch: Patch) {
        let held = {
            let mut gate = self.gate.lock().unwrap();
            let now = Instant::now();
            match patch.0.as_slice() {
                [PatchOperation::Remove(op)] => {
                    let path = op.path.to_string();
                    gate.pending.remove(&path);
                    gate.last_sent.remove(&path);
                }
                [op] => {
                    let path = op.path().to_string();
                    gate.pending.remove(&path);
                    gate.last_sent.insert(path, now);
                }
                _ => {}
            }
            let held = std::mem::take(&mut gate.pending);
            for path in held.keys() {
                gate.last_sent.insert(path.clone(), now);
            }
            held
        };
        for (_, patch) in held {
            self.inner.push_patch(patch);
        }
        self.inner.push_patch(patch);
    }

    /// Cumulative replace of a streaming entry: sent now if the entry was not
    /// updated within the interval, otherwise held (replacing any earlier held
    /// snapshot) until the interval elapses, the next immediate push, [`flush`]
    /// or drop. Anything that is not a single `replace` is pushed immediately.
    ///
    /// [`flush`]: Self::flush
    pub fn push_patch_deferred(&self, patch: Patch) {
        let [PatchOperation::Replace(op)] = patch.0.as_slice() else {
            return self.push_patch(patch);
        };
        let path = op.path.to_string();
        let now = Instant::now();
        let mut gate = self.gate.lock().unwrap();
        if gate
            .last_sent
            .get(&path)
            .is_some_and(|sent| now.duration_since(*sent) < self.interval)
        {
            gate.pending.insert(path, patch);
            return;
        }
        gate.pending.remove(&path);
        gate.last_sent.insert(path, now);
        drop(gate);
        self.inner.push_patch(patch);
    }

    pub fn replace_deferred(&self, index: usize, entry: NormalizedEntry) {
        self.push_patch_deferred(ConversationPatch::replace(index, entry));
    }

    pub fn upsert_deferred(&self, index: usize, entry: NormalizedEntry, is_new: bool) {
        if is_new {
            self.push_patch(ConversationPatch::add_normalized_entry(index, entry));
        } else {
            self.replace_deferred(index, entry);
        }
    }

    /// Send every held replace now.
    pub fn flush(&self) {
        let held = {
            let mut gate = self.gate.lock().unwrap();
            let now = Instant::now();
            let held = std::mem::take(&mut gate.pending);
            for path in held.keys() {
                gate.last_sent.insert(path.clone(), now);
            }
            held
        };
        for (_, patch) in held {
            self.inner.push_patch(patch);
        }
    }
}

impl PatchSink for ThrottledMsgStore {
    fn push_patch(&self, patch: Patch) {
        ThrottledMsgStore::push_patch(self, patch);
    }
}

impl Deref for ThrottledMsgStore {
    type Target = MsgStore;

    fn deref(&self) -> &MsgStore {
        &self.inner
    }
}

impl Drop for ThrottledMsgStore {
    fn drop(&mut self) {
        self.flush();
    }
}

#[cfg(test)]
mod tests {
    use workspace_utils::log_msg::LogMsg;

    use super::*;
    use crate::logs::{NormalizedEntryType, utils::patch::extract_normalized_entry_from_patch};

    fn entry(content: &str) -> NormalizedEntry {
        NormalizedEntry {
            timestamp: None,
            entry_type: NormalizedEntryType::AssistantMessage,
            content: content.to_string(),
            metadata: None,
        }
    }

    /// `(op, index, content)` of every conversation patch in push order.
    fn pushed(store: &MsgStore) -> Vec<(&'static str, usize, String)> {
        store
            .get_history()
            .iter()
            .filter_map(|msg| match msg {
                LogMsg::JsonPatch(patch) => {
                    let op = match patch.0.as_slice() {
                        [PatchOperation::Add(_)] => "add",
                        [PatchOperation::Replace(_)] => "replace",
                        _ => "other",
                    };
                    extract_normalized_entry_from_patch(patch)
                        .map(|(index, entry)| (op, index, entry.content))
                }
                _ => None,
            })
            .collect()
    }

    fn never() -> Duration {
        Duration::from_secs(3600)
    }

    #[test]
    fn held_replaces_keep_only_the_latest_snapshot_until_flushed() {
        let inner = Arc::new(MsgStore::new());
        let store = ThrottledMsgStore::with_interval(inner.clone(), never());
        store.upsert_deferred(0, entry("a"), true);
        store.replace_deferred(0, entry("ab"));
        store.replace_deferred(0, entry("abc"));
        assert_eq!(pushed(&inner), vec![("add", 0, "a".to_string())]);

        store.flush();
        assert_eq!(
            pushed(&inner),
            vec![
                ("add", 0, "a".to_string()),
                ("replace", 0, "abc".to_string())
            ]
        );
    }

    #[test]
    fn immediate_push_flushes_other_paths_first_and_supersedes_its_own() {
        let inner = Arc::new(MsgStore::new());
        let store = ThrottledMsgStore::with_interval(inner.clone(), never());
        store.push_patch(ConversationPatch::add_normalized_entry(0, entry("x")));
        store.push_patch(ConversationPatch::add_normalized_entry(1, entry("y")));
        store.replace_deferred(0, entry("x1"));
        store.replace_deferred(1, entry("y1"));
        store.push_patch(ConversationPatch::replace(1, entry("y-final")));

        assert_eq!(
            pushed(&inner),
            vec![
                ("add", 0, "x".to_string()),
                ("add", 1, "y".to_string()),
                ("replace", 0, "x1".to_string()),
                ("replace", 1, "y-final".to_string()),
            ]
        );
    }

    #[test]
    fn elapsed_interval_sends_replaces_immediately() {
        let inner = Arc::new(MsgStore::new());
        let store = ThrottledMsgStore::with_interval(inner.clone(), Duration::ZERO);
        store.upsert_deferred(0, entry("a"), true);
        for n in 1..=5 {
            store.replace_deferred(0, entry(&"a".repeat(n + 1)));
        }
        assert_eq!(pushed(&inner).len(), 6);
    }

    #[test]
    fn drop_flushes_held_replaces() {
        let inner = Arc::new(MsgStore::new());
        {
            let store = ThrottledMsgStore::with_interval(inner.clone(), never());
            store.upsert_deferred(3, entry("a"), true);
            store.replace_deferred(3, entry("final"));
        }
        assert_eq!(
            pushed(&inner),
            vec![
                ("add", 3, "a".to_string()),
                ("replace", 3, "final".to_string())
            ]
        );
    }

    #[test]
    fn removal_drops_held_replace_of_the_same_path() {
        let inner = Arc::new(MsgStore::new());
        let store = ThrottledMsgStore::with_interval(inner.clone(), never());
        store.upsert_deferred(2, entry("a"), true);
        store.replace_deferred(2, entry("stale"));
        store.push_patch(ConversationPatch::remove(2));
        store.flush();
        assert_eq!(pushed(&inner), vec![("add", 2, "a".to_string())]);
        assert_eq!(inner.get_history().len(), 2);
    }
}
