use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sqlx::Type;
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, TS, JsonSchema)]
#[sqlx(type_name = "issue_relationship_type", rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum IssueRelationshipType {
    Blocking,
    Related,
    HasDuplicate,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct IssueRelationship {
    pub id: Uuid,
    pub issue_id: Uuid,
    pub related_issue_id: Uuid,
    pub relationship_type: IssueRelationshipType,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct CreateIssueRelationshipRequest {
    /// Optional client-generated ID. If not provided, server generates one.
    /// Using client-generated IDs enables stable optimistic updates.
    #[ts(optional)]
    pub id: Option<Uuid>,
    pub issue_id: Uuid,
    pub related_issue_id: Uuid,
    pub relationship_type: IssueRelationshipType,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IssueRelationshipDirection {
    /// Relationships where the given issue is the source (`issue_id = $1`).
    /// Default; preserves the original API behaviour.
    Outgoing,
    /// Relationships that target the given issue (`related_issue_id = $1`).
    /// Used to find issues that block the given issue.
    Incoming,
    /// Both directions combined.
    Both,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ListIssueRelationshipsQuery {
    pub issue_id: Uuid,
    #[serde(default)]
    pub direction: Option<IssueRelationshipDirection>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ListIssueRelationshipsResponse {
    pub issue_relationships: Vec<IssueRelationship>,
}
