use std::collections::HashMap;

use axum::{Json, extract::State, response::Json as ResponseJson};
use db::models::{
    pending_execution_start::PendingExecutionStart,
    repo::Repo,
    requests::{
        CreateAndStartWorkspaceRequest, CreateAndStartWorkspaceResponse, CreateWorkspaceApiRequest,
        CreateWorkspaceWithoutStartingRequest, CreateWorkspaceWithoutStartingResponse,
        LinkedIssueInfo, PrReviewInput, WorkingBranchInput, WorkspaceRepoInput,
    },
    workspace::{CreateWorkspace, Workspace},
};
use deployment::Deployment;
use executors::model_selector::PermissionPolicy;
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

    deployment
        .track_if_analytics_allowed(
            "workspace_created",
            serde_json::json!({
                "workspace_id": workspace.id.to_string(),
            }),
        )
        .await;

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
/// branch-name override to use (`None` = auto-generate). Enforces the conflict
/// and existence rules: a `New` name must not already exist in any repo; an
/// `Existing` name must exist and is single-repo only.
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

    if reuse_existing && repos.len() != 1 {
        return Err(ApiError::BadRequest(
            "Reusing an existing branch is only supported for single-repo workspaces".to_string(),
        ));
    }

    for repo_input in repos {
        let repo = Repo::find_by_id(&deployment.db().pool, repo_input.repo_id)
            .await?
            .ok_or_else(|| ApiError::BadRequest("Repository not found".to_string()))?;
        let exists = deployment
            .git()
            .check_branch_exists(&repo.path, branch)
            .map_err(|e| ApiError::BadRequest(e.to_string()))?;
        if reuse_existing && !exists {
            return Err(ApiError::BadRequest(format!(
                "Branch '{branch}' does not exist in repository '{}'",
                repo.name
            )));
        }
        if !reuse_existing && exists {
            return Err(ApiError::BadRequest(format!(
                "Branch '{branch}' already exists in repository '{}'",
                repo.name
            )));
        }
    }

    Ok(Some(branch.to_string()))
}

async fn create_workspace_with_repos(
    deployment: &DeploymentImpl,
    name: Option<String>,
    repos: Vec<WorkspaceRepoInput>,
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
            let branch_override =
                resolve_working_branch(deployment, &repos, working_branch).await?;
            let mut managed_workspace = deployment
                .workspace_manager()
                .load_managed_workspace(
                    create_workspace_record(deployment, name, branch_override).await?,
                )
                .await?;

            for repo in &repos {
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
        working_branch,
    } = payload;

    let managed_workspace = create_workspace_with_repos(
        &deployment,
        name,
        repos,
        linked_issue.as_ref(),
        attachment_ids,
        None,
        working_branch,
    )
    .await?;
    let workspace = managed_workspace.workspace;

    deployment
        .track_if_analytics_allowed(
            "workspace_created_without_starting",
            serde_json::json!({
                "workspace_id": workspace.id.to_string(),
            }),
        )
        .await;

    Ok(ResponseJson(ApiResponse::success(
        CreateWorkspaceWithoutStartingResponse { workspace },
    )))
}

pub async fn create_and_start_workspace(
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

    // If the linked issue carries the `vibe` tag, opt this run into the
    // automated workflow: force permission_policy=Auto so approvals never block,
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
                executor_config.permission_policy = Some(PermissionPolicy::Auto);
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

    deployment
        .track_if_analytics_allowed(
            "workspace_created_and_started",
            serde_json::json!({
                "executor": &executor_config.executor,
                "variant": &executor_config.variant,
                "workspace_id": workspace.id.to_string(),
            }),
        )
        .await;

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
