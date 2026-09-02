use std::collections::HashMap;

use axum::{Json, extract::State, http::HeaderMap, response::Json as ResponseJson};
use db::models::{
    pending_execution_start::PendingExecutionStart,
    repo::Repo,
    requests::{
        CreateAndStartWorkspaceRequest, CreateAndStartWorkspaceResponse, CreateQuickChatRequest,
        CreateWorkspaceApiRequest, CreateWorkspaceWithoutStartingRequest,
        CreateWorkspaceWithoutStartingResponse, GithubLinkedBranchInput, LinkedIssueInfo,
        PrReviewInput, WorkingBranchInput, WorkspaceRepoInput,
    },
    workspace::{CreateWorkspace, Workspace},
};
use deployment::Deployment;
use executors::model_selector::PermissionPolicy;
use git::GitService;
use git_host::github::GitHubProvider;
use services::services::{container::ContainerService, issue_gating, vibe_orchestrator, vibe_tags};
use utils::response::ApiResponse;
use uuid::Uuid;
use workspace_manager::ManagedWorkspace;

use crate::{
    DeploymentImpl,
    error::ApiError,
    routes::workspaces::{
        attachments::{ImportedIssueAttachment, import_issue_attachments_from_remote},
        pr::{self, BranchFetchFailure},
        review_mode::{self, BranchSetup},
    },
};

pub(crate) async fn create_workspace_record(
    deployment: &DeploymentImpl,
    name: Option<String>,
    branch_override: Option<String>,
) -> Result<Workspace, ApiError> {
    let workspace_id = Uuid::new_v4();
    let git_branch_name = match branch_override {
        Some(branch) => branch,
        None => {
            let branch_label = name
                .as_deref()
                .filter(|branch_label| !branch_label.is_empty())
                .unwrap_or("workspace");
            deployment
                .container()
                .git_branch_from_workspace(&workspace_id, branch_label)
                .await
        }
    };

    let workspace = Workspace::create(
        &deployment.db().pool,
        &CreateWorkspace {
            branch: git_branch_name,
            name: name.filter(|workspace_name| !workspace_name.is_empty()),
        },
        workspace_id,
    )
    .await?;

    Ok(workspace)
}

pub async fn create_workspace(
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<CreateWorkspaceApiRequest>,
) -> Result<ResponseJson<ApiResponse<Workspace>>, ApiError> {
    let workspace = create_workspace_record(&deployment, payload.name, None).await?;

    Ok(ResponseJson(ApiResponse::success(workspace)))
}

fn normalize_prompt(prompt: &str) -> Option<String> {
    let trimmed = prompt.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn escape_markdown_label(label: &str) -> String {
    let mut escaped = String::with_capacity(label.len());
    for ch in label.chars() {
        if matches!(ch, '[' | ']' | '\\') {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped
}

fn build_workspace_attachment_markdown(
    file: &ImportedIssueAttachment,
    label: &str,
    uses_image_markdown: bool,
) -> String {
    let path = format!(".vibe-attachments/{}", file.file.file_path);
    let normalized_label = if label.trim().is_empty() {
        file.file.original_name.as_str()
    } else {
        label
    };
    let escaped_label = escape_markdown_label(normalized_label);

    if uses_image_markdown {
        format!("![{}]({})", escaped_label, path)
    } else {
        format!("[{}]({})", escaped_label, path)
    }
}

struct ParsedAttachmentMarkdown<'a> {
    attachment_id: Uuid,
    label: &'a str,
    uses_image_markdown: bool,
    end: usize,
}

fn find_unescaped_char(haystack: &str, target: char) -> Option<usize> {
    let mut escaped = false;

    for (index, ch) in haystack.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }

        if ch == '\\' {
            escaped = true;
            continue;
        }

        if ch == target {
            return Some(index);
        }
    }

    None
}

fn parse_attachment_markdown_at(
    prompt: &str,
    start: usize,
) -> Option<ParsedAttachmentMarkdown<'_>> {
    let rest = prompt.get(start..)?;
    let (uses_image_markdown, label_start_offset) = if rest.starts_with("![") {
        (true, 2)
    } else if rest.starts_with('[') {
        (false, 1)
    } else {
        return None;
    };

    let label_rest = rest.get(label_start_offset..)?;
    let label_end_offset = find_unescaped_char(label_rest, ']')?;
    let label = &label_rest[..label_end_offset];

    let after_label = label_rest.get(label_end_offset + 1..)?;
    let attachment_prefix = "(attachment://";
    if !after_label.starts_with(attachment_prefix) {
        return None;
    }

    let attachment_id_start =
        start + label_start_offset + label_end_offset + 1 + attachment_prefix.len();
    let attachment_id_rest = prompt.get(attachment_id_start..)?;
    let attachment_id_end_offset = attachment_id_rest.find(')')?;
    let attachment_id = Uuid::parse_str(&attachment_id_rest[..attachment_id_end_offset]).ok()?;

    Some(ParsedAttachmentMarkdown {
        attachment_id,
        label,
        uses_image_markdown,
        end: attachment_id_start + attachment_id_end_offset + 1,
    })
}

fn rewrite_imported_issue_attachments_markdown(
    prompt: &str,
    imported_attachments: &[ImportedIssueAttachment],
) -> String {
    if imported_attachments.is_empty() {
        return prompt.to_string();
    }

    let imported_by_attachment_id = imported_attachments
        .iter()
        .map(|attachment| (attachment.attachment_id, attachment))
        .collect::<HashMap<_, _>>();
    let mut rewritten = String::with_capacity(prompt.len());
    let mut index = 0;

    while index < prompt.len() {
        if let Some(parsed) = parse_attachment_markdown_at(prompt, index)
            && let Some(attachment) = imported_by_attachment_id.get(&parsed.attachment_id)
        {
            rewritten.push_str(&build_workspace_attachment_markdown(
                attachment,
                parsed.label,
                parsed.uses_image_markdown,
            ));
            index = parsed.end;
            continue;
        }

        let Some(ch) = prompt[index..].chars().next() else {
            break;
        };
        rewritten.push(ch);
        index += ch.len_utf8();
    }

    rewritten
}

/// Validate the requested working-branch setup against the repos and return the
/// branch name to use as the workspace's working branch (`None` = auto-generate).
///
/// - `New`: a fresh branch forked from each repo's target branch. Rejected when
///   the name collides with an existing *local* branch (a remote-only name can
///   still be forked into a fresh local branch).
/// - `Existing`: continue work on an existing branch (single-repo only). A local
///   branch is reused as-is; a remote-tracking selection (`origin/<name>`, the
///   form the branch picker surfaces) is materialized into a local tracking
///   branch so the worktree checks out a real branch instead of a detached HEAD.
///   Rejected when the branch is missing or already checked out elsewhere.
async fn resolve_working_branch(
    deployment: &DeploymentImpl,
    repos: &[WorkspaceRepoInput],
    working_branch: WorkingBranchInput,
) -> Result<Option<String>, ApiError> {
    let (name, reuse_existing) = match working_branch {
        WorkingBranchInput::Auto => return Ok(None),
        WorkingBranchInput::New { name } => (name, false),
        WorkingBranchInput::Existing { name } => (name, true),
    };

    let branch = name.trim();
    if branch.is_empty() {
        return Err(ApiError::BadRequest(
            "Working branch name must not be empty".to_string(),
        ));
    }

    let git = deployment.git();

    // Validate the name server-side too — the client-side check only covers the
    // local UI, not the MCP/API or older clients.
    if !git.is_branch_name_valid(branch) {
        return Err(ApiError::BadRequest(format!(
            "'{branch}' is not a valid git branch name"
        )));
    }

    // New branch: forked from each repo's target branch. Reject only when the
    // name collides with an existing *local* branch.
    if !reuse_existing {
        for repo_input in repos {
            let repo = Repo::find_by_id(&deployment.db().pool, repo_input.repo_id)
                .await?
                .ok_or_else(|| ApiError::BadRequest("Repository not found".to_string()))?;
            if git
                .check_local_branch_exists(&repo.path, branch)
                .map_err(|e| ApiError::BadRequest(e.to_string()))?
            {
                return Err(ApiError::BadRequest(format!(
                    "Branch '{branch}' already exists in repository '{}'",
                    repo.name
                )));
            }
        }
        return Ok(Some(branch.to_string()));
    }

    // Continue-work on an existing branch — single repo only.
    if repos.len() != 1 {
        return Err(ApiError::BadRequest(
            "Reusing an existing branch is only supported for single-repo workspaces".to_string(),
        ));
    }
    let repo = Repo::find_by_id(&deployment.db().pool, repos[0].repo_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Repository not found".to_string()))?;

    let working = if git
        .check_local_branch_exists(&repo.path, branch)
        .map_err(|e| ApiError::BadRequest(e.to_string()))?
    {
        // A real local branch — check it out as-is.
        branch.to_string()
    } else {
        // Not a local branch. The picker surfaces remote branches as
        // `<remote>/<name>`; handing that straight to `git worktree add` would
        // check out a detached HEAD. Materialize a local branch tracking the
        // remote one so the worktree lands on a real branch.
        if !git
            .check_branch_exists(&repo.path, branch)
            .map_err(|e| ApiError::BadRequest(e.to_string()))?
        {
            return Err(ApiError::BadRequest(format!(
                "Branch '{branch}' does not exist in repository '{}'",
                repo.name
            )));
        }
        let local_name = strip_remote_prefix(git, &repo.path, branch)
            .map_err(|e| ApiError::BadRequest(e.to_string()))?;
        if !git
            .check_local_branch_exists(&repo.path, &local_name)
            .map_err(|e| ApiError::BadRequest(e.to_string()))?
        {
            git.create_branch(&repo.path, &local_name, branch)
                .map_err(|e| ApiError::BadRequest(e.to_string()))?;
        }
        local_name
    };

    // Git allows a branch in only one worktree at a time; reject up front rather
    // than failing late inside worktree creation.
    if git
        .is_branch_checked_out(&repo.path, &working)
        .map_err(|e| ApiError::BadRequest(e.to_string()))?
    {
        return Err(ApiError::BadRequest(format!(
            "Branch '{working}' is already checked out in another worktree"
        )));
    }

    Ok(Some(working))
}

/// For "feature branch" target modes (`create_target_branch`), make sure the
/// requested `target_branch` exists as a local branch before the workspace's
/// working branch forks from it. When missing, it's created off the repo's
/// configured default branch (`Repo::default_target_branch`, falling back to the
/// repo's current branch). An already-existing branch is reused as-is, so
/// multiple workspaces can share one feature branch.
async fn ensure_feature_target_branch(
    deployment: &DeploymentImpl,
    repo_input: &WorkspaceRepoInput,
) -> Result<(), ApiError> {
    if !repo_input.create_target_branch {
        return Ok(());
    }

    let target = repo_input.target_branch.trim();
    if target.is_empty() {
        return Err(ApiError::BadRequest(
            "Target branch name must not be empty".to_string(),
        ));
    }

    let git = deployment.git();
    if !git.is_branch_name_valid(target) {
        return Err(ApiError::BadRequest(format!(
            "'{target}' is not a valid git branch name"
        )));
    }

    let repo = Repo::find_by_id(&deployment.db().pool, repo_input.repo_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Repository not found".to_string()))?;

    // Reuse an existing local branch (shared feature branch across workspaces).
    if git
        .check_local_branch_exists(&repo.path, target)
        .map_err(|e| ApiError::BadRequest(e.to_string()))?
    {
        return Ok(());
    }

    // Fork a fresh feature branch from the repo's default branch.
    let base = match repo.default_target_branch.as_deref() {
        Some(base) if !base.trim().is_empty() => base.trim().to_string(),
        _ => git
            .get_current_branch(&repo.path)
            .map_err(|e| ApiError::BadRequest(e.to_string()))?,
    };

    if let Err(e) = git.create_branch(&repo.path, target, &base) {
        // A concurrent workspace-create targeting the same shared feature branch
        // can win the race between the existence check above and this create.
        // If the branch now exists, treat it as success (shared feature branch);
        // otherwise surface the real failure.
        if git
            .check_local_branch_exists(&repo.path, target)
            .unwrap_or(false)
        {
            return Ok(());
        }
        return Err(ApiError::BadRequest(format!(
            "Failed to create feature branch '{target}' from '{base}' in repository '{}': {e}",
            repo.name
        )));
    }

    Ok(())
}

/// Strip a leading `<remote>/` from a remote-tracking branch name (e.g.
/// `origin/feature` -> `feature`) so a local tracking branch can be forked from
/// it. Returns the name unchanged when it matches no configured remote.
fn strip_remote_prefix(
    git: &GitService,
    repo_path: &std::path::Path,
    branch: &str,
) -> Result<String, git::GitServiceError> {
    for remote in git.list_remotes(repo_path)? {
        if let Some(stripped) = branch.strip_prefix(&format!("{}/", remote.name)) {
            return Ok(stripped.to_string());
        }
    }
    Ok(branch.to_string())
}

/// Resolve a repo's target branch to the GitHub issue's linked branch: reuse the
/// issue's existing linked branch, or create one on GitHub (the "Create a branch
/// for this issue" equivalent) forked from `base_branch`'s tip on the remote.
/// The branch is fetched and materialized as a local branch, and its (plain)
/// name is returned so the working branch can fork from it and PRs can merge into
/// it. `base_branch` is the incoming target (e.g. `origin/develop`), used only as
/// the fork base for a newly created linked branch.
async fn resolve_github_linked_target_branch(
    deployment: &DeploymentImpl,
    repo_id: Uuid,
    base_branch: &str,
    gh: &GithubLinkedBranchInput,
) -> Result<String, ApiError> {
    let repo = Repo::find_by_id(&deployment.db().pool, repo_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Repository not found".to_string()))?;

    let git = deployment.git();
    let remote = git.get_default_remote(&repo.path).map_err(|e| {
        ApiError::BadRequest(format!(
            "Could not determine the default remote for '{}': {e}",
            repo.name
        ))
    })?;

    let provider = GitHubProvider::new().map_err(|e| ApiError::BadRequest(e.to_string()))?;

    // Guard: the checkout must be the GitHub repo the issue lives in, otherwise
    // the linked branch (and its base commit) would resolve against the wrong
    // repository.
    let actual_repo = provider
        .repo_spec(&remote.url, &repo.path)
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    if !actual_repo.eq_ignore_ascii_case(gh.repository.trim()) {
        return Err(ApiError::BadRequest(format!(
            "Repository '{}' is not a clone of the GitHub issue's repository '{}'",
            actual_repo,
            gh.repository.trim()
        )));
    }

    // Reuse an existing linked branch when the issue already has one.
    let existing = provider
        .list_issue_linked_branches(&remote.url, &repo.path, &gh.issue_node_id)
        .await
        .map_err(|e| {
            ApiError::BadRequest(format!(
                "Failed to query the issue's GitHub linked branches: {e}"
            ))
        })?;

    let branch_name = if let Some(name) = existing.into_iter().next() {
        tracing::info!(
            "Reusing existing GitHub linked branch '{name}' for issue {}",
            gh.issue_node_id
        );
        name
    } else {
        // Fork a new linked branch from the fork base's tip on the remote. The
        // base may be a remote-tracking selector (`origin/develop`), but GitHub's
        // `git/ref/heads/{branch}` API expects a plain branch name (`develop`),
        // so strip the remote prefix. Fall back to the repo's default target.
        let base = {
            let requested = base_branch.trim();
            if !requested.is_empty() {
                requested.to_string()
            } else {
                repo.default_target_branch
                    .as_deref()
                    .map(str::trim)
                    .filter(|b| !b.is_empty())
                    .ok_or_else(|| {
                        ApiError::BadRequest(
                            "No base branch to fork the GitHub linked branch from".to_string(),
                        )
                    })?
                    .to_string()
            }
        };
        let base = strip_remote_prefix(git, &repo.path, &base)
            .map_err(|e| ApiError::BadRequest(e.to_string()))?;
        let oid = provider
            .resolve_remote_branch_oid(&remote.url, &repo.path, &base)
            .await
            .map_err(|e| {
                ApiError::BadRequest(format!(
                    "Failed to resolve base branch '{base}' on the remote: {e}"
                ))
            })?;
        let created = provider
            .create_issue_linked_branch(&remote.url, &repo.path, &gh.issue_node_id, &oid, None)
            .await
            .map_err(|e| {
                ApiError::BadRequest(format!("Failed to create the GitHub linked branch: {e}"))
            })?;
        tracing::info!(
            "Created GitHub linked branch '{created}' for issue {} from {base}@{oid}",
            gh.issue_node_id
        );
        created
    };

    // Materialize the branch locally so the working branch can fork from it.
    git.fetch_remote(&repo.path, &remote.name).map_err(|e| {
        ApiError::BadRequest(format!(
            "Failed to fetch '{}' after resolving the linked branch: {e}",
            remote.name
        ))
    })?;
    let local_exists = git
        .check_local_branch_exists(&repo.path, &branch_name)
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    if !local_exists {
        git.create_branch(
            &repo.path,
            &branch_name,
            &format!("{}/{}", remote.name, branch_name),
        )
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    }

    Ok(branch_name)
}

async fn create_workspace_with_repos(
    deployment: &DeploymentImpl,
    name: Option<String>,
    mut repos: Vec<WorkspaceRepoInput>,
    linked_issue: Option<&LinkedIssueInfo>,
    attachment_ids: Option<Vec<Uuid>>,
    pr_review: Option<&PrReviewInput>,
    working_branch: WorkingBranchInput,
) -> Result<ManagedWorkspace, ApiError> {
    if repos.is_empty() {
        return Err(ApiError::BadRequest(
            "At least one repository is required".to_string(),
        ));
    }

    let managed_workspace = match review_mode::plan_branch_setup(&repos, pr_review)
        .map_err(|e| ApiError::BadRequest(e.to_string()))?
    {
        // Default: a working branch forked from each repo's selected target
        // branch — auto-named, or an explicit/existing name per `working_branch`.
        BranchSetup::NewWorktreeBranch => {
            // Point any GitHub-issue-linked repo's target branch at the issue's
            // linked branch (reused or created), which the working branch then
            // forks from and PRs merge into. Working-branch setup is unaffected.
            for repo in repos.iter_mut() {
                if let Some(gh) = repo.github_linked_branch.take() {
                    let base = repo.target_branch.clone();
                    let linked =
                        resolve_github_linked_target_branch(deployment, repo.repo_id, &base, &gh)
                            .await?;
                    repo.target_branch = linked;
                    repo.create_target_branch = false;
                }
            }
            let branch_override =
                resolve_working_branch(deployment, &repos, working_branch).await?;
            let mut managed_workspace = deployment
                .workspace_manager()
                .load_managed_workspace(
                    create_workspace_record(deployment, name, branch_override).await?,
                )
                .await?;

            for repo in &repos {
                // Materialize a "new"/"auto" feature target branch (off the
                // repo's default branch) before the working branch forks from it.
                ensure_feature_target_branch(deployment, repo).await?;
                managed_workspace
                    .add_repository(repo, deployment.git())
                    .await
                    .map_err(ApiError::from)?;
            }

            managed_workspace
        }
        // Review mode: check out the existing PR head branch directly and link
        // the PR, instead of branching a new `vk/` worktree.
        BranchSetup::ExistingPrBranch(review) => {
            let workspace = match pr::setup_pr_review_workspace(deployment, name, review).await? {
                Ok(workspace) => workspace,
                Err(BranchFetchFailure { message }) => {
                    return Err(ApiError::BadRequest(format!(
                        "Failed to check out PR #{} branch for review: {message}",
                        review.pr_number
                    )));
                }
            };

            deployment
                .workspace_manager()
                .load_managed_workspace(workspace)
                .await?
        }
    };

    if let Some(ids) = &attachment_ids {
        managed_workspace.associate_attachments(ids).await?;
    }

    let workspace = &managed_workspace.workspace;
    tracing::info!("Created workspace {}", workspace.id);

    // Mirror the linked issue onto the workspace row so local issue-aware flows
    // can detect it even before any agent execution exists.
    if let Some(linked_issue) = linked_issue
        && let Err(e) = Workspace::set_task_id(
            &deployment.db().pool,
            workspace.id,
            Some(linked_issue.issue_id),
        )
        .await
    {
        tracing::warn!("Failed to set task_id on workspace {}: {}", workspace.id, e);
    }

    Ok(managed_workspace)
}

pub async fn create_workspace_without_starting(
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<CreateWorkspaceWithoutStartingRequest>,
) -> Result<ResponseJson<ApiResponse<CreateWorkspaceWithoutStartingResponse>>, ApiError> {
    let CreateWorkspaceWithoutStartingRequest {
        name,
        repos,
        linked_issue,
        attachment_ids,
        pr_review,
        working_branch,
    } = payload;

    let managed_workspace = create_workspace_with_repos(
        &deployment,
        name,
        repos,
        linked_issue.as_ref(),
        attachment_ids,
        pr_review.as_ref(),
        working_branch,
    )
    .await?;
    let workspace = managed_workspace.workspace;

    Ok(ResponseJson(ApiResponse::success(
        CreateWorkspaceWithoutStartingResponse { workspace },
    )))
}

pub async fn create_and_start_workspace(
    State(deployment): State<DeploymentImpl>,
    headers: HeaderMap,
    Json(payload): Json<CreateAndStartWorkspaceRequest>,
) -> Result<ResponseJson<ApiResponse<CreateAndStartWorkspaceResponse>>, ApiError> {
    let pool = deployment.db().pool.clone();
    let key = match crate::routes::automation::claim_action::<
        ApiResponse<CreateAndStartWorkspaceResponse>,
    >(&pool, &headers, "start_workspace")
    .await?
    {
        crate::routes::automation::ActionClaim::Execute(key) => key,
        crate::routes::automation::ActionClaim::Replay(response) => {
            return Ok(ResponseJson(response));
        }
    };
    let result = create_and_start_workspace_inner(State(deployment), Json(payload)).await;
    match &result {
        Ok(response) => {
            crate::routes::automation::complete_action(&pool, key.as_deref(), &response.0).await?
        }
        // An error can happen after the workspace or execution record exists.
        // Keep the claim so an automatic retry cannot duplicate that side effect.
        Err(_) => {}
    }
    result
}

async fn create_and_start_workspace_inner(
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<CreateAndStartWorkspaceRequest>,
) -> Result<ResponseJson<ApiResponse<CreateAndStartWorkspaceResponse>>, ApiError> {
    let CreateAndStartWorkspaceRequest {
        name,
        repos,
        linked_issue,
        mut executor_config,
        prompt,
        attachment_ids,
        pr_review,
        working_branch,
    } = payload;

    let mut workspace_prompt = normalize_prompt(&prompt).ok_or_else(|| {
        ApiError::BadRequest(
            "A workspace prompt is required. Provide a non-empty `prompt`.".to_string(),
        )
    })?;

    let managed_workspace = create_workspace_with_repos(
        &deployment,
        name,
        repos,
        linked_issue.as_ref(),
        attachment_ids,
        pr_review.as_ref(),
        working_branch,
    )
    .await?;

    if let Some(linked_issue) = &linked_issue
        && let Ok(client) = deployment.remote_client()
    {
        match import_issue_attachments_from_remote(
            &client,
            deployment.file(),
            linked_issue.issue_id,
        )
        .await
        {
            Ok(imported_attachments) if !imported_attachments.is_empty() => {
                let imported_ids = imported_attachments
                    .iter()
                    .map(|imported| imported.file.id)
                    .collect::<Vec<_>>();

                if let Err(e) = managed_workspace.associate_attachments(&imported_ids).await {
                    tracing::warn!("Failed to associate imported files with workspace: {}", e);
                }

                workspace_prompt = rewrite_imported_issue_attachments_markdown(
                    &workspace_prompt,
                    &imported_attachments,
                );

                tracing::info!(
                    "Imported {} files from issue {}",
                    imported_ids.len(),
                    linked_issue.issue_id
                );
            }
            Ok(_) => {}
            Err(e) => {
                tracing::warn!(
                    "Failed to import issue attachments for issue {}: {}",
                    linked_issue.issue_id,
                    e
                );
            }
        }
    }

    let workspace = managed_workspace.workspace.clone();

    // A review-mode workspace (checked out from an existing PR's head branch)
    // means the issue is now actively under review, so move it to "In review"
    // here. The remote intentionally skips the PR-open → "In review" transition
    // for `review`-tagged issues so the move lands at workspace creation instead.
    if pr_review.is_some()
        && let Some(linked) = &linked_issue
        && let Ok(client) = deployment.remote_client()
    {
        match client.mark_issue_for_review(linked.issue_id).await {
            Ok(()) => {
                // The remote pushes an `issue_review_requested` notification to
                // the user's remote subscriptions (phone). Mirror that to this
                // host's LOCAL subscriptions (e.g. a desktop browser paired via
                // the local server), which the remote push never reaches. Local
                // only, to avoid double-notifying remote devices.
                let name = workspace.name.as_deref().unwrap_or(&workspace.branch);
                deployment
                    .container()
                    .notification_service()
                    .notify_local_only(
                        "Ready for review",
                        &format!("'{name}' is ready for review"),
                        Some(workspace.id),
                    )
                    .await;
            }
            Err(e) => {
                tracing::warn!(
                    "Failed to mark issue {} In review after review-mode workspace creation: {}",
                    linked.issue_id,
                    e
                );
            }
        }
    }

    // If the linked issue carries the `vibe` tag, opt this run into the
    // automated workflow: force permission_policy=DontAsk so approvals and
    // agent questions never block,
    // and append the self-report instruction so the agent emits a `VIBE_RESULT:`
    // sentinel the backend acts on. Applies to the deferred-spawn (blocker)
    // path too, since the action below is built from these values.
    if let Some(linked) = &linked_issue
        && let Ok(client) = deployment.remote_client()
    {
        match vibe_tags::has_issue_tag_named(&client, linked.issue_id, vibe_orchestrator::TAG_VIBE)
            .await
        {
            Ok(true) => {
                executor_config.permission_policy = Some(PermissionPolicy::DontAsk);
                workspace_prompt = vibe_orchestrator::with_coding_preamble(&workspace_prompt);
                tracing::info!(
                    "vibe: enabled automated workflow for issue {}",
                    linked.issue_id
                );
            }
            Ok(false) => {}
            // Distinguish "not a vibe issue" from "couldn't determine": swallowing
            // the error would silently spawn a genuine vibe issue as an ordinary
            // one-shot session (no preamble, no Auto policy), so the workflow
            // would never engage or recover. Surface it instead.
            Err(e) => {
                tracing::warn!(
                    "vibe: could not determine vibe tag for issue {} ({e}); \
                     spawning as a non-vibe session",
                    linked.issue_id
                );
            }
        }
    }

    // Blocker gating for the very first execution. When the linked issue has
    // unresolved blockers, build the full setup+coding-agent action chain and
    // persist the execution_process row, but skip the spawn. A background
    // watcher resumes it once every blocker reaches a resolved status.
    let gated_blocker = match &linked_issue {
        Some(linked) => match deployment.remote_client() {
            Ok(client) => match issue_gating::unresolved_blockers(&client, linked.issue_id).await {
                Ok(blockers) if !blockers.is_empty() => Some((linked.issue_id, blockers.len())),
                Ok(_) => None,
                Err(e) => {
                    tracing::warn!(
                        "Failed to evaluate blockers for issue {} (proceeding with spawn): {}",
                        linked.issue_id,
                        e
                    );
                    None
                }
            },
            Err(_) => None,
        },
        None => None,
    };

    let execution_process = if let Some((task_id, blocker_count)) = gated_blocker {
        let (session, record, main_action) = deployment
            .container()
            .start_workspace_deferred(&workspace, executor_config.clone(), workspace_prompt)
            .await?;

        match PendingExecutionStart::create(
            &deployment.db().pool,
            record.id,
            workspace.id,
            session.id,
            task_id,
        )
        .await
        {
            Ok(_) => {
                tracing::info!(
                    "Deferred initial execution {} for workspace {} due to {} unresolved blocker(s)",
                    record.id,
                    workspace.id,
                    blocker_count
                );
            }
            Err(e) => {
                tracing::error!(
                    "Failed to register pending execution for process {} (spawning immediately): {}",
                    record.id,
                    e
                );
                deployment
                    .container()
                    .finish_execution_spawn(&workspace, &session, &record, &main_action)
                    .await?;
            }
        }

        record
    } else {
        deployment
            .container()
            .start_workspace(&workspace, executor_config.clone(), workspace_prompt)
            .await?
    };

    Ok(ResponseJson(ApiResponse::success(
        CreateAndStartWorkspaceResponse {
            workspace,
            execution_process,
        },
    )))
}

/// "Quick chat": create a lightweight in-place workspace and immediately run a
/// coding agent inside the repo's existing checkout — no `vk/` worktree, no new
/// branch, no setup/cleanup scripts. The agent's edits stay uncommitted in the
/// user's working tree, and the workspace is excluded from destructive cleanup
/// (see `Workspace::in_place`).
pub async fn create_and_start_quick_chat(
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<CreateQuickChatRequest>,
) -> Result<ResponseJson<ApiResponse<CreateAndStartWorkspaceResponse>>, ApiError> {
    let CreateQuickChatRequest {
        repo_id,
        executor_config,
        prompt,
        name,
    } = payload;

    let prompt = normalize_prompt(&prompt).ok_or_else(|| {
        ApiError::BadRequest("A prompt is required. Provide a non-empty `prompt`.".to_string())
    })?;

    let repo = Repo::find_by_id(&deployment.db().pool, repo_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Repository not found".to_string()))?;

    // The agent runs directly in the repo's current checkout. Capture its current
    // branch for display (no checkout happens) and reuse it as the diff base so
    // the Changes view surfaces exactly the chat's uncommitted edits.
    let current_branch = deployment
        .git()
        .get_current_branch(&repo.path)
        .map_err(|e| {
            ApiError::BadRequest(format!(
                "Could not determine the current branch of '{}': {e}",
                repo.name
            ))
        })?;

    let container_ref = repo.path.to_string_lossy().to_string();
    let workspace = Workspace::create_in_place(
        &deployment.db().pool,
        &CreateWorkspace {
            branch: current_branch.clone(),
            name,
        },
        Uuid::new_v4(),
        &container_ref,
    )
    .await?;

    let mut managed_workspace = deployment
        .workspace_manager()
        .load_managed_workspace(workspace)
        .await?;
    managed_workspace
        .add_repository(
            &WorkspaceRepoInput {
                repo_id,
                target_branch: current_branch,
                create_target_branch: false,
                github_linked_branch: None,
            },
            deployment.git(),
        )
        .await
        .map_err(ApiError::from)?;

    let workspace = managed_workspace.workspace.clone();
    tracing::info!(
        "Created in-place quick-chat workspace {} at {}",
        workspace.id,
        container_ref
    );

    let execution_process = deployment
        .container()
        .start_workspace(&workspace, executor_config.clone(), prompt)
        .await?;

    Ok(ResponseJson(ApiResponse::success(
        CreateAndStartWorkspaceResponse {
            workspace,
            execution_process,
        },
    )))
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use db::models::file::File;
    use uuid::Uuid;

    use super::{ImportedIssueAttachment, rewrite_imported_issue_attachments_markdown};

    fn imported_file(
        attachment_id: Uuid,
        original_name: &str,
        file_path: &str,
        mime_type: Option<&str>,
    ) -> ImportedIssueAttachment {
        ImportedIssueAttachment {
            attachment_id,
            file: File {
                id: Uuid::new_v4(),
                file_path: file_path.to_string(),
                original_name: original_name.to_string(),
                mime_type: mime_type.map(str::to_string),
                size_bytes: 123,
                hash: "hash".to_string(),
                created_at: Utc::now(),
                updated_at: Utc::now(),
            },
        }
    }

    #[test]
    fn rewrites_imported_non_image_attachment_links() {
        let attachment_id = Uuid::new_v4();
        let prompt = format!("[proposal.pdf](attachment://{})", attachment_id);
        let imported = vec![imported_file(
            attachment_id,
            "proposal.pdf",
            "abc_proposal.pdf",
            Some("application/pdf"),
        )];

        let rewritten = rewrite_imported_issue_attachments_markdown(&prompt, &imported);

        assert_eq!(
            rewritten,
            "[proposal.pdf](.vibe-attachments/abc_proposal.pdf)"
        );
    }

    #[test]
    fn preserves_authored_image_markdown_for_imported_images() {
        let attachment_id = Uuid::new_v4();
        let prompt = format!("![diagram.png](attachment://{})", attachment_id);
        let imported = vec![imported_file(
            attachment_id,
            "diagram.png",
            "xyz_diagram.png",
            Some("image/png"),
        )];

        let rewritten = rewrite_imported_issue_attachments_markdown(&prompt, &imported);

        assert_eq!(
            rewritten,
            "![diagram.png](.vibe-attachments/xyz_diagram.png)"
        );
    }

    #[test]
    fn preserves_authored_link_markdown_for_imported_images() {
        let attachment_id = Uuid::new_v4();
        let prompt = format!("[diagram.png](attachment://{})", attachment_id);
        let imported = vec![imported_file(
            attachment_id,
            "diagram.png",
            "xyz_diagram.png",
            Some("image/png"),
        )];

        let rewritten = rewrite_imported_issue_attachments_markdown(&prompt, &imported);

        assert_eq!(
            rewritten,
            "[diagram.png](.vibe-attachments/xyz_diagram.png)"
        );
    }

    #[test]
    fn preserves_authored_image_markdown_for_imported_non_images() {
        let attachment_id = Uuid::new_v4();
        let prompt = format!("![proposal.pdf](attachment://{})", attachment_id);
        let imported = vec![imported_file(
            attachment_id,
            "proposal.pdf",
            "abc_proposal.pdf",
            Some("application/pdf"),
        )];

        let rewritten = rewrite_imported_issue_attachments_markdown(&prompt, &imported);

        assert_eq!(
            rewritten,
            "![proposal.pdf](.vibe-attachments/abc_proposal.pdf)"
        );
    }

    #[test]
    fn leaves_unknown_attachment_references_unchanged() {
        let prompt = format!("[proposal.pdf](attachment://{})", Uuid::new_v4());
        let imported = vec![imported_file(
            Uuid::new_v4(),
            "proposal.pdf",
            "abc_proposal.pdf",
            Some("application/pdf"),
        )];

        let rewritten = rewrite_imported_issue_attachments_markdown(&prompt, &imported);

        assert_eq!(rewritten, prompt);
    }

    #[test]
    fn rewrites_multiple_attachments_and_leaves_other_links_alone() {
        let image_attachment_id = Uuid::new_v4();
        let file_attachment_id = Uuid::new_v4();
        let prompt = format!(
            "See [doc.pdf](attachment://{}) and ![shot.png](attachment://{}). https://example.com",
            file_attachment_id, image_attachment_id
        );
        let imported = vec![
            imported_file(
                file_attachment_id,
                "doc.pdf",
                "doc_file.pdf",
                Some("application/pdf"),
            ),
            imported_file(
                image_attachment_id,
                "shot.png",
                "shot_file.png",
                Some("image/png"),
            ),
        ];

        let rewritten = rewrite_imported_issue_attachments_markdown(&prompt, &imported);

        assert_eq!(
            rewritten,
            "See [doc.pdf](.vibe-attachments/doc_file.pdf) and ![shot.png](.vibe-attachments/shot_file.png). https://example.com"
        );
    }
}
