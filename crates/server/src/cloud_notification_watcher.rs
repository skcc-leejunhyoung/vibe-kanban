//! Mirrors new cloud notifications (comments, review requests, status changes
//! on the user's issues) into the agent event journal so `vk events wait` and
//! the `wait_for_events` MCP tool see them next to local process events.
//!
//! Polls every 30 seconds. The first poll only seeds the seen set, so a
//! restart does not replay the whole inbox as fresh events.

use std::{collections::HashSet, time::Duration};

use services::services::agent_journal;
use uuid::Uuid;

use crate::DeploymentImpl;

const POLL_INTERVAL: Duration = Duration::from_secs(30);

pub fn spawn(deployment: DeploymentImpl) {
    tokio::spawn(async move {
        let mut seen: Option<HashSet<Uuid>> = None;
        loop {
            tokio::time::sleep(POLL_INTERVAL).await;
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
