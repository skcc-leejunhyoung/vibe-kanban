use std::collections::{HashMap, HashSet};

use api_types::{Issue, IssueRelationshipType};
use uuid::Uuid;

use crate::services::remote_client::{RemoteClient, RemoteClientError};

/// Status names considered "resolved" for blocker-gating purposes. Matched
/// case-insensitively against the project's status names.
const RESOLVED_STATUS_NAMES: &[&str] = &["Done", "In review"];

fn is_resolved_status_name(name: &str) -> bool {
    RESOLVED_STATUS_NAMES
        .iter()
        .any(|candidate| name.eq_ignore_ascii_case(candidate))
}

/// Given a workspace's linked `task_id` (cloud issue id), returns the list of
/// blocker issues that have not yet reached a resolved status. Empty Vec means
/// the workspace can run immediately.
///
/// "Blocker" = an `issue_relationships` row with `type = blocking` and
/// `related_issue_id = task_id`. Resolution is decided by the blocker's
/// `status_id` matching a project status whose name is in
/// [`RESOLVED_STATUS_NAMES`].
pub async fn unresolved_blockers(
    client: &RemoteClient,
    task_id: Uuid,
) -> Result<Vec<Issue>, RemoteClientError> {
    let relationships = client
        .list_issue_relationships_incoming(task_id)
        .await?
        .issue_relationships;

    let blocker_ids: Vec<Uuid> = relationships
        .into_iter()
        .filter(|r| matches!(r.relationship_type, IssueRelationshipType::Blocking))
        .map(|r| r.issue_id)
        .collect();

    if blocker_ids.is_empty() {
        return Ok(Vec::new());
    }

    let mut resolved_by_project: HashMap<Uuid, HashSet<Uuid>> = HashMap::new();
    let mut unresolved = Vec::new();

    for blocker_id in blocker_ids {
        let issue = client.get_issue(blocker_id).await?;

        if !resolved_by_project.contains_key(&issue.project_id) {
            let statuses = client
                .list_project_statuses(issue.project_id)
                .await?
                .project_statuses;
            let set: HashSet<Uuid> = statuses
                .into_iter()
                .filter(|s| is_resolved_status_name(&s.name))
                .map(|s| s.id)
                .collect();
            resolved_by_project.insert(issue.project_id, set);
        }

        let resolved = resolved_by_project
            .get(&issue.project_id)
            .map(|set| set.contains(&issue.status_id))
            .unwrap_or(false);

        if !resolved {
            unresolved.push(issue);
        }
    }

    Ok(unresolved)
}
