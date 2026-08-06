use std::{
    future::Future,
    hash::Hash,
    sync::{
        Arc, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use moka::future::Cache;
use tokio::sync::OnceCell;

pub struct PullRequestCache<K, V> {
    entries: Cache<K, Arc<OnceCell<V>>>,
}

/// Result of peeking a [`SwrCache`] entry without triggering a fetch.
pub enum Cached<V> {
    /// A value fetched within the freshness TTL.
    Fresh(V),
    /// A value past the freshness TTL — safe to serve while a refresh runs.
    Stale(V),
    /// No value cached yet.
    Missing,
}

struct Stamped<V> {
    value: V,
    stored_at: Instant,
}

struct SwrSlot<V> {
    value: RwLock<Option<Stamped<V>>>,
    /// Guards against spawning more than one background refresh per key.
    refreshing: AtomicBool,
}

/// RAII guard for a single-flight refresh claim. Dropping it releases the claim
/// (`refreshing` flag), so a background refresh that panics mid-fetch can't
/// leave the slot permanently wedged.
pub struct RefreshClaim<V> {
    slot: Arc<SwrSlot<V>>,
}

impl<V> Drop for RefreshClaim<V> {
    fn drop(&mut self) {
        self.slot.refreshing.store(false, Ordering::SeqCst);
    }
}

/// Stale-while-revalidate cache: reads never block on the fetch. A caller peeks
/// the current value (fresh/stale/missing) and, when it's stale or missing,
/// runs the fetch in the background so the tunnel-facing request returns
/// immediately instead of hanging on a slow `gh` call.
///
/// Unlike [`PullRequestCache`], expired entries are kept (served as `Stale`)
/// rather than evicted, so a refresh always has a prior value to fall back to.
/// `time_to_idle` only bounds memory for keys nobody reads anymore.
pub struct SwrCache<K, V> {
    entries: Cache<K, Arc<SwrSlot<V>>>,
    ttl: Duration,
}

impl<K, V> SwrCache<K, V>
where
    K: Eq + Hash + Clone + Send + Sync + 'static,
    V: Clone + Send + Sync + 'static,
{
    pub fn new(ttl: Duration) -> Self {
        Self {
            entries: Cache::builder()
                .max_capacity(500)
                .time_to_idle(Duration::from_secs(3600))
                .build(),
            ttl,
        }
    }

    async fn slot(&self, key: K) -> Arc<SwrSlot<V>> {
        self.entries
            .get_with(key, async {
                Arc::new(SwrSlot {
                    value: RwLock::new(None),
                    refreshing: AtomicBool::new(false),
                })
            })
            .await
    }

    /// Returns the currently cached value and its freshness without fetching.
    pub async fn peek(&self, key: &K) -> Cached<V> {
        let Some(slot) = self.entries.get(key).await else {
            return Cached::Missing;
        };
        let guard = slot.value.read().expect("swr cache lock poisoned");
        match guard.as_ref() {
            None => Cached::Missing,
            Some(stamped) if stamped.stored_at.elapsed() < self.ttl => {
                Cached::Fresh(stamped.value.clone())
            }
            Some(stamped) => Cached::Stale(stamped.value.clone()),
        }
    }

    /// Stores a freshly fetched value, stamping it as fresh.
    pub async fn store(&self, key: K, value: V) {
        let slot = self.slot(key).await;
        *slot.value.write().expect("swr cache lock poisoned") = Some(Stamped {
            value,
            stored_at: Instant::now(),
        });
    }

    /// Claims the single background-refresh slot for `key`. Returns a
    /// [`RefreshClaim`] guard when the caller won the claim (it should run the
    /// refresh); `None` when a refresh is already in flight (skip — it will fill
    /// the cache). The claim is released when the guard drops, so it is freed
    /// even if the refreshing task panics mid-fetch.
    pub async fn begin_refresh(&self, key: K) -> Option<RefreshClaim<V>> {
        let slot = self.slot(key).await;
        match slot.refreshing.compare_exchange(
            false,
            true,
            Ordering::SeqCst,
            Ordering::SeqCst,
        ) {
            Ok(_) => Some(RefreshClaim { slot }),
            Err(_) => None,
        }
    }
}

impl<K, V> PullRequestCache<K, V>
where
    K: Eq + Hash + Clone + Send + Sync + 'static,
    V: Clone + Send + Sync + 'static,
{
    pub fn new(ttl: Duration) -> Self {
        Self {
            entries: Cache::builder().max_capacity(500).time_to_live(ttl).build(),
        }
    }

    pub async fn get_or_try_init<E, F, Fut>(&self, key: K, init: F) -> Result<V, E>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<V, E>>,
    {
        let cell = self
            .entries
            .get_with(key, async { Arc::new(OnceCell::new()) })
            .await;
        cell.get_or_try_init(init).await.cloned()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use super::*;

    #[tokio::test]
    async fn coalesces_concurrent_requests_for_the_same_key() {
        let cache = Arc::new(PullRequestCache::new(Duration::from_secs(60)));
        let calls = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();

        for _ in 0..4 {
            let cache = cache.clone();
            let calls = calls.clone();
            tasks.push(tokio::spawn(async move {
                cache
                    .get_or_try_init("same", || async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        tokio::task::yield_now().await;
                        Ok::<_, ()>(42)
                    })
                    .await
            }));
        }

        for task in tasks {
            assert_eq!(task.await.unwrap(), Ok(42));
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn retries_after_an_initialization_error() {
        let cache = PullRequestCache::new(Duration::from_secs(60));
        let first = cache
            .get_or_try_init("key", || async { Err::<usize, _>("failed") })
            .await;
        let second = cache
            .get_or_try_init("key", || async { Ok::<_, &str>(7) })
            .await;

        assert_eq!(first, Err("failed"));
        assert_eq!(second, Ok(7));
    }

    #[tokio::test]
    async fn swr_serves_stale_before_ttl_and_after() {
        // ttl=0 makes every stored value immediately stale, so we can assert the
        // fresh-vs-stale transition without sleeping.
        let fresh = SwrCache::<&str, i32>::new(Duration::from_secs(60));
        assert!(matches!(fresh.peek(&"k").await, Cached::Missing));
        fresh.store("k", 1).await;
        assert!(matches!(fresh.peek(&"k").await, Cached::Fresh(1)));

        let stale = SwrCache::<&str, i32>::new(Duration::from_millis(0));
        stale.store("k", 7).await;
        assert!(matches!(stale.peek(&"k").await, Cached::Stale(7)));
    }

    #[tokio::test]
    async fn swr_refresh_claim_is_single_flight() {
        let cache = SwrCache::<&str, i32>::new(Duration::from_secs(60));
        let claim = cache.begin_refresh("k").await;
        assert!(claim.is_some(), "first claim wins");
        assert!(
            cache.begin_refresh("k").await.is_none(),
            "second claim blocked while refreshing"
        );
        drop(claim);
        assert!(
            cache.begin_refresh("k").await.is_some(),
            "claim reusable after release"
        );
    }

    #[tokio::test]
    async fn swr_refresh_claim_released_when_task_panics() {
        let cache = SwrCache::<&str, i32>::new(Duration::from_secs(60));
        let claim = cache.begin_refresh("k").await.expect("first claim wins");
        // A background refresh holds the claim and panics mid-fetch.
        let handle = tokio::spawn(async move {
            let _claim = claim;
            panic!("boom");
        });
        assert!(handle.await.is_err(), "task panicked");
        // The guard's Drop must have released the claim during unwind, so the
        // slot is not permanently wedged.
        assert!(
            cache.begin_refresh("k").await.is_some(),
            "claim freed after a panicking task"
        );
    }
}
