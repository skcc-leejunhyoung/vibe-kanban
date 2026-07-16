//! Process-wide cache of deduplicated normalized-log patches for finished
//! execution processes.
//!
//! Replaying a finished process re-reads its whole JSONL log from disk and
//! re-runs executor normalization — O(log bytes) CPU per viewer, serialized
//! behind a width-1 semaphore. A finished process's logs are immutable, so the
//! deduplicated patch list is cached after the first replay and served from
//! memory to every later viewer (workspace reopen, session switch, remote web
//! through the host relay).
//!
//! No invalidation hooks are needed: rows for deleted sessions/processes 404
//! in the route middleware before the container is consulted, and stale
//! entries age out via the byte-budget LRU below.

use std::{
    collections::HashMap,
    io::Write,
    sync::{Arc, Mutex, OnceLock},
};

use json_patch::Patch;
use uuid::Uuid;

/// Total byte budget across all cached processes. Sizes are measured as
/// serialized JSON; the in-memory `serde_json::Value` trees run a small
/// multiple of that, so the budget is kept deliberately modest.
const MAX_TOTAL_BYTES: usize = 32 * 1024 * 1024;
/// Processes whose deduped patches exceed this are not cached.
const MAX_ENTRY_BYTES: usize = 4 * 1024 * 1024;

struct CacheEntry {
    patches: Arc<Vec<Patch>>,
    bytes: usize,
    last_used: u64,
}

struct Cache {
    entries: HashMap<Uuid, CacheEntry>,
    total_bytes: usize,
    clock: u64,
}

impl Cache {
    fn new() -> Self {
        Self {
            entries: HashMap::new(),
            total_bytes: 0,
            clock: 0,
        }
    }

    fn get(&mut self, id: &Uuid) -> Option<Arc<Vec<Patch>>> {
        self.clock += 1;
        let clock = self.clock;
        self.entries.get_mut(id).map(|entry| {
            entry.last_used = clock;
            entry.patches.clone()
        })
    }

    fn insert(&mut self, id: Uuid, patches: Arc<Vec<Patch>>, bytes: usize) {
        if bytes > MAX_ENTRY_BYTES {
            return;
        }
        if let Some(old) = self.entries.remove(&id) {
            self.total_bytes = self.total_bytes.saturating_sub(old.bytes);
        }
        while self.total_bytes.saturating_add(bytes) > MAX_TOTAL_BYTES {
            let Some(evict_id) = self
                .entries
                .iter()
                .min_by_key(|(_, e)| e.last_used)
                .map(|(id, _)| *id)
            else {
                break;
            };
            if let Some(evicted) = self.entries.remove(&evict_id) {
                self.total_bytes = self.total_bytes.saturating_sub(evicted.bytes);
            }
        }
        self.clock += 1;
        self.entries.insert(
            id,
            CacheEntry {
                patches,
                bytes,
                last_used: self.clock,
            },
        );
        self.total_bytes = self.total_bytes.saturating_add(bytes);
    }
}

static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();

fn cache() -> &'static Mutex<Cache> {
    CACHE.get_or_init(|| Mutex::new(Cache::new()))
}

/// Serialized-JSON byte size of a patch, mirroring `LogMsg::approx_bytes`.
fn patch_bytes(patch: &Patch) -> usize {
    struct ByteCounter(usize);
    impl Write for ByteCounter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0 = self.0.saturating_add(buf.len());
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = ByteCounter(0);
    serde_json::to_writer(&mut counter, patch)
        .map(|()| counter.0)
        .unwrap_or(2)
}

pub fn get(id: &Uuid) -> Option<Arc<Vec<Patch>>> {
    cache().lock().ok()?.get(id)
}

pub fn insert(id: Uuid, patches: Arc<Vec<Patch>>) {
    let bytes: usize = patches.iter().map(patch_bytes).sum();
    if let Ok(mut cache) = cache().lock() {
        cache.insert(id, patches, bytes);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn add_patch(path: &str, value: serde_json::Value) -> Patch {
        serde_json::from_value(json!([{ "op": "add", "path": path, "value": value }])).unwrap()
    }

    #[test]
    fn cache_insert_get_and_lru_eviction() {
        let mut cache = Cache::new();
        let patches = Arc::new(vec![add_patch("/entries/0", json!("v"))]);
        // Fill the byte budget exactly with max-size entries, derived from the
        // constants so budget changes don't invalidate the arithmetic.
        let entry_bytes = MAX_ENTRY_BYTES;
        let capacity = MAX_TOTAL_BYTES / entry_bytes;
        assert!(capacity >= 2);

        let ids: Vec<Uuid> = (0..capacity).map(|_| Uuid::new_v4()).collect();
        for id in &ids {
            cache.insert(*id, patches.clone(), entry_bytes);
        }
        // Touch every entry in insertion order, then re-touch the first so the
        // second entry becomes the LRU victim.
        for id in &ids {
            assert!(cache.get(id).is_some());
        }
        assert!(cache.get(&ids[0]).is_some());

        let extra = Uuid::new_v4();
        cache.insert(extra, patches.clone(), entry_bytes);
        assert!(cache.get(&ids[1]).is_none());
        assert!(cache.get(&ids[0]).is_some());
        for id in &ids[2..] {
            assert!(cache.get(id).is_some());
        }
        assert!(cache.get(&extra).is_some());
        assert!(cache.total_bytes <= MAX_TOTAL_BYTES);
    }

    #[test]
    fn cache_reinsert_replaces_existing_entry_bytes() {
        let mut cache = Cache::new();
        let id = Uuid::new_v4();
        let patches = Arc::new(vec![add_patch("/entries/0", json!("v"))]);

        cache.insert(id, patches.clone(), 100);
        cache.insert(id, patches.clone(), 200);
        assert_eq!(cache.total_bytes, 200);
        assert!(cache.get(&id).is_some());
    }

    #[test]
    fn cache_skips_oversized_entries() {
        let mut cache = Cache::new();
        let id = Uuid::new_v4();
        let patches = Arc::new(vec![add_patch("/entries/0", json!("v"))]);
        cache.insert(id, patches, MAX_ENTRY_BYTES + 1);
        assert!(cache.get(&id).is_none());
    }

    #[test]
    fn patch_bytes_reflects_serialized_size() {
        let small = add_patch("/entries/0", json!("v"));
        let large = add_patch("/entries/0", json!("v".repeat(1000)));
        assert!(patch_bytes(&large) > patch_bytes(&small));
        assert!(patch_bytes(&small) > 0);
    }
}
