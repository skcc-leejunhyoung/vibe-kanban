mod handler;
mod tools;

use anyhow::Context;
use rmcp::{handler::server::tool::ToolRouter, schemars};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::client::VkClient;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, schemars::JsonSchema)]
pub struct McpRepoContext {
    #[schemars(description = "The unique identifier of the repository")]
    pub repo_id: Uuid,
    #[schemars(description = "The name of the repository")]
    pub repo_name: String,
    #[schemars(description = "The target branch for this repository in this workspace")]
    pub target_branch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, schemars::JsonSchema)]
pub struct McpContext {
    #[schemars(description = "The organization ID (if workspace is linked to remote)")]
    pub organization_id: Option<Uuid>,
    #[schemars(description = "The remote project ID (if workspace is linked to remote)")]
    pub project_id: Option<Uuid>,
    #[schemars(description = "The remote issue ID (if workspace is linked to a remote issue)")]
    pub issue_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(description = "The orchestrator session ID when running in orchestrator mode")]
    pub orchestrator_session_id: Option<Uuid>,
    pub workspace_id: Uuid,
    pub workspace_branch: String,
    #[schemars(
        description = "Repository info and target branches for each repo in this workspace"
    )]
    pub workspace_repos: Vec<McpRepoContext>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(description = "Cloud host id of the machine this server runs on, when registered")]
    pub host_id: Option<Uuid>,
    #[serde(default)]
    #[schemars(description = "MCP mode: global or orchestrator")]
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(
        description = "Agent access toggles of this host (write_issues, control_sessions, respond_approvals, git_write, git_merge, delete_workspaces, update_config, automation_write)"
    )]
    pub agent_access: Option<serde_json::Value>,
}

#[derive(Debug, Clone)]
pub enum McpMode {
    Global,
    Orchestrator,
}

impl McpMode {
    fn label(&self) -> &'static str {
        match self {
            McpMode::Global => "global",
            McpMode::Orchestrator => "orchestrator",
        }
    }
}

#[derive(Debug, Clone)]
pub struct McpServer {
    client: VkClient,
    tool_router: ToolRouter<McpServer>,
    context: Option<McpContext>,
    mode: McpMode,
}

impl McpServer {
    pub fn new_global(base_url: &str) -> Self {
        Self {
            client: Self::client(base_url),
            tool_router: Self::global_mode_router(),
            context: None,
            mode: McpMode::Global,
        }
    }

    pub fn new_orchestrator(base_url: &str) -> Self {
        Self {
            client: Self::client(base_url),
            tool_router: Self::orchestrator_mode_router(),
            context: None,
            mode: McpMode::Orchestrator,
        }
    }

    fn client(base_url: &str) -> VkClient {
        VkClient::new(
            base_url,
            &format!("vibe-kanban-mcp/{}", env!("CARGO_PKG_VERSION")),
        )
    }

    pub async fn init(mut self) -> anyhow::Result<Self> {
        let context = self.fetch_context_at_startup().await?;

        if context.is_none() {
            self.tool_router.map.remove("get_context");
            tracing::debug!("VK context not available, get_context tool will not be registered");
        } else {
            tracing::info!("VK context loaded, get_context tool available");
        }

        self.context = context;
        Ok(self)
    }

    pub fn mode(&self) -> &McpMode {
        &self.mode
    }

    async fn fetch_context_at_startup(&self) -> anyhow::Result<Option<McpContext>> {
        let current_dir = std::env::current_dir().context("Failed to resolve current directory")?;
        match self.client.workspace_context(&current_dir).await {
            Ok(Some(ctx)) => Ok(Some(self.build_mcp_context(&ctx).await)),
            Ok(None) | Err(_) if matches!(self.mode(), McpMode::Global) => Ok(None),
            Ok(None) => anyhow::bail!(
                "Failed to load orchestrator MCP context from /api/containers/attempt-context"
            ),
            Err(error) => {
                Err(anyhow::Error::from(error).context("Failed to load orchestrator MCP context"))
            }
        }
    }

    async fn build_mcp_context(&self, ctx: &db::models::workspace::WorkspaceContext) -> McpContext {
        let workspace_repos = ctx
            .workspace_repos
            .iter()
            .map(|rwb| McpRepoContext {
                repo_id: rwb.repo.id,
                repo_name: rwb.repo.name.clone(),
                target_branch: rwb.target_branch.clone(),
            })
            .collect();
        let orchestrator_session_id = match self.mode() {
            McpMode::Orchestrator => ctx.orchestrator_session_id,
            McpMode::Global => None,
        };
        let (links, host_id, agent_access) = tokio::join!(
            self.client.remote_workspace_links(ctx.workspace.id),
            self.client.self_host_id(),
            self.client.agent_access(),
        );
        McpContext {
            organization_id: links.organization_id,
            project_id: links.project_id,
            issue_id: links.issue_id,
            orchestrator_session_id,
            workspace_id: ctx.workspace.id,
            workspace_branch: ctx.workspace.branch.clone(),
            workspace_repos,
            host_id,
            mode: self.mode.label().to_string(),
            agent_access,
        }
    }
}
