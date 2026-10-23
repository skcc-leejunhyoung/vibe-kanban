//! Host agent-journal events collected centrally: every host pushes its
//! journal (`process.*`, `approval.*`, `workspace.*`, ...) to the remote
//! server, and automation reads one stream for all of the owner's hosts.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;
use uuid::Uuid;

/// One journal event as a host pushes it.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct PushedAgentEvent {
    /// The host journal's own cursor; with `host_id` it makes re-pushes
    /// idempotent.
    pub host_cursor: i64,
    pub at: DateTime<Utc>,
    pub kind: String,
    pub workspace_id: Option<Uuid>,
    pub session_id: Option<Uuid>,
    pub execution_id: Option<Uuid>,
    /// The event belongs to the host's Autopilot workspace (automation skips
    /// these so an Autopilot turn never wakes an Autopilot).
    #[serde(default)]
    pub autopilot: bool,
    pub data: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct PushAgentEventsRequest {
    pub host_id: Uuid,
    pub events: Vec<PushedAgentEvent>,
}

/// A stored event, as read back from the central stream.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentEvent {
    /// Central, monotonic position; pass the page's `cursor` back as `since`.
    pub cursor: i64,
    pub at: DateTime<Utc>,
    pub kind: String,
    /// `None` for events from the remote server itself (`cloud.notification`).
    pub host_id: Option<Uuid>,
    /// The host's name, or `cloud`.
    pub host_name: String,
    pub workspace_id: Option<Uuid>,
    pub session_id: Option<Uuid>,
    pub execution_id: Option<Uuid>,
    pub autopilot: bool,
    pub data: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentEventsPage {
    pub events: Vec<AgentEvent>,
    /// The next `since`: the last event's cursor when the page hit `limit`,
    /// otherwise the latest cursor the server has handed out.
    pub cursor: i64,
}
