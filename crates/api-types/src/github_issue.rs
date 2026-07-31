use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::some_if_present;

#[derive(Debug, Clone, Serialize, Deserialize, TS, sqlx::FromRow)]
pub struct GithubIssueLink {
    pub id: Uuid,
    pub project_id: Uuid,
    pub issue_id: Uuid,
    pub repository: String,
    pub number: i32,
    pub url: String,
    pub github_node_id: Option<String>,
    pub project_item_id: Option<String>,
    pub github_state: String,
    pub github_updated_at: Option<DateTime<Utc>>,
    pub last_synced_vibe_updated_at: Option<DateTime<Utc>>,
    pub synced_title: Option<String>,
    pub synced_description: Option<String>,
    pub synced_vibe_status_id: Option<Uuid>,
    pub synced_github_status_option_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct CreateGithubIssueLinkRequest {
    #[ts(optional)]
    pub id: Option<Uuid>,
    pub issue_id: Uuid,
    pub repository: String,
    pub number: i32,
    pub url: String,
    pub github_node_id: Option<String>,
    pub project_item_id: Option<String>,
    pub github_state: String,
    pub github_updated_at: Option<DateTime<Utc>>,
    pub last_synced_vibe_updated_at: Option<DateTime<Utc>>,
    pub synced_title: Option<String>,
    pub synced_description: Option<String>,
    pub synced_vibe_status_id: Option<Uuid>,
    pub synced_github_status_option_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
pub struct UpdateGithubIssueLinkRequest {
    pub project_item_id: Option<String>,
    pub github_state: Option<String>,
    pub github_updated_at: Option<DateTime<Utc>>,
    pub last_synced_vibe_updated_at: Option<DateTime<Utc>>,
    pub synced_title: Option<String>,
    #[serde(
        default,
        deserialize_with = "some_if_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub synced_description: Option<Option<String>>,
    pub synced_vibe_status_id: Option<Uuid>,
    pub synced_github_status_option_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ListGithubIssueLinksResponse {
    pub github_issue_links: Vec<GithubIssueLink>,
}
