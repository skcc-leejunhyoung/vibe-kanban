use std::{
    future::Future,
    sync::LazyLock,
    time::{Duration, Instant},
};

use axum::{Json, Router, extract::Path, routing::get};
use chrono::{DateTime, Utc};
use executors::{
    executors::{BaseCodingAgent, CodingAgent},
    profile::{ExecutorConfigs, ExecutorProfileId},
    usage::{AgentUsageSnapshot, AgentUsageWindow},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use ts_rs::TS;
use utils::response::ApiResponse;

use crate::{DeploymentImpl, error::ApiError};

const REFRESH: Duration = Duration::from_secs(5 * 60);
static CLAUDE_USAGE: LazyLock<Mutex<UsageCache>> = LazyLock::new(Default::default);
static CODEX_USAGE: LazyLock<Mutex<UsageCache>> = LazyLock::new(Default::default);

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentUsage {
    pub windows: Vec<AgentUsageWindow>,
    pub reset_credits: Option<u32>,
    pub reset_credit_expirations: Vec<Option<DateTime<Utc>>>,
    pub updated_at: Option<DateTime<Utc>>,
    pub next_refresh_at: DateTime<Utc>,
    pub unavailable: bool,
}

#[derive(Default)]
struct UsageCache {
    fingerprint: Option<[u8; 32]>,
    value: Option<AgentUsage>,
    next_attempt: Option<Instant>,
    failures: u32,
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new().route("/agents/{executor}/usage", get(get_usage))
}

async fn get_usage(
    Path(executor): Path<BaseCodingAgent>,
) -> Result<Json<ApiResponse<AgentUsage>>, ApiError> {
    let cache = match executor {
        BaseCodingAgent::ClaudeCode => &*CLAUDE_USAGE,
        BaseCodingAgent::Codex => &*CODEX_USAGE,
        _ => {
            return Err(ApiError::BadRequest(
                "Usage is only available for Claude Code and Codex".into(),
            ));
        }
    };
    // Usage follows this host's default CLI login across session presets.
    let agent = ExecutorConfigs::get_cached().get_coding_agent(&ExecutorProfileId::new(executor));
    // Discard cached values when that default CLI configuration changes.
    let fingerprint =
        Sha256::digest(serde_json::to_vec(&agent).map_err(std::io::Error::other)?).into();
    let value = cached_usage(cache, fingerprint, async {
        let result = match agent {
            Some(CodingAgent::ClaudeCode(claude))
                if !claude.claude_code_router.unwrap_or(false) =>
            {
                claude
                    .read_account_usage()
                    .await
                    .map(|windows| AgentUsageSnapshot {
                        windows,
                        reset_credits: None,
                        reset_credit_expirations: Vec::new(),
                    })
            }
            Some(CodingAgent::Codex(codex)) if !codex.oss.unwrap_or(false) => {
                codex.read_account_usage().await
            }
            _ => return Err(()),
        };
        // CLI output/errors can include account details; expose only availability.
        result.map_err(|_| ())
    })
    .await;
    Ok(Json(ApiResponse::success(value)))
}

async fn cached_usage(
    cache: &Mutex<UsageCache>,
    fingerprint: [u8; 32],
    fetch: impl Future<Output = Result<AgentUsageSnapshot, ()>>,
) -> AgentUsage {
    // Hold the per-provider lock through refresh: tabs and tooltips share one probe.
    let mut cache = cache.lock().await;
    if cache.fingerprint != Some(fingerprint) {
        *cache = UsageCache {
            fingerprint: Some(fingerprint),
            ..Default::default()
        };
    }
    if cache.next_attempt.is_some_and(|next| Instant::now() < next)
        && let Some(value) = &cache.value
    {
        return value.clone();
    }

    let result = fetch.await;
    let now = Utc::now();
    let mut value = cache.value.take().unwrap_or(AgentUsage {
        windows: Vec::new(),
        reset_credits: None,
        reset_credit_expirations: Vec::new(),
        updated_at: None,
        next_refresh_at: now,
        unavailable: false,
    });
    let delay = match result {
        Ok(usage) if !usage.windows.is_empty() || usage.reset_credits.is_some() => {
            value.windows = usage.windows;
            value.reset_credits = usage.reset_credits;
            value.reset_credit_expirations = usage.reset_credit_expirations;
            value.updated_at = Some(now);
            value.unavailable = false;
            cache.failures = 0;
            REFRESH
        }
        _ => {
            cache.failures = (cache.failures + 1).min(3);
            value.unavailable = true;
            Duration::from_secs(15 * 60 * 2_u64.pow(cache.failures - 1))
        }
    };
    value.next_refresh_at = now + chrono::Duration::from_std(delay).expect("bounded delay");
    cache.next_attempt = Some(Instant::now() + delay);
    cache.value = Some(value.clone());
    value
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use super::*;

    fn usage() -> AgentUsageSnapshot {
        AgentUsageSnapshot {
            windows: vec![AgentUsageWindow {
                label: "5h".into(),
                used_percent: 25.0,
                reset_description: None,
            }],
            reset_credits: Some(2),
            reset_credit_expirations: vec![DateTime::from_timestamp(1793299994, 0)],
        }
    }

    #[tokio::test]
    async fn usage_cache_coalesces_concurrent_requests() {
        let cache = Arc::new(Mutex::new(UsageCache::default()));
        let calls = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for _ in 0..10 {
            let (cache, calls) = (cache.clone(), calls.clone());
            tasks.push(tokio::spawn(async move {
                cached_usage(&cache, [0; 32], async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    tokio::task::yield_now().await;
                    Ok(usage())
                })
                .await
            }));
        }
        for task in tasks {
            let value = task.await.unwrap();
            assert_eq!(value.windows, usage().windows);
            assert_eq!(value.reset_credits, Some(2));
            assert_eq!(
                value.reset_credit_expirations,
                usage().reset_credit_expirations
            );
            assert!(!value.unavailable);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn usage_failure_preserves_last_success_and_backs_off() {
        let cache = Mutex::new(UsageCache::default());
        let initial = cached_usage(&cache, [0; 32], async { Ok(usage()) }).await;
        for minutes in [15, 30, 60, 60] {
            cache.lock().await.next_attempt = None;
            let value = cached_usage(&cache, [0; 32], async { Err(()) }).await;
            assert!(value.unavailable);
            assert_eq!(value.updated_at, initial.updated_at);
            assert_eq!(value.windows, initial.windows);
            assert_eq!(value.reset_credits, initial.reset_credits);
            assert_eq!(
                value.reset_credit_expirations,
                initial.reset_credit_expirations
            );
            assert!(
                (minutes * 60 - 2..=minutes * 60)
                    .contains(&(value.next_refresh_at - Utc::now()).num_seconds())
            );
            cached_usage(&cache, [0; 32], async {
                panic!("cooldown must suppress probes")
            })
            .await;
        }
        cache.lock().await.next_attempt = None;
        assert!(
            !cached_usage(&cache, [0; 32], async { Ok(usage()) })
                .await
                .unavailable
        );
        assert_eq!(cache.lock().await.failures, 0);
    }

    #[tokio::test]
    async fn usage_profile_change_discards_previous_account_and_cooldown() {
        let cache = Mutex::new(UsageCache::default());
        cached_usage(&cache, [0; 32], async { Ok(usage()) }).await;
        let changed = cached_usage(&cache, [1; 32], async { Err(()) }).await;
        assert!(changed.unavailable);
        assert!(changed.windows.is_empty());
        assert!(changed.reset_credits.is_none());
        assert!(changed.reset_credit_expirations.is_empty());
        assert!(changed.updated_at.is_none());
    }

    #[tokio::test]
    async fn usage_refresh_clears_reset_counts_that_are_no_longer_available() {
        let cache = Mutex::new(UsageCache::default());
        cached_usage(&cache, [0; 32], async { Ok(usage()) }).await;
        for reset_credits in [Some(0), None] {
            cache.lock().await.next_attempt = None;
            let value = cached_usage(&cache, [0; 32], async {
                Ok(AgentUsageSnapshot {
                    reset_credits,
                    reset_credit_expirations: Vec::new(),
                    ..usage()
                })
            })
            .await;
            assert_eq!(value.reset_credits, reset_credits);
            assert!(value.reset_credit_expirations.is_empty());
            assert!(!value.unavailable);
        }
    }

    #[tokio::test]
    async fn usage_accepts_reset_credits_without_a_quota_window() {
        let cache = Mutex::new(UsageCache::default());
        let value = cached_usage(&cache, [0; 32], async {
            Ok(AgentUsageSnapshot {
                windows: Vec::new(),
                reset_credits: Some(0),
                reset_credit_expirations: Vec::new(),
            })
        })
        .await;
        assert!(!value.unavailable);
        assert_eq!(value.reset_credits, Some(0));
    }
}
