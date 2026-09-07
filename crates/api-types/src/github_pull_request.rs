use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
pub struct GitHubRepository {
    pub name: String,
    pub full_name: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GitHubPullRequestStatus {
    Open,
    Merged,
    Closed,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
pub struct GitHubPullRequestSummary {
    pub number: i64,
    pub url: String,
    pub status: GitHubPullRequestStatus,
    pub title: String,
    pub body: String,
    pub author: Option<String>,
    pub assignees: Vec<String>,
    pub labels: Vec<String>,
    pub repository: String,
    pub is_draft: bool,
    pub review_decision: Option<String>,
    pub is_review_requested: bool,
    pub comments_count: i64,
    pub created_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
    pub closed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
pub struct GitHubPullRequestDetail {
    pub number: i64,
    pub url: String,
    pub status: GitHubPullRequestStatus,
    pub merged_at: Option<DateTime<Utc>>,
    pub merge_commit_sha: Option<String>,
    pub title: String,
    pub body: String,
    pub author: Option<String>,
    pub assignees: Vec<String>,
    pub reviewers: Vec<String>,
    pub reviews: Vec<GitHubPullRequestReview>,
    pub review_requests: Vec<GitHubPullRequestReviewRequest>,
    pub commits: Vec<GitHubPullRequestCommit>,
    pub review_decision: Option<String>,
    pub is_draft: bool,
    pub created_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
    pub base_branch: String,
    pub head_branch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
pub struct GitHubPullRequestReview {
    pub id: String,
    pub author: String,
    pub state: String,
    pub body: String,
    pub submitted_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
pub struct GitHubPullRequestCommit {
    pub oid: String,
    pub message: String,
    pub authors: Vec<String>,
    pub committed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GitHubPullRequestReviewRequestAction {
    Requested,
    Rerequested,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
pub struct GitHubPullRequestReviewRequest {
    pub id: String,
    pub actor: String,
    pub requested_reviewer: String,
    pub action: GitHubPullRequestReviewRequestAction,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
pub struct GitHubPullRequestCommentsResponse {
    pub comments: Vec<GitHubPullRequestComment>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(tag = "comment_type", rename_all = "snake_case")]
pub enum GitHubPullRequestComment {
    General {
        id: String,
        author: String,
        author_association: Option<String>,
        body: String,
        created_at: DateTime<Utc>,
        url: Option<String>,
        parent_id: Option<String>,
    },
    Review {
        id: String,
        author: String,
        author_association: Option<String>,
        body: String,
        created_at: DateTime<Utc>,
        url: Option<String>,
        path: String,
        line: Option<i64>,
        side: Option<String>,
        diff_hunk: Option<String>,
        parent_id: Option<String>,
        review_id: Option<String>,
        thread_id: Option<String>,
        is_resolved: Option<bool>,
        is_outdated: Option<bool>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
pub struct SetGitHubReviewThreadResolvedRequest {
    pub url: String,
    pub thread_id: String,
    pub resolved: bool,
}

/// Which GitHub credential the server stack uses for a user.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GitHubCredentialSource {
    /// A GitHub CLI login uploaded from one of the user's hosts.
    HostGh,
    /// The GitHub sign-in of the Vibe OAuth app.
    #[serde(rename = "oauth")]
    OAuth,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
pub struct GitHubCredentialStatus {
    pub source: GitHubCredentialSource,
    pub login: Option<String>,
    pub scopes: Vec<String>,
    pub updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct RegisterGitHubCredentialRequest {
    pub token: String,
}
