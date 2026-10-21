use rmcp::{
    ErrorData, handler::server::wrapper::Parameters, model::CallToolResult, schemars, tool,
    tool_router,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::McpServer;
use crate::client::StartWorkspaceInput;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpWorkspaceRepoInput {
    #[schemars(description = "The repository ID")]
    repo_id: Uuid,
    #[schemars(description = "The branch for this repository")]
    branch: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct StartWorkspaceRequest {
    #[schemars(description = "Optional paired host ID. Omit to create on this machine.")]
    host_id: Option<Uuid>,
    #[schemars(description = "Name for the workspace")]
    name: String,
    #[schemars(
        description = "Optional prompt for the first workspace session. If omitted/empty, the linked issue title/description is used."
    )]
    prompt: Option<String>,
    #[schemars(
        description = "The coding agent executor to run ('CLAUDE_CODE', 'AMP', 'GEMINI', 'CODEX', 'OPENCODE', 'CURSOR_AGENT', 'QWEN_CODE', 'COPILOT', 'DROID')"
    )]
    executor: String,
    #[schemars(description = "Optional executor variant, if needed")]
    variant: Option<String>,
    #[schemars(description = "Repository selection for the workspace")]
    repositories: Vec<McpWorkspaceRepoInput>,
    #[schemars(
        description = "Optional issue ID to link the workspace to. When provided, the workspace will be associated with this remote issue."
    )]
    issue_id: Option<Uuid>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct StartWorkspaceResponse {
    workspace_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct LinkWorkspaceIssueRequest {
    #[schemars(description = "Optional paired host ID. Omit for this machine.")]
    host_id: Option<Uuid>,
    #[schemars(description = "The workspace ID to link")]
    workspace_id: Uuid,
    #[schemars(description = "The issue ID to link the workspace to")]
    issue_id: Uuid,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct LinkWorkspaceIssueResponse {
    #[schemars(description = "Whether the linking was successful")]
    success: bool,
    #[schemars(description = "The workspace ID that was linked")]
    workspace_id: String,
    #[schemars(description = "The issue ID it was linked to")]
    issue_id: String,
}

#[tool_router(router = task_attempts_tools_router, vis = "pub")]
impl McpServer {
    #[tool(description = "Create a new workspace and start its first session.")]
    async fn start_workspace(
        &self,
        Parameters(StartWorkspaceRequest {
            name,
            prompt,
            executor,
            variant,
            repositories,
            issue_id,
            host_id,
        }): Parameters<StartWorkspaceRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        if executor.trim().is_empty() {
            return Self::err("Executor must not be empty.", None::<&str>);
        }
        let input = StartWorkspaceInput {
            name,
            prompt,
            executor,
            variant,
            repositories: repositories
                .into_iter()
                .map(|r| (r.repo_id, r.branch))
                .collect(),
            issue_id,
        };
        let workspace_id = match self.client.host(host_id).start_workspace(input).await {
            Ok(id) => id,
            Err(e) => return Ok(Self::tool_error(e)),
        };
        McpServer::success(&StartWorkspaceResponse {
            workspace_id: workspace_id.to_string(),
        })
    }

    #[tool(
        description = "Link an existing workspace to a remote issue. This associates the workspace with the issue for tracking."
    )]
    async fn link_workspace_issue(
        &self,
        Parameters(LinkWorkspaceIssueRequest {
            host_id,
            workspace_id,
            issue_id,
        }): Parameters<LinkWorkspaceIssueRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        if let Err(e) = self
            .client
            .host(host_id)
            .link_workspace_to_issue(workspace_id, issue_id)
            .await
        {
            return Ok(Self::tool_error(e));
        }

        McpServer::success(&LinkWorkspaceIssueResponse {
            success: true,
            workspace_id: workspace_id.to_string(),
            issue_id: issue_id.to_string(),
        })
    }
}
