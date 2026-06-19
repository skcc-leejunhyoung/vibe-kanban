//! Backend-side reading/writing of the `vibe-*` cloud tags.
//!
//! The orchestration source of truth is the `vibe_runs` table; these tags only
//! mirror the phase for human visibility in the issue tracker. Writes are
//! therefore best-effort. `vibe-*` tags are not seeded by default, so a missing
//! tag is auto-created on first use.

use api_types::{CreateIssueTagRequest, CreateTagRequest, Tag};
use uuid::Uuid;

use crate::services::remote_client::{RemoteClient, RemoteClientError};

/// Color for auto-created `vibe-*` tags (a neutral slate).
const VIBE_TAG_COLOR: &str = "#64748b";

/// Find a tag id by case-insensitive name. Pure.
pub fn find_tag_id_by_name(tags: &[Tag], name: &str) -> Option<Uuid> {
    tags.iter()
        .find(|t| t.name.eq_ignore_ascii_case(name))
        .map(|t| t.id)
}

/// Returns whether `issue_id` currently carries a tag named `name`
/// (case-insensitive). Used as the spawn-time gate for the vibe workflow.
pub async fn has_issue_tag_named(
    client: &RemoteClient,
    issue_id: Uuid,
    name: &str,
) -> Result<bool, RemoteClientError> {
    let issue = client.get_issue(issue_id).await?;
    let tags = client.list_tags(issue.project_id).await?.tags;
    let Some(tag_id) = find_tag_id_by_name(&tags, name) else {
        return Ok(false);
    };
    Ok(client
        .list_issue_tags(issue_id)
        .await?
        .issue_tags
        .iter()
        .any(|it| it.tag_id == tag_id))
}

/// Resolve the tag id for `name` within `project_id`, creating the tag if it
/// does not exist yet.
pub async fn ensure_tag_id(
    client: &RemoteClient,
    project_id: Uuid,
    name: &str,
) -> Result<Uuid, RemoteClientError> {
    let tags = client.list_tags(project_id).await?.tags;
    if let Some(id) = find_tag_id_by_name(&tags, name) {
        return Ok(id);
    }
    let created = client
        .create_tag(&CreateTagRequest {
            id: None,
            project_id,
            name: name.to_string(),
            color: VIBE_TAG_COLOR.to_string(),
        })
        .await?;
    Ok(created.data.id)
}

/// Attach the tag named `name` to `issue_id` (idempotent). The project is
/// resolved from the issue; the tag is created if missing.
pub async fn add_issue_tag_by_name(
    client: &RemoteClient,
    issue_id: Uuid,
    name: &str,
) -> Result<(), RemoteClientError> {
    let issue = client.get_issue(issue_id).await?;
    let tag_id = ensure_tag_id(client, issue.project_id, name).await?;

    let already_attached = client
        .list_issue_tags(issue_id)
        .await?
        .issue_tags
        .iter()
        .any(|it| it.tag_id == tag_id);
    if already_attached {
        return Ok(());
    }

    client
        .create_issue_tag(&CreateIssueTagRequest {
            id: None,
            issue_id,
            tag_id,
        })
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tag(name: &str) -> Tag {
        Tag {
            id: Uuid::new_v4(),
            project_id: Uuid::nil(),
            name: name.to_string(),
            color: "#000000".to_string(),
        }
    }

    #[test]
    fn finds_tag_by_exact_name() {
        let tags = vec![tag("vibe"), tag("vibe-done"), tag("bug")];
        let want = tags[1].id;
        assert_eq!(find_tag_id_by_name(&tags, "vibe-done"), Some(want));
    }

    #[test]
    fn matches_case_insensitively() {
        let tags = vec![tag("Vibe-Approve")];
        let want = tags[0].id;
        assert_eq!(find_tag_id_by_name(&tags, "vibe-approve"), Some(want));
    }

    #[test]
    fn returns_none_when_absent() {
        let tags = vec![tag("vibe"), tag("feature")];
        assert_eq!(find_tag_id_by_name(&tags, "vibe-block"), None);
    }

    #[test]
    fn empty_list_is_none() {
        assert_eq!(find_tag_id_by_name(&[], "vibe"), None);
    }
}
