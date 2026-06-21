use executors::profile::ExecutorConfig;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use super::{execution_process::ExecutionProcess, workspace::Workspace};

#[derive(Debug, Deserialize, Serialize)]
pub struct ContainerQuery {
    #[serde(rename = "ref")]
    pub container_ref: String,
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct WorkspaceRepoInput {
    pub repo_id: Uuid,
    pub target_branch: String,
}

/// Review-mode payload: when present on a create request, the workspace works
/// directly on an existing PR's head branch (no new `vk/` worktree branch) and
/// auto-links that PR. Populated by the frontend when the linked issue carries
/// the `review` tag and already has an open PR.
#[derive(Debug, Serialize, Deserialize, TS)]
pub struct PrReviewInput {
    /// Repo whose PR is being reviewed. Must match the single entry in `repos`.
    pub repo_id: Uuid,
    pub pr_number: i64,
    pub pr_title: String,
    pub pr_url: String,
    /// The PR's head (feature) branch — checked out directly via `gh pr checkout`
    /// instead of branching a new `vk/` worktree.
    pub head_branch: String,
    /// The PR's base branch (merge target).
    pub base_branch: String,
    /// Remote the PR lives on; defaults to the repo's default remote when absent.
    pub remote_name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct CreateWorkspaceApiRequest {
    pub name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct LinkedIssueInfo {
    pub remote_project_id: Uuid,
    pub issue_id: Uuid,
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct CreateAndStartWorkspaceRequest {
    pub name: Option<String>,
    pub repos: Vec<WorkspaceRepoInput>,
    pub linked_issue: Option<LinkedIssueInfo>,
    pub executor_config: ExecutorConfig,
    pub prompt: String,
    pub attachment_ids: Option<Vec<Uuid>>,
    /// When set, work directly on an existing PR's head branch (review mode)
    /// instead of creating a new `vk/` worktree branch. Absent for normal runs.
    pub pr_review: Option<PrReviewInput>,
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct CreateAndStartWorkspaceResponse {
    pub workspace: Workspace,
    pub execution_process: ExecutionProcess,
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct CreateWorkspaceWithoutStartingRequest {
    pub name: Option<String>,
    pub repos: Vec<WorkspaceRepoInput>,
    pub linked_issue: Option<LinkedIssueInfo>,
    pub attachment_ids: Option<Vec<Uuid>>,
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct CreateWorkspaceWithoutStartingResponse {
    pub workspace: Workspace,
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct UpdateWorkspace {
    pub archived: Option<bool>,
    pub pinned: Option<bool>,
    pub name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct UpdateSession {
    pub name: Option<String>,
}
