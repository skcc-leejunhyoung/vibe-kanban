use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::some_if_present;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct IssueComment {
    pub id: Uuid,
    pub issue_id: Uuid,
    pub author_id: Option<Uuid>,
    pub parent_id: Option<Uuid>,
    pub message: String,
    /// GitHub comment id this row mirrors (identity key, never non-null for a
    /// native vibe comment). Set by the automation worker's bidirectional sync.
    pub github_comment_id: Option<String>,
    /// Real GitHub author login, shown in place of the sync bot when set.
    pub github_author_login: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct CreateIssueCommentRequest {
    /// Optional client-generated ID. If not provided, server generates one.
    /// Using client-generated IDs enables stable optimistic updates.
    #[ts(optional)]
    pub id: Option<Uuid>,
    pub issue_id: Uuid,
    pub message: String,
    pub parent_id: Option<Uuid>,
    /// Sync-only: set by the automation worker when importing a GitHub comment.
    #[ts(optional)]
    pub github_comment_id: Option<String>,
    #[ts(optional)]
    pub github_author_login: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct UpdateIssueCommentRequest {
    #[serde(default, deserialize_with = "some_if_present")]
    pub message: Option<String>,
    #[serde(default, deserialize_with = "some_if_present")]
    pub parent_id: Option<Option<Uuid>>,
    /// Sync-only: set once when the worker mirrors a native comment to GitHub.
    /// Unlike `message`, this is not gated on comment authorship (see route).
    #[serde(default, deserialize_with = "some_if_present")]
    pub github_comment_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ListIssueCommentsQuery {
    pub issue_id: Uuid,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct ListIssueCommentsResponse {
    pub issue_comments: Vec<IssueComment>,
}
