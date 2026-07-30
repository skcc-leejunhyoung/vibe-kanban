use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use axum::{
    Extension, Json, Router,
    extract::{Query, State},
    response::{IntoResponse, Json as ResponseJson},
    routing::{get, post},
};
use db::models::{
    merge::{Merge, MergeStatus, PrMerge, PullRequestInfo},
    pull_request::PullRequest,
    repo::{Repo, RepoError},
    workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
use deployment::Deployment;
use git::{ConflictOp, GitCliError, GitServiceError, PullOutcome};
use serde::{Deserialize, Serialize};
use services::services::{container::ContainerService, diff_stream, remote_sync};
use ts_rs::TS;
use utils::{diff::Diff, response::ApiResponse};
use uuid::Uuid;

use super::streams::{DiffStreamQuery, stream_workspace_diff_sse, stream_workspace_diff_ws};
use crate::{
    DeploymentImpl,
    error::ApiError,
    middleware::signed_ws::SignedWsUpgrade,
    routes::repo::{resolve_primary_remote, resolve_primary_remote_with},
};

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct RebaseWorkspaceRequest {
    pub repo_id: Uuid,
    pub old_base_branch: Option<String>,
    pub new_base_branch: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct AbortConflictsRequest {
    pub repo_id: Uuid,
}

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct ContinueRebaseRequest {
    pub repo_id: Uuid,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum GitOperationError {
    MergeConflicts {
        message: String,
        op: ConflictOp,
        conflicted_files: Vec<String>,
        target_branch: String,
    },
    RebaseInProgress,
}

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct MergeWorkspaceRequest {
    pub repo_id: Uuid,
}

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct CommitWorkspaceRequest {
    pub repo_id: Uuid,
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct CommitWorkspaceResponse {
    /// Whether a new commit was created. `false` means the worktree was clean
    /// (nothing to commit) — not an error.
    pub committed: bool,
}

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct PushWorkspaceRequest {
    pub repo_id: Uuid,
}

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct PullWorkspaceRequest {
    pub repo_id: Uuid,
}

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct ResetWorkspaceToRemoteRequest {
    pub repo_id: Uuid,
    pub confirm_discard: bool,
}

/// Outcome of fast-forwarding the work branch to its own remote. `diverged` is
/// not an error — it tells the UI a fast-forward was impossible (the remote was
/// left untouched) so it can offer rebase / update-from-base instead.
#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum PullWorkspaceResponse {
    UpToDate,
    FastForwarded { commits: usize },
    Diverged { ahead: usize, behind: usize },
}

/// How to bring the target (base) branch into the work branch.
#[derive(Debug, Deserialize, Serialize, TS, Clone, Copy)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum UpdateFromBaseStrategy {
    /// Merge the base into the work branch (preserves history; safe on shared
    /// PR branches).
    Merge,
    /// Rebase the work branch onto the base (rewrites history; requires a
    /// force-push afterwards).
    Rebase,
}

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct UpdateFromBaseRequest {
    pub repo_id: Uuid,
    pub strategy: UpdateFromBaseStrategy,
}

/// Merge a selected base branch into the workspace's target branch.
#[derive(Debug, Deserialize, Serialize, TS)]
pub struct UpdateTargetBranchFromBaseRequest {
    pub repo_id: Uuid,
    pub base_branch: String,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum PushError {
    /// A regular push was rejected and the recovery couldn't fast-forward, but
    /// the local branch is not behind the remote — the only case where a force
    /// push is the appropriate remedy (e.g. after an intentional history rewrite).
    ForcePushRequired,
    /// The branch has diverged: the remote holds `behind` commit(s) the local
    /// branch is missing (and the local is `ahead` by its own commits). A force
    /// push would discard the remote commits, so the UI must offer to pull/merge
    /// them first instead.
    Diverged { ahead: usize, behind: usize },
}

/// Which repo of the workspace a target-branch remote operation applies to.
#[derive(Debug, Deserialize, TS)]
pub struct TargetBranchRepoQuery {
    pub repo_id: Uuid,
}

#[derive(Debug, Default, Deserialize, TS)]
pub struct FetchTargetBranchRequest {
    pub repo_id: Uuid,
}

#[derive(Debug, Default, Deserialize, TS)]
pub struct PushTargetBranchRequest {
    pub repo_id: Uuid,
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Default, Deserialize, TS)]
pub struct PullTargetBranchRequest {
    pub repo_id: Uuid,
}

/// Status of a workspace repo's target (base) branch relative to the repo's
/// primary remote (origin). Drives the target-branch fetch/push buttons.
#[derive(Debug, Serialize, TS)]
pub struct TargetBranchRemoteStatus {
    /// The workspace repo's target (base) branch.
    pub target_branch: String,
    /// Resolved remote name (the repo's primary remote, or the git default
    /// remote when none is set). `None` when the repo has no remotes.
    pub remote: Option<String>,
    /// Whether the repo has any remote configured at all.
    pub remote_configured: bool,
    /// True when the target branch is itself a remote-only branch (e.g.
    /// `origin/main` with no local branch). Fetch/push to the remote don't
    /// apply in that case.
    pub is_target_remote: bool,
    /// Whether `<remote>/<target_branch>` exists locally as a tracking ref.
    pub remote_branch_exists: bool,
    /// Commits the local target branch is ahead of the remote (can be pushed).
    pub ahead: u32,
    /// Commits the local target branch is behind the remote (can be fetched).
    pub behind: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct BranchStatus {
    pub commits_behind: Option<usize>,
    pub commits_ahead: Option<usize>,
    pub has_uncommitted_changes: Option<bool>,
    pub head_oid: Option<String>,
    pub uncommitted_count: Option<usize>,
    pub untracked_count: Option<usize>,
    pub target_branch_name: String,
    pub remote_commits_behind: Option<usize>,
    pub remote_commits_ahead: Option<usize>,
    /// Commits the local target (base) branch is ahead of its counterpart on the
    /// repo's primary remote — i.e. commits that can be pushed to origin. `None`
    /// when the target is a remote-only branch or the repo has no remote.
    pub target_remote_commits_ahead: Option<usize>,
    /// Commits the local target (base) branch is behind the remote.
    pub target_remote_commits_behind: Option<usize>,
    /// Whether the work branch has a counterpart on the repo's primary remote
    /// (a local `refs/remotes/<remote>/<branch>` ref exists). Independent of any
    /// open PR. Drives the "Pull" button: pull fast-forwards the work branch from
    /// origin, so it is only meaningful when this is true. Local-only work
    /// branches (e.g. vk/* worktrees never pushed) are false.
    pub work_branch_has_remote: bool,
    pub merges: Vec<Merge>,
    pub is_rebase_in_progress: bool,
    pub conflict_op: Option<ConflictOp>,
    pub conflicted_files: Vec<String>,
    pub is_target_remote: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct RepoBranchStatus {
    pub repo_id: Uuid,
    pub repo_name: String,
    /// True when the source repository no longer exists on disk (e.g. the project
    /// folder was moved or deleted). Git-derived fields are left empty in this case.
    pub repo_missing: bool,
    #[serde(flatten)]
    pub status: BranchStatus,
}

/// A single commit added by a workspace branch on top of its base branch,
/// across one of the workspace's repos.
#[derive(Debug, Clone, Serialize, TS)]
pub struct WorkspaceCommit {
    pub repo_id: Uuid,
    pub repo_name: String,
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
    pub description: String,
    pub author: String,
    /// RFC 3339 timestamp (UTC).
    pub committed_at: String,
}

#[derive(Debug, Deserialize, TS)]
pub struct CommitDiffQuery {
    pub repo_id: Uuid,
    pub sha: String,
}

#[derive(Deserialize, Debug, TS)]
pub struct ChangeTargetBranchRequest {
    pub repo_id: Uuid,
    pub new_target_branch: String,
}

#[derive(Serialize, Debug, TS)]
pub struct ChangeTargetBranchResponse {
    pub repo_id: Uuid,
    pub new_target_branch: String,
    pub status: (usize, usize),
}

#[derive(Deserialize, Debug, TS)]
pub struct RenameBranchRequest {
    pub new_branch_name: String,
}

#[derive(Serialize, Debug, TS)]
pub struct RenameBranchResponse {
    pub branch: String,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum RenameBranchError {
    EmptyBranchName,
    InvalidBranchNameFormat,
    OpenPullRequest,
    BranchAlreadyExists { repo_name: String },
    RebaseInProgress { repo_name: String },
    RenameFailed { repo_name: String, message: String },
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/status", get(get_workspace_branch_status))
        .route("/diff/ws", get(stream_diff_ws))
        .route("/diff/sse", get(stream_diff_sse))
        .route("/commits", get(list_workspace_commits))
        .route("/commit-diff", get(get_workspace_commit_diff))
        .route("/merge", post(merge_workspace))
        .route("/commit", post(commit_workspace))
        .route("/push", post(push_workspace_branch))
        .route("/push/force", post(force_push_workspace_branch))
        .route("/pull-and-push", post(pull_and_push_workspace_branch))
        .route("/merge-remote", post(merge_remote_workspace_branch))
        .route("/reset-to-remote", post(reset_workspace_branch_to_remote))
        .route("/pull", post(pull_workspace_branch_from_remote))
        .route("/update-from-base", post(update_workspace_from_base))
        .route("/rebase", post(rebase_workspace))
        .route("/rebase/continue", post(continue_workspace_rebase))
        .route("/conflicts/abort", post(abort_workspace_conflicts))
        .route("/target-branch", axum::routing::put(change_target_branch))
        .route(
            "/target-branch/remote-status",
            get(get_target_branch_remote_status),
        )
        .route("/target-branch/fetch", post(fetch_target_branch))
        .route(
            "/target-branch/update-from-base",
            post(update_target_branch_from_base),
        )
        .route("/target-branch/push", post(push_target_branch))
        .route(
            "/target-branch/pull-and-push",
            post(pull_and_push_target_branch),
        )
        .route("/target-branch/pull", post(pull_target_branch))
        .route("/branch", axum::routing::put(rename_branch))
}

#[axum::debug_handler]
pub async fn stream_diff_ws(
    ws: SignedWsUpgrade,
    query: axum::extract::Query<DiffStreamQuery>,
    workspace: Extension<Workspace>,
    deployment: State<DeploymentImpl>,
) -> impl IntoResponse {
    stream_workspace_diff_ws(ws, query, workspace, deployment).await
}

pub async fn stream_diff_sse(
    query: axum::extract::Query<DiffStreamQuery>,
    workspace: Extension<Workspace>,
    deployment: State<DeploymentImpl>,
) -> impl IntoResponse {
    stream_workspace_diff_sse(query, workspace, deployment).await
}

/// Upper bound on how many added commits we surface per repo. Workspaces are
/// short-lived branches, so this is generous; it just guards pathological cases.
const COMMIT_LIST_LIMIT: usize = 200;

/// List the commits each repo's workspace branch added on top of its target
/// branch, newest first across all repos.
#[axum::debug_handler]
pub async fn list_workspace_commits(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<Vec<WorkspaceCommit>>>, ApiError> {
    let pool = &deployment.db().pool;

    let repositories = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let workspace_repos = WorkspaceRepo::find_by_workspace_id(pool, workspace.id).await?;
    let target_branches: HashMap<_, _> = workspace_repos
        .iter()
        .map(|wr| (wr.repo_id, wr.target_branch.clone()))
        .collect();

    let mut commits: Vec<WorkspaceCommit> = Vec::new();
    for repo in repositories {
        // Skip repos whose source folder is gone (mirrors get_workspace_branch_status).
        if !deployment.git().is_repo_openable(&repo.path) {
            continue;
        }
        let Some(target_branch) = target_branches.get(&repo.id) else {
            continue;
        };

        match deployment.git().list_commits(
            &repo.path,
            &workspace.branch,
            target_branch,
            COMMIT_LIST_LIMIT,
        ) {
            Ok(list) => {
                for c in list {
                    commits.push(WorkspaceCommit {
                        repo_id: repo.id,
                        repo_name: repo.name.clone(),
                        sha: c.sha,
                        short_sha: c.short_sha,
                        subject: c.subject,
                        description: c.description,
                        author: c.author,
                        committed_at: c.committed_at,
                    });
                }
            }
            Err(e) => {
                tracing::warn!("Failed to list commits for repo {}: {}", repo.name, e);
            }
        }
    }

    // RFC 3339 UTC timestamps sort lexicographically in chronological order.
    commits.sort_by(|a, b| b.committed_at.cmp(&a.committed_at));

    Ok(ResponseJson(ApiResponse::success(commits)))
}

/// Return the diffs introduced by a single commit, shaped identically to the
/// live diff stream (repo-name-prefixed paths, repo id tagged) so the existing
/// Changes UI can render them without special-casing.
#[axum::debug_handler]
pub async fn get_workspace_commit_diff(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<CommitDiffQuery>,
) -> Result<ResponseJson<ApiResponse<Vec<Diff>>>, ApiError> {
    let pool = &deployment.db().pool;

    // Ensure the requested repo actually belongs to this workspace.
    let workspace_repo =
        WorkspaceRepo::find_by_workspace_and_repo_id(pool, workspace.id, query.repo_id)
            .await?
            .ok_or(RepoError::NotFound)?;
    let repo = Repo::find_by_id(pool, workspace_repo.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    let is_workspace_commit = deployment
        .git()
        .list_commits(
            &repo.path,
            &workspace.branch,
            &workspace_repo.target_branch,
            COMMIT_LIST_LIMIT,
        )?
        .iter()
        .any(|commit| commit.sha == query.sha);
    if !is_workspace_commit {
        return Err(RepoError::NotFound.into());
    }

    let mut diffs = deployment.git().get_commit_diffs(&repo.path, &query.sha)?;
    for diff in &mut diffs {
        if let Some(old) = diff.old_path.take() {
            diff.old_path = Some(format!("{}/{}", repo.name, old));
        }
        if let Some(new) = diff.new_path.take() {
            diff.new_path = Some(format!("{}/{}", repo.name, new));
        }
        diff.repo_id = Some(repo.id);
    }

    Ok(ResponseJson(ApiResponse::success(diffs)))
}

#[axum::debug_handler]
pub async fn merge_workspace(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<MergeWorkspaceRequest>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    let pool = &deployment.db().pool;

    let workspace_repo =
        WorkspaceRepo::find_by_workspace_and_repo_id(pool, workspace.id, request.repo_id)
            .await?
            .ok_or(RepoError::NotFound)?;

    let repo = Repo::find_by_id(pool, workspace_repo.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    let merges = Merge::find_by_workspace_and_repo_id(pool, workspace.id, request.repo_id).await?;
    // Only block a direct merge when an open PR originates from THIS work branch.
    // A PR opened from an intermediate feature branch (head != workspace.branch,
    // e.g. feature -> develop in a three-branch flow) must not block continued
    // work-branch -> feature merges. A NULL head means the legacy default
    // (workspace.branch).
    let has_open_pr_from_work_branch = merges.iter().any(|m| {
        matches!(m, Merge::Pr(pr)
            if matches!(pr.pr_info.status, MergeStatus::Open)
                && pr.head_branch_name.as_deref().unwrap_or(workspace.branch.as_str())
                    == workspace.branch)
    });
    if has_open_pr_from_work_branch {
        return Err(ApiError::BadRequest(
            "Cannot merge directly when a pull request is open for this branch.".to_string(),
        ));
    }

    // If the target is a remote-only branch, materialize a local branch from it
    // (tracking the remote) and merge into that instead of blocking the merge.
    let is_target_remote = deployment
        .git()
        .is_remote_branch(&repo.path, &workspace_repo.target_branch)?;
    let target_branch = if is_target_remote {
        deployment
            .git()
            .ensure_local_branch_for_remote(&repo.path, &workspace_repo.target_branch)?
    } else {
        workspace_repo.target_branch.clone()
    };

    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let workspace_path = Path::new(&container_ref);
    let worktree_path = workspace_path.join(repo.name);

    let merge_commit_id = deployment.git().merge_changes(
        &repo.path,
        &worktree_path,
        &workspace.branch,
        &target_branch,
    )?;

    // Persist the materialized local target only after the merge succeeds, so a
    // failed merge (diverged base, dirty worktree, ff-only rejection) doesn't
    // silently rewrite the recorded target branch.
    if is_target_remote {
        WorkspaceRepo::update_target_branch(pool, workspace.id, request.repo_id, &target_branch)
            .await?;
    }

    Merge::create_direct(
        pool,
        workspace.id,
        workspace_repo.repo_id,
        &target_branch,
        &merge_commit_id,
    )
    .await?;

    if let Ok(client) = deployment.remote_client() {
        let workspace_id = workspace.id;
        tokio::spawn(async move {
            remote_sync::sync_local_workspace_merge_to_remote(&client, workspace_id).await;
        });
    }

    Ok(ResponseJson(ApiResponse::success(())))
}

/// Commit all currently-uncommitted changes in the selected repo's worktree to
/// the task branch, reusing the same git plumbing as the coding-agent
/// auto-commit path (`GitService::commit` stages everything and skips when the
/// worktree is clean). This is the reliable way to capture work left behind by
/// headed (interactive) sessions, which do not auto-commit per turn.
#[axum::debug_handler]
pub async fn commit_workspace(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<CommitWorkspaceRequest>,
) -> Result<ResponseJson<ApiResponse<CommitWorkspaceResponse>>, ApiError> {
    let pool = &deployment.db().pool;

    let workspace_repo =
        WorkspaceRepo::find_by_workspace_and_repo_id(pool, workspace.id, request.repo_id)
            .await?
            .ok_or(RepoError::NotFound)?;

    let repo = Repo::find_by_id(pool, workspace_repo.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let workspace_path = Path::new(&container_ref);
    // In-place ("quick chat") workspaces run in the repo root itself, so the
    // worktree path IS `container_ref` rather than a per-repo subdir.
    let worktree_path = if workspace.in_place {
        PathBuf::from(&container_ref)
    } else {
        workspace_path.join(&repo.name)
    };

    // Refuse to commit while the worktree is mid-rebase or has unresolved
    // conflicts — committing there would capture a half-resolved state.
    if deployment
        .git()
        .is_rebase_in_progress(&worktree_path)
        .unwrap_or(false)
    {
        return Err(ApiError::BadRequest(
            "Cannot commit while a rebase is in progress.".to_string(),
        ));
    }
    if !deployment
        .git()
        .get_conflicted_files(&worktree_path)
        .unwrap_or_default()
        .is_empty()
    {
        return Err(ApiError::BadRequest(
            "Cannot commit while there are unresolved conflicts.".to_string(),
        ));
    }

    let workspace_label = workspace.name.as_deref().unwrap_or(&workspace.branch);
    let commit_message = format!("Commit uncommitted changes for {workspace_label}");

    let committed = deployment.git().commit(&worktree_path, &commit_message)?;

    if committed {
        if let Ok(client) = deployment.remote_client() {
            let pool = deployment.db().pool.clone();
            let git = deployment.git().clone();
            let mut ws = workspace.clone();
            ws.container_ref = Some(container_ref.clone());
            tokio::spawn(async move {
                let stats = diff_stream::compute_diff_stats(&pool, &git, &ws).await;
                remote_sync::sync_workspace_to_remote(&client, ws.id, None, None, stats.as_ref())
                    .await;
            });
        }
    }

    Ok(ResponseJson(ApiResponse::success(
        CommitWorkspaceResponse { committed },
    )))
}

pub async fn push_workspace_branch(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<PushWorkspaceRequest>,
) -> Result<ResponseJson<ApiResponse<(), PushError>>, ApiError> {
    let pool = &deployment.db().pool;

    let workspace_repo =
        WorkspaceRepo::find_by_workspace_and_repo_id(pool, workspace.id, request.repo_id)
            .await?
            .ok_or(RepoError::NotFound)?;

    let repo = Repo::find_by_id(pool, workspace_repo.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let workspace_path = Path::new(&container_ref);
    // In-place ("quick chat") workspaces run in the repo root itself, so the
    // worktree path IS `container_ref` rather than a per-repo subdir.
    let worktree_path = if workspace.in_place {
        PathBuf::from(&container_ref)
    } else {
        workspace_path.join(&repo.name)
    };

    let no_verify = deployment.config().read().await.git_push_no_verify;
    match deployment
        .git()
        .push_to_remote(&worktree_path, &workspace.branch, false, no_verify)
    {
        Ok(_) => {
            if let Ok(client) = deployment.remote_client() {
                let pool = deployment.db().pool.clone();
                let git = deployment.git().clone();
                let mut ws = workspace.clone();
                ws.container_ref = Some(container_ref.clone());
                tokio::spawn(async move {
                    let stats = diff_stream::compute_diff_stats(&pool, &git, &ws).await;
                    remote_sync::sync_workspace_to_remote(
                        &client,
                        ws.id,
                        None,
                        None,
                        stats.as_ref(),
                    )
                    .await;
                });
            }
            Ok(ResponseJson(ApiResponse::success(())))
        }
        Err(GitServiceError::PushDiverged { ahead, behind }) => Ok(ResponseJson(
            ApiResponse::error_with_data(PushError::Diverged { ahead, behind }),
        )),
        Err(GitServiceError::GitCLI(GitCliError::PushRejected(_))) => Ok(ResponseJson(
            ApiResponse::error_with_data(PushError::ForcePushRequired),
        )),
        Err(e) => Err(ApiError::GitService(e)),
    }
}

pub async fn force_push_workspace_branch(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<PushWorkspaceRequest>,
) -> Result<ResponseJson<ApiResponse<(), PushError>>, ApiError> {
    // SAFETY: in-place ("quick chat") workspaces run on the user's actual branch;
    // a force-push would rewrite the remote history of their real branch.
    if workspace.in_place {
        return Err(ApiError::BadRequest(
            "Force-push isn't available for quick chats — they run on your existing branch."
                .to_string(),
        ));
    }

    let pool = &deployment.db().pool;

    let workspace_repo =
        WorkspaceRepo::find_by_workspace_and_repo_id(pool, workspace.id, request.repo_id)
            .await?
            .ok_or(RepoError::NotFound)?;

    let repo = Repo::find_by_id(pool, workspace_repo.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let workspace_path = Path::new(&container_ref);
    let worktree_path = workspace_path.join(&repo.name);

    let no_verify = deployment.config().read().await.git_push_no_verify;
    deployment
        .git()
        .push_to_remote(&worktree_path, &workspace.branch, true, no_verify)?;

    if let Ok(client) = deployment.remote_client() {
        let pool = deployment.db().pool.clone();
        let git = deployment.git().clone();
        let mut ws = workspace.clone();
        ws.container_ref = Some(container_ref.clone());
        tokio::spawn(async move {
            let stats = diff_stream::compute_diff_stats(&pool, &git, &ws).await;
            remote_sync::sync_workspace_to_remote(&client, ws.id, None, None, stats.as_ref()).await;
        });
    }

    Ok(ResponseJson(ApiResponse::success(())))
}

/// Integrate the work branch's diverged remote (fetch + merge) and then push —
/// the safe, non-destructive resolution offered when a regular push is rejected
/// because the branch diverged. Unlike a force push it never discards the remote
/// commits. Merge conflicts surface as a typed `GitOperationError` so the
/// existing conflict-resolution UI lights up, identical to update-from-base.
#[axum::debug_handler]
pub async fn pull_and_push_workspace_branch(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<PushWorkspaceRequest>,
) -> Result<ResponseJson<ApiResponse<(), GitOperationError>>, ApiError> {
    let pool = &deployment.db().pool;

    let workspace_repo =
        WorkspaceRepo::find_by_workspace_and_repo_id(pool, workspace.id, request.repo_id)
            .await?
            .ok_or(RepoError::NotFound)?;

    let repo = Repo::find_by_id(pool, workspace_repo.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    // In-place ("quick chat") workspaces run in the repo root itself, so the
    // worktree path IS `container_ref` rather than a per-repo subdir. A pull is a
    // normal, non-destructive merge, so — unlike force-push — it is allowed here.
    let worktree_path = if workspace.in_place {
        PathBuf::from(&container_ref)
    } else {
        Path::new(&container_ref).join(&repo.name)
    };

    // 1. Fetch + merge the branch's own remote into the local branch. On
    //    conflicts the worktree is left mid-merge; surface them as typed data so
    //    the conflict UI takes over (the user resolves, commits, then pushes).
    if let Err(e) = deployment
        .git()
        .merge_remote_into_workspace_branch(&worktree_path, &workspace.branch)
    {
        return match e {
            GitServiceError::MergeConflicts {
                message,
                conflicted_files,
            } => Ok(ResponseJson(
                ApiResponse::<(), GitOperationError>::error_with_data(
                    GitOperationError::MergeConflicts {
                        message,
                        op: ConflictOp::Merge,
                        conflicted_files,
                        target_branch: workspace.branch.clone(),
                    },
                ),
            )),
            GitServiceError::RebaseInProgress => Ok(ResponseJson(ApiResponse::<
                (),
                GitOperationError,
            >::error_with_data(
                GitOperationError::RebaseInProgress,
            ))),
            other => Err(ApiError::GitService(other)),
        };
    }

    // 2. The local branch now contains every remote commit, so a regular push
    //    fast-forwards the remote.
    let no_verify = deployment.config().read().await.git_push_no_verify;
    deployment
        .git()
        .push_to_remote(&worktree_path, &workspace.branch, false, no_verify)?;

    spawn_workspace_stats_sync(&deployment, &workspace, &container_ref);

    Ok(ResponseJson(ApiResponse::success(())))
}

/// Integrate the work branch's own remote into the local worktree without
/// pushing. This is the Pull-side divergence resolution: it preserves both
/// histories and leaves any conflicts in the workspace for the existing
/// conflict-resolution UI.
#[axum::debug_handler]
pub async fn merge_remote_workspace_branch(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<PushWorkspaceRequest>,
) -> Result<ResponseJson<ApiResponse<(), GitOperationError>>, ApiError> {
    let pool = &deployment.db().pool;
    let workspace_repo =
        WorkspaceRepo::find_by_workspace_and_repo_id(pool, workspace.id, request.repo_id)
            .await?
            .ok_or(RepoError::NotFound)?;
    let repo = Repo::find_by_id(pool, workspace_repo.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;
    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let worktree_path = if workspace.in_place {
        PathBuf::from(&container_ref)
    } else {
        Path::new(&container_ref).join(&repo.name)
    };

    if let Err(e) = deployment
        .git()
        .merge_remote_into_workspace_branch(&worktree_path, &workspace.branch)
    {
        return match e {
            GitServiceError::MergeConflicts {
                message,
                conflicted_files,
            } => Ok(ResponseJson(
                ApiResponse::<(), GitOperationError>::error_with_data(
                    GitOperationError::MergeConflicts {
                        message,
                        op: ConflictOp::Merge,
                        conflicted_files,
                        target_branch: workspace.branch.clone(),
                    },
                ),
            )),
            GitServiceError::RebaseInProgress => Ok(ResponseJson(ApiResponse::<
                (),
                GitOperationError,
            >::error_with_data(
                GitOperationError::RebaseInProgress,
            ))),
            other => Err(ApiError::GitService(other)),
        };
    }

    spawn_workspace_stats_sync(&deployment, &workspace, &container_ref);
    Ok(ResponseJson(ApiResponse::success(())))
}

/// Replace the local work branch with its latest remote state. This is the
/// destructive counterpart to merge-remote for cases where a remote force-push
/// is authoritative and the local commits should be discarded.
#[axum::debug_handler]
pub async fn reset_workspace_branch_to_remote(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<ResetWorkspaceToRemoteRequest>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    if !request.confirm_discard {
        return Err(ApiError::BadRequest(
            "Explicit confirmation is required to discard local work".to_string(),
        ));
    }

    let pool = &deployment.db().pool;
    let workspace_repo =
        WorkspaceRepo::find_by_workspace_and_repo_id(pool, workspace.id, request.repo_id)
            .await?
            .ok_or(RepoError::NotFound)?;
    let repo = Repo::find_by_id(pool, workspace_repo.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;
    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let worktree_path = if workspace.in_place {
        PathBuf::from(&container_ref)
    } else {
        Path::new(&container_ref).join(&repo.name)
    };

    deployment
        .git()
        .reset_workspace_branch_to_remote(&worktree_path, &workspace.branch)?;
    spawn_workspace_stats_sync(&deployment, &workspace, &container_ref);

    Ok(ResponseJson(ApiResponse::success(())))
}

/// Recompute the workspace's diff stats and push them to the remote (best
/// effort, in the background). Used after operations that change the work
/// branch tip (pull, update-from-base) so the cloud view stays accurate.
fn spawn_workspace_stats_sync(
    deployment: &DeploymentImpl,
    workspace: &Workspace,
    container_ref: &str,
) {
    if let Ok(client) = deployment.remote_client() {
        let pool = deployment.db().pool.clone();
        let git = deployment.git().clone();
        let mut ws = workspace.clone();
        ws.container_ref = Some(container_ref.to_string());
        tokio::spawn(async move {
            let stats = diff_stream::compute_diff_stats(&pool, &git, &ws).await;
            remote_sync::sync_workspace_to_remote(&client, ws.id, None, None, stats.as_ref()).await;
        });
    }
}

/// Fast-forward the work branch to its own remote (`git pull --ff-only`). Never
/// touches the remote, so it is safe on shared PR branches: it only advances the
/// local branch when the remote is strictly ahead, and reports `diverged`
/// otherwise so the caller can fall back to update-from-base.
#[axum::debug_handler]
pub async fn pull_workspace_branch_from_remote(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<PullWorkspaceRequest>,
) -> Result<ResponseJson<ApiResponse<PullWorkspaceResponse>>, ApiError> {
    let pool = &deployment.db().pool;

    let workspace_repo =
        WorkspaceRepo::find_by_workspace_and_repo_id(pool, workspace.id, request.repo_id)
            .await?
            .ok_or(RepoError::NotFound)?;

    let repo = Repo::find_by_id(pool, workspace_repo.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    // In-place ("quick chat") workspaces run in the repo root itself, so the
    // worktree path IS `container_ref` rather than a per-repo subdir.
    let worktree_path = if workspace.in_place {
        PathBuf::from(&container_ref)
    } else {
        Path::new(&container_ref).join(&repo.name)
    };

    let outcome = deployment
        .git()
        .pull_workspace_branch(&worktree_path, &workspace.branch)?;

    let response = match outcome {
        PullOutcome::UpToDate => PullWorkspaceResponse::UpToDate,
        PullOutcome::FastForwarded { commits, .. } => {
            spawn_workspace_stats_sync(&deployment, &workspace, &container_ref);
            PullWorkspaceResponse::FastForwarded { commits }
        }
        PullOutcome::Diverged { ahead, behind } => {
            PullWorkspaceResponse::Diverged { ahead, behind }
        }
    };

    Ok(ResponseJson(ApiResponse::success(response)))
}

/// Bring the target (base) branch into the work branch via merge (default,
/// history-preserving) or rebase (opt-in, rewrites history). Conflicts surface
/// as a typed `GitOperationError` so the existing conflict-resolution UI lights
/// up, identical to the rebase flow.
#[axum::debug_handler]
pub async fn update_workspace_from_base(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<UpdateFromBaseRequest>,
) -> Result<ResponseJson<ApiResponse<(), GitOperationError>>, ApiError> {
    let pool = &deployment.db().pool;

    let workspace_repo =
        WorkspaceRepo::find_by_workspace_and_repo_id(pool, workspace.id, payload.repo_id)
            .await?
            .ok_or(RepoError::NotFound)?;

    let repo = Repo::find_by_id(pool, workspace_repo.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    let target_branch = workspace_repo.target_branch.clone();

    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    // In-place ("quick chat") workspaces run in the repo root itself, so the
    // worktree path IS `container_ref` rather than a per-repo subdir.
    let worktree_path = if workspace.in_place {
        PathBuf::from(&container_ref)
    } else {
        Path::new(&container_ref).join(&repo.name)
    };

    let result = match payload.strategy {
        UpdateFromBaseStrategy::Merge => deployment
            .git()
            .merge_base_into_workspace(
                &repo.path,
                &worktree_path,
                &workspace.branch,
                &target_branch,
            )
            .map(|_| ()),
        UpdateFromBaseStrategy::Rebase => deployment
            .git()
            .rebase_branch(
                &repo.path,
                &worktree_path,
                &target_branch,
                &target_branch,
                &workspace.branch,
            )
            .map(|_| ()),
    };

    if let Err(e) = result {
        return match e {
            GitServiceError::MergeConflicts {
                message,
                conflicted_files,
            } => {
                let op = match payload.strategy {
                    UpdateFromBaseStrategy::Merge => ConflictOp::Merge,
                    UpdateFromBaseStrategy::Rebase => ConflictOp::Rebase,
                };
                Ok(ResponseJson(
                    ApiResponse::<(), GitOperationError>::error_with_data(
                        GitOperationError::MergeConflicts {
                            message,
                            op,
                            conflicted_files,
                            target_branch,
                        },
                    ),
                ))
            }
            GitServiceError::RebaseInProgress => Ok(ResponseJson(ApiResponse::<
                (),
                GitOperationError,
            >::error_with_data(
                GitOperationError::RebaseInProgress,
            ))),
            other => Err(ApiError::GitService(other)),
        };
    }

    spawn_workspace_stats_sync(&deployment, &workspace, &container_ref);

    Ok(ResponseJson(ApiResponse::success(())))
}

/// Bring the selected base branch into the workspace target branch. This is
/// equivalent to GitHub Desktop's "Update from main/develop" for the target
/// branch. Prefer the current remote-tracking base when available so the merge
/// includes the latest fetched upstream commit.
#[axum::debug_handler]
pub async fn update_target_branch_from_base(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<UpdateTargetBranchFromBaseRequest>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    let (repo, workspace_repo) =
        load_workspace_repo(&deployment, workspace.id, payload.repo_id).await?;
    let target_branch = workspace_repo.target_branch;

    if target_branch == payload.base_branch {
        return Ok(ResponseJson(ApiResponse::error(
            "The target branch and base branch must be different.",
        )));
    }

    let git = deployment.git();
    let base_branch = if let Some(remote) = resolve_primary_remote(&deployment, &repo) {
        git.fetch_remote(&repo.path, &remote)?;
        let remote_base = format!("{remote}/{}", payload.base_branch);
        if git.check_branch_exists(&repo.path, &remote_base)? {
            remote_base
        } else {
            payload.base_branch
        }
    } else {
        payload.base_branch
    };

    git.merge_base_into_branch_checkout(&repo.path, &target_branch, &base_branch)?;

    Ok(ResponseJson(ApiResponse::success(())))
}

pub async fn get_workspace_branch_status(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<Vec<RepoBranchStatus>>>, ApiError> {
    let pool = &deployment.db().pool;

    let repositories = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let workspace_repos = WorkspaceRepo::find_by_workspace_id(pool, workspace.id).await?;
    let target_branches: HashMap<_, _> = workspace_repos
        .iter()
        .map(|wr| (wr.repo_id, wr.target_branch.clone()))
        .collect();

    // Detect source repos that no longer exist on disk (e.g. the project folder was
    // moved or deleted). We must not fail the whole status request in that case —
    // otherwise the workspace becomes impossible to inspect or delete. Report those
    // repos as missing and skip any git operations on them.
    let missing_repo_ids: std::collections::HashSet<Uuid> = repositories
        .iter()
        .filter(|repo| !deployment.git().is_repo_openable(&repo.path))
        .map(|repo| repo.id)
        .collect();

    // Re-creating worktrees requires the source repos, so only ensure the container when
    // every source repo is still present. When one is missing, fall back to whatever
    // container directory already exists (if any).
    let workspace_dir = if missing_repo_ids.is_empty() {
        let container_ref = deployment
            .container()
            .ensure_container_exists(&workspace)
            .await?;
        Some(PathBuf::from(container_ref))
    } else {
        workspace.container_ref.clone().map(PathBuf::from)
    };

    let all_merges = Merge::find_by_workspace_id(pool, workspace.id).await?;
    let merges_by_repo: HashMap<Uuid, Vec<Merge>> =
        all_merges
            .into_iter()
            .fold(HashMap::new(), |mut acc, merge| {
                let repo_id = match &merge {
                    Merge::Direct(dm) => dm.repo_id,
                    Merge::Pr(pm) => pm.repo_id,
                };
                acc.entry(repo_id).or_insert_with(Vec::new).push(merge);
                acc
            });

    // The per-repo work below is synchronous git (libgit2 + CLI) that takes
    // hundreds of milliseconds on busy repos and is polled every few seconds
    // by the frontend. Run it on the blocking pool so it can't starve the
    // async workers (same failure class as the log-normalization starvation).
    let git = deployment.git().clone();
    let results = tokio::task::spawn_blocking(move || {
        let mut results = Vec::with_capacity(repositories.len());

        for repo in repositories {
            let Some(target_branch) = target_branches.get(&repo.id).cloned() else {
                continue;
            };

            let mut repo_merges = merges_by_repo.get(&repo.id).cloned().unwrap_or_default();

            // Missing source repo: report it without touching git, so the caller can warn
            // the user while still allowing cleanup/deletion to proceed.
            if missing_repo_ids.contains(&repo.id) {
                results.push(RepoBranchStatus {
                    repo_id: repo.id,
                    repo_name: repo.name,
                    repo_missing: true,
                    status: BranchStatus {
                        commits_behind: None,
                        commits_ahead: None,
                        has_uncommitted_changes: None,
                        head_oid: None,
                        uncommitted_count: None,
                        untracked_count: None,
                        target_branch_name: target_branch,
                        remote_commits_behind: None,
                        remote_commits_ahead: None,
                        target_remote_commits_ahead: None,
                        target_remote_commits_behind: None,
                        work_branch_has_remote: false,
                        merges: repo_merges,
                        is_rebase_in_progress: false,
                        conflict_op: None,
                        conflicted_files: Vec::new(),
                        is_target_remote: false,
                    },
                });
                continue;
            }

            // In-place ("quick chat") workspaces run in the repo root itself, so the
            // worktree path IS `container_ref` rather than a per-repo subdir.
            let worktree_path = if workspace.in_place {
                workspace_dir.clone()
            } else {
                workspace_dir.as_ref().map(|dir| dir.join(&repo.name))
            };

            let head_oid = worktree_path
                .as_ref()
                .and_then(|path| git.get_head_info(path).ok())
                .map(|h| h.oid);

            let (is_rebase_in_progress, conflicted_files, conflict_op) =
                if let Some(worktree_path) = worktree_path.as_ref() {
                    let in_rebase = git.is_rebase_in_progress(worktree_path).unwrap_or(false);
                    let conflicts = git.get_conflicted_files(worktree_path).unwrap_or_default();
                    let op = if conflicts.is_empty() {
                        None
                    } else {
                        git.detect_conflict_op(worktree_path).unwrap_or(None)
                    };
                    (in_rebase, conflicts, op)
                } else {
                    (false, Vec::new(), None)
                };

            let (uncommitted_count, untracked_count) = match worktree_path
                .as_ref()
                .map(|path| git.get_worktree_change_counts(path))
            {
                Some(Ok((a, b))) => (Some(a), Some(b)),
                _ => (None, None),
            };

            let has_uncommitted_changes = uncommitted_count.map(|c| c > 0);

            let is_target_remote = git.is_remote_branch(&repo.path, &target_branch)?;

            let (commits_ahead, commits_behind) = if is_target_remote {
                let (ahead, behind) = git.get_remote_branch_status(
                    &repo.path,
                    &workspace.branch,
                    Some(&target_branch),
                )?;
                (Some(ahead), Some(behind))
            } else {
                let (a, b) =
                    git.get_branch_status(&repo.path, &workspace.branch, &target_branch)?;
                (Some(a), Some(b))
            };

            let (remote_ahead, remote_behind) = if let Some(Merge::Pr(PrMerge {
                pr_info:
                    PullRequestInfo {
                        status: MergeStatus::Open,
                        ..
                    },
                ..
            })) = repo_merges.first()
            {
                match git.get_remote_branch_status(&repo.path, &workspace.branch, None) {
                    Ok((ahead, behind)) => (Some(ahead), Some(behind)),
                    Err(_) => (None, None),
                }
            } else {
                (None, None)
            };

            // Whether the work branch has a counterpart on the repo's primary remote.
            // Checked via the local remote-tracking ref (`origin/<work_branch>`), so
            // it's network-free and — unlike `remote_commits_ahead` above — does NOT
            // depend on an open PR. This mirrors what the pull operation actually does
            // (resolve origin for the branch), so the "Pull" button matches whether a
            // pull would do anything: a pushed vk branch with no PR still shows it, a
            // local-only branch never does.
            let work_branch_has_remote =
                if let Some(remote) = resolve_primary_remote_with(&git, &repo) {
                    git.get_remote_tracking_status(&repo.path, &workspace.branch, &remote)
                        .map(|(exists, _, _)| exists)
                        .unwrap_or(false)
                } else {
                    false
                };

            // How far the local target (base) branch is ahead/behind its counterpart
            // on the repo's primary remote. Read from local tracking refs only (no
            // network), so it's cheap to include in this poll. Only meaningful for a
            // real local branch with a remote configured.
            let (target_remote_ahead, target_remote_behind) = if is_target_remote {
                (None, None)
            } else if let Some(remote) = resolve_primary_remote_with(&git, &repo) {
                match git.get_remote_tracking_status(&repo.path, &target_branch, &remote) {
                    Ok((true, ahead, behind)) => (Some(ahead), Some(behind)),
                    // Target branch has never been pushed to this remote yet.
                    Ok((false, _, _)) => (None, None),
                    Err(e) => {
                        tracing::warn!(
                            "Failed to compute target-branch remote status for repo {}: {e}",
                            repo.id
                        );
                        (None, None)
                    }
                }
            } else {
                (None, None)
            };

            // For each open PR, compute how far its head branch is ahead/behind its
            // base branch — the PR's own diff size — so the PR panel can show it
            // independently of the work-branch -> target status above. In a
            // three-branch flow the head is the feature branch (not workspace.branch)
            // and the base is the PR's own base (e.g. develop).
            for merge in repo_merges.iter_mut() {
                if let Merge::Pr(pr) = merge
                    && matches!(pr.pr_info.status, MergeStatus::Open)
                {
                    let head = pr
                        .head_branch_name
                        .clone()
                        .unwrap_or_else(|| workspace.branch.clone());
                    if let Some((ahead, behind)) =
                        compute_pr_head_ahead_behind(&git, &repo, &head, &pr.target_branch_name)
                    {
                        pr.head_commits_ahead = Some(ahead);
                        pr.head_commits_behind = Some(behind);
                    }
                }
            }

            results.push(RepoBranchStatus {
                repo_id: repo.id,
                repo_name: repo.name,
                repo_missing: false,
                status: BranchStatus {
                    commits_ahead,
                    commits_behind,
                    has_uncommitted_changes,
                    head_oid,
                    uncommitted_count,
                    untracked_count,
                    remote_commits_ahead: remote_ahead,
                    remote_commits_behind: remote_behind,
                    target_remote_commits_ahead: target_remote_ahead,
                    target_remote_commits_behind: target_remote_behind,
                    work_branch_has_remote,
                    merges: repo_merges,
                    target_branch_name: target_branch,
                    is_rebase_in_progress,
                    conflict_op,
                    conflicted_files,
                    is_target_remote,
                },
            });
        }

        Ok::<_, ApiError>(results)
    })
    .await
    .map_err(|join_error| ApiError::Io(std::io::Error::other(join_error)))??;

    Ok(ResponseJson(ApiResponse::success(results)))
}

/// How far a PR's head branch is ahead/behind its base branch — the PR's own
/// commit count, independent of the workspace's work-branch -> target status.
/// Tries the base as given (a local branch or a remote-tracking ref), then falls
/// back to the primary remote's tracking ref (e.g. `origin/develop`). Returns
/// `None` when neither resolves.
fn compute_pr_head_ahead_behind(
    git: &git::GitService,
    repo: &Repo,
    head: &str,
    base: &str,
) -> Option<(usize, usize)> {
    if let Ok((ahead, behind)) = git.get_branch_status(&repo.path, head, base) {
        return Some((ahead, behind));
    }
    if let Some(remote) = resolve_primary_remote_with(git, repo) {
        let remote_base = format!("{remote}/{base}");
        if let Ok((ahead, behind)) = git.get_branch_status(&repo.path, head, &remote_base) {
            return Some((ahead, behind));
        }
    }
    None
}

/// Compute the target (base) branch's status relative to the repo's primary
/// remote. When the target is a remote-only branch or the repo has no remote,
/// the ahead/behind fields are left zeroed and the corresponding flags tell the
/// UI to disable the fetch/push buttons.
fn compute_target_branch_remote_status(
    deployment: &DeploymentImpl,
    repo: &Repo,
    target_branch: &str,
) -> Result<TargetBranchRemoteStatus, GitServiceError> {
    let git = deployment.git();
    let is_target_remote = git.is_remote_branch(&repo.path, target_branch)?;
    let remote = resolve_primary_remote(deployment, repo);

    if let (Some(remote_name), false) = (&remote, is_target_remote) {
        let (remote_branch_exists, ahead, behind) =
            git.get_remote_tracking_status(&repo.path, target_branch, remote_name)?;
        Ok(TargetBranchRemoteStatus {
            target_branch: target_branch.to_string(),
            remote: Some(remote_name.clone()),
            remote_configured: true,
            is_target_remote: false,
            remote_branch_exists,
            ahead: ahead as u32,
            behind: behind as u32,
        })
    } else {
        Ok(TargetBranchRemoteStatus {
            target_branch: target_branch.to_string(),
            remote_configured: remote.is_some(),
            remote,
            is_target_remote,
            remote_branch_exists: false,
            ahead: 0,
            behind: 0,
        })
    }
}

/// Resolve the workspace repo + its underlying repo for a target-branch remote
/// operation, erroring if the repo isn't part of the workspace.
async fn load_workspace_repo(
    deployment: &DeploymentImpl,
    workspace_id: Uuid,
    repo_id: Uuid,
) -> Result<(Repo, WorkspaceRepo), ApiError> {
    let pool = &deployment.db().pool;
    let workspace_repo = WorkspaceRepo::find_by_workspace_and_repo_id(pool, workspace_id, repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;
    let repo = Repo::find_by_id(pool, workspace_repo.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;
    Ok((repo, workspace_repo))
}

/// Ahead/behind of the workspace's target branch relative to its counterpart on
/// the repo's primary remote. Drives the target-branch fetch/push buttons.
#[axum::debug_handler]
pub async fn get_target_branch_remote_status(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<TargetBranchRepoQuery>,
) -> Result<ResponseJson<ApiResponse<TargetBranchRemoteStatus>>, ApiError> {
    let (repo, workspace_repo) =
        load_workspace_repo(&deployment, workspace.id, query.repo_id).await?;
    let status =
        compute_target_branch_remote_status(&deployment, &repo, &workspace_repo.target_branch)?;
    Ok(ResponseJson(ApiResponse::success(status)))
}

/// Fetch from the repo's primary remote, refreshing the target branch's
/// remote-tracking ref, then return the updated ahead/behind status.
#[axum::debug_handler]
pub async fn fetch_target_branch(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<FetchTargetBranchRequest>,
) -> Result<ResponseJson<ApiResponse<TargetBranchRemoteStatus>>, ApiError> {
    let (repo, workspace_repo) =
        load_workspace_repo(&deployment, workspace.id, request.repo_id).await?;

    let Some(remote) = resolve_primary_remote(&deployment, &repo) else {
        return Ok(ResponseJson(ApiResponse::error(
            "No remote configured for this repository",
        )));
    };

    if let Err(e) = deployment.git().fetch_remote(&repo.path, &remote) {
        tracing::error!(
            "Fetch of target branch '{}' from remote '{remote}' for repo {} failed: {e}",
            workspace_repo.target_branch,
            repo.id
        );
        return Ok(ResponseJson(ApiResponse::error(&e.to_string())));
    }

    let status =
        compute_target_branch_remote_status(&deployment, &repo, &workspace_repo.target_branch)?;
    Ok(ResponseJson(ApiResponse::success(status)))
}

/// Push the workspace's target (base) branch to the repo's primary remote. This
/// pushes the committed branch tip in the source repo (not the workspace
/// worktree), matching plain `git push` semantics.
#[axum::debug_handler]
pub async fn push_target_branch(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<PushTargetBranchRequest>,
) -> Result<ResponseJson<ApiResponse<TargetBranchRemoteStatus, PushError>>, ApiError> {
    let (repo, workspace_repo) =
        load_workspace_repo(&deployment, workspace.id, request.repo_id).await?;
    let git = deployment.git();

    if git.is_remote_branch(&repo.path, &workspace_repo.target_branch)? {
        return Err(ApiError::BadRequest(
            "The target branch is a remote branch; there is nothing to push.".to_string(),
        ));
    }

    let Some(remote) = resolve_primary_remote(&deployment, &repo) else {
        return Ok(ResponseJson(ApiResponse::error(
            "No remote configured for this repository",
        )));
    };

    let no_verify = deployment.config().read().await.git_push_no_verify;
    match git.push_branch_to_named_remote(
        &repo.path,
        &workspace_repo.target_branch,
        &remote,
        request.force,
        no_verify,
    ) {
        Ok(()) => {
            let status = compute_target_branch_remote_status(
                &deployment,
                &repo,
                &workspace_repo.target_branch,
            )?;
            Ok(ResponseJson(ApiResponse::success(status)))
        }
        Err(GitServiceError::PushDiverged { ahead, behind }) => Ok(ResponseJson(
            ApiResponse::error_with_data(PushError::Diverged { ahead, behind }),
        )),
        Err(GitServiceError::GitCLI(GitCliError::PushRejected(_))) => Ok(ResponseJson(
            ApiResponse::error_with_data(PushError::ForcePushRequired),
        )),
        Err(e) => {
            tracing::error!(
                "Push of target branch '{}' to '{remote}' for repo {} failed: {e}",
                workspace_repo.target_branch,
                repo.id
            );
            Err(ApiError::GitService(e))
        }
    }
}

/// Integrate the target (base) branch's diverged remote (fetch + merge) and then
/// push it — the safe, non-destructive resolution offered when a target-branch
/// push is rejected because it diverged. Unlike a force push it never discards
/// the remote commits. A conflict is aborted in the target branch's checkout and
/// returned as an ordinary error because the workspace conflict UI cannot safely
/// operate on that separate checkout.
#[axum::debug_handler]
pub async fn pull_and_push_target_branch(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<PullTargetBranchRequest>,
) -> Result<ResponseJson<ApiResponse<(), GitOperationError>>, ApiError> {
    let (repo, workspace_repo) =
        load_workspace_repo(&deployment, workspace.id, request.repo_id).await?;
    let git = deployment.git();
    let target = workspace_repo.target_branch.clone();

    if git.is_remote_branch(&repo.path, &target)? {
        return Err(ApiError::BadRequest(
            "The target branch is a remote branch; there is nothing to push.".to_string(),
        ));
    }

    let Some(remote) = resolve_primary_remote(&deployment, &repo) else {
        return Ok(ResponseJson(ApiResponse::error(
            "No remote configured for this repository",
        )));
    };

    // 1. Fetch + merge origin/<target> into the local target branch (wherever
    //    it's checked out). The git service aborts target-checkout conflicts so
    //    they are not mistaken for conflicts in this workspace's worktree.
    if let Err(e) = git.merge_remote_into_branch_checkout(&repo.path, &target) {
        return match e {
            GitServiceError::RebaseInProgress => Ok(ResponseJson(ApiResponse::<
                (),
                GitOperationError,
            >::error_with_data(
                GitOperationError::RebaseInProgress,
            ))),
            other => Err(ApiError::GitService(other)),
        };
    }

    // 2. The local target now contains every remote commit, so a regular push
    //    fast-forwards origin.
    let no_verify = deployment.config().read().await.git_push_no_verify;
    git.push_branch_to_named_remote(&repo.path, &target, &remote, false, no_verify)?;

    Ok(ResponseJson(ApiResponse::success(())))
}

/// Fetch, then fast-forward the workspace's target (base) branch to its
/// counterpart on the repo's primary remote (`git pull --ff-only`), returning
/// the updated ahead/behind status. Errors (as data) when the branch has
/// diverged from origin so the UI can surface it without a 500.
#[axum::debug_handler]
pub async fn pull_target_branch(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<PullTargetBranchRequest>,
) -> Result<ResponseJson<ApiResponse<TargetBranchRemoteStatus>>, ApiError> {
    let (repo, workspace_repo) =
        load_workspace_repo(&deployment, workspace.id, request.repo_id).await?;
    let git = deployment.git();

    if git.is_remote_branch(&repo.path, &workspace_repo.target_branch)? {
        return Ok(ResponseJson(ApiResponse::error(
            "The target branch is a remote branch; there is nothing to pull.",
        )));
    }

    let Some(remote) = resolve_primary_remote(&deployment, &repo) else {
        return Ok(ResponseJson(ApiResponse::error(
            "No remote configured for this repository",
        )));
    };

    if let Err(e) = git.fetch_remote(&repo.path, &remote) {
        tracing::error!(
            "Fetch before pull of target branch '{}' from '{remote}' for repo {} failed: {e}",
            workspace_repo.target_branch,
            repo.id
        );
        return Ok(ResponseJson(ApiResponse::error(&e.to_string())));
    }

    match git.fast_forward_local_branch_to_remote(
        &repo.path,
        &workspace_repo.target_branch,
        &remote,
    ) {
        Ok(PullOutcome::Diverged { .. }) => {
            return Ok(ResponseJson(ApiResponse::error(
                "The target branch has diverged from origin; a fast-forward pull isn't possible.",
            )));
        }
        Ok(_) => {}
        Err(e) => {
            tracing::error!(
                "Pull of target branch '{}' from '{remote}' for repo {} failed: {e}",
                workspace_repo.target_branch,
                repo.id
            );
            return Err(ApiError::GitService(e));
        }
    }

    let status =
        compute_target_branch_remote_status(&deployment, &repo, &workspace_repo.target_branch)?;
    Ok(ResponseJson(ApiResponse::success(status)))
}

#[axum::debug_handler]
pub async fn change_target_branch(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<ChangeTargetBranchRequest>,
) -> Result<ResponseJson<ApiResponse<ChangeTargetBranchResponse>>, ApiError> {
    let repo_id = payload.repo_id;
    let new_target_branch = payload.new_target_branch;
    let pool = &deployment.db().pool;

    let repo = Repo::find_by_id(pool, repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    if !deployment
        .git()
        .check_branch_exists(&repo.path, &new_target_branch)?
    {
        return Ok(ResponseJson(ApiResponse::error(
            format!(
                "Branch '{}' does not exist in repository '{}'",
                new_target_branch, repo.name
            )
            .as_str(),
        )));
    };

    WorkspaceRepo::update_target_branch(pool, workspace.id, repo_id, &new_target_branch).await?;

    // A work-branch PR opened against the previous base branch no longer matches
    // this workspace's target, so unlink it. Feature-branch-head PRs (three-branch
    // flow) are preserved — their base is independent of the workspace target.
    match PullRequest::delete_stale_for_target_change(
        pool,
        workspace.id,
        repo_id,
        &new_target_branch,
        &workspace.branch,
    )
    .await
    {
        Ok(removed) if removed > 0 => {
            tracing::info!(
                "Unlinked {} stale PR(s) from workspace {} repo {} after target branch change to {}",
                removed,
                workspace.id,
                repo_id,
                new_target_branch
            );
        }
        Ok(_) => {}
        Err(e) => {
            tracing::warn!(
                "Failed to unlink stale PRs for workspace {} repo {} after target branch change: {}",
                workspace.id,
                repo_id,
                e
            );
        }
    }

    let status =
        deployment
            .git()
            .get_branch_status(&repo.path, &workspace.branch, &new_target_branch)?;

    Ok(ResponseJson(ApiResponse::success(
        ChangeTargetBranchResponse {
            repo_id,
            new_target_branch,
            status,
        },
    )))
}

#[axum::debug_handler]
pub async fn rename_branch(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<RenameBranchRequest>,
) -> Result<ResponseJson<ApiResponse<RenameBranchResponse, RenameBranchError>>, ApiError> {
    // SAFETY: in-place ("quick chat") workspaces run on the user's actual branch;
    // renaming it would rename their real branch out from under them.
    if workspace.in_place {
        return Err(ApiError::BadRequest(
            "Renaming the branch isn't available for quick chats — they run on your existing branch."
                .to_string(),
        ));
    }

    let new_branch_name = payload.new_branch_name.trim();

    if new_branch_name.is_empty() {
        return Ok(ResponseJson(ApiResponse::error_with_data(
            RenameBranchError::EmptyBranchName,
        )));
    }
    if !deployment.git().is_branch_name_valid(new_branch_name) {
        return Ok(ResponseJson(ApiResponse::error_with_data(
            RenameBranchError::InvalidBranchNameFormat,
        )));
    }
    if new_branch_name == workspace.branch {
        return Ok(ResponseJson(ApiResponse::success(RenameBranchResponse {
            branch: workspace.branch.clone(),
        })));
    }

    let pool = &deployment.db().pool;

    let merges = Merge::find_by_workspace_id(pool, workspace.id).await?;
    // Renaming the work branch only conflicts with an open PR that uses THIS
    // branch as its head. A PR opened from an intermediate feature branch
    // (head != workspace.branch) is unaffected. A NULL head means the legacy
    // default (workspace.branch).
    let has_open_pr_from_work_branch = merges.into_iter().any(|merge| {
        matches!(merge, Merge::Pr(pr_merge)
            if matches!(pr_merge.pr_info.status, MergeStatus::Open)
                && pr_merge.head_branch_name.as_deref().unwrap_or(workspace.branch.as_str())
                    == workspace.branch)
    });
    if has_open_pr_from_work_branch {
        return Ok(ResponseJson(ApiResponse::error_with_data(
            RenameBranchError::OpenPullRequest,
        )));
    }

    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let workspace_dir = PathBuf::from(&container_ref);

    for repo in &repos {
        let worktree_path = workspace_dir.join(&repo.name);

        if deployment
            .git()
            .check_branch_exists(&repo.path, new_branch_name)?
        {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                RenameBranchError::BranchAlreadyExists {
                    repo_name: repo.name.clone(),
                },
            )));
        }

        if deployment.git().is_rebase_in_progress(&worktree_path)? {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                RenameBranchError::RebaseInProgress {
                    repo_name: repo.name.clone(),
                },
            )));
        }
    }

    let old_branch = workspace.branch.clone();
    let mut renamed_repos: Vec<&Repo> = Vec::new();

    for repo in &repos {
        let worktree_path = workspace_dir.join(&repo.name);

        match deployment.git().rename_local_branch(
            &worktree_path,
            &workspace.branch,
            new_branch_name,
        ) {
            Ok(()) => {
                renamed_repos.push(repo);
            }
            Err(e) => {
                for renamed_repo in &renamed_repos {
                    let rollback_path = workspace_dir.join(&renamed_repo.name);
                    if let Err(rollback_err) = deployment.git().rename_local_branch(
                        &rollback_path,
                        new_branch_name,
                        &old_branch,
                    ) {
                        tracing::error!(
                            "Failed to rollback branch rename in '{}': {}",
                            renamed_repo.name,
                            rollback_err
                        );
                    }
                }
                return Ok(ResponseJson(ApiResponse::error_with_data(
                    RenameBranchError::RenameFailed {
                        repo_name: repo.name.clone(),
                        message: e.to_string(),
                    },
                )));
            }
        }
    }

    db::models::workspace::Workspace::update_branch_name(pool, workspace.id, new_branch_name)
        .await?;
    let updated_children_count = WorkspaceRepo::update_target_branch_for_children_of_workspace(
        pool,
        workspace.id,
        &old_branch,
        new_branch_name,
    )
    .await?;

    if updated_children_count > 0 {
        tracing::info!(
            "Updated {} child workspaces to target new branch '{}'",
            updated_children_count,
            new_branch_name
        );
    }

    Ok(ResponseJson(ApiResponse::success(RenameBranchResponse {
        branch: new_branch_name.to_string(),
    })))
}

#[axum::debug_handler]
pub async fn rebase_workspace(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<RebaseWorkspaceRequest>,
) -> Result<ResponseJson<ApiResponse<(), GitOperationError>>, ApiError> {
    let pool = &deployment.db().pool;

    let workspace_repo =
        WorkspaceRepo::find_by_workspace_and_repo_id(pool, workspace.id, payload.repo_id)
            .await?
            .ok_or(RepoError::NotFound)?;

    let repo = Repo::find_by_id(pool, workspace_repo.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    let old_base_branch = payload
        .old_base_branch
        .unwrap_or_else(|| workspace_repo.target_branch.clone());
    let new_base_branch = payload
        .new_base_branch
        .unwrap_or_else(|| workspace_repo.target_branch.clone());

    match deployment
        .git()
        .check_branch_exists(&repo.path, &new_base_branch)?
    {
        true => {
            WorkspaceRepo::update_target_branch(
                pool,
                workspace.id,
                payload.repo_id,
                &new_base_branch,
            )
            .await?;
        }
        false => {
            return Ok(ResponseJson(ApiResponse::error(
                format!(
                    "Branch '{}' does not exist in the repository",
                    new_base_branch
                )
                .as_str(),
            )));
        }
    }

    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let workspace_path = Path::new(&container_ref);
    let worktree_path = workspace_path.join(&repo.name);

    let result = deployment.git().rebase_branch(
        &repo.path,
        &worktree_path,
        &new_base_branch,
        &old_base_branch,
        &workspace.branch.clone(),
    );
    if let Err(e) = result {
        return match e {
            GitServiceError::MergeConflicts {
                message,
                conflicted_files,
            } => Ok(ResponseJson(
                ApiResponse::<(), GitOperationError>::error_with_data(
                    GitOperationError::MergeConflicts {
                        message,
                        op: ConflictOp::Rebase,
                        conflicted_files,
                        target_branch: new_base_branch.clone(),
                    },
                ),
            )),
            GitServiceError::RebaseInProgress => Ok(ResponseJson(ApiResponse::<
                (),
                GitOperationError,
            >::error_with_data(
                GitOperationError::RebaseInProgress,
            ))),
            other => Err(ApiError::GitService(other)),
        };
    }

    Ok(ResponseJson(ApiResponse::success(())))
}

#[axum::debug_handler]
pub async fn abort_workspace_conflicts(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<AbortConflictsRequest>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    let pool = &deployment.db().pool;

    let repo = Repo::find_by_id(pool, payload.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let workspace_path = Path::new(&container_ref);
    // In-place ("quick chat") workspaces run in the repo root itself, so the
    // worktree path IS `container_ref` rather than a per-repo subdir.
    let worktree_path = if workspace.in_place {
        PathBuf::from(&container_ref)
    } else {
        workspace_path.join(&repo.name)
    };

    deployment.git().abort_conflicts(&worktree_path)?;

    Ok(ResponseJson(ApiResponse::success(())))
}

#[axum::debug_handler]
pub async fn continue_workspace_rebase(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<ContinueRebaseRequest>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    let pool = &deployment.db().pool;

    let repo = Repo::find_by_id(pool, payload.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let workspace_path = Path::new(&container_ref);
    // In-place ("quick chat") workspaces run in the repo root itself, so the
    // worktree path IS `container_ref` rather than a per-repo subdir.
    let worktree_path = if workspace.in_place {
        PathBuf::from(&container_ref)
    } else {
        workspace_path.join(&repo.name)
    };

    deployment.git().continue_rebase(&worktree_path)?;

    Ok(ResponseJson(ApiResponse::success(())))
}
