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

use super::{McpServer, ToolError};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct ListEventsRequest {
    #[schemars(description = "Optional paired host ID to read from. Omit for this machine.")]
    host_id: Option<Uuid>,
    #[schemars(
        description = "Return events after this cursor (a previous page's `cursor`). Omit or \"0\" for everything still buffered. With all_hosts the cursor is `self=N,<host-id>=N`; pass it back verbatim."
    )]
    since: Option<String>,
    #[schemars(
        description = "Optional kind prefixes to keep, e.g. [\"process.\", \"approval.pending\"]. Kinds: process.started|completed|failed|killed, approval.pending|resolved, workspace.created|archived|unarchived|deleted|status_note, vibe.phase, queue.changed, resume.fired, cloud.notification."
    )]
    kinds: Option<Vec<String>>,
    #[schemars(description = "Max events to return (default 100, max 1000)")]
    limit: Option<u32>,
    #[schemars(
        description = "Merge this machine and every paired host (cursor becomes `self=N,<host-id>=N`)"
    )]
    all_hosts: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct WaitForEventsRequest {
    #[schemars(description = "Optional paired host ID to wait on. Omit for this machine.")]
    host_id: Option<Uuid>,
    #[schemars(
        description = "Return events after this cursor (a previous page's `cursor`). Pass the latest cursor you have seen; \"0\" returns the buffered backlog at once. With all_hosts pass the `self=N,<host-id>=N` cursor back verbatim."
    )]
    since: String,
    #[schemars(
        description = "Optional kind prefixes to keep, e.g. [\"process.\", \"approval.pending\"]. Kinds: process.started|completed|failed|killed, approval.pending|resolved, workspace.created|archived|unarchived|deleted|status_note, vibe.phase, queue.changed, resume.fired, cloud.notification."
    )]
    kinds: Option<Vec<String>>,
    #[schemars(description = "Seconds to wait for a matching event (default 30, max 300)")]
    timeout_seconds: Option<u64>,
    #[schemars(description = "Max events to return (default 100)")]
    limit: Option<u32>,
    #[schemars(description = "Watch this machine and every paired host")]
    all_hosts: Option<bool>,
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

fn single_host_cursor(since: Option<&str>) -> Result<u64, ToolError> {
    let raw = since.unwrap_or("0").trim();
    raw.parse().map_err(|_| {
        ToolError::message(format!(
            "since must be a cursor number (got '{raw}'); host=cursor pairs need all_hosts=true"
        ))
    })
}

#[tool_router(router = events_tools_router, vis = "pub")]
impl McpServer {
    #[tool(
        description = "Read the event journal: process starts and ends, approvals pending/resolved, workspace status-note changes, vibe-run phase changes, workspace lifecycle, queue changes, scheduled resumes and cloud notifications, after a cursor. Returns the next cursor to pass back. all_hosts merges every host and lists the ones left out in failed_hosts."
    )]
    async fn list_events(
        &self,
        Parameters(ListEventsRequest {
            host_id,
            since,
            kinds,
            limit,
            all_hosts,
        }): Parameters<ListEventsRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let kinds = kinds.unwrap_or_default();
        let limit = limit.unwrap_or(100) as usize;
        if all_hosts.unwrap_or(false) {
            return match self
                .client
                .events_list_all_hosts(since.as_deref().unwrap_or("0"), &kinds, limit)
                .await
            {
                Ok(page) => Self::success(&page),
                Err(error) => Ok(Self::tool_error(error)),
            };
        }
        let since = match single_host_cursor(since.as_deref()) {
            Ok(since) => since,
            Err(error) => return Ok(Self::tool_error(error)),
        };
        match self
            .client
            .host(host_id)
            .events_list(since, &kinds, limit)
            .await
        {
            Ok(page) => Self::success(&page),
            Err(error) => Ok(Self::tool_error(error)),
        }
    }

    #[tool(
        description = "Block until a matching event lands in the journal (or the timeout passes), then return the events and the next cursor. Use this instead of polling to wait for a turn to finish, an approval to appear, or a status note to change. all_hosts watches every host too (failed_hosts lists the ones left out)."
    )]
    async fn wait_for_events(
        &self,
        Parameters(WaitForEventsRequest {
            host_id,
            since,
            kinds,
            timeout_seconds,
            limit,
            all_hosts,
        }): Parameters<WaitForEventsRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let timeout = Duration::from_secs(timeout_seconds.unwrap_or(30).clamp(1, 300));
        let kinds = kinds.unwrap_or_default();
        let limit = limit.unwrap_or(100) as usize;
        if all_hosts.unwrap_or(false) {
            return match self
                .client
                .events_wait_all_hosts(&since, &kinds, limit, timeout)
                .await
            {
                Ok(page) => Self::success(&page),
                Err(error) => Ok(Self::tool_error(error)),
            };
        }
        let since = match single_host_cursor(Some(&since)) {
            Ok(since) => since,
            Err(error) => return Ok(Self::tool_error(error)),
        };
        match self
            .client
            .host(host_id)
            .events_wait(since, &kinds, limit, timeout)
            .await
        {
            Ok(page) => Self::success(&page),
            Err(error) => Ok(Self::tool_error(error)),
        }
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
