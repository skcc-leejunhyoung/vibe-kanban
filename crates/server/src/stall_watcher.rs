//! Background poller that reports coding-agent runs that went silent: a hung
//! model request, a tool waiting on a prompt nobody will answer, a result that
//! never ends the turn. The UI only shows a spinner for these. The journal gets
//! one `process.stalled` per run once it has produced no output for
//! `VK_STALL_IDLE_SECS` (default 30 minutes), with the `vk` commands an agent
//! can act with (`vk session log`, `vk session stop`).

use std::{collections::HashSet, time::Duration};

use chrono::{DateTime, Utc};
use db::models::execution_process::{ExecutionProcess, ExecutionProcessRunReason};
use deployment::Deployment;
use serde_json::{Value, json};
use services::services::agent_journal;
use tokio::time::sleep;
use uuid::Uuid;

use crate::DeploymentImpl;

const POLL_INTERVAL: Duration = Duration::from_secs(60);
const DEFAULT_IDLE_SECS: i64 = 30 * 60;

fn idle_limit_secs() -> i64 {
    std::env::var("VK_STALL_IDLE_SECS")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_IDLE_SECS)
}

/// Seconds since the run last wrote a log line, or since it started when it
/// never did (a prompt at spawn, a hung first request).
pub fn idle_seconds(
    started_at: DateTime<Utc>,
    last_output_at: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> i64 {
    let last = last_output_at.map_or(started_at, |at| at.max(started_at));
    (now - last).num_seconds()
}

/// Spawns the watcher loop. Returns immediately; the loop runs for the lifetime
/// of the process.
pub fn spawn(deployment: DeploymentImpl) {
    tokio::spawn(async move {
        let mut announced: HashSet<Uuid> = HashSet::new();
        loop {
            sleep(POLL_INTERVAL).await;
            if let Err(e) = tick(&deployment, &mut announced).await {
                tracing::warn!("stall_watcher tick failed: {}", e);
            }
        }
    });
}

async fn tick(deployment: &DeploymentImpl, announced: &mut HashSet<Uuid>) -> anyhow::Result<()> {
    let pool = &deployment.db().pool;
    let running = ExecutionProcess::find_running(pool).await?;
    // Once a run ends its id leaves the set, so a re-run can be reported again.
    announced.retain(|id| running.iter().any(|process| process.id == *id));
    let limit = idle_limit_secs();
    let now = Utc::now();
    for process in running {
        if process.run_reason != ExecutionProcessRunReason::CodingAgent
            || announced.contains(&process.id)
        {
            continue;
        }
        let last_output_at = std::fs::metadata(utils::execution_logs::process_log_file_path(
            process.session_id,
            process.id,
        ))
        .and_then(|meta| meta.modified())
        .ok()
        .map(DateTime::<Utc>::from);
        let idle = idle_seconds(process.started_at, last_output_at, now);
        if idle < limit {
            continue;
        }
        announced.insert(process.id);
        let (workspace_id, workspace) = match process.parent_workspace_and_session(pool).await {
            Ok(Some((workspace, _))) => (
                Some(workspace.id),
                json!({ "name": workspace.name, "branch": workspace.branch }),
            ),
            _ => (None, json!({})),
        };
        tracing::warn!(
            execution_id = %process.id,
            idle_secs = idle,
            "coding-agent run has produced no output for a long time"
        );
        agent_journal::publish(
            "process.stalled",
            workspace_id,
            Some(process.session_id),
            Some(process.id),
            stalled_event(&process, idle, last_output_at, workspace),
        );
    }
    Ok(())
}

/// The event's data: how long the run has been silent and what to do about it.
pub fn stalled_event(
    process: &ExecutionProcess,
    idle_secs: i64,
    last_output_at: Option<DateTime<Utc>>,
    mut workspace: Value,
) -> Value {
    let details = json!({
        "idle_secs": idle_secs,
        "started_at": process.started_at,
        "last_output_at": last_output_at,
        "run_reason": process.run_reason,
        "choices": [
            { "id": "inspect", "command": format!("vk session log {} --limit 40", process.id), "destructive": false },
            { "id": "stop", "command": format!("vk session stop {}", process.id), "destructive": false },
            { "id": "cancel", "destructive": false },
        ],
    });
    if let (Some(map), Some(more)) = (workspace.as_object_mut(), details.as_object()) {
        for (key, value) in more {
            map.insert(key.clone(), value.clone());
        }
    }
    workspace
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;
    use db::models::execution_process::{ExecutionProcessStatus, ExecutorActionField};

    use super::*;

    #[test]
    fn idle_time_counts_from_the_last_output_or_the_start() {
        let started = Utc.with_ymd_and_hms(2026, 11, 4, 10, 0, 0).unwrap();
        let now = started + chrono::Duration::minutes(45);
        assert_eq!(idle_seconds(started, None, now), 45 * 60);
        let output = started + chrono::Duration::minutes(40);
        assert_eq!(idle_seconds(started, Some(output), now), 5 * 60);
        // A log file older than the run (reused id, clock skew) never hides a stall.
        let stale = started - chrono::Duration::hours(1);
        assert_eq!(idle_seconds(started, Some(stale), now), 45 * 60);
    }

    #[test]
    fn the_event_names_the_run_and_the_commands() {
        let process = ExecutionProcess {
            id: Uuid::new_v4(),
            session_id: Uuid::new_v4(),
            run_reason: ExecutionProcessRunReason::CodingAgent,
            executor_action: sqlx::types::Json(ExecutorActionField::Other(json!({}))),
            status: ExecutionProcessStatus::Running,
            exit_code: None,
            dropped: false,
            started_at: Utc::now(),
            completed_at: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        let data = stalled_event(
            &process,
            1900,
            None,
            json!({ "name": "feature", "branch": "vk/feature" }),
        );
        assert_eq!(data["idle_secs"], 1900);
        assert_eq!(data["name"], "feature");
        assert_eq!(data["run_reason"], "codingagent");
        let choices = data["choices"].as_array().unwrap();
        assert_eq!(choices[1]["id"], "stop");
        assert_eq!(
            choices[1]["command"],
            format!("vk session stop {}", process.id)
        );
        assert_eq!(choices[2]["id"], "cancel");
    }
}
