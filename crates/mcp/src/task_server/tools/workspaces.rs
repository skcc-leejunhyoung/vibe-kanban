use db::models::{requests::UpdateWorkspace, workspace::Workspace};
use rmcp::{
    ErrorData, handler::server::wrapper::Parameters, model::CallToolResult, schemars, tool,
    tool_router,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::McpServer;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpListWorkspacesRequest {
    #[schemars(description = "Optional paired host ID. Omit to list this machine.")]
    host_id: Option<Uuid>,
    #[schemars(description = "Filter by archived state")]
    archived: Option<bool>,
    #[schemars(description = "Filter by pinned state")]
    pinned: Option<bool>,
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
struct WorkspaceSummary {
    #[schemars(description = "Workspace ID")]
    id: String,
    #[schemars(description = "Paired host ID, or null for this machine")]
    host_id: Option<String>,
    #[schemars(description = "Workspace branch")]
    branch: String,
    #[schemars(description = "Whether the workspace is archived")]
    archived: bool,
    #[schemars(description = "Whether the workspace is pinned")]
    pinned: bool,
    #[schemars(description = "Optional workspace display name")]
    name: Option<String>,
    #[schemars(description = "Creation timestamp")]
    created_at: String,
    #[schemars(description = "Last update timestamp")]
    updated_at: String,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct McpListWorkspacesResponse {
    workspaces: Vec<WorkspaceSummary>,
    total_count: usize,
    returned_count: usize,
    limit: usize,
    offset: usize,
}

#[derive(Debug, Deserialize)]
struct PairedHost {
    host_id: Uuid,
    host_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PairedHostsResponse {
    hosts: Vec<PairedHost>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct WorkspaceHostSummary {
    host_id: String,
    name: Option<String>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct McpListWorkspaceHostsResponse {
    hosts: Vec<WorkspaceHostSummary>,
    count: usize,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpUpdateWorkspaceRequest {
    #[schemars(
        description = "Workspace ID to update. Optional if running inside that workspace context."
    )]
    workspace_id: Option<Uuid>,
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
struct McpDeleteWorkspaceRequest {
    #[schemars(
        description = "Workspace ID to delete. Optional if running inside that workspace context."
    )]
    workspace_id: Option<Uuid>,
    #[schemars(
        description = "Also delete linked remote workspace when available (default: false)"
    )]
    delete_remote: Option<bool>,
    #[schemars(description = "Also delete workspace branches from repos (default: false)")]
    delete_branches: Option<bool>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct McpDeleteWorkspaceResponse {
    success: bool,
    workspace_id: String,
    delete_remote: bool,
    delete_branches: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpSyncWorkspaceBranchRequest {
    #[schemars(
        description = "Workspace ID to sync. Optional if running inside that workspace context."
    )]
    workspace_id: Option<Uuid>,
    #[schemars(
        description = "Repository ID to sync. Optional when the workspace has exactly one repo."
    )]
    repo_id: Option<Uuid>,
    #[schemars(
        description = "How to sync the work branch: 'pull' fast-forwards it to its own remote (git pull --ff-only, never touches the remote, safe on shared PR branches); 'merge_base' merges the target/base branch into the work branch (preserves history); 'rebase_base' rebases the work branch onto the target/base branch (rewrites history — needs a force-push afterwards)."
    )]
    mode: String,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct McpSyncWorkspaceBranchResponse {
    success: bool,
    workspace_id: String,
    repo_id: String,
    mode: String,
    /// Human-readable result, e.g. "Fast-forwarded 2 commits" or "Already up to date".
    outcome: String,
}

/// Minimal projection of the workspace repos endpoint — we only need the id.
#[derive(Debug, Deserialize)]
struct McpRepoRef {
    id: Uuid,
}

/// Mirror of `PullWorkspaceResponse` (server) for deserialization.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum McpPullOutcome {
    UpToDate,
    FastForwarded { commits: usize },
    Diverged { ahead: usize, behind: usize },
}

/// Mirror of `GitOperationError` (server) so conflicts produce a useful message.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum McpGitOperationError {
    MergeConflicts {
        message: String,
        #[serde(default)]
        conflicted_files: Vec<String>,
    },
    RebaseInProgress,
}

/// Envelope used to surface typed conflict errors from update-from-base.
#[derive(Debug, Deserialize)]
struct McpUpdateFromBaseEnvelope {
    success: bool,
    message: Option<String>,
    error_data: Option<McpGitOperationError>,
}

#[tool_router(router = workspaces_tools_router, vis = "pub")]
impl McpServer {
    #[tool(description = "List paired hosts that can run remote workspace operations.")]
    async fn list_workspace_hosts(&self) -> Result<CallToolResult, ErrorData> {
        let url = self.url("/api/relay-auth/client/hosts");
        let response: PairedHostsResponse = match self.send_json(self.client.get(&url)).await {
            Ok(response) => response,
            Err(error) => return Ok(Self::tool_error(error)),
        };
        let hosts = response
            .hosts
            .into_iter()
            .map(|host| WorkspaceHostSummary {
                host_id: host.host_id.to_string(),
                name: host.host_name,
            })
            .collect::<Vec<_>>();
        McpServer::success(&McpListWorkspaceHostsResponse {
            count: hosts.len(),
            hosts,
        })
    }

    #[tool(
        description = "List workspaces on this machine or a paired host, with optional filters and pagination."
    )]
    async fn list_workspaces(
        &self,
        Parameters(McpListWorkspacesRequest {
            host_id,
            archived,
            pinned,
            branch,
            name_search,
            limit,
            offset,
        }): Parameters<McpListWorkspacesRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let url = match host_id {
            Some(host_id) => self.url(&format!("/api/host/{host_id}/workspaces")),
            None => self.url("/api/workspaces"),
        };
        let mut workspaces: Vec<Workspace> = match self.send_json(self.client.get(&url)).await {
            Ok(ws) => ws,
            Err(e) => return Ok(Self::tool_error(e)),
        };

        if let Some(archived_filter) = archived {
            workspaces.retain(|w| w.archived == archived_filter);
        }
        if let Some(pinned_filter) = pinned {
            workspaces.retain(|w| w.pinned == pinned_filter);
        }
        if let Some(branch_filter) = branch.as_deref() {
            workspaces.retain(|w| w.branch.eq_ignore_ascii_case(branch_filter));
        }
        if let Some(name_search) = name_search.as_deref() {
            let needle = name_search.to_ascii_lowercase();
            workspaces.retain(|w| {
                w.name
                    .as_deref()
                    .map(|name| name.to_ascii_lowercase().contains(&needle))
                    .unwrap_or(false)
            });
        }

        // Keep ordering deterministic after filtering.
        workspaces.sort_by(|a, b| b.created_at.cmp(&a.created_at));

        let total_count = workspaces.len();
        let offset = offset.unwrap_or(0).max(0) as usize;
        let limit = limit.unwrap_or(50).max(0) as usize;

        let workspace_summaries = workspaces
            .into_iter()
            .skip(offset)
            .take(limit)
            .map(|workspace| WorkspaceSummary {
                id: workspace.id.to_string(),
                host_id: host_id.map(|id| id.to_string()),
                branch: workspace.branch,
                archived: workspace.archived,
                pinned: workspace.pinned,
                name: workspace.name,
                created_at: workspace.created_at.to_rfc3339(),
                updated_at: workspace.updated_at.to_rfc3339(),
            })
            .collect::<Vec<_>>();

        McpServer::success(&McpListWorkspacesResponse {
            returned_count: workspace_summaries.len(),
            total_count,
            limit,
            offset,
            workspaces: workspace_summaries,
        })
    }

    #[tool(
        description = "Update a workspace's archived, pinned, or name fields. `workspace_id` is optional if running inside that workspace context."
    )]
    async fn update_workspace(
        &self,
        Parameters(McpUpdateWorkspaceRequest {
            workspace_id,
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

        let url = self.url(&format!("/api/workspaces/{}", workspace_id));
        let payload = UpdateWorkspace {
            archived,
            pinned,
            name,
        };

        let updated: Workspace = match self.send_json(self.client.put(&url).json(&payload)).await {
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
        description = "Delete a local workspace. `workspace_id` is optional if running inside that workspace context."
    )]
    async fn delete_workspace(
        &self,
        Parameters(McpDeleteWorkspaceRequest {
            workspace_id,
            delete_remote,
            delete_branches,
        }): Parameters<McpDeleteWorkspaceRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let workspace_id = match self.resolve_workspace_id(workspace_id) {
            Ok(id) => id,
            Err(error_result) => return Ok(Self::tool_error(error_result)),
        };
        if let Err(error_result) = self.scope_allows_workspace(workspace_id) {
            return Ok(Self::tool_error(error_result));
        }

        let delete_remote = delete_remote.unwrap_or(false);
        let delete_branches = delete_branches.unwrap_or(false);

        let url = self.url(&format!("/api/workspaces/{}", workspace_id));
        if let Err(e) = self
            .send_empty_json(self.client.delete(&url).query(&[
                ("delete_remote", delete_remote),
                ("delete_branches", delete_branches),
            ]))
            .await
        {
            return Ok(Self::tool_error(e));
        }

        McpServer::success(&McpDeleteWorkspaceResponse {
            success: true,
            workspace_id: workspace_id.to_string(),
            delete_remote,
            delete_branches,
        })
    }

    #[tool(
        description = "Sync a workspace's git work branch when it has fallen behind. mode='pull' fast-forwards the branch to its own remote (safe on shared PR branches; reports 'diverged' when a fast-forward is impossible). mode='merge_base' / 'rebase_base' brings the target (base) branch into the work branch. `workspace_id` is optional inside a workspace context; `repo_id` is optional when the workspace has a single repo."
    )]
    async fn sync_workspace_branch(
        &self,
        Parameters(McpSyncWorkspaceBranchRequest {
            workspace_id,
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

        let mode = mode.trim().to_ascii_lowercase();
        let strategy = match mode.as_str() {
            "pull" => None,
            "merge_base" => Some("merge"),
            "rebase_base" => Some("rebase"),
            other => {
                return Self::err(
                    format!("Unknown mode '{other}'. Use 'pull', 'merge_base', or 'rebase_base'."),
                    None::<String>,
                );
            }
        };

        // Resolve the repo: explicit, or the sole repo of a single-repo workspace.
        let repo_id = match repo_id {
            Some(id) => id,
            None => {
                let url = self.url(&format!("/api/workspaces/{workspace_id}/repos"));
                let repos: Vec<McpRepoRef> = match self.send_json(self.client.get(&url)).await {
                    Ok(repos) => repos,
                    Err(e) => return Ok(Self::tool_error(e)),
                };
                match repos.as_slice() {
                    [single] => single.id,
                    [] => {
                        return Self::err("Workspace has no repositories to sync.", None::<&str>);
                    }
                    _ => {
                        return Self::err(
                            "Workspace has multiple repositories; specify `repo_id`.",
                            None::<&str>,
                        );
                    }
                }
            }
        };

        let outcome = if let Some(strategy) = strategy {
            // Update from base (merge / rebase). Conflicts come back as typed
            // error_data, which we translate into an actionable message.
            let url = self.url(&format!(
                "/api/workspaces/{workspace_id}/git/update-from-base"
            ));
            let resp = match self
                .client
                .post(&url)
                .json(&serde_json::json!({ "repo_id": repo_id, "strategy": strategy }))
                .send()
                .await
            {
                Ok(resp) => resp,
                Err(e) => {
                    return Self::err(
                        "Failed to connect to VK API".to_string(),
                        Some(e.to_string()),
                    );
                }
            };
            if !resp.status().is_success() {
                return Self::err(
                    format!("VK API returned error status: {}", resp.status()),
                    None::<String>,
                );
            }
            let envelope: McpUpdateFromBaseEnvelope = match resp.json().await {
                Ok(env) => env,
                Err(e) => {
                    return Self::err(
                        "Failed to parse VK API response".to_string(),
                        Some(e.to_string()),
                    );
                }
            };
            if !envelope.success {
                let message = match envelope.error_data {
                    Some(McpGitOperationError::MergeConflicts {
                        message,
                        conflicted_files,
                    }) => {
                        if conflicted_files.is_empty() {
                            message
                        } else {
                            format!(
                                "{message} Conflicted files: {}",
                                conflicted_files.join(", ")
                            )
                        }
                    }
                    Some(McpGitOperationError::RebaseInProgress) => {
                        "A rebase is already in progress; resolve or abort it first.".to_string()
                    }
                    None => envelope
                        .message
                        .unwrap_or_else(|| "Update from base failed.".to_string()),
                };
                return Self::err(message, None::<String>);
            }
            match strategy {
                "rebase" => format!("Rebased onto the base branch ({mode})"),
                _ => format!("Merged the base branch into the work branch ({mode})"),
            }
        } else {
            // Fast-forward pull.
            let url = self.url(&format!("/api/workspaces/{workspace_id}/git/pull"));
            let pull: McpPullOutcome = match self
                .send_json(
                    self.client
                        .post(&url)
                        .json(&serde_json::json!({ "repo_id": repo_id })),
                )
                .await
            {
                Ok(outcome) => outcome,
                Err(e) => return Ok(Self::tool_error(e)),
            };
            match pull {
                McpPullOutcome::UpToDate => "Already up to date with remote".to_string(),
                McpPullOutcome::FastForwarded { commits } => {
                    format!("Fast-forwarded {commits} commit(s) from remote")
                }
                McpPullOutcome::Diverged { ahead, behind } => format!(
                    "Diverged from remote ({ahead} ahead, {behind} behind) — a fast-forward is impossible. Use mode 'merge_base' or 'rebase_base', or reconcile manually."
                ),
            }
        };

        McpServer::success(&McpSyncWorkspaceBranchResponse {
            success: true,
            workspace_id: workspace_id.to_string(),
            repo_id: repo_id.to_string(),
            mode,
            outcome,
        })
    }
}
