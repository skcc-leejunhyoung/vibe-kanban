use std::{
    hash::Hash,
    num::NonZeroUsize,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

use futures::StreamExt;
use lru::LruCache;

use super::{BaseCodingAgent, SlashCommandDescription, StandardCodingAgentExecutor};
use crate::{
    executor_discovery::{ExecutorConfigCacheKey, ExecutorDiscoveredOptions},
    profile::ExecutorConfigs,
};

pub(super) fn provider_request_error(
    agent: &str,
    status: Option<i64>,
    login: &str,
    fallback: &str,
) -> super::ExecutorError {
    match status {
        Some(401 | 403) => super::ExecutorError::AuthRequired(format!(
            "{agent}: the provider rejected the credentials or access to the model. {login}"
        )),
        Some(404) => agent_error(format!(
            "{agent}: the provider could not find the selected model or API endpoint (HTTP 404). Check the model ID and provider URL."
        )),
        _ => agent_error(fallback),
    }
}

/// Refuses a turn under a permission policy the agent cannot honour instead
/// of running it under a different one.
pub(super) fn unsupported_policy(
    agent: &str,
    policy: &crate::model_selector::PermissionPolicy,
    supported: &str,
) -> super::ExecutorError {
    agent_error(format!(
        "{agent} cannot run with the {policy:?} permission policy. Choose {supported}."
    ))
}

/// Refuses the turn when the requested policy is one the agent does not implement.
pub(super) fn refuse_unsupported(
    agent: &str,
    policy: &Option<crate::model_selector::PermissionPolicy>,
    supported: &str,
) -> Result<(), super::ExecutorError> {
    match policy {
        Some(policy) => Err(unsupported_policy(agent, policy, supported)),
        None => Ok(()),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlashCommandCall<'a> {
    /// The command name in lowercase (without the leading slash)
    pub name: String,
    /// The arguments after the command name
    pub arguments: &'a str,
}

pub fn parse_slash_command<'a, T>(prompt: &'a str) -> Option<T>
where
    T: From<SlashCommandCall<'a>>,
{
    let trimmed = prompt.trim_start();
    let without_slash = trimmed.strip_prefix('/')?;
    let mut parts = without_slash.splitn(2, |ch: char| ch.is_whitespace());
    let name = parts.next()?.trim().to_lowercase();
    if name.is_empty() {
        return None;
    }
    let arguments = parts.next().map(|s| s.trim()).unwrap_or("");
    Some(T::from(SlashCommandCall { name, arguments }))
}

/// Reorder slash commands to prioritize compact then review.
#[must_use]
pub fn reorder_slash_commands(
    commands: impl IntoIterator<Item = SlashCommandDescription>,
) -> Vec<SlashCommandDescription> {
    let mut compact_command = None;
    let mut review_commands = None;
    let mut remaining_commands = Vec::new();

    for command in commands {
        match command.name.as_str() {
            "compact" => compact_command = Some(command),
            "review" => review_commands = Some(command),
            _ => remaining_commands.push(command),
        }
    }

    compact_command
        .into_iter()
        .chain(review_commands)
        .chain(remaining_commands)
        .collect()
}

#[derive(Clone, Debug)]
struct CacheEntry<V> {
    cached_at: Instant,
    value: Arc<V>,
}

pub struct TtlCache<K, V> {
    cache: Mutex<LruCache<K, CacheEntry<V>>>,
    ttl: Duration,
}

impl<K, V> TtlCache<K, V>
where
    K: Hash + Eq,
{
    pub fn new(capacity: usize, ttl: Duration) -> Self {
        Self {
            cache: Mutex::new(LruCache::new(
                NonZeroUsize::new(capacity).unwrap_or_else(|| NonZeroUsize::new(1).unwrap()),
            )),
            ttl,
        }
    }

    /// Fresh value only — for "skip the probe entirely" short circuits.
    #[must_use]
    pub fn get(&self, key: &K) -> Option<Arc<V>> {
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        let entry = cache.get(key)?;
        (entry.cached_at.elapsed() <= self.ttl).then(|| entry.value.clone())
    }

    /// Last known value, TTL be damned — for the provisional catalog shown
    /// while a refresh runs. Expired entries stay until LRU eviction, so a
    /// picker opened after the TTL still renders instantly.
    #[must_use]
    pub fn get_stale(&self, key: &K) -> Option<Arc<V>> {
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        Some(cache.get(key)?.value.clone())
    }

    pub fn put(&self, key: K, value: V) {
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        cache.put(
            key,
            CacheEntry {
                cached_at: Instant::now(),
                value: Arc::new(value),
            },
        );
    }

    /// Store a value that already counts as expired: `get` misses, `get_stale`
    /// still serves it. Lets tests exercise the "stale provisional + re-probe"
    /// path without waiting out the TTL. (Falls back to a fresh entry when the
    /// monotonic clock is too young to subtract from — only on a machine that
    /// booted seconds ago.)
    #[cfg(test)]
    pub fn put_expired(&self, key: K, value: V) {
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        cache.put(
            key,
            CacheEntry {
                cached_at: Instant::now()
                    .checked_sub(self.ttl * 2)
                    .unwrap_or_else(Instant::now),
                value: Arc::new(value),
            },
        );
    }
}

pub const EXECUTOR_OPTIONS_CACHE_CAPACITY: usize = 64;
pub const DEFAULT_CACHE_TTL: Duration = Duration::from_mins(5);

pub fn executor_options_cache()
-> &'static TtlCache<ExecutorConfigCacheKey, ExecutorDiscoveredOptions> {
    static INSTANCE: OnceLock<TtlCache<ExecutorConfigCacheKey, ExecutorDiscoveredOptions>> =
        OnceLock::new();
    INSTANCE.get_or_init(|| TtlCache::new(EXECUTOR_OPTIONS_CACHE_CAPACITY, DEFAULT_CACHE_TTL))
}

/// How many live executor probes (`claude`, `codex app-server`, the OpenCode
/// server) may run at once. Every open picker/editor stream used to spawn its
/// own probe, so a reconnect burst launched dozens of CLIs at once and all of
/// them blew the 10s discovery timeout.
const DISCOVERY_PROBE_LIMIT: usize = 4;

fn discovery_probe_semaphore() -> &'static tokio::sync::Semaphore {
    static INSTANCE: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    INSTANCE.get_or_init(|| tokio::sync::Semaphore::new(DISCOVERY_PROBE_LIMIT))
}

/// One lock per cache key so concurrent callers for the same catalog queue
/// behind a single probe and pick its result up from the cache.
// ponytail: LRU of 64 key locks; a burst of >64 distinct keys in flight can
// evict a held lock and double-probe that key. Switch to a Weak map if seen.
fn discovery_key_lock(key: &ExecutorConfigCacheKey) -> Arc<tokio::sync::Mutex<()>> {
    type Locks = LruCache<ExecutorConfigCacheKey, Arc<tokio::sync::Mutex<()>>>;
    static INSTANCE: OnceLock<Mutex<Locks>> = OnceLock::new();
    let locks = INSTANCE.get_or_init(|| {
        Mutex::new(LruCache::new(
            NonZeroUsize::new(EXECUTOR_OPTIONS_CACHE_CAPACITY).expect("non-zero capacity"),
        ))
    });
    let mut locks = locks.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(lock) = locks.get(key) {
        return lock.clone();
    }
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    locks.put(key.clone(), lock.clone());
    lock
}

/// Held for the duration of one live probe. Dropping it lets the next caller
/// for the same key see the freshly cached result and skip its own probe.
pub struct DiscoveryProbe {
    _key_guard: tokio::sync::OwnedMutexGuard<()>,
    _permit: tokio::sync::SemaphorePermit<'static>,
}

pub enum ProbeSlot {
    /// A catalog cached within the TTL — serve it, no probe needed.
    Cached(Arc<ExecutorDiscoveredOptions>),
    /// This caller runs the probe; hold the value until the cache is written.
    Probe(DiscoveryProbe),
}

/// Either a fresh cached catalog or the right to run the probe that produces
/// one. Concurrent callers for the same key wait for the first probe and then
/// find its result in the cache; distinct keys are throttled to
/// [`DISCOVERY_PROBE_LIMIT`] probes at a time.
// ponytail: failed probes are not cached, so a broken CLI still probes once per
// waiter (throttled); add a short negative-cache TTL if that ever matters.
pub async fn acquire_discovery_probe(key: &ExecutorConfigCacheKey) -> ProbeSlot {
    let cache = executor_options_cache();
    if let Some(fresh) = cache.get(key) {
        return ProbeSlot::Cached(fresh);
    }
    let key_guard = discovery_key_lock(key).lock_owned().await;
    if let Some(fresh) = cache.get(key) {
        return ProbeSlot::Cached(fresh);
    }
    let permit = discovery_probe_semaphore()
        .acquire()
        .await
        .expect("discovery semaphore is never closed");
    ProbeSlot::Probe(DiscoveryProbe {
        _key_guard: key_guard,
        _permit: permit,
    })
}

/// Spawn a background task to refresh the global cache for an executor.
/// This should be called on every use to keep the cache warm.
pub fn spawn_global_cache_refresh_for_agent(base_agent: BaseCodingAgent) {
    spawn_global_cache_refresh_for_agent_with_configs(base_agent, ExecutorConfigs::get_cached());
}

fn spawn_global_cache_refresh_for_agent_with_configs(
    base_agent: BaseCodingAgent,
    configs: ExecutorConfigs,
) {
    let profile_id = crate::profile::ExecutorProfileId::new(base_agent);

    if let Some(coding_agent) = configs.get_coding_agent(&profile_id) {
        tokio::spawn(async move {
            if let Ok(mut stream) = coding_agent.discover_options(None, None).await {
                while stream.next().await.is_some() {}
            }
        });
    }
}

/// Preload the global cache for all executors with DEFAULT presets.
/// This should be called on startup to warm the cache.
pub async fn preload_global_executor_options_cache() {
    let configs = ExecutorConfigs::get_cached();
    let executors: Vec<BaseCodingAgent> = configs.executors.keys().copied().collect();

    for base_agent in executors {
        spawn_global_cache_refresh_for_agent_with_configs(base_agent, configs.clone());
    }
}

pub(super) fn agent_error(message: impl Into<String>) -> super::ExecutorError {
    super::ExecutorError::Io(std::io::Error::other(message.into()))
}

pub(super) fn installation_error(
    error: super::ExecutorError,
    install: &str,
) -> super::ExecutorError {
    match error {
        super::ExecutorError::ExecutableNotFound { .. } => agent_error(install),
        other => other,
    }
}

pub(super) fn agent_command(
    base: &str,
    overrides: &crate::command::CmdOverrides,
) -> Result<crate::command::CommandParts, super::ExecutorError> {
    Ok(
        crate::command::apply_overrides(crate::command::CommandBuilder::new(base), overrides)?
            .build_initial()?,
    )
}

pub(super) fn agent_availability(
    base: &str,
    overrides: &crate::command::CmdOverrides,
) -> super::AvailabilityInfo {
    // Availability checks are synchronous; an actual launch refreshes the login-shell PATH.
    if agent_command(base, overrides)
        .ok()
        .is_some_and(|parts| parts.is_available())
    {
        super::AvailabilityInfo::InstallationFound
    } else {
        super::AvailabilityInfo::NotFound
    }
}

pub(super) fn discovery_dir(
    workdir: Option<&std::path::Path>,
    repo_path: Option<&std::path::Path>,
) -> std::path::PathBuf {
    workdir
        .or(repo_path)
        .map(std::path::Path::to_path_buf)
        .or_else(dirs::home_dir)
        .unwrap_or_else(std::env::temp_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expired_entries_stay_readable_as_stale() {
        let cache: TtlCache<&str, u32> = TtlCache::new(4, Duration::from_millis(1));
        cache.put("k", 7);
        assert_eq!(cache.get(&"k").as_deref(), Some(&7));

        std::thread::sleep(Duration::from_millis(5));
        assert!(cache.get(&"k").is_none(), "fresh read honours the TTL");
        assert_eq!(
            cache.get_stale(&"k").as_deref(),
            Some(&7),
            "stale read still serves the last catalog"
        );

        assert!(cache.get_stale(&"missing").is_none());
    }
}
