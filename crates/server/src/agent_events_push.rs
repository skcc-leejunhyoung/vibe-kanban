//! Pushes this host's agent-journal events to the remote server, which keeps
//! one stream for all of the owner's hosts: automation reads it to wake the
//! Autopilot, so a new host only needs to be signed in, with no port opened.
//!
//! Follows the journal from this process's start. While the remote server is
//! unreachable (or this computer is not registered as a host) it retries the
//! same batch with backoff, so nothing is lost unless the in-memory ring
//! overflows. Cloud notifications are not pushed: they come from the remote
//! server in the first place and are mirrored into every host's journal.

use std::time::Duration;

use api_types::{PushAgentEventsRequest, PushedAgentEvent};
use db::models::workspace::Workspace;
use deployment::Deployment;
use services::services::{
    agent_journal::{self, JournalEvent},
    remote_client::RemoteClientError,
};
use uuid::Uuid;

use crate::DeploymentImpl;

const BATCH: usize = 200;
const FOLLOW_TIMEOUT: Duration = Duration::from_secs(30);
const RETRY_MIN: Duration = Duration::from_secs(5);
const RETRY_MAX: Duration = Duration::from_secs(300);
/// Matches the remote server's per-event limit; bigger payloads are replaced
/// so one event cannot stall the stream.
const MAX_DATA_BYTES: usize = 64 * 1024;

pub fn spawn(deployment: DeploymentImpl) {
    tokio::spawn(async move {
        let mut since = 0;
        let mut host_id: Option<Uuid> = None;
        let mut retry = RETRY_MIN;
        loop {
            let page = agent_journal::follow(since, BATCH, FOLLOW_TIMEOUT).await;
            let events: Vec<&JournalEvent> = page
                .events
                .iter()
                .filter(|event| event.kind != "cloud.notification")
                .collect();
            if events.is_empty() {
                since = page.cursor;
                continue;
            }
            match push(&deployment, &mut host_id, &events).await {
                Ok(()) => {
                    since = page.cursor;
                    retry = RETRY_MIN;
                }
                // The server refused the batch itself; retrying cannot help.
                Err(PushError::Rejected(error)) => {
                    tracing::warn!(%error, count = events.len(), "Central agent events dropped");
                    since = page.cursor;
                }
                Err(PushError::Retry(error)) => {
                    if retry == RETRY_MIN {
                        tracing::warn!(%error, "Central agent event push failed; retrying");
                    }
                    host_id = None;
                    tokio::time::sleep(retry).await;
                    retry = (retry * 2).min(RETRY_MAX);
                }
            }
        }
    });
}

enum PushError {
    Rejected(anyhow::Error),
    Retry(anyhow::Error),
}

async fn push(
    deployment: &DeploymentImpl,
    host_id: &mut Option<Uuid>,
    events: &[&JournalEvent],
) -> Result<(), PushError> {
    let retry = |error: anyhow::Error| PushError::Retry(error);
    let client = deployment
        .remote_client()
        .map_err(|error| retry(error.into()))?;
    let id = match *host_id {
        Some(id) => id,
        None => {
            let id = crate::agent_memory_sync::current_remote_host(deployment)
                .await
                .map_err(retry)?
                .id;
            *host_id = Some(id);
            id
        }
    };
    let autopilot = Workspace::find_active_autopilot(&deployment.db().pool)
        .await
        .map_err(|error| retry(error.into()))?
        .map(|workspace| workspace.id);
    let request = PushAgentEventsRequest {
        host_id: id,
        events: events
            .iter()
            .map(|event| pushed(event, autopilot))
            .collect(),
    };
    match client.push_agent_events(&request).await {
        Ok(()) => Ok(()),
        Err(RemoteClientError::Http { status: 400, body }) => {
            Err(PushError::Rejected(anyhow::anyhow!("http 400: {body}")))
        }
        Err(error) => Err(retry(error.into())),
    }
}

fn pushed(event: &JournalEvent, autopilot: Option<Uuid>) -> PushedAgentEvent {
    let data = if event.data.to_string().len() > MAX_DATA_BYTES {
        serde_json::json!({ "truncated": true })
    } else {
        event.data.clone()
    };
    PushedAgentEvent {
        host_cursor: event.cursor as i64,
        at: event.at,
        kind: event.kind.clone(),
        workspace_id: event.workspace_id,
        session_id: event.session_id,
        execution_id: event.execution_id,
        autopilot: autopilot.is_some() && event.workspace_id == autopilot,
        data,
    }
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use serde_json::json;

    use super::*;

    fn event(workspace_id: Option<Uuid>, data: serde_json::Value) -> JournalEvent {
        JournalEvent {
            cursor: 7,
            at: Utc::now(),
            kind: "process.completed".to_string(),
            workspace_id,
            session_id: None,
            execution_id: None,
            host_id: None,
            data,
        }
    }

    #[test]
    fn tags_the_autopilot_and_caps_oversized_data() {
        let autopilot = Uuid::new_v4();
        let own = pushed(
            &event(Some(autopilot), json!({"ok": true})),
            Some(autopilot),
        );
        assert!(own.autopilot);
        assert_eq!(own.host_cursor, 7);
        let other = pushed(&event(Some(Uuid::new_v4()), json!({})), Some(autopilot));
        assert!(!other.autopilot);
        let unrelated = pushed(&event(None, json!({})), None);
        assert!(!unrelated.autopilot);
        let big = pushed(
            &event(None, json!({ "note": "x".repeat(MAX_DATA_BYTES) })),
            None,
        );
        assert_eq!(big.data, json!({ "truncated": true }));
    }
}
