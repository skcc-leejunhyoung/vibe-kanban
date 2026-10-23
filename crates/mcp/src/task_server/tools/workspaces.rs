use db::models::{requests::UpdateWorkspace, workspace::Workspace};
use rmcp::{
    ErrorData, handler::server::wrapper::Parameters, model::CallToolResult, schemars, tool,
    tool_router,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::McpServer;
use crate::client::{PairedHost, SyncBranchOutcome, WorkspaceFilter, WorkspaceListItem};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpListWorkspacesRequest {
    #[schemars(description = "Optional paired host ID. Omit to list this machine.")]
    host_id: Option<Uuid>,
    #[schemars(description = "Filter by archived state")]
    archived: Option<bool>,
    #[schemars(description = "Filter by pinned state")]
    pinned: Option<bool>,
    #[schemars(
        description = "Only workspaces with (true) or without (false) a running agent turn"
    )]
    running: Option<bool>,
    #[schemars(description = "Filter by branch name (exact match, case-insensitive)")]
    branch: Option<String>,
    #[schemars(description = "Case-insensitive substring match against workspace name")]
    name_search: Option<String>,
    #[schemars(description = "Maximum number of workspaces to return (default: 50)")]
    limit: Option<i32>,
    #[schemars(description = "Number of results to skip before returning rows (default: 0)")]
    offset: Option<i32>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct McpListWorkspacesResponse {
    workspaces: Vec<WorkspaceListItem>,
    total_count: usize,
    returned_count: usize,
    limit: usize,
    offset: usize,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct McpListWorkspaceHostsResponse {
    hosts: Vec<PairedHost>,
    count: usize,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpUpdateWorkspaceRequest {
    #[schemars(
        description = "Workspace ID to update. Optional if running inside that workspace context."
    )]
    workspace_id: Option<Uuid>,
    #[schemars(
        description = "Paired host ID the workspace lives on (from list_workspaces). Omit for this machine."
    )]
    host_id: Option<Uuid>,
    #[schemars(description = "Set archived state")]
    archived: Option<bool>,
    #[schemars(description = "Set pinned state")]
    pinned: Option<bool>,
    #[schemars(description = "Set workspace display name (empty string clears it)")]
    name: Option<String>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct McpUpdateWorkspaceResponse {
    success: bool,
    workspace_id: String,
    archived: bool,
    pinned: bool,
    name: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpSyncWorkspaceBranchRequest {
    #[schemars(
        description = "Workspace ID to sync. Optional if running inside that workspace context."
    )]
    workspace_id: Option<Uuid>,
    #[schemars(
        description = "Paired host ID the workspace lives on (from list_workspaces). Omit for this machine."
    )]
    host_id: Option<Uuid>,
    #[schemars(
        description = "Repository ID to sync. Optional when the workspace has exactly one repo."
    )]
    repo_id: Option<Uuid>,
    #[schemars(
        description = "How to sync the work branch: 'pull' fast-forwards it to its own remote (git pull --ff-only, never touches the remote, safe on shared PR branches); 'merge_base' merges the target/base branch into the work branch (preserves history); 'rebase_base' rebases the work branch onto the target/base branch (rewrites history — needs a force-push afterwards)."
    )]
    mode: String,
}

#[tool_router(router = workspaces_tools_router, vis = "pub")]
impl McpServer {
    #[tool(
        description = "List your other hosts (name, online status, auth mode) that can run remote workspace operations."
    )]
    async fn list_workspace_hosts(&self) -> Result<CallToolResult, ErrorData> {
        let hosts = match self.client.list_hosts().await {
            Ok(hosts) => hosts,
            Err(error) => return Ok(Self::tool_error(error)),
        };
        McpServer::success(&McpListWorkspaceHostsResponse {
            count: hosts.len(),
            hosts,
        })
    }

    #[tool(
        description = "List workspaces on this machine or a paired host with their live state: the agent's status note, whether a turn is running, the latest process status, pending approvals and blocker waits, PR state. Supports filters and pagination."
    )]
    async fn list_workspaces(
        &self,
        Parameters(McpListWorkspacesRequest {
            host_id,
            archived,
            pinned,
            running,
            branch,
            name_search,
            limit,
            offset,
        }): Parameters<McpListWorkspacesRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let filter = WorkspaceFilter {
            archived,
            pinned,
            running,
            branch,
            name_search,
        };
        let workspaces = match self.client.host(host_id).list_workspaces(&filter).await {
            Ok(workspaces) => workspaces,
            Err(error) => return Ok(Self::tool_error(error)),
        };
        let total_count = workspaces.len();
        let offset = offset.unwrap_or(0).max(0) as usize;
        let limit = limit.unwrap_or(50).max(0) as usize;
        let page: Vec<WorkspaceListItem> =
            workspaces.into_iter().skip(offset).take(limit).collect();
        McpServer::success(&McpListWorkspacesResponse {
            returned_count: page.len(),
            total_count,
            limit,
            offset,
            workspaces: page,
        })
    }

    #[tool(
        description = "Update a workspace's archived, pinned, or name fields. `workspace_id` is optional if running inside that workspace context."
    )]
    async fn update_workspace(
        &self,
        Parameters(McpUpdateWorkspaceRequest {
            workspace_id,
            host_id,
            archived,
            pinned,
            name,
        }): Parameters<McpUpdateWorkspaceRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let workspace_id = match self.resolve_workspace_id(workspace_id) {
            Ok(id) => id,
            Err(error_result) => return Ok(Self::tool_error(error_result)),
        };
        if let Err(error_result) = self.scope_allows_workspace(workspace_id) {
            return Ok(Self::tool_error(error_result));
        }

        let payload = UpdateWorkspace {
            archived,
            pinned,
            name,
        };
        let updated: Workspace = match self
            .client
            .host(host_id)
            .put(&format!("/workspaces/{workspace_id}"), &payload)
            .await
        {
            Ok(ws) => ws,
            Err(e) => return Ok(Self::tool_error(e)),
        };

        McpServer::success(&McpUpdateWorkspaceResponse {
            success: true,
            workspace_id: updated.id.to_string(),
            archived: updated.archived,
            pinned: updated.pinned,
            name: updated.name,
        })
    }

    #[tool(
        description = "Sync a workspace's git work branch when it has fallen behind. mode='pull' fast-forwards the branch to its own remote (safe on shared PR branches; reports 'diverged' when a fast-forward is impossible). mode='merge_base' / 'rebase_base' brings the target (base) branch into the work branch. `workspace_id` is optional inside a workspace context; `repo_id` is optional when the workspace has a single repo."
    )]
    async fn sync_workspace_branch(
        &self,
        Parameters(McpSyncWorkspaceBranchRequest {
            workspace_id,
            host_id,
            repo_id,
            mode,
        }): Parameters<McpSyncWorkspaceBranchRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let workspace_id = match self.resolve_workspace_id(workspace_id) {
            Ok(id) => id,
            Err(error_result) => return Ok(Self::tool_error(error_result)),
        };
        if let Err(error_result) = self.scope_allows_workspace(workspace_id) {
            return Ok(Self::tool_error(error_result));
        }
        let outcome: SyncBranchOutcome = match self
            .client
            .host(host_id)
            .sync_workspace_branch(workspace_id, repo_id, &mode)
            .await
        {
            Ok(outcome) => outcome,
            Err(e) => return Ok(Self::tool_error(e)),
        };
        McpServer::success(&outcome)
    }
}
