use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::executors::ExecutorError;

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
pub struct AgentUsageWindow {
    pub label: String,
    pub used_percent: f64,
    pub reset_description: Option<String>,
    #[serde(default)]
    pub resets_at: Option<DateTime<Utc>>,
}

#[derive(Debug)]
pub struct AgentUsageSnapshot {
    pub windows: Vec<AgentUsageWindow>,
    pub reset_credits: Option<u32>,
    pub reset_credit_expirations: Vec<Option<DateTime<Utc>>>,
}

pub(crate) fn parse_codex_usage(
    response: codex_app_server_protocol::GetAccountRateLimitsResponse,
) -> AgentUsageSnapshot {
    let reset_credits = response
        .rate_limit_reset_credits
        .as_ref()
        .and_then(|credits| u32::try_from(credits.available_count).ok());
    let mut reset_credit_expirations: Vec<_> = response
        .rate_limit_reset_credits
        .filter(|_| reset_credits.is_some_and(|count| count > 0))
        .and_then(|credits| credits.credits)
        .unwrap_or_default()
        .into_iter()
        .filter(|credit| {
            credit.status == codex_app_server_protocol::RateLimitResetCreditStatus::Available
        })
        .filter_map(|credit| match credit.expires_at {
            Some(seconds) => DateTime::from_timestamp(seconds, 0).map(Some),
            None => Some(None),
        })
        .collect();
    reset_credit_expirations.sort_by_key(|expiration| (expiration.is_none(), *expiration));
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
            resets_at: window
                .resets_at
                .and_then(|seconds| DateTime::from_timestamp(seconds, 0)),
        })
        .collect();
    AgentUsageSnapshot {
        windows,
        reset_credits,
        reset_credit_expirations,
    }
}

pub(crate) fn parse_claude_usage(output: &[u8]) -> Result<Vec<AgentUsageWindow>, ExecutorError> {
    parse_claude_usage_at(output, Utc::now())
}

fn parse_claude_usage_at(
    output: &[u8],
    now: DateTime<Utc>,
) -> Result<Vec<AgentUsageWindow>, ExecutorError> {
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
            let reset_description = rest.trim().strip_prefix("· ").map(str::to_string);
            let resets_at = reset_description
                .as_deref()
                .and_then(|description| parse_claude_reset(description, now));
            Some(AgentUsageWindow {
                label: label.to_string(),
                used_percent,
                reset_description,
                resets_at,
            })
        })
        .collect();
    if windows.is_empty() {
        return Err(invalid());
    }
    Ok(windows)
}

fn parse_claude_reset(description: &str, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let value = description
        .strip_prefix("resets ")?
        .strip_suffix(" (UTC)")?;
    let (date, clock) = match value.rsplit_once(" at ") {
        Some((date, clock)) => (Some(date), clock),
        None => (None, value.strip_prefix("at ").unwrap_or(value)),
    };
    let (clock, afternoon) = clock
        .strip_suffix("am")
        .map(|clock| (clock, false))
        .or_else(|| clock.strip_suffix("pm").map(|clock| (clock, true)))?;
    let (hour, minute) = clock.split_once(':').unwrap_or((clock, "0"));
    let hour: u32 = hour.parse().ok()?;
    if !(1..=12).contains(&hour) {
        return None;
    }
    let time = NaiveTime::from_hms_opt(
        hour % 12 + if afternoon { 12 } else { 0 },
        minute.parse().ok()?,
        0,
    )?;
    // Yearless CLI dates describe the next reset, including midnight/year rollover.
    for offset in 0..=1 {
        let date = match date {
            Some(date) => {
                NaiveDate::parse_from_str(&format!("{} {date}", now.year() + offset), "%Y %b %e")
                    .ok()
            }
            None => now
                .date_naive()
                .checked_add_signed(Duration::days(offset.into())),
        };
        if let Some(date) = date {
            let reset = date.and_time(time).and_utc();
            if reset >= now - Duration::minutes(1) && reset <= now + Duration::days(8) {
                return Some(reset);
            }
        }
    }
    None
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
        let claude_usage = claude.read_account_usage().await.unwrap();
        assert!(!claude_usage.is_empty());
        assert!(
            claude_usage
                .iter()
                .all(|window| { window.reset_description.is_none() || window.resets_at.is_some() })
        );
        let codex_usage = codex.read_account_usage().await.unwrap();
        assert!(!codex_usage.windows.is_empty());
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
            "rateLimits": { "primary": { "usedPercent": 37, "windowDurationMins": 10080, "resetsAt": 1893628800 } },
            "rateLimitResetCredits": { "availableCount": 2, "credits": [] }
        })).unwrap();
        let usage = parse_codex_usage(response);
        assert_eq!(usage.reset_credits, Some(2));
        assert_eq!(usage.windows.len(), 1);
        assert_eq!(usage.windows[0].label, "7d");
        assert_eq!(usage.windows[0].used_percent, 37.0);
        assert_eq!(
            usage.windows[0].resets_at,
            DateTime::from_timestamp(1893628800, 0)
        );
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

    fn credit(status: &str, expires_at: Option<i64>) -> serde_json::Value {
        serde_json::json!({
            "id": "test-credit", "resetType": "codexRateLimits", "status": status,
            "grantedAt": 1893283200, "expiresAt": expires_at
        })
    }

    #[test]
    fn codex_usage_keeps_available_credit_expiries_and_distinguishes_no_expiry() {
        let response = serde_json::from_value(serde_json::json!({
            "rateLimits": {},
            "rateLimitResetCredits": { "availableCount": 8, "credits": [
                credit("available", Some(1893542400)),
                credit("available", Some(1893456000)),
                credit("available", Some(1893456000)),
                credit("available", None),
                credit("redeemed", Some(1893369600)),
                credit("redeeming", Some(1893369600)),
                credit("expired", Some(1893369600)),
                credit("available", Some(i64::MAX))
            ] }
        }))
        .unwrap();
        let usage = parse_codex_usage(response);
        assert_eq!(usage.reset_credits, Some(8));
        assert_eq!(
            usage.reset_credit_expirations,
            vec![
                DateTime::from_timestamp(1893456000, 0),
                DateTime::from_timestamp(1893456000, 0),
                DateTime::from_timestamp(1893542400, 0),
                None,
            ]
        );
    }

    #[test]
    fn codex_usage_does_not_invent_expiries_for_unknown_or_unavailable_credits() {
        for credits in [
            serde_json::json!({"availableCount": 2}),
            serde_json::json!({"availableCount": 2, "credits": null}),
            serde_json::json!({"availableCount": 2, "credits": []}),
            serde_json::json!({"availableCount": 0, "credits": [credit("available", None)]}),
            serde_json::json!({"availableCount": -1, "credits": [credit("available", None)]}),
        ] {
            let response = serde_json::from_value(serde_json::json!({
                "rateLimits": {}, "rateLimitResetCredits": credits
            }))
            .unwrap();
            assert!(
                parse_codex_usage(response)
                    .reset_credit_expirations
                    .is_empty()
            );
        }
    }

    #[test]
    fn usage_parses_subscription_windows_without_local_activity_stats() {
        let value = result(
            "Current session: 0% used\nCurrent week (all models): 100% used · resets Jan 3 at 9:00am (Asia/Seoul)\nCurrent week (Fable): 60.5% used\nLast 7d · 100 requests\n  86% of your usage was at >150k context",
        );
        let windows = parse_claude_usage(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(windows.len(), 3);
        assert_eq!(windows[0].used_percent, 0.0);
        assert_eq!(windows[1].used_percent, 100.0);
        assert_eq!(windows[2].used_percent, 60.5);
        assert_eq!(
            windows[1].reset_description.as_deref(),
            Some("resets Jan 3 at 9:00am (Asia/Seoul)")
        );
    }

    #[test]
    fn usage_normalizes_claude_utc_resets_without_guessing_unknown_time_zones() {
        let now = DateTime::parse_from_rfc3339("2030-12-31T23:00:30Z")
            .unwrap()
            .with_timezone(&Utc);
        for (description, expected) in [
            ("resets at 11:30pm (UTC)", Some("2030-12-31T23:30:00Z")),
            ("resets 12:15am (UTC)", Some("2031-01-01T00:15:00Z")),
            ("resets Jan 1 at 12am (UTC)", Some("2031-01-01T00:00:00Z")),
            ("resets Jan 3 at 9:05am (UTC)", Some("2031-01-03T09:05:00Z")),
            ("resets at 11pm (UTC)", Some("2030-12-31T23:00:00Z")),
            ("resets Jan 3 at 12pm (UTC)", Some("2031-01-03T12:00:00Z")),
            ("resets Jan 3 at 9am (Asia/Seoul)", None),
            ("resets Jan 30 at 9am (UTC)", None),
            ("resets Jan 3 at 13pm (UTC)", None),
            ("resets Jan 3 at 9:99am (UTC)", None),
            ("unknown", None),
        ] {
            let value = result(&format!("Current session: 25% used · {description}"));
            let windows = parse_claude_usage_at(&serde_json::to_vec(&value).unwrap(), now).unwrap();
            assert_eq!(
                windows[0].resets_at,
                expected.map(|time| DateTime::parse_from_rfc3339(time)
                    .unwrap()
                    .with_timezone(&Utc)),
                "{description}"
            );
            assert_eq!(windows[0].reset_description.as_deref(), Some(description));
        }
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
