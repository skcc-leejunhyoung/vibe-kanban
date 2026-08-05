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
    /// Base branch the working branch forks from (and the PR merge target).
    /// When `create_target_branch` is false this must already exist. When true,
    /// it's a feature branch name that is created off the repo's default branch
    /// if missing (reused if it already exists).
    pub target_branch: String,
    /// "Feature branch" modes (`new`/`auto`): create `target_branch` off the
    /// repo's `default_target_branch` when it doesn't exist yet. Defaults to
    /// false (the legacy "existing branch" behavior) for older clients.
    #[serde(default)]
    pub create_target_branch: bool,
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

/// How the workspace's working (worktree) branch should be set up. Distinct
/// from each repo's `target_branch`, which is the base / merge target. The
/// frontend resolves the final name — including issue-template expansion —
/// so the create-time preview matches exactly what gets created.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum WorkingBranchInput {
    /// Auto-generate the branch name (`{prefix}/{uuid}-{title}`). Default.
    #[default]
    Auto,
    /// Create a new branch with this exact name, forked from each repo's
    /// target branch. Rejected if the branch already exists (conflict).
    New { name: String },
    /// Check out an existing branch with this name instead of creating one
    /// (continue work). Single-repo only; rejected if the branch is missing.
    Existing { name: String },
    /// Use the GitHub linked branch for the issue mapped to this workspace's
    /// repo. If the issue already has a linked branch it is checked out;
    /// otherwise one is created on GitHub (the "Create a branch for this issue"
    /// equivalent), forked from the repo's target branch tip on the remote.
    /// Single-repo only; the repo must be a clone of the issue's GitHub repo.
    GithubLinkedBranch {
        /// The GitHub issue's GraphQL node id
        /// (`github_issue_links.github_node_id`).
        issue_node_id: String,
        /// The issue's GitHub repository in `owner/repo` form
        /// (`github_issue_links.repository`), used to confirm the local repo
        /// matches before touching its linked branches.
        repository: String,
    },
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
    /// Working branch setup (auto / new name / existing branch). Defaults to
    /// `Auto` when omitted by older clients.
    #[serde(default)]
    pub working_branch: WorkingBranchInput,
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct CreateAndStartWorkspaceResponse {
    pub workspace: Workspace,
    pub execution_process: ExecutionProcess,
}

/// "Quick chat" payload: run an agent directly in an existing checkout without
/// creating a `vk/` worktree branch. The workspace is marked `in_place`, its
/// `container_ref` points at the repo's real path, no worktree is materialized,
/// and the agent's edits stay uncommitted in the user's working tree. Reuses
/// [`CreateAndStartWorkspaceResponse`].
#[derive(Debug, Serialize, Deserialize, TS)]
pub struct CreateQuickChatRequest {
    /// Registered repo whose existing checkout the agent runs in directly.
    pub repo_id: Uuid,
    pub executor_config: ExecutorConfig,
    pub prompt: String,
    /// Optional explicit name; defaults to the first line of the prompt.
    pub name: Option<String>,
}

/// Request to expand a rough brief into a development-ready technical task by
/// running a coding agent in a throwaway (ephemeral) multi-repo workspace.
#[derive(Debug, Serialize, Deserialize, TS)]
pub struct GenerateSpecRequest {
    /// Project the card will belong to. Provenance/context only — the local
    /// backend does not validate remote repo membership against it.
    pub project_id: Uuid,
    /// The rough, minimal task brief from the user.
    pub brief: String,
    /// Selected agent parameters (executor/variant/model), same shape as
    /// the create-workspace flow.
    pub executor_config: ExecutorConfig,
    /// Repos (with target branch) to mount in the ephemeral workspace so the
    /// agent can explore the codebase.
    pub repos: Vec<WorkspaceRepoInput>,
}

/// Result of a spec-intake generation: a title + full markdown spec to pre-fill
/// the New Issue dialog, plus the provenance object to store in the issue's
/// `extension_metadata` on create.
#[derive(Debug, Serialize, Deserialize, TS)]
pub struct GenerateSpecResponse {
    pub title: String,
    pub description: String,
    /// `{ "intake": { brief, executor_config, repos } }` — drop verbatim into
    /// `CreateIssueRequest.extension_metadata`.
    pub intake_metadata: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct CreateWorkspaceWithoutStartingRequest {
    pub name: Option<String>,
    pub repos: Vec<WorkspaceRepoInput>,
    pub linked_issue: Option<LinkedIssueInfo>,
    pub attachment_ids: Option<Vec<Uuid>>,
    /// Working branch setup (auto / new name / existing branch). Defaults to
    /// `Auto` when omitted by older clients.
    #[serde(default)]
    pub working_branch: WorkingBranchInput,
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
