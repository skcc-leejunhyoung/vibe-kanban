use db::models::execution_process::ExecutionProcessStatus;
use rmcp::{
    ErrorData,
    model::{CallToolResult, ContentBlock},
};
use serde::Serialize;
use thiserror::Error;
use uuid::Uuid;

use super::{McpMode, McpServer};
use crate::client::VkError;

type ToolCallResult = Result<CallToolResult, ErrorData>;

#[derive(Debug, Error)]
#[error("{message}")]
struct ToolError {
    message: String,
    details: Option<String>,
}

impl ToolError {
    fn new(message: impl Into<String>, details: Option<impl Into<String>>) -> Self {
        Self {
            message: message.into(),
            details: details.map(Into::into),
        }
    }

    fn message(message: impl Into<String>) -> Self {
        Self::new(message, None::<String>)
    }
}

impl From<VkError> for ToolError {
    fn from(error: VkError) -> Self {
        match error {
            VkError::Connect(details) => {
                ToolError::new("Failed to connect to VK API", Some(details))
            }
            VkError::Api { status, message } if status >= 400 => ToolError::new(
                format!("VK API returned error status: {status}"),
                Some(message),
            ),
            VkError::Api { message, .. } => ToolError::new("VK API returned error", Some(message)),
            VkError::Parse(details) => {
                ToolError::new("Failed to parse VK API response", Some(details))
            }
            VkError::Message(message) => ToolError::message(message),
        }
    }
}

mod context;
mod events;
mod remote_issues;
mod session_search;
mod sessions;
mod task_attempts;
mod workspaces;

/// Everything the global server exposes. Kept small on purpose: tool schemas
/// ride along with every model turn, so the long tail (repos, tags,
/// assignees, relationships, scripts, organizations, deletes) lives in the
/// `vk` CLI instead.
pub const GLOBAL_TOOLS: &[&str] = &[
    "get_context",
    "list_workspaces",
    "list_workspace_hosts",
    "search_sessions",
    "get_session_slice",
    "get_execution",
    "run_session_prompt",
    "start_workspace",
    "link_workspace_issue",
    "create_issue",
    "update_issue",
    "get_issue",
    "list_issues",
    "list_events",
    "wait_for_events",
    "notify_user",
];

impl McpServer {
    fn all_tools_router() -> rmcp::handler::server::tool::ToolRouter<Self> {
        Self::context_tools_router()
            + Self::workspaces_tools_router()
            + Self::remote_issues_tools_router()
            + Self::task_attempts_tools_router()
            + Self::session_tools_router()
            + Self::session_search_tools_router()
            + Self::events_tools_router()
    }

    pub fn global_mode_router() -> rmcp::handler::server::tool::ToolRouter<Self> {
        let mut router = Self::all_tools_router();
        let extra: Vec<String> = router
            .list_all()
            .into_iter()
            .map(|tool| tool.name.to_string())
            .filter(|name| !GLOBAL_TOOLS.contains(&name.as_str()))
            .collect();
        for name in extra {
            router.remove_route(&name);
        }
        router
    }

    pub fn orchestrator_mode_router() -> rmcp::handler::server::tool::ToolRouter<Self> {
        let mut router = Self::context_tools_router()
            + Self::workspaces_tools_router()
            + Self::session_tools_router()
            + Self::session_search_tools_router();
        router.remove_route("list_workspaces");
        router.remove_route("list_workspace_hosts");
        router
    }
}

impl McpServer {
    fn orchestrator_session_id(&self) -> Option<Uuid> {
        self.context
            .as_ref()
            .and_then(|ctx| ctx.orchestrator_session_id)
    }

    fn scoped_workspace_id(&self) -> Option<Uuid> {
        self.context.as_ref().map(|ctx| ctx.workspace_id)
    }

    fn success<T: Serialize>(data: &T) -> ToolCallResult {
        Ok(CallToolResult::success(vec![ContentBlock::text(
            serde_json::to_string_pretty(data)
                .unwrap_or_else(|_| "Failed to serialize response".to_string()),
        )]))
    }

    fn err<S: Into<String>>(msg: S, details: Option<S>) -> ToolCallResult {
        Ok(Self::tool_error(ToolError::new(msg, details)))
    }

    fn tool_error(error: impl Into<ToolError>) -> CallToolResult {
        let error: ToolError = error.into();
        let mut value = serde_json::json!({
            "success": false,
            "error": error.message,
        });
        if let Some(details) = error.details {
            value["details"] = serde_json::json!(details);
        }

        CallToolResult::error(vec![ContentBlock::text(
            serde_json::to_string_pretty(&value)
                .unwrap_or_else(|_| "Failed to serialize error".to_string()),
        )])
    }

    fn resolve_workspace_id(&self, explicit: Option<Uuid>) -> Result<Uuid, ToolError> {
        if let Some(id) = explicit {
            return Ok(id);
        }
        if let Some(workspace_id) = self.scoped_workspace_id() {
            return Ok(workspace_id);
        }
        Err(ToolError::message(
            "workspace_id is required (not available from current MCP context)",
        ))
    }

    fn scope_allows_workspace(&self, workspace_id: Uuid) -> Result<(), ToolError> {
        if matches!(self.mode(), McpMode::Orchestrator)
            && let Some(scoped_workspace_id) = self.scoped_workspace_id()
            && scoped_workspace_id != workspace_id
        {
            return Err(ToolError::new(
                "Operation is outside the configured workspace scope",
                Some(format!(
                    "requested workspace_id={}, configured workspace_id={}",
                    workspace_id, scoped_workspace_id
                )),
            ));
        }

        Ok(())
    }

    // Resolves a project_id from an explicit parameter or falls back to context.
    fn resolve_project_id(&self, explicit: Option<Uuid>) -> Result<Uuid, ToolError> {
        if let Some(id) = explicit {
            return Ok(id);
        }
        if let Some(ctx) = &self.context
            && let Some(id) = ctx.project_id
        {
            return Ok(id);
        }
        Err(ToolError::message(
            "project_id is required (not available from workspace context)",
        ))
    }

    fn execution_process_status_label(status: &ExecutionProcessStatus) -> &'static str {
        match status {
            ExecutionProcessStatus::Running => "running",
            ExecutionProcessStatus::Completed => "completed",
            ExecutionProcessStatus::Failed => "failed",
            ExecutionProcessStatus::Killed => "killed",
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeSet, sync::Once};

    use rmcp::handler::server::tool::ToolRouter;
    use uuid::Uuid;

    use super::{GLOBAL_TOOLS, McpServer};
    use crate::{
        client::VkClient,
        task_server::{McpContext, McpMode, McpRepoContext},
    };

    static RUSTLS_PROVIDER: Once = Once::new();

    fn install_rustls_provider() {
        RUSTLS_PROVIDER.call_once(|| {
            rustls::crypto::aws_lc_rs::default_provider()
                .install_default()
                .expect("Failed to install rustls crypto provider");
        });
    }

    fn tool_names(router: rmcp::handler::server::tool::ToolRouter<McpServer>) -> BTreeSet<String> {
        router
            .list_all()
            .into_iter()
            .map(|tool| tool.name.to_string())
            .collect()
    }

    fn test_client() -> VkClient {
        install_rustls_provider();
        VkClient::new("http://127.0.0.1:3000", "test/0")
    }

    #[test]
    fn orchestrator_mode_exposes_only_scoped_workflow_tools() {
        let actual = tool_names(McpServer::orchestrator_mode_router());
        let expected = BTreeSet::from([
            "create_session".to_string(),
            "get_context".to_string(),
            "get_execution".to_string(),
            "get_session_slice".to_string(),
            "list_sessions".to_string(),
            "run_session_prompt".to_string(),
            "search_sessions".to_string(),
            "sync_workspace_branch".to_string(),
            "update_session".to_string(),
            "update_workspace".to_string(),
        ]);

        assert_eq!(actual, expected);
    }

    #[test]
    fn global_mode_is_the_sixteen_core_tools() {
        let actual = tool_names(McpServer::global_mode_router());
        let expected: BTreeSet<String> = GLOBAL_TOOLS.iter().map(|s| s.to_string()).collect();
        assert_eq!(actual, expected);
        assert!(actual.len() <= 16);
        for retired in [
            "delete_workspace",
            "list_repos",
            "list_tags",
            "assign_issue",
            "delete_issue",
            "list_organizations",
            "list_projects",
            "create_session",
            "update_setup_script",
        ] {
            assert!(
                !actual.contains(retired),
                "{retired} should live in the vk CLI"
            );
        }
    }

    #[test]
    fn orchestrator_session_id_is_resolved_from_context() {
        let session_id = Uuid::new_v4();
        let workspace_id = Uuid::new_v4();
        let server = McpServer {
            client: test_client(),
            tool_router: ToolRouter::default(),
            context: Some(McpContext {
                organization_id: None,
                project_id: None,
                issue_id: None,
                orchestrator_session_id: Some(session_id),
                workspace_id,
                workspace_branch: "main".to_string(),
                workspace_repos: vec![McpRepoContext {
                    repo_id: Uuid::new_v4(),
                    repo_name: "repo".to_string(),
                    target_branch: "main".to_string(),
                }],
                host_id: None,
                mode: "global".to_string(),
                agent_access: None,
            }),
            mode: McpMode::Global,
        };

        assert_eq!(server.orchestrator_session_id(), Some(session_id));
        assert_eq!(server.resolve_workspace_id(None).unwrap(), workspace_id);
    }

    #[test]
    fn orchestrator_scope_requires_context_when_missing() {
        let server = McpServer {
            client: test_client(),
            tool_router: ToolRouter::default(),
            context: None,
            mode: McpMode::Orchestrator,
        };

        assert_eq!(server.orchestrator_session_id(), None);
        assert!(server.resolve_workspace_id(None).is_err());
        assert!(server.scope_allows_workspace(Uuid::new_v4()).is_ok());
    }

    #[test]
    fn global_context_omits_orchestrator_session_id_from_serialized_output() {
        let context = McpContext {
            organization_id: None,
            project_id: None,
            issue_id: None,
            orchestrator_session_id: None,
            workspace_id: Uuid::new_v4(),
            workspace_branch: "main".to_string(),
            workspace_repos: vec![],
            host_id: None,
            mode: "global".to_string(),
            agent_access: None,
        };

        let serialized = serde_json::to_value(&context).expect("context should serialize");

        assert!(serialized.get("orchestrator_session_id").is_none());
        assert_eq!(serialized["mode"], "global");
    }
}
