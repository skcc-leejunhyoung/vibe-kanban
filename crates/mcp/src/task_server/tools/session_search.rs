use rmcp::{
    ErrorData, handler::server::wrapper::Parameters, model::CallToolResult, schemars, tool,
    tool_router,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::McpServer;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct SearchSessionsRequest {
    #[schemars(
        description = "Substring to find in past session conversations (user/assistant/thinking messages, tool-use summary lines, system and error messages). Case-insensitive for ASCII; matches inside words, so short Korean fragments work."
    )]
    query: String,
    #[schemars(description = "Optional repo ID: only sessions whose workspace contains this repo")]
    repo_id: Option<Uuid>,
    #[schemars(
        description = "Optional entry-type filter. Valid values: user_message, user_feedback, assistant_message, thinking, tool_use, system_message, error_message, user_answered_questions"
    )]
    entry_types: Option<Vec<String>>,
    #[schemars(description = "Max hits to return (default 20, max 100)")]
    limit: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
struct SessionSearchHit {
    #[schemars(description = "Session containing the hit; pass to get_session_slice")]
    session_id: Uuid,
    session_name: Option<String>,
    workspace_id: Uuid,
    workspace_name: Option<String>,
    #[schemars(description = "Title of the task/issue the workspace belongs to (if any)")]
    task_title: Option<String>,
    #[schemars(description = "Execution (turn) containing the hit; pass to get_session_slice")]
    execution_id: Uuid,
    #[schemars(description = "Entry position within the execution; pass to get_session_slice")]
    entry_index: i64,
    entry_type: String,
    tool_name: Option<String>,
    #[schemars(description = "When the turn started (RFC3339)")]
    created_at: String,
    #[schemars(description = "Matched content trimmed to a window around the match")]
    snippet: String,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct SearchSessionsResponse {
    total_count: usize,
    hits: Vec<SessionSearchHit>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct GetSessionSliceRequest {
    #[schemars(description = "Session ID (from a search_sessions hit)")]
    session_id: Uuid,
    #[schemars(description = "Execution ID of the hit (from search_sessions)")]
    execution_id: Uuid,
    #[schemars(description = "Entry index of the hit (from search_sessions)")]
    entry_index: i64,
    #[schemars(
        description = "How many entries of context to include on each side of the hit (default 5, max 50)"
    )]
    radius: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
struct SessionSliceEntry {
    execution_id: Uuid,
    entry_index: i64,
    entry_type: String,
    tool_name: Option<String>,
    #[schemars(description = "Full entry content (not truncated)")]
    content: String,
    created_at: String,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct GetSessionSliceResponse {
    session_id: String,
    total_count: usize,
    entries: Vec<SessionSliceEntry>,
}

#[tool_router(router = session_search_tools_router, vis = "pub")]
impl McpServer {
    #[tool(
        description = "Search past session conversations by content across all workspaces (including finished and archived ones). Returns top matches with session/workspace context and a snippet. Follow up with get_session_slice to read the conversation around a hit."
    )]
    async fn search_sessions(
        &self,
        Parameters(SearchSessionsRequest {
            query,
            repo_id,
            entry_types,
            limit,
        }): Parameters<SearchSessionsRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let query = query.trim().to_string();
        if query.is_empty() {
            return Self::err("query must not be empty", None);
        }

        let url = self.url("/api/sessions/search");
        let mut params: Vec<(&str, String)> = vec![("q", query)];
        if let Some(repo_id) = repo_id {
            params.push(("repo_id", repo_id.to_string()));
        }
        if let Some(entry_types) = entry_types.filter(|t| !t.is_empty()) {
            params.push(("entry_types", entry_types.join(",")));
        }
        if let Some(limit) = limit {
            params.push(("limit", limit.to_string()));
        }

        let hits: Vec<SessionSearchHit> =
            match self.send_json(self.client.get(&url).query(&params)).await {
                Ok(value) => value,
                Err(error_result) => return Ok(Self::tool_error(error_result)),
            };

        Self::success(&SearchSessionsResponse {
            total_count: hits.len(),
            hits,
        })
    }

    #[tool(
        description = "Read the conversation around a search_sessions hit: the hit entry plus `radius` entries of context on each side, in session order (crossing turn boundaries). Avoids reading whole transcripts."
    )]
    async fn get_session_slice(
        &self,
        Parameters(GetSessionSliceRequest {
            session_id,
            execution_id,
            entry_index,
            radius,
        }): Parameters<GetSessionSliceRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let url = self.url(&format!("/api/sessions/{session_id}/message-slice"));
        let mut params: Vec<(&str, String)> = vec![
            ("execution_id", execution_id.to_string()),
            ("entry_index", entry_index.to_string()),
        ];
        if let Some(radius) = radius {
            params.push(("radius", radius.to_string()));
        }

        let entries: Vec<SessionSliceEntry> =
            match self.send_json(self.client.get(&url).query(&params)).await {
                Ok(value) => value,
                Err(error_result) => return Ok(Self::tool_error(error_result)),
            };

        Self::success(&GetSessionSliceResponse {
            session_id: session_id.to_string(),
            total_count: entries.len(),
            entries,
        })
    }
}
