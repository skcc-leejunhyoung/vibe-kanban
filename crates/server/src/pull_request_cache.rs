use std::{future::Future, hash::Hash, sync::Arc, time::Duration};

use moka::future::Cache;
use tokio::sync::OnceCell;

pub struct PullRequestCache<K, V> {
    entries: Cache<K, Arc<OnceCell<V>>>,
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
}
