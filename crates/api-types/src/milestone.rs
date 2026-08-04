use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::some_if_present;

#[derive(Debug, Clone, Serialize, Deserialize, TS, sqlx::FromRow)]
pub struct ProjectMilestone {
    pub id: Uuid,
    pub project_id: Uuid,
    pub name: String,
    pub start_date: Option<DateTime<Utc>>,
    pub target_date: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub source_repository: Option<String>,
    pub source_number: Option<i32>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct CreateProjectMilestoneRequest {
    #[ts(optional)]
    pub id: Option<Uuid>,
    pub project_id: Uuid,
    pub name: String,
    pub start_date: Option<DateTime<Utc>>,
    pub target_date: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub source_repository: Option<String>,
    pub source_number: Option<i32>,
}

#[derive(Debug, Clone, Default, Deserialize, TS)]
pub struct UpdateProjectMilestoneRequest {
    #[serde(default, deserialize_with = "some_if_present")]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "some_if_present")]
    pub start_date: Option<Option<DateTime<Utc>>>,
    #[serde(default, deserialize_with = "some_if_present")]
    pub target_date: Option<Option<DateTime<Utc>>>,
    #[serde(default, deserialize_with = "some_if_present")]
    pub completed_at: Option<Option<DateTime<Utc>>>,
    #[serde(default, deserialize_with = "some_if_present")]
    pub source_repository: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_if_present")]
    pub source_number: Option<Option<i32>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, sqlx::FromRow)]
pub struct IssueMilestone {
    pub id: Uuid,
    pub project_id: Uuid,
    pub issue_id: Uuid,
    pub milestone_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct CreateIssueMilestoneRequest {
    #[ts(optional)]
    pub id: Option<Uuid>,
    pub issue_id: Uuid,
    pub milestone_id: Uuid,
}
