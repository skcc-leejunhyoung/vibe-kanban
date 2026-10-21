//! Mirrors new cloud notifications (comments, review requests, status changes
//! on the user's issues) into the agent event journal so `vk events wait` and
//! the `wait_for_events` MCP tool see them next to local process events.
//!
//! Polls every 30 seconds while an agent has read the journal in the last ten
//! minutes. The first poll (after a restart or an idle stretch) only seeds the
//! seen set, so the whole inbox is not replayed as fresh events.

use std::{collections::HashSet, time::Duration};

use services::services::agent_journal;
use uuid::Uuid;

use crate::DeploymentImpl;

const POLL_INTERVAL: Duration = Duration::from_secs(30);
const IDLE_AFTER: Duration = Duration::from_secs(600);

pub fn spawn(deployment: DeploymentImpl) {
    tokio::spawn(async move {
        let mut seen: Option<HashSet<Uuid>> = None;
        loop {
            tokio::time::sleep(POLL_INTERVAL).await;
            if !agent_journal::read_within(IDLE_AFTER) {
                seen = None;
                continue;
            }
            let Ok(client) = deployment.remote_client() else {
                continue;
            };
            let notifications = match client.list_notifications(false).await {
                Ok(notifications) => notifications,
                Err(error) => {
                    tracing::debug!(%error, "cloud_notification_watcher: poll failed");
                    continue;
                }
            };
            let current: HashSet<Uuid> = notifications.iter().map(|n| n.id).collect();
            if let Some(previous) = &seen {
                for notification in notifications.iter().filter(|n| !previous.contains(&n.id)) {
                    agent_journal::publish(
                        "cloud.notification",
                        None,
                        None,
                        None,
                        serde_json::to_value(notification).unwrap_or_default(),
                    );
                }
            }
            seen = Some(current);
        }
    });
}
