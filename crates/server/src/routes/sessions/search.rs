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
    session_message_index::{
        SessionMessageIndex, SessionMessageSliceMetadata, SessionMessageSliceRow,
    },
};
use deployment::Deployment;
use serde::{Deserialize, Serialize};
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

const DEFAULT_SEARCH_LIMIT: i64 = 20;
const MAX_SEARCH_LIMIT: i64 = 100;
const DEFAULT_SLICE_RADIUS: i64 = 5;
/// Bounds the DB fetch only; the response size is governed by the byte budget.
/// Large enough to cover any indexed session (the biggest holds ~2.2k rows).
const MAX_SLICE_RADIUS: i64 = 2000;
/// Content bytes a single slice response may carry. Measured on a real index,
/// 88% of sessions fit whole under this, so "read the whole session" is one
/// call for most and a short re-anchored walk for the rest.
const SLICE_BUDGET_BYTES: usize = 64 * 1024;
/// Bytes of context kept on each side of the first match in a snippet.
const SNIPPET_CONTEXT_BYTES: usize = 160;

#[derive(Debug, Deserialize)]
pub struct SessionSearchQuery {
    /// Substring to match. May be omitted when `session_id` is given, which
    /// then lists that session's entries (e.g. its turn prompts).
    pub q: Option<String>,
    pub repo_id: Option<Uuid>,
    pub session_id: Option<Uuid>,
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
    let q = query.q.as_deref().unwrap_or_default().trim();
    if q.is_empty() && query.session_id.is_none() {
        return Err(ApiError::BadRequest(
            "Query parameter 'q' is required unless 'session_id' is given".to_string(),
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
        query.session_id,
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

#[derive(Debug, Serialize)]
pub struct SessionSliceCursor {
    pub execution_id: Uuid,
    pub entry_index: i64,
}

#[derive(Debug, Serialize)]
pub struct SessionSliceResponse {
    pub entries: Vec<SessionMessageSliceRow>,
    /// Entries within `radius` existed before/after `entries` but were cut by
    /// the byte budget. The cursors point to the first omitted entries.
    pub truncated_before: bool,
    pub truncated_after: bool,
    pub before_cursor: Option<SessionSliceCursor>,
    pub after_cursor: Option<SessionSliceCursor>,
}

pub async fn get_session_message_slice(
    Extension(session): Extension<Session>,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<SessionSliceQuery>,
) -> Result<ResponseJson<ApiResponse<SessionSliceResponse>>, ApiError> {
    let radius = query
        .radius
        .unwrap_or(DEFAULT_SLICE_RADIUS)
        .clamp(0, MAX_SLICE_RADIUS);
    let metadata = SessionMessageIndex::slice_metadata(
        &deployment.db().pool,
        session.id,
        query.execution_id,
        query.entry_index,
        radius,
    )
    .await?;
    let Some(hit) = metadata
        .iter()
        .position(|r| r.execution_id == query.execution_id && r.entry_index == query.entry_index)
    else {
        return Ok(ResponseJson(ApiResponse::success(SessionSliceResponse {
            entries: Vec::new(),
            truncated_before: false,
            truncated_after: false,
            before_cursor: None,
            after_cursor: None,
        })));
    };
    let window = slice_window_within_budget(&metadata, Some(hit), SLICE_BUDGET_BYTES)
        .expect("slice metadata contains the hit");
    let before_cursor = window
        .lo
        .checked_sub(1)
        .and_then(|index| metadata.get(index))
        .map(SessionSliceCursor::from);
    let after_cursor = metadata.get(window.hi + 1).map(SessionSliceCursor::from);
    let entries = SessionMessageIndex::slice_range(
        &deployment.db().pool,
        session.id,
        query.execution_id,
        query.entry_index,
        (hit - window.lo) as i64,
        (window.hi - hit) as i64,
    )
    .await?;

    Ok(ResponseJson(ApiResponse::success(SessionSliceResponse {
        entries,
        truncated_before: before_cursor.is_some(),
        truncated_after: after_cursor.is_some(),
        before_cursor,
        after_cursor,
    })))
}

#[derive(Debug, PartialEq, Eq)]
struct SliceWindow {
    lo: usize,
    hi: usize,
}

impl From<&SessionMessageSliceMetadata> for SessionSliceCursor {
    fn from(row: &SessionMessageSliceMetadata) -> Self {
        Self {
            execution_id: row.execution_id,
            entry_index: row.entry_index,
        }
    }
}

/// Choose a contiguous range within `budget` before loading message bodies.
/// The hit itself is kept even if it alone exceeds the budget.
fn slice_window_within_budget(
    rows: &[SessionMessageSliceMetadata],
    hit: Option<usize>,
    budget: usize,
) -> Option<SliceWindow> {
    let hit = hit?;
    let (mut lo, mut hi) = (hit, hit);
    let mut used = usize::try_from(rows[hit].content_bytes).unwrap_or(usize::MAX);
    loop {
        let mut grew = false;
        if lo > 0
            && usize::try_from(rows[lo - 1].content_bytes).unwrap_or(usize::MAX)
                <= budget.saturating_sub(used)
        {
            lo -= 1;
            used += usize::try_from(rows[lo].content_bytes).unwrap_or(usize::MAX);
            grew = true;
        }
        if hi + 1 < rows.len()
            && usize::try_from(rows[hi + 1].content_bytes).unwrap_or(usize::MAX)
                <= budget.saturating_sub(used)
        {
            hi += 1;
            used += usize::try_from(rows[hi].content_bytes).unwrap_or(usize::MAX);
            grew = true;
        }
        if !grew {
            break;
        }
    }
    Some(SliceWindow { lo, hi })
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

    fn row(i: i64, bytes: i64) -> SessionMessageSliceMetadata {
        SessionMessageSliceMetadata {
            execution_id: Uuid::nil(),
            entry_index: i,
            content_bytes: bytes,
        }
    }

    #[test]
    fn slice_budget_grows_outward_from_hit_and_flags_cut_edges() {
        // 7 rows of 10 bytes, hit in the middle, budget for 5 rows.
        let rows: Vec<_> = (0..7).map(|i| row(i, 10)).collect();
        assert_eq!(
            slice_window_within_budget(&rows, Some(3), 50),
            Some(SliceWindow { lo: 1, hi: 5 })
        );

        // Hit at the start: the whole budget goes forward, nothing to cut before.
        let rows: Vec<_> = (0..7).map(|i| row(i, 10)).collect();
        assert_eq!(
            slice_window_within_budget(&rows, Some(0), 35),
            Some(SliceWindow { lo: 0, hi: 2 })
        );

        // Everything fits: no flags.
        let rows: Vec<_> = (0..3).map(|i| row(i, 10)).collect();
        assert_eq!(
            slice_window_within_budget(&rows, Some(1), 1000),
            Some(SliceWindow { lo: 0, hi: 2 })
        );

        // A huge neighbour blocks one side only; the hit is always kept.
        let rows = vec![row(0, 500), row(1, 10), row(2, 10)];
        assert_eq!(
            slice_window_within_budget(&rows, Some(1), 30),
            Some(SliceWindow { lo: 1, hi: 2 })
        );
        assert_eq!(
            slice_window_within_budget(&[row(0, 500)], Some(0), 30),
            Some(SliceWindow { lo: 0, hi: 0 }),
            "oversized hit is still returned"
        );

        // Unknown anchor yields nothing.
        assert_eq!(slice_window_within_budget(&[], None, 30), None);
    }

    #[test]
    fn slice_continuation_cursor_always_advances() {
        let rows = vec![row(0, 4_000), row(1, 61_000), row(2, 4_000)];

        let first = slice_window_within_budget(&rows, Some(0), SLICE_BUDGET_BYTES).unwrap();
        assert_eq!(first, SliceWindow { lo: 0, hi: 1 });
        let after = SessionSliceCursor::from(&rows[first.hi + 1]);
        let next_hit = rows
            .iter()
            .position(|row| row.entry_index == after.entry_index);
        assert_eq!(
            slice_window_within_budget(&rows, next_hit, SLICE_BUDGET_BYTES),
            Some(SliceWindow { lo: 1, hi: 2 })
        );

        let last = slice_window_within_budget(&rows, Some(2), SLICE_BUDGET_BYTES).unwrap();
        assert_eq!(last, SliceWindow { lo: 1, hi: 2 });
        let before = SessionSliceCursor::from(&rows[last.lo - 1]);
        let previous_hit = rows
            .iter()
            .position(|row| row.entry_index == before.entry_index);
        assert_eq!(
            slice_window_within_budget(&rows, previous_hit, SLICE_BUDGET_BYTES),
            Some(SliceWindow { lo: 0, hi: 1 })
        );
    }

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
