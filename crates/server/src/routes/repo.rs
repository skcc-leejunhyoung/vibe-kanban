use std::path::PathBuf;

use axum::{
    Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::Json as ResponseJson,
    routing::{get, post},
};
use db::models::repo::{Repo, SearchResult, UpdateRepo};
use deployment::Deployment;
use git::{GitBranch, GitRemote};
use git_host::{
    GitHostError, GitHostProvider, GitHostService, ProviderKind, PullRequestDetail,
    PullRequestSummary, github::GitHubProvider,
};
use serde::{Deserialize, Serialize};
use services::services::file_search::SearchQuery;
use ts_rs::TS;
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{
    DeploymentImpl,
    error::ApiError,
    routes::workspaces::pr::{GetPrCommentsError, PrCommentsResponse},
};

#[derive(serde::Deserialize)]
pub struct OpenEditorRequest {
    pub editor_type: Option<String>,
    pub git_repo_path: Option<PathBuf>,
    /// Whether the request originates from the remote web app. Used together
    /// with the editor's `remote_ssh_only_in_remote_web` setting.
    #[serde(default)]
    pub is_remote_web: Option<bool>,
}

#[derive(Debug, serde::Serialize, ts_rs::TS)]
pub struct OpenEditorResponse {
    pub url: Option<String>,
}

#[derive(Debug, Deserialize, TS)]
pub struct RegisterRepoRequest {
    pub path: String,
    pub display_name: Option<String>,
}

#[derive(Debug, Deserialize, TS)]
pub struct InitRepoRequest {
    pub parent_path: String,
    pub folder_name: String,
}

#[derive(Debug, Deserialize, TS)]
pub struct BatchRepoRequest {
    pub ids: Vec<Uuid>,
}

pub async fn register_repo(
    State(deployment): State<DeploymentImpl>,
    ResponseJson(payload): ResponseJson<RegisterRepoRequest>,
) -> Result<ResponseJson<ApiResponse<Repo>>, ApiError> {
    let repo = deployment
        .repo()
        .register(
            &deployment.db().pool,
            &payload.path,
            payload.display_name.as_deref(),
        )
        .await?;

    Ok(ResponseJson(ApiResponse::success(repo)))
}

pub async fn init_repo(
    State(deployment): State<DeploymentImpl>,
    ResponseJson(payload): ResponseJson<InitRepoRequest>,
) -> Result<ResponseJson<ApiResponse<Repo>>, ApiError> {
    let repo = deployment
        .repo()
        .init_repo(
            &deployment.db().pool,
            deployment.git(),
            &payload.parent_path,
            &payload.folder_name,
        )
        .await?;

    Ok(ResponseJson(ApiResponse::success(repo)))
}

#[derive(Debug, Deserialize)]
pub struct GetBranchesQuery {
    /// When true, fetch from the default remote before listing branches so the
    /// caller sees the latest branches pushed to origin. Best-effort: a failed
    /// fetch still returns the locally known branches.
    #[serde(default)]
    pub fetch: bool,
}

#[derive(Debug, Deserialize, TS)]
pub struct CreateLocalBranchRequest {
    /// Remote-tracking branch to materialize, for example `origin/feature`.
    pub remote_branch: String,
}

pub async fn get_repo_branches(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
    Query(query): Query<GetBranchesQuery>,
) -> Result<ResponseJson<ApiResponse<Vec<GitBranch>>>, ApiError> {
    let repo = deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await?;

    if query.fetch
        && let Err(e) = deployment.git().fetch_default_remote(&repo.path)
    {
        tracing::warn!(
            "Failed to fetch from default remote for repo {repo_id} before listing branches: {e}"
        );
    }

    let branches = deployment.git().get_all_branches(&repo.path)?;
    Ok(ResponseJson(ApiResponse::success(branches)))
}

pub async fn create_local_branch_from_remote(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
    ResponseJson(payload): ResponseJson<CreateLocalBranchRequest>,
) -> Result<ResponseJson<ApiResponse<String>>, ApiError> {
    let repo = deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await?;

    let local_branch = deployment
        .git()
        .ensure_local_branch_for_remote(&repo.path, &payload.remote_branch)?;
    Ok(ResponseJson(ApiResponse::success(local_branch)))
}

pub async fn get_repo_remotes(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<Vec<GitRemote>>>, ApiError> {
    let repo = deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await?;

    let remotes = deployment.git().list_remotes(&repo.path)?;
    Ok(ResponseJson(ApiResponse::success(remotes)))
}

/// Status of the repo's checked-out branch relative to its primary remote.
/// Drives the push/fetch buttons in repo settings.
#[derive(Debug, Serialize, TS)]
pub struct RepoRemoteStatus {
    /// Branch currently checked out at the repo path.
    pub current_branch: String,
    /// Resolved remote name (the repo's primary remote, or the git default
    /// remote when none is set). `None` when the repo has no remotes.
    pub remote: Option<String>,
    /// Whether the repo has any remote configured at all.
    pub remote_configured: bool,
    /// Whether `<remote>/<current_branch>` exists locally as a tracking ref.
    pub remote_branch_exists: bool,
    /// Commits the local branch is ahead of the remote (can be pushed).
    pub ahead: u32,
    /// Commits the local branch is behind the remote.
    pub behind: u32,
}

#[derive(Debug, Default, Deserialize, TS)]
pub struct PushRepoBranchRequest {
    #[serde(default)]
    pub force: bool,
}

/// Resolve the remote to use for push/fetch: the repo's saved primary remote,
/// falling back to the git default remote. Returns `None` when the repo has no
/// remotes configured.
pub(crate) fn resolve_primary_remote(deployment: &DeploymentImpl, repo: &Repo) -> Option<String> {
    resolve_primary_remote_with(deployment.git(), repo)
}

/// `resolve_primary_remote` for callers that only hold a `GitService` (e.g.
/// git work moved onto the blocking pool).
pub(crate) fn resolve_primary_remote_with(git: &git::GitService, repo: &Repo) -> Option<String> {
    if let Some(name) = repo.primary_remote.as_ref().filter(|n| !n.is_empty()) {
        return Some(name.clone());
    }
    git.get_default_remote(&repo.path).ok().map(|r| r.name)
}

fn compute_repo_remote_status(
    deployment: &DeploymentImpl,
    repo: &Repo,
) -> Result<RepoRemoteStatus, git::GitServiceError> {
    let git = deployment.git();
    let current_branch = git.get_current_branch(&repo.path)?;

    match resolve_primary_remote(deployment, repo) {
        Some(remote) => {
            let (remote_branch_exists, ahead, behind) =
                git.get_remote_tracking_status(&repo.path, &current_branch, &remote)?;
            Ok(RepoRemoteStatus {
                current_branch,
                remote: Some(remote),
                remote_configured: true,
                remote_branch_exists,
                ahead: ahead as u32,
                behind: behind as u32,
            })
        }
        None => Ok(RepoRemoteStatus {
            current_branch,
            remote: None,
            remote_configured: false,
            remote_branch_exists: false,
            ahead: 0,
            behind: 0,
        }),
    }
}

pub async fn get_repo_remote_status(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<RepoRemoteStatus>>, ApiError> {
    let repo = deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await?;
    let status = compute_repo_remote_status(&deployment, &repo)?;
    Ok(ResponseJson(ApiResponse::success(status)))
}

pub async fn fetch_repo_remote(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<RepoRemoteStatus>>, ApiError> {
    let repo = deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await?;

    let Some(remote) = resolve_primary_remote(&deployment, &repo) else {
        return Ok(ResponseJson(ApiResponse::error(
            "No remote configured for this repository",
        )));
    };

    if let Err(e) = deployment.git().fetch_remote(&repo.path, &remote) {
        tracing::error!("Fetch from remote '{remote}' for repo {repo_id} failed: {e}");
        return Ok(ResponseJson(ApiResponse::error(&e.to_string())));
    }

    let status = compute_repo_remote_status(&deployment, &repo)?;
    Ok(ResponseJson(ApiResponse::success(status)))
}

pub async fn push_repo_branch(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
    ResponseJson(payload): ResponseJson<Option<PushRepoBranchRequest>>,
) -> Result<ResponseJson<ApiResponse<RepoRemoteStatus>>, ApiError> {
    let repo = deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await?;

    let force = payload.unwrap_or_default().force;
    let git = deployment.git();
    let current_branch = git.get_current_branch(&repo.path)?;

    let Some(remote) = resolve_primary_remote(&deployment, &repo) else {
        return Ok(ResponseJson(ApiResponse::error(
            "No remote configured for this repository",
        )));
    };

    let no_verify = deployment.config().read().await.git_push_no_verify;
    if let Err(e) =
        git.push_branch_to_named_remote(&repo.path, &current_branch, &remote, force, no_verify)
    {
        tracing::error!(
            "Push of branch '{current_branch}' to '{remote}' for repo {repo_id} failed: {e}"
        );
        return Ok(ResponseJson(ApiResponse::error(&e.to_string())));
    }

    let status = compute_repo_remote_status(&deployment, &repo)?;
    Ok(ResponseJson(ApiResponse::success(status)))
}

pub async fn get_repos_batch(
    State(deployment): State<DeploymentImpl>,
    ResponseJson(payload): ResponseJson<BatchRepoRequest>,
) -> Result<ResponseJson<ApiResponse<Vec<Repo>>>, ApiError> {
    let repos = Repo::find_by_ids(&deployment.db().pool, &payload.ids).await?;
    Ok(ResponseJson(ApiResponse::success(repos)))
}

pub async fn get_repos(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<Vec<Repo>>>, ApiError> {
    let repos = Repo::list_all(&deployment.db().pool).await?;
    Ok(ResponseJson(ApiResponse::success(repos)))
}

pub async fn get_recent_repos(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<Vec<Repo>>>, ApiError> {
    let repos = Repo::list_by_recent_workspace_usage(&deployment.db().pool).await?;
    Ok(ResponseJson(ApiResponse::success(repos)))
}

pub async fn get_repo(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<Repo>>, ApiError> {
    let repo = deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await?;
    Ok(ResponseJson(ApiResponse::success(repo)))
}

pub async fn update_repo(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
    ResponseJson(payload): ResponseJson<UpdateRepo>,
) -> Result<ResponseJson<ApiResponse<Repo>>, ApiError> {
    let repo = Repo::update(&deployment.db().pool, repo_id, &payload).await?;
    Ok(ResponseJson(ApiResponse::success(repo)))
}

pub async fn open_repo_in_editor(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
    ResponseJson(payload): ResponseJson<Option<OpenEditorRequest>>,
) -> Result<ResponseJson<ApiResponse<OpenEditorResponse>>, ApiError> {
    let repo = deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await?;

    let editor_config = {
        let config = deployment.config().read().await;
        let editor_type_str = payload.as_ref().and_then(|req| req.editor_type.as_deref());
        config.editor.with_override(editor_type_str)
    };

    let is_remote_web = payload
        .as_ref()
        .and_then(|req| req.is_remote_web)
        .unwrap_or(false);
    match editor_config.open_file(&repo.path, is_remote_web).await {
        Ok(url) => {
            tracing::info!(
                "Opened editor for repo {} at path: {}{}",
                repo_id,
                repo.path.to_string_lossy(),
                if url.is_some() { " (remote mode)" } else { "" }
            );

            Ok(ResponseJson(ApiResponse::success(OpenEditorResponse {
                url,
            })))
        }
        Err(e) => {
            tracing::error!("Failed to open editor for repo {}: {:?}", repo_id, e);
            Err(ApiError::EditorOpen(e))
        }
    }
}

pub async fn search_repo(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
    Query(search_query): Query<SearchQuery>,
) -> Result<ResponseJson<ApiResponse<Vec<SearchResult>>>, StatusCode> {
    if search_query.q.trim().is_empty() {
        return Ok(ResponseJson(ApiResponse::error(
            "Query parameter 'q' is required and cannot be empty",
        )));
    }

    let repo = match deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await
    {
        Ok(repo) => repo,
        Err(e) => {
            tracing::error!("Failed to get repo {}: {}", repo_id, e);
            return Err(StatusCode::NOT_FOUND);
        }
    };

    match deployment
        .file_search_cache()
        .search_repo(&repo.path, &search_query.q, search_query.mode)
        .await
    {
        Ok(results) => Ok(ResponseJson(ApiResponse::success(results))),
        Err(e) => {
            tracing::error!("Failed to search files in repo {}: {}", repo_id, e);
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum ListPrsError {
    CliNotInstalled { provider: ProviderKind },
    AuthFailed { message: String },
    UnsupportedProvider,
}

#[derive(Debug, Deserialize)]
pub struct ListPrsQuery {
    pub remote: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ListPullRequestSummariesQuery {
    #[serde(default = "default_true")]
    pub involves_me: bool,
}

fn default_true() -> bool {
    true
}

pub async fn list_open_prs(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
    Query(query): Query<ListPrsQuery>,
) -> Result<ResponseJson<ApiResponse<Vec<PullRequestDetail>, ListPrsError>>, ApiError> {
    let repo = deployment
        .repo()
        .get_by_id(&deployment.db().pool, repo_id)
        .await?;

    let remote = match query.remote {
        Some(name) => GitRemote {
            url: deployment.git().get_remote_url(&repo.path, &name)?,
            name,
        },
        None => deployment.git().get_default_remote(&repo.path)?,
    };

    let git_host = match GitHostService::from_url(&remote.url) {
        Ok(host) => host,
        Err(GitHostError::UnsupportedProvider) => {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                ListPrsError::UnsupportedProvider,
            )));
        }
        Err(e) => {
            tracing::error!("Failed to create git host service: {}", e);
            return Ok(ResponseJson(ApiResponse::error(&e.to_string())));
        }
    };

    match git_host.list_open_prs(&repo.path, &remote.url).await {
        Ok(prs) => Ok(ResponseJson(ApiResponse::success(prs))),
        Err(GitHostError::CliNotInstalled { provider }) => Ok(ResponseJson(
            ApiResponse::error_with_data(ListPrsError::CliNotInstalled { provider }),
        )),
        Err(GitHostError::AuthFailed(message)) => Ok(ResponseJson(ApiResponse::error_with_data(
            ListPrsError::AuthFailed { message },
        ))),
        Err(GitHostError::UnsupportedProvider) => Ok(ResponseJson(ApiResponse::error_with_data(
            ListPrsError::UnsupportedProvider,
        ))),
        Err(e) => {
            tracing::error!("Failed to list open PRs for repo {}: {}", repo_id, e);
            Ok(ResponseJson(ApiResponse::error(&e.to_string())))
        }
    }
}

pub async fn list_involved_prs(
    Query(query): Query<ListPullRequestSummariesQuery>,
) -> Result<ResponseJson<ApiResponse<Vec<PullRequestSummary>, ListPrsError>>, ApiError> {
    let provider = GitHubProvider::new()?;
    match provider
        .list_pull_request_summaries(query.involves_me)
        .await
    {
        Ok(prs) => Ok(ResponseJson(ApiResponse::success(prs))),
        Err(GitHostError::CliNotInstalled { provider }) => Ok(ResponseJson(
            ApiResponse::error_with_data(ListPrsError::CliNotInstalled { provider }),
        )),
        Err(GitHostError::AuthFailed(message)) => Ok(ResponseJson(ApiResponse::error_with_data(
            ListPrsError::AuthFailed { message },
        ))),
        Err(e) => {
            tracing::error!("Failed to list involved pull requests: {e}");
            Ok(ResponseJson(ApiResponse::error(&e.to_string())))
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct PrInfoQuery {
    pub url: String,
}

#[derive(Debug, Deserialize)]
pub struct PrCommentsByUrlQuery {
    pub url: String,
    pub pr_number: i64,
}

#[derive(Debug, Deserialize)]
pub struct ResolvePrCommentByUrlRequest {
    pub url: String,
    pub pr_number: i64,
    pub thread_id: String,
    pub resolved: bool,
}

pub async fn get_pr_info(
    State(_deployment): State<DeploymentImpl>,
    Query(query): Query<PrInfoQuery>,
) -> Result<ResponseJson<ApiResponse<PullRequestDetail, ListPrsError>>, ApiError> {
    let git_host = match GitHostService::from_url(&query.url) {
        Ok(host) => host,
        Err(GitHostError::UnsupportedProvider) => {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                ListPrsError::UnsupportedProvider,
            )));
        }
        Err(e) => {
            tracing::error!("Failed to create git host service: {}", e);
            return Ok(ResponseJson(ApiResponse::error(&e.to_string())));
        }
    };

    match git_host.get_pr_status(&query.url).await {
        Ok(info) => Ok(ResponseJson(ApiResponse::success(info))),
        Err(GitHostError::CliNotInstalled { provider }) => Ok(ResponseJson(
            ApiResponse::error_with_data(ListPrsError::CliNotInstalled { provider }),
        )),
        Err(GitHostError::AuthFailed(message)) => Ok(ResponseJson(ApiResponse::error_with_data(
            ListPrsError::AuthFailed { message },
        ))),
        Err(GitHostError::UnsupportedProvider) => Ok(ResponseJson(ApiResponse::error_with_data(
            ListPrsError::UnsupportedProvider,
        ))),
        Err(e) => {
            tracing::error!("Failed to get PR info for {}: {}", query.url, e);
            Ok(ResponseJson(ApiResponse::error(&e.to_string())))
        }
    }
}

pub async fn get_pr_comments_by_url(
    State(_deployment): State<DeploymentImpl>,
    Query(query): Query<PrCommentsByUrlQuery>,
) -> Result<ResponseJson<ApiResponse<PrCommentsResponse, GetPrCommentsError>>, ApiError> {
    let git_host = GitHostService::from_url(&query.url)?;
    let provider = git_host.provider_kind();

    match git_host
        .get_pr_comments_by_url(&query.url, query.pr_number)
        .await
    {
        Ok(comments) => Ok(ResponseJson(ApiResponse::success(PrCommentsResponse {
            comments,
        }))),
        Err(GitHostError::CliNotInstalled { provider }) => Ok(ResponseJson(
            ApiResponse::error_with_data(GetPrCommentsError::CliNotInstalled { provider }),
        )),
        Err(GitHostError::AuthFailed(_)) => Ok(ResponseJson(ApiResponse::error_with_data(
            GetPrCommentsError::CliNotLoggedIn { provider },
        ))),
        Err(error) => Err(ApiError::GitHost(error)),
    }
}

pub async fn set_pr_review_thread_resolved_by_url(
    State(_deployment): State<DeploymentImpl>,
    ResponseJson(payload): ResponseJson<ResolvePrCommentByUrlRequest>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    GitHostService::from_url(&payload.url)?
        .set_pr_review_thread_resolved_by_url(
            &payload.url,
            payload.pr_number,
            &payload.thread_id,
            payload.resolved,
        )
        .await?;

    Ok(ResponseJson(ApiResponse::success(())))
}

#[derive(Debug, Serialize, TS)]
pub struct DeleteRepoConflict {
    pub message: String,
    pub workspaces: Vec<String>,
}

pub async fn delete_repo(
    State(deployment): State<DeploymentImpl>,
    Path(repo_id): Path<Uuid>,
) -> Result<
    (
        StatusCode,
        ResponseJson<ApiResponse<(), DeleteRepoConflict>>,
    ),
    ApiError,
> {
    let active = Repo::active_workspace_names(&deployment.db().pool, repo_id).await?;
    if !active.is_empty() {
        return Ok((
            StatusCode::CONFLICT,
            ResponseJson(ApiResponse::error_with_data(DeleteRepoConflict {
                message: format!("Repository is used by {} active workspace(s)", active.len()),
                workspaces: active,
            })),
        ));
    }

    Repo::delete(&deployment.db().pool, repo_id).await?;
    Ok((StatusCode::OK, ResponseJson(ApiResponse::success(()))))
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/repos", get(get_repos).post(register_repo))
        .route("/repos/recent", get(get_recent_repos))
        .route("/repos/init", post(init_repo))
        .route("/repos/batch", post(get_repos_batch))
        .route(
            "/repos/{repo_id}",
            get(get_repo).put(update_repo).delete(delete_repo),
        )
        .route("/repos/{repo_id}/branches", get(get_repo_branches))
        .route(
            "/repos/{repo_id}/branches/local",
            post(create_local_branch_from_remote),
        )
        .route("/repos/{repo_id}/remotes", get(get_repo_remotes))
        .route(
            "/repos/{repo_id}/remote-status",
            get(get_repo_remote_status),
        )
        .route("/repos/{repo_id}/fetch", post(fetch_repo_remote))
        .route("/repos/{repo_id}/push", post(push_repo_branch))
        .route("/repos/{repo_id}/prs", get(list_open_prs))
        .route("/pull-requests", get(list_involved_prs))
        .route("/repos/pr-info", get(get_pr_info))
        .route("/repos/pr-comments", get(get_pr_comments_by_url))
        .route(
            "/repos/pr-comments/resolve",
            post(set_pr_review_thread_resolved_by_url),
        )
        .route("/repos/{repo_id}/search", get(search_repo))
        .route("/repos/{repo_id}/open-editor", post(open_repo_in_editor))
}
