//! Event journal and notifications: the two things an orchestrating agent
//! needs that a shell command does badly (a long poll holding a tool call
//! open, a one-line alert to the user).

use std::time::Duration;

use rmcp::{
    ErrorData, handler::server::wrapper::Parameters, model::CallToolResult, schemars, tool,
    tool_router,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::McpServer;
use crate::client::JournalPage;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct ListEventsRequest {
    #[schemars(description = "Optional paired host ID to read from. Omit for this machine.")]
    host_id: Option<Uuid>,
    #[schemars(
        description = "Return events after this cursor (from a previous page's `cursor`). 0 returns everything still buffered."
    )]
    since: Option<u64>,
    #[schemars(
        description = "Optional kind prefixes to keep, e.g. [\"process.\", \"approval.pending\"]. Kinds: process.started|completed|failed|killed, approval.pending|resolved, workspace.created|archived|unarchived|deleted|status_note, vibe.phase, queue.changed, resume.fired, cloud.notification."
    )]
    kinds: Option<Vec<String>>,
    #[schemars(description = "Max events to return (default 100, max 1000)")]
    limit: Option<u32>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct WaitForEventsRequest {
    #[schemars(description = "Optional paired host ID to wait on. Omit for this machine.")]
    host_id: Option<Uuid>,
    #[schemars(
        description = "Return events after this cursor (from a previous page's `cursor`). Pass the latest cursor you have seen; 0 returns immediately with the buffered backlog."
    )]
    since: u64,
    #[schemars(
        description = "Optional kind prefixes to keep, e.g. [\"process.\", \"approval.pending\"]. Kinds: process.started|completed|failed|killed, approval.pending|resolved, workspace.created|archived|unarchived|deleted|status_note, vibe.phase, queue.changed, resume.fired, cloud.notification."
    )]
    kinds: Option<Vec<String>>,
    #[schemars(description = "Seconds to wait for a matching event (default 30, max 300)")]
    timeout_seconds: Option<u64>,
    #[schemars(description = "Max events to return (default 100)")]
    limit: Option<u32>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct NotifyUserRequest {
    #[schemars(description = "Notification title")]
    title: String,
    #[schemars(description = "Notification body")]
    message: String,
    #[schemars(description = "Workspace the notification opens when clicked")]
    workspace_id: Option<Uuid>,
    #[schemars(
        description = "Deliver only on this host (OS notifier / local browser), not to the user's phone via cloud web push"
    )]
    local_only: Option<bool>,
    #[schemars(description = "Optional paired host ID to notify from. Omit for this machine.")]
    host_id: Option<Uuid>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct NotifyUserResponse {
    success: bool,
}

#[tool_router(router = events_tools_router, vis = "pub")]
impl McpServer {
    #[tool(
        description = "Read the event journal: process starts and ends, approvals pending/resolved, workspace status-note changes, vibe-run phase changes, workspace lifecycle, queue changes, scheduled resumes and cloud notifications, after a cursor. Returns the next cursor to pass back."
    )]
    async fn list_events(
        &self,
        Parameters(ListEventsRequest {
            host_id,
            since,
            kinds,
            limit,
        }): Parameters<ListEventsRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let page: JournalPage = match self
            .client
            .host(host_id)
            .events_list(
                since.unwrap_or(0),
                &kinds.unwrap_or_default(),
                limit.unwrap_or(100) as usize,
            )
            .await
        {
            Ok(page) => page,
            Err(error) => return Ok(Self::tool_error(error)),
        };
        Self::success(&page)
    }

    #[tool(
        description = "Block until a matching event lands in the journal (or the timeout passes), then return the events and the next cursor. Use this instead of polling to wait for a turn to finish, an approval to appear, or a status note to change."
    )]
    async fn wait_for_events(
        &self,
        Parameters(WaitForEventsRequest {
            host_id,
            since,
            kinds,
            timeout_seconds,
            limit,
        }): Parameters<WaitForEventsRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let timeout = Duration::from_secs(timeout_seconds.unwrap_or(30).clamp(1, 300));
        let page: JournalPage = match self
            .client
            .host(host_id)
            .events_wait(
                since,
                &kinds.unwrap_or_default(),
                limit.unwrap_or(100) as usize,
                timeout,
            )
            .await
        {
            Ok(page) => page,
            Err(error) => return Ok(Self::tool_error(error)),
        };
        Self::success(&page)
    }

    #[tool(
        description = "Send the user a notification (sound, desktop and web push, including their phone unless local_only)."
    )]
    async fn notify_user(
        &self,
        Parameters(NotifyUserRequest {
            title,
            message,
            workspace_id,
            local_only,
            host_id,
        }): Parameters<NotifyUserRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        if title.trim().is_empty() && message.trim().is_empty() {
            return Self::err("Provide a title or a message", None);
        }
        if let Err(error) = self
            .client
            .host(host_id)
            .notify(
                title.trim(),
                message.trim(),
                workspace_id,
                local_only.unwrap_or(false),
            )
            .await
        {
            return Ok(Self::tool_error(error));
        }
        Self::success(&NotifyUserResponse { success: true })
    }
}
