use rmcp::{
    ErrorData, RoleServer, ServerHandler,
    handler::server::tool::ToolCallContext,
    model::{
        CallToolRequestParams, CallToolResponse, Implementation, ProtocolVersion,
        ServerCapabilities, ServerInfo,
    },
    service::RequestContext,
    tool_handler,
};

use super::{McpMode, McpServer};
use crate::client::CURRENT_COMMAND;

#[tool_handler(router = self.tool_router)]
impl ServerHandler for McpServer {
    /// Same dispatch the macro would generate, wrapped so every HTTP call the
    /// tool makes carries the tool name for the server's audit log.
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let name = request.name.to_string();
        let tcc = ToolCallContext::new(self, request, context);
        CURRENT_COMMAND
            .scope(name, self.tool_router.call(tcc))
            .await
    }

    fn get_info(&self) -> ServerInfo {
        let mut tool_names = self
            .tool_router
            .list_all()
            .into_iter()
            .map(|tool| format!("'{}'", tool.name))
            .collect::<Vec<_>>();
        tool_names.sort();

        let preamble = match self.mode() {
            McpMode::Global => {
                "A Vibe Kanban MCP server for task, issue, repository, workspace, and session management."
            }
            McpMode::Orchestrator => {
                "An orchestrator-scoped Vibe Kanban MCP server with tools limited to the configured workspace and orchestrator session context."
            }
        };
        let mut instruction = format!(
            "{} Use list/read tools first when you need IDs or current state. TOOLS: {}.",
            preamble,
            tool_names.join(", ")
        );
        if self.context.is_some() {
            instruction = format!(
                "Use 'get_context' to fetch project, issue, workspace, and orchestrator-session metadata for the active MCP context when available. {}",
                instruction
            );
        }

        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("vibe-kanban-mcp", "1.0.0"))
            .with_protocol_version(ProtocolVersion::V_2025_03_26)
            .with_instructions(instruction)
    }
}
