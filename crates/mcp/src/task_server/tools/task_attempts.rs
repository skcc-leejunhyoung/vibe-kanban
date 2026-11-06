use rmcp::{
    ErrorData, handler::server::wrapper::Parameters, model::CallToolResult, schemars, tool,
    tool_router,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::McpServer;
use crate::client::{ReviewWorkspaceInput, StartWorkspaceInput, review_executor_config};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpWorkspaceRepoInput {
    #[schemars(description = "The repository ID")]
    repo_id: Uuid,
    #[schemars(description = "The branch for this repository")]
    branch: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct StartWorkspaceRequest {
    #[schemars(
        description = "Optional host ID (from list_workspace_hosts). Omit to create on this machine."
    )]
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
struct ReviewWorkspaceRequest {
    #[schemars(
        description = "Host that clones the PR's repository (from list_workspace_hosts). Omit for this machine."
    )]
    host_id: Option<Uuid>,
    #[schemars(description = "The review-tagged issue whose linked PR is reviewed")]
    issue_id: Uuid,
    #[schemars(
        description = "URL or number of the linked PR to review; needed when several are open"
    )]
    pr: Option<String>,
    #[schemars(
        description = "Repository ID on the host; defaults to the one registered repo whose remote hosts the PR"
    )]
    repo_id: Option<Uuid>,
    #[schemars(
        description = "The coding agent that reviews ('CLAUDE_CODE', 'CODEX', 'GEMINI', 'AMP', 'OPENCODE', 'CURSOR_AGENT', 'QWEN_CODE', 'COPILOT', 'DROID')"
    )]
    executor: String,
    #[schemars(description = "Executor variant/preset")]
    variant: Option<String>,
    #[schemars(description = "Model override, e.g. 'claude-opus-5-5' or 'gpt-5.6-sol'")]
    model_id: Option<String>,
    #[schemars(description = "Reasoning effort override, e.g. 'high'")]
    reasoning_id: Option<String>,
    #[schemars(description = "Permission policy: AUTO, DONT_ASK, SUPERVISED or PLAN")]
    permission_policy: Option<String>,
    #[schemars(
        description = "Review instructions; 'Review the checked-out PR.' is appended. Default: the issue's title and description, fenced as untrusted PR data."
    )]
    prompt: Option<String>,
    #[schemars(description = "Workspace name (default: the issue title)")]
    name: Option<String>,
    #[schemars(
        description = "Create and check out only, like the UI's create button: no first turn, no In review move. Start later with run_session_prompt on a session of the workspace."
    )]
    create_only: Option<bool>,
    #[schemars(
        description = "Resolve issue, PR, repo and any existing review workspace without writing anything"
    )]
    dry_run: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct LinkWorkspaceIssueRequest {
    #[schemars(
        description = "Optional host ID (from list_workspace_hosts). Omit for this machine."
    )]
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
        description = "Create and start the PR review workspace of a review-tagged issue, as the UI does: the linked PR's head is checked out on a private review branch, <remote>/<base> is the diff target, PR and issue are linked, the issue moves to In review and the first review turn starts. Fails instead of falling back to a normal branch (no review tag or PR link, vibe tag, merged/closed PR, several open PRs, no or several clones of the PR's repository, checkout or gh auth failure). Rerun = retry: an open review workspace for the same issue and PR, on the chosen host or any reachable host, comes back as action 'reused' with no second workspace or turn. Returns host_id, workspace_id, branch, checkout (ready|pending), checkout_sha, session_id, execution_process_id, executor_config, pr (number, url, head_branch, base_branch, head_sha), repo, remote, target_branch, issue_status."
    )]
    async fn review_workspace(
        &self,
        Parameters(ReviewWorkspaceRequest {
            host_id,
            issue_id,
            pr,
            repo_id,
            executor,
            variant,
            model_id,
            reasoning_id,
            permission_policy,
            prompt,
            name,
            create_only,
            dry_run,
        }): Parameters<ReviewWorkspaceRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let executor_config = match review_executor_config(
            &executor,
            variant,
            model_id,
            reasoning_id,
            permission_policy,
        ) {
            Ok(config) => config,
            Err(e) => return Ok(Self::tool_error(e)),
        };
        let input = ReviewWorkspaceInput {
            issue_id,
            pr,
            repo_id,
            name,
            prompt,
            executor_config,
            create_only: create_only.unwrap_or(false),
            dry_run: dry_run.unwrap_or(false),
        };
        match self.client.host(host_id).review_workspace(input).await {
            Ok(outcome) => McpServer::success(&outcome),
            Err(e) => Ok(Self::tool_error(e)),
        }
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
