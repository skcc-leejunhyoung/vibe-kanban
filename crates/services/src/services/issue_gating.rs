use std::collections::{HashMap, HashSet};

use api_types::{Issue, IssueRelationshipType, PullRequestStatus};
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

        if let std::collections::hash_map::Entry::Vacant(e) =
            resolved_by_project.entry(issue.project_id)
        {
            let statuses = client
                .list_project_statuses(issue.project_id)
                .await?
                .project_statuses;
            let set: HashSet<Uuid> = statuses
                .into_iter()
                .filter(|s| is_resolved_status_name(&s.name))
                .map(|s| s.id)
                .collect();
            e.insert(set);
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

/// Collects the `merge_commit_sha` of every merged PR linked to any blocker of
/// `task_id`. Used by the watcher to verify that the actual commits have landed
/// in `origin/<base>` before resuming the deferred spawn — guards against the
/// race where the blocker's issue status flips to resolved (e.g. on PR-close
/// webhook) before GitHub has finished pushing the merge commit, or against a
/// user manually flipping status without merging.
///
/// Returns the (sometimes empty) list of merge commit shas. A blocker without
/// any merged PR contributes no shas; callers should treat an empty result as
/// "nothing to verify" and proceed.
pub async fn blocker_merge_commit_shas(
    client: &RemoteClient,
    task_id: Uuid,
) -> Result<Vec<String>, RemoteClientError> {
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

    let mut shas = Vec::new();
    for blocker_id in blocker_ids {
        let prs = client.list_pull_requests(blocker_id).await?.pull_requests;
        for pr in prs {
            if matches!(pr.status, PullRequestStatus::Merged)
                && let Some(sha) = pr.merge_commit_sha
                && !sha.is_empty()
            {
                shas.push(sha);
            }
        }
    }
    Ok(shas)
}
