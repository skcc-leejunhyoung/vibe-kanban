use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::Type;
use ts_rs::TS;
use uuid::Uuid;

use crate::{IssuePriority, some_if_present};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, TS)]
#[serde(rename_all = "snake_case")]
#[sqlx(type_name = "notification_type", rename_all = "snake_case")]
pub enum NotificationType {
    IssueCommentAdded,
    IssueStatusChanged,
    IssueAssigneeChanged,
    IssuePriorityChanged,
    IssueUnassigned,
    IssueCommentReaction,
    IssueDeleted,
    IssueTitleChanged,
    IssueDescriptionChanged,
    IssueReviewRequested,
    WorkspaceTaskCompleted,
    PullRequestCommentAdded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum NotificationGroupKind {
    Single,
    IssueChanges,
    StatusChanges,
    Comments,
    Reactions,
    IssueDeleted,
    WorkspaceTask,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, TS)]
#[serde(rename_all = "snake_case")]
#[sqlx(type_name = "text", rename_all = "snake_case")]
pub enum NotificationIntent {
    RawEvent,
    UserReport,
    #[default]
    Legacy,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, TS)]
#[serde(rename_all = "snake_case")]
#[sqlx(type_name = "text", rename_all = "snake_case")]
pub enum NotificationRoutingState {
    #[default]
    User,
    AutopilotPending,
    AutopilotClaimed,
    AutopilotConsumed,
}

impl NotificationRoutingState {
    pub fn is_held(self) -> bool {
        matches!(self, Self::AutopilotPending | Self::AutopilotClaimed)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Notification {
    #[serde(default)]
    pub source_key: Option<String>,
    #[serde(default)]
    pub intent: NotificationIntent,
    #[serde(default)]
    pub routing_state: NotificationRoutingState,
    #[serde(default = "notification_revision")]
    pub revision: i32,
    pub id: Uuid,
    pub organization_id: Uuid,
    pub user_id: Uuid,
    pub notification_type: NotificationType,
    pub payload: NotificationPayload,
    pub issue_id: Option<Uuid>,
    pub comment_id: Option<Uuid>,
    pub seen: bool,
    pub dismissed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
pub struct NotificationPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_only: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_push_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deeplink_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_simple_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_user_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment_preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_status_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_status_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_status_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_status_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_priority: Option<IssuePriority>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_priority: Option<IssuePriority>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignee_user_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<Uuid>,
    /// Whether the sending host's workspace is an Autopilot. Captured at send
    /// time so notification filtering never depends on journal upload order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autopilot: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_id: Option<Uuid>,
    /// A Drawer note this notification points at (opens the Drawer tab).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drawer_note_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pull_request_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pull_request_number: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct CreatePullRequestCommentNotificationRequest {
    pub project_id: Uuid,
    pub pull_request_url: String,
    pub pull_request_number: i32,
    pub pull_request_title: String,
    pub actor_name: String,
    pub comment_preview: Option<String>,
    pub comment_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct UpdateNotificationRequest {
    #[serde(default)]
    #[ts(optional)]
    pub expected_revision: Option<i32>,
    #[serde(default, deserialize_with = "some_if_present")]
    pub seen: Option<bool>,
    #[serde(default, deserialize_with = "some_if_present")]
    pub archived: Option<bool>,
}

fn notification_revision() -> i32 {
    1
}

pub fn notification_body(
    notification_type: NotificationType,
    payload: &NotificationPayload,
) -> String {
    let issue = issue_label(payload);
    match notification_type {
        NotificationType::IssueCommentAdded => format!("{issue}: new comment"),
        NotificationType::IssueStatusChanged => {
            if let Some(status) = payload.new_status_name.as_deref() {
                format!("{issue}: moved to {status}")
            } else {
                format!("{issue}: status changed")
            }
        }
        NotificationType::IssueAssigneeChanged => format!("{issue}: assignee changed"),
        NotificationType::IssuePriorityChanged => format!("{issue}: priority changed"),
        NotificationType::IssueUnassigned => format!("{issue}: unassigned"),
        NotificationType::IssueCommentReaction => {
            if let Some(emoji) = payload.emoji.as_deref() {
                format!("{issue}: reacted with {emoji}")
            } else {
                format!("{issue}: new reaction")
            }
        }
        NotificationType::IssueDeleted => format!("{issue}: issue deleted"),
        NotificationType::IssueTitleChanged => format!("{issue}: title changed"),
        NotificationType::IssueDescriptionChanged => format!("{issue}: description changed"),
        NotificationType::IssueReviewRequested => format!("{issue}: ready for review"),
        NotificationType::WorkspaceTaskCompleted => payload
            .body
            .clone()
            .unwrap_or_else(|| "workspace task completed".to_string()),
        NotificationType::PullRequestCommentAdded => format!(
            "PR #{}: new comment from {}",
            payload.pull_request_number.unwrap_or_default(),
            payload.actor_name.as_deref().unwrap_or("Someone")
        ),
    }
}

fn issue_label(payload: &NotificationPayload) -> String {
    match (
        payload.issue_simple_id.as_deref(),
        payload.issue_title.as_deref(),
    ) {
        (Some(simple_id), Some(title)) => format!("{simple_id} {title}"),
        (Some(simple_id), None) => simple_id.to_string(),
        (None, Some(title)) => title.to_string(),
        (None, None) => "Issue".to_string(),
    }
}
