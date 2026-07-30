use api_types::{CreateWorkspaceRequest, UpsertPullRequestRequest};
use db::models::workspace::Workspace;
use git::GitService;
use sqlx::SqlitePool;
use tracing::{debug, error};
use uuid::Uuid;

use super::{
    diff_stream::{self, DiffStats},
    remote_client::{RemoteClient, RemoteClientError},
};

async fn update_workspace_on_remote(
    client: &RemoteClient,
    workspace_id: Uuid,
    name: Option<Option<String>>,
    archived: Option<bool>,
    stats: Option<&DiffStats>,
) {
    match client
        .update_workspace(
            workspace_id,
            name,
            archived,
            stats.map(|s| s.files_changed as i32),
            stats.map(|s| s.lines_added as i32),
            stats.map(|s| s.lines_removed as i32),
        )
        .await
    {
        Ok(()) => {
            debug!("Synced workspace {} to remote", workspace_id);
        }
        Err(RemoteClientError::Auth) => {
            debug!("Workspace {} sync skipped: not authenticated", workspace_id);
        }
        Err(RemoteClientError::Http { status: 404, .. }) => {
            debug!(
                "Workspace {} disappeared from remote before update, skipping sync",
                workspace_id
            );
        }
        Err(e) => {
            error!("Failed to sync workspace {} to remote: {}", workspace_id, e);
        }
    }
}

/// Syncs workspace data to the remote server.
/// First checks if the workspace exists on remote, then updates if it does.
pub async fn sync_workspace_to_remote(
    client: &RemoteClient,
    workspace_id: Uuid,
    name: Option<Option<String>>,
    archived: Option<bool>,
    stats: Option<&DiffStats>,
) {
    // First check if workspace exists on remote
    match client.workspace_exists(workspace_id).await {
        Ok(false) => {
            debug!(
                "Workspace {} not found on remote, skipping sync",
                workspace_id
            );
            return;
        }
        Err(RemoteClientError::Auth) => {
            debug!("Workspace {} sync skipped: not authenticated", workspace_id);
            return;
        }
        Err(e) => {
            error!(
                "Failed to check workspace {} existence on remote: {}",
                workspace_id, e
            );
            return;
        }
        Ok(true) => {}
    }

    // Workspace exists, proceed with update
    update_workspace_on_remote(client, workspace_id, name, archived, stats).await;
}

/// Syncs issue status to remote for a workspace merged locally without a PR.
pub async fn sync_local_workspace_merge_to_remote(client: &RemoteClient, workspace_id: Uuid) {
    match client
        .sync_issue_status_from_local_workspace_merge(workspace_id)
        .await
    {
        Ok(()) => {
            debug!(
                "Synced local workspace merge status to remote for workspace {}",
                workspace_id
            );
        }
        Err(RemoteClientError::Auth) => {
            debug!(
                "Local workspace merge sync skipped for workspace {}: not authenticated",
                workspace_id
            );
        }
        Err(RemoteClientError::Http { status: 404, .. }) => {
            debug!(
                "Local workspace merge sync skipped for workspace {}: workspace not found on remote",
                workspace_id
            );
        }
        Err(e) => {
            error!(
                "Failed to sync local workspace merge status for workspace {}: {}",
                workspace_id, e
            );
        }
    }
}

async fn upsert_pr_on_remote(client: &RemoteClient, request: UpsertPullRequestRequest) {
    let number = request.number;
    let workspace_id = request.local_workspace_id;

    // Workspace exists, proceed with PR upsert
    match client.upsert_pull_request(request).await {
        Ok(()) => {
            debug!("Synced PR #{} to remote", number);
        }
        Err(RemoteClientError::Auth) => {
            debug!("PR #{} sync skipped: not authenticated", number);
        }
        Err(RemoteClientError::Http { status: 404, .. }) => {
            debug!(
                "PR #{} workspace {} not found on remote, skipping sync",
                number, workspace_id
            );
        }
        Err(e) => {
            error!("Failed to sync PR #{} to remote: {}", number, e);
        }
    }
}

/// Syncs PR data to the remote server.
/// First checks if the workspace exists on remote, then upserts the PR if it does.
pub async fn sync_pr_to_remote(client: &RemoteClient, request: UpsertPullRequestRequest) {
    // First check if workspace exists on remote
    match client.workspace_exists(request.local_workspace_id).await {
        Ok(false) => {
            debug!(
                "PR #{} workspace {} not found on remote, skipping sync",
                request.number, request.local_workspace_id
            );
            return;
        }
        Err(RemoteClientError::Auth) => {
            debug!("PR #{} sync skipped: not authenticated", request.number);
            return;
        }
        Err(e) => {
            error!(
                "Failed to check workspace {} existence on remote: {}",
                request.local_workspace_id, e
            );
            return;
        }
        Ok(true) => {}
    }

    upsert_pr_on_remote(client, request).await;
}

/// Syncs all linked workspaces and their PRs to the remote server.
/// Used after login to catch up on any changes made while logged out.
pub async fn sync_all_linked_workspaces(
    client: &RemoteClient,
    pool: &SqlitePool,
    git: &GitService,
) {
    // Sync workspace stats
    let workspaces = match Workspace::fetch_all(pool).await {
        Ok(ws) => ws,
        Err(e) => {
            error!("Failed to fetch workspaces for post-login sync: {}", e);
            return;
        }
    };

    for workspace in &workspaces {
        sync_or_create_linked_workspace(client, pool, git, workspace).await;
    }

    debug!("Post-login workspace sync completed");
}

/// Reconciles a single workspace's cloud row, creating it if missing.
///
/// The cloud workspace row is normally created by the one-shot "link" call at
/// creation time. If that link never ran or failed (a swallowed frontend error,
/// a transient network failure, or a host-registration race), the workspace is
/// left as a local-only orphan: it carries a `task_id` mirror but has no cloud
/// row, so it never appears on the issue board/panel — regardless of which host
/// it runs on. Backfilling from the local `task_id` here lets those orphans
/// self-heal on the next sync (post-login or after an agent execution).
pub async fn sync_or_create_linked_workspace(
    client: &RemoteClient,
    pool: &SqlitePool,
    git: &GitService,
    workspace: &Workspace,
) {
    match client.workspace_exists(workspace.id).await {
        Ok(true) => {
            let stats = diff_stream::compute_diff_stats(pool, git, workspace).await;
            update_workspace_on_remote(
                client,
                workspace.id,
                workspace.name.clone().map(Some),
                Some(workspace.archived),
                stats.as_ref(),
            )
            .await;
        }
        Ok(false) => match workspace.task_id {
            // Only issue-linked workspaces can be backfilled — the cloud row
            // requires an issue_id (and, via the issue, its project).
            Some(issue_id) => {
                create_linked_workspace_on_remote(client, pool, git, workspace, issue_id).await;
            }
            None => {
                debug!(
                    "Workspace {} not found on remote and not issue-linked, skipping",
                    workspace.id
                );
            }
        },
        Err(RemoteClientError::Auth) => {
            debug!("Workspace {} sync skipped: not authenticated", workspace.id);
        }
        Err(e) => {
            error!(
                "Failed to check workspace {} existence on remote: {}",
                workspace.id, e
            );
        }
    }
}

/// Creates a missing cloud row for a locally issue-linked workspace, resolving
/// the remote project from the linked issue and stamping the current host.
async fn create_linked_workspace_on_remote(
    client: &RemoteClient,
    pool: &SqlitePool,
    git: &GitService,
    workspace: &Workspace,
    issue_id: Uuid,
) {
    // The cloud row is project-scoped; resolve the project from the issue.
    let issue = match client.get_issue(issue_id).await {
        Ok(issue) => issue,
        Err(RemoteClientError::Auth) => return,
        Err(e) => {
            error!(
                "Failed to resolve issue {} while backfilling workspace {}: {}",
                issue_id, workspace.id, e
            );
            return;
        }
    };

    let host_id = match client.current_host_id().await {
        Ok(host_id) => host_id,
        Err(e) => {
            debug!(
                "Skipping workspace {} backfill; this host is not registered: {}",
                workspace.id, e
            );
            return;
        }
    };

    let stats = diff_stream::compute_diff_stats(pool, git, workspace).await;
    match client
        .create_workspace(CreateWorkspaceRequest {
            project_id: issue.project_id,
            host_id,
            local_workspace_id: workspace.id,
            issue_id,
            name: workspace.name.clone(),
            archived: Some(workspace.archived),
            files_changed: stats.as_ref().map(|s| s.files_changed as i32),
            lines_added: stats.as_ref().map(|s| s.lines_added as i32),
            lines_removed: stats.as_ref().map(|s| s.lines_removed as i32),
        })
        .await
    {
        Ok(_) => {
            debug!(
                "Backfilled missing remote workspace row for {} (issue {})",
                workspace.id, issue_id
            );
        }
        // A concurrent link may have created the row first (local_workspace_id
        // is unique) — that's benign, the row exists either way.
        Err(e) => {
            error!(
                "Failed to backfill remote workspace row for {}: {}",
                workspace.id, e
            );
        }
    }
}
