//! Content search over indexed session conversations (`session_message_index`)
//! plus a slice endpoint returning the conversation around a hit. Consumed by
//! the vibe-kanban MCP server (`search_sessions` / `get_session_slice`).

use axum::{
    Extension,
    extract::{Query, State},
    response::Json as ResponseJson,
};
use chrono::{DateTime, Utc};
use db::models::{
    session::Session,
    session_message_index::{SessionMessageIndex, SessionMessageSliceRow},
};
use deployment::Deployment;
use serde::{Deserialize, Serialize};
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

const DEFAULT_SEARCH_LIMIT: i64 = 20;
const MAX_SEARCH_LIMIT: i64 = 100;
const DEFAULT_SLICE_RADIUS: i64 = 5;
const MAX_SLICE_RADIUS: i64 = 50;
/// Bytes of context kept on each side of the first match in a snippet.
const SNIPPET_CONTEXT_BYTES: usize = 160;

#[derive(Debug, Deserialize)]
pub struct SessionSearchQuery {
    pub q: String,
    pub repo_id: Option<Uuid>,
    /// Comma-separated entry types, e.g. `user_message,tool_use`.
    pub entry_types: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct SessionSearchHit {
    pub session_id: Uuid,
    pub session_name: Option<String>,
    pub workspace_id: Uuid,
    pub workspace_name: Option<String>,
    pub task_title: Option<String>,
    pub execution_id: Uuid,
    pub entry_index: i64,
    pub entry_type: String,
    pub tool_name: Option<String>,
    pub created_at: DateTime<Utc>,
    pub snippet: String,
}

pub async fn search_session_messages(
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<SessionSearchQuery>,
) -> Result<ResponseJson<ApiResponse<Vec<SessionSearchHit>>>, ApiError> {
    let q = query.q.trim();
    if q.is_empty() {
        return Err(ApiError::BadRequest(
            "Query parameter 'q' is required and cannot be empty".to_string(),
        ));
    }
    let entry_types_json = query.entry_types.as_deref().and_then(|raw| {
        let types: Vec<&str> = raw
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        if types.is_empty() {
            None
        } else {
            serde_json::to_string(&types).ok()
        }
    });
    let limit = query
        .limit
        .unwrap_or(DEFAULT_SEARCH_LIMIT)
        .clamp(1, MAX_SEARCH_LIMIT);

    let hits = SessionMessageIndex::search(
        &deployment.db().pool,
        q,
        query.repo_id,
        entry_types_json,
        limit,
    )
    .await?;

    let hits = hits
        .into_iter()
        .map(|hit| SessionSearchHit {
            snippet: snippet_around_match(&hit.content, q),
            session_id: hit.session_id,
            session_name: hit.session_name,
            workspace_id: hit.workspace_id,
            workspace_name: hit.workspace_name,
            task_title: hit.task_title,
            execution_id: hit.execution_id,
            entry_index: hit.entry_index,
            entry_type: hit.entry_type,
            tool_name: hit.tool_name,
            created_at: hit.created_at,
        })
        .collect();

    Ok(ResponseJson(ApiResponse::success(hits)))
}

#[derive(Debug, Deserialize)]
pub struct SessionSliceQuery {
    pub execution_id: Uuid,
    pub entry_index: i64,
    pub radius: Option<i64>,
}

pub async fn get_session_message_slice(
    Extension(session): Extension<Session>,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<SessionSliceQuery>,
) -> Result<ResponseJson<ApiResponse<Vec<SessionMessageSliceRow>>>, ApiError> {
    let radius = query
        .radius
        .unwrap_or(DEFAULT_SLICE_RADIUS)
        .clamp(0, MAX_SLICE_RADIUS);
    let rows = SessionMessageIndex::slice(
        &deployment.db().pool,
        session.id,
        query.execution_id,
        query.entry_index,
        radius,
    )
    .await?;
    Ok(ResponseJson(ApiResponse::success(rows)))
}

/// Trim `content` to a window around the first (case-insensitive) match of
/// `query`, clamped to char boundaries, with `…` marking truncation.
fn snippet_around_match(content: &str, query: &str) -> String {
    let match_start = content.find(query).or_else(|| {
        // SQL LIKE matched case-insensitively (ASCII); mirror that here. The
        // lowercased haystack can shift byte offsets for some non-ASCII chars,
        // but offsets are clamped to char boundaries below, so worst case the
        // window is slightly off-center — never a panic.
        content.to_lowercase().find(&query.to_lowercase())
    });
    let (mut start, mut end) = match match_start {
        Some(pos) => (
            pos.saturating_sub(SNIPPET_CONTEXT_BYTES),
            (pos + query.len() + SNIPPET_CONTEXT_BYTES).min(content.len()),
        ),
        None => (0, (2 * SNIPPET_CONTEXT_BYTES).min(content.len())),
    };
    while start > 0 && !content.is_char_boundary(start) {
        start -= 1;
    }
    while end < content.len() && !content.is_char_boundary(end) {
        end += 1;
    }
    let mut snippet = String::new();
    if start > 0 {
        snippet.push('…');
    }
    snippet.push_str(&content[start..end]);
    if end < content.len() {
        snippet.push('…');
    }
    snippet
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snippet_centers_on_korean_match_at_char_boundaries() {
        let padding = "가나다라마바사아자차카타파하".repeat(30);
        let content = format!("{padding}핵심 결정 사항{padding}");
        let snippet = snippet_around_match(&content, "핵심 결정");
        assert!(snippet.contains("핵심 결정 사항"));
        assert!(snippet.starts_with('…') && snippet.ends_with('…'));
        assert!(snippet.len() < content.len());
    }

    #[test]
    fn snippet_returns_short_content_unchanged() {
        assert_eq!(snippet_around_match("short text", "text"), "short text");
    }

    #[test]
    fn snippet_matches_case_insensitively() {
        let snippet = snippet_around_match("Decided to use FTS later", "fts");
        assert!(snippet.contains("FTS"));
    }
}
