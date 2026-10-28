use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::executors::ExecutorError;

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
pub struct AgentUsageWindow {
    pub label: String,
    pub used_percent: f64,
    pub reset_description: Option<String>,
}

#[derive(Debug)]
pub struct AgentUsageSnapshot {
    pub windows: Vec<AgentUsageWindow>,
    pub reset_credits: Option<u32>,
}

pub(crate) fn parse_codex_usage(
    response: codex_app_server_protocol::GetAccountRateLimitsResponse,
) -> AgentUsageSnapshot {
    let reset_credits = response
        .rate_limit_reset_credits
        .and_then(|credits| u32::try_from(credits.available_count).ok());
    let windows = [response.rate_limits.primary, response.rate_limits.secondary]
        .into_iter()
        .flatten()
        .filter(|window| (0..=100).contains(&window.used_percent))
        .map(|window| AgentUsageWindow {
            label: match window.window_duration_mins {
                Some(300) => "5h".to_string(),
                Some(10080) => "7d".to_string(),
                Some(mins) => format!("{mins} min"),
                None => "Usage".to_string(),
            },
            used_percent: f64::from(window.used_percent),
            reset_description: window
                .resets_at
                .and_then(|seconds| chrono::DateTime::from_timestamp(seconds, 0))
                .map(|time| format!("resets {}", time.format("%Y-%m-%d %H:%M UTC"))),
        })
        .collect();
    AgentUsageSnapshot {
        windows,
        reset_credits,
    }
}

pub(crate) fn parse_claude_usage(output: &[u8]) -> Result<Vec<AgentUsageWindow>, ExecutorError> {
    let invalid = || {
        ExecutorError::Io(std::io::Error::other(
            "Claude Code did not return subscription usage from the local /usage command",
        ))
    };
    let value: serde_json::Value = serde_json::from_slice(output).map_err(|_| invalid())?;
    if value["is_error"] == true
        || value["local_command"] != "usage"
        || value["num_turns"].as_u64() != Some(0)
        || value["total_cost_usd"].as_f64() != Some(0.0)
    {
        return Err(invalid());
    }

    // shortcut: /usage returns English text inside JSON; update this parser if its labels change.
    let windows: Vec<_> = value["result"]
        .as_str()
        .ok_or_else(invalid)?
        .lines()
        .filter_map(|line| {
            let (label, usage) = line.split_once(": ")?;
            if label != "Current session" && !label.starts_with("Current week") {
                return None;
            }
            let (percent, rest) = usage.split_once("% used")?;
            let used_percent: f64 = percent.parse().ok()?;
            if !used_percent.is_finite() || !(0.0..=100.0).contains(&used_percent) {
                return None;
            }
            Some(AgentUsageWindow {
                label: label.to_string(),
                used_percent,
                reset_description: rest.trim().strip_prefix("· ").map(str::to_string),
            })
        })
        .collect();
    if windows.is_empty() {
        return Err(invalid());
    }
    Ok(windows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "requires installed Claude and Codex CLIs signed in to subscriptions"]
    async fn usage_live_cli_probes_return_subscription_windows() {
        let claude: crate::executors::claude::ClaudeCode =
            serde_json::from_value(serde_json::json!({})).unwrap();
        let codex: crate::executors::codex::Codex =
            serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(!claude.read_account_usage().await.unwrap().is_empty());
        let codex_usage = codex.read_account_usage().await.unwrap();
        assert!(!codex_usage.windows.is_empty());
        eprintln!("Codex reset credits: {:?}", codex_usage.reset_credits);
    }

    fn result(text: &str) -> serde_json::Value {
        serde_json::json!({
            "local_command": "usage", "is_error": false,
            "num_turns": 0, "total_cost_usd": 0, "result": text
        })
    }

    #[test]
    fn codex_usage_preserves_the_authoritative_reset_count_and_weekly_only_window() {
        let response = serde_json::from_value(serde_json::json!({
            "rateLimits": { "primary": { "usedPercent": 62, "windowDurationMins": 10080, "resetsAt": 1793599716 } },
            "rateLimitResetCredits": { "availableCount": 2, "credits": [] }
        })).unwrap();
        let usage = parse_codex_usage(response);
        assert_eq!(usage.reset_credits, Some(2));
        assert_eq!(usage.windows.len(), 1);
        assert_eq!(usage.windows[0].label, "7d");
        assert_eq!(usage.windows[0].used_percent, 62.0);
    }

    #[test]
    fn codex_usage_distinguishes_zero_unknown_and_invalid_reset_counts() {
        for (credits, expected) in [
            (serde_json::json!({ "availableCount": 0 }), Some(0)),
            (serde_json::Value::Null, None),
            (serde_json::json!({ "availableCount": -1 }), None),
            (serde_json::json!({ "availableCount": i64::MAX }), None),
        ] {
            let response = serde_json::from_value(serde_json::json!({
                "rateLimits": {}, "rateLimitResetCredits": credits
            }))
            .unwrap();
            assert_eq!(parse_codex_usage(response).reset_credits, expected);
        }
    }

    #[test]
    fn usage_parses_subscription_windows_without_local_activity_stats() {
        let value = result(
            "Current session: 0% used\nCurrent week (all models): 100% used · resets Oct 29 at 9:59am (Asia/Seoul)\nCurrent week (Fable): 60.5% used\nLast 7d · 100 requests\n  86% of your usage was at >150k context",
        );
        let windows = parse_claude_usage(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(windows.len(), 3);
        assert_eq!(windows[0].used_percent, 0.0);
        assert_eq!(windows[1].used_percent, 100.0);
        assert_eq!(windows[2].used_percent, 60.5);
        assert_eq!(
            windows[1].reset_description.as_deref(),
            Some("resets Oct 29 at 9:59am (Asia/Seoul)")
        );
    }

    #[test]
    fn usage_rejects_model_output_errors_and_missing_or_invalid_limits() {
        for value in [
            serde_json::json!({"result": "Current session: 42% used"}),
            result("API billing only"),
            result("Current session: NaN% used\nCurrent week: 101% used"),
            {
                let mut v = result("Current session: 42% used");
                v["num_turns"] = 1.into();
                v
            },
            {
                let mut v = result("Current session: 42% used");
                v["is_error"] = true.into();
                v
            },
        ] {
            assert!(parse_claude_usage(&serde_json::to_vec(&value).unwrap()).is_err());
        }
    }
}
