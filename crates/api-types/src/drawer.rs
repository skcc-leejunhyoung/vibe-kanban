//! The Drawer: notes the Autopilot writes for its user (title + markdown
//! body), which the user reads, comments on and archives. The Autopilot
//! creates, edits, deletes and archives notes; the user only comments,
//! marks seen and archives/restores. Archived notes are pruned after 90 days.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::some_if_present;

#[derive(Debug, Clone, Serialize, Deserialize, TS, sqlx::FromRow)]
pub struct DrawerNote {
    pub id: Uuid,
    pub owner_user_id: Uuid,
    /// Host whose Autopilot wrote the note (artifacts in the body live there).
    pub host_id: Option<Uuid>,
    pub workspace_id: Option<Uuid>,
    pub session_id: Option<Uuid>,
    /// Execution whose artifact manifest resolves `vibe-artifact` links in the body.
    pub execution_id: Option<Uuid>,
    pub title: String,
    /// Markdown; `[Title](path "vibe-artifact")` lines render as artifact tiles.
    pub body: String,
    /// Optional status chip set by the Autopilot (e.g. "확인 필요").
    pub label: Option<String>,
    pub pinned: bool,
    pub archived_at: Option<DateTime<Utc>>,
    /// When the user last opened the note; unread = older than the last change or comment.
    pub user_seen_at: Option<DateTime<Utc>>,
    pub last_comment_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum DrawerCommentAuthor {
    User,
    Autopilot,
}

impl DrawerCommentAuthor {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Autopilot => "autopilot",
        }
    }

    pub fn parse(value: &str) -> Self {
        if value == "autopilot" {
            Self::Autopilot
        } else {
            Self::User
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct DrawerComment {
    pub id: Uuid,
    pub note_id: Uuid,
    pub owner_user_id: Uuid,
    pub author: DrawerCommentAuthor,
    pub body: String,
    pub created_at: DateTime<Utc>,
    /// Set once handled (by either side); consecutive resolved comments fold
    /// into one line in the thread. `null` = open.
    pub resolved_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct CreateDrawerNoteRequest {
    /// Optional client-generated id for stable optimistic updates.
    #[ts(optional)]
    pub id: Option<Uuid>,
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[ts(optional)]
    pub label: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub pinned: Option<bool>,
    #[ts(optional)]
    pub host_id: Option<Uuid>,
    #[ts(optional)]
    pub workspace_id: Option<Uuid>,
    #[ts(optional)]
    pub session_id: Option<Uuid>,
    #[ts(optional)]
    pub execution_id: Option<Uuid>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
pub struct UpdateDrawerNoteRequest {
    #[serde(default, deserialize_with = "some_if_present")]
    #[ts(optional)]
    pub title: Option<String>,
    #[serde(default, deserialize_with = "some_if_present")]
    #[ts(optional)]
    pub body: Option<String>,
    /// `null` clears the label.
    #[serde(default, deserialize_with = "some_if_present")]
    #[ts(optional)]
    pub label: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_if_present")]
    #[ts(optional)]
    pub pinned: Option<bool>,
    /// Moves the note to (true) or back from (false) the archive.
    #[serde(default, deserialize_with = "some_if_present")]
    #[ts(optional)]
    pub archived: Option<bool>,
    /// `true` records that the user has read the note now.
    #[serde(default, deserialize_with = "some_if_present")]
    #[ts(optional)]
    pub seen: Option<bool>,
    /// Updating the body from a new turn moves the artifact scope along.
    #[serde(default, deserialize_with = "some_if_present")]
    #[ts(optional)]
    pub host_id: Option<Uuid>,
    #[serde(default, deserialize_with = "some_if_present")]
    #[ts(optional)]
    pub workspace_id: Option<Uuid>,
    #[serde(default, deserialize_with = "some_if_present")]
    #[ts(optional)]
    pub session_id: Option<Uuid>,
    #[serde(default, deserialize_with = "some_if_present")]
    #[ts(optional)]
    pub execution_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct CreateDrawerCommentRequest {
    #[ts(optional)]
    pub id: Option<Uuid>,
    pub note_id: Uuid,
    pub body: String,
    /// Defaults to `user`; the Autopilot's CLI sends `autopilot`.
    #[ts(optional)]
    pub author: Option<DrawerCommentAuthor>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
pub struct UpdateDrawerCommentRequest {
    /// `true` folds the comment into the resolved group (the first resolve
    /// time is kept), `false` reopens it.
    #[serde(default, deserialize_with = "some_if_present")]
    pub resolved: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct ListDrawerNotesQuery {
    /// `true` = archived only, `false` = inbox only, absent = both.
    #[ts(optional)]
    pub archived: Option<bool>,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct ListDrawerNotesResponse {
    pub drawer_notes: Vec<DrawerNote>,
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct ListDrawerCommentsQuery {
    #[ts(optional)]
    pub note_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct ListDrawerCommentsResponse {
    pub drawer_comments: Vec<DrawerComment>,
}
