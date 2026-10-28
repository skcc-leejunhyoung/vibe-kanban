use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::executors::ExecutorError;

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
pub struct AgentUsageWindow {
    pub label: String,
    pub used_percent: f64,
    pub reset_description: Option<String>,
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
        assert!(!codex.read_account_usage().await.unwrap().is_empty());
    }

    fn result(text: &str) -> serde_json::Value {
        serde_json::json!({
            "local_command": "usage", "is_error": false,
            "num_turns": 0, "total_cost_usd": 0, "result": text
        })
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
