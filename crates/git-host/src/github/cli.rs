//! Minimal helpers around the GitHub CLI (`gh`).
//!
//! This module provides low-level access to the GitHub CLI for operations
//! the REST client does not cover well.

use std::{
    collections::{HashMap, HashSet},
    ffi::{OsStr, OsString},
    io::Write,
    path::Path,
    process::Command,
};

use chrono::{DateTime, Utc};
use db::models::merge::MergeStatus;
use serde::Deserialize;
use tempfile::NamedTempFile;
use thiserror::Error;
use url::Url;
use utils::{command_ext::NoWindowExt, shell::resolve_executable_path_blocking};

use crate::types::{
    CreatePrRequest, PrComment, PrCommentAuthor, PrReviewComment, PrReviewThread,
    PullRequestCommit, PullRequestDetail, PullRequestReview, PullRequestReviewRequest,
    PullRequestReviewRequestAction, PullRequestSummary, ReviewCommentUser,
};

#[derive(Debug, Clone)]
pub struct GitHubRepoInfo {
    pub owner: String,
    pub repo_name: String,
    /// GitHub hostname (e.g., "github.com" or enterprise hostname)
    pub hostname: Option<String>,
}

impl GitHubRepoInfo {
    pub fn repo_spec(&self) -> String {
        match &self.hostname {
            Some(host) => format!("{}/{}/{}", host, self.owner, self.repo_name),
            None => format!("{}/{}", self.owner, self.repo_name),
        }
    }

    pub fn search_repo_spec(&self) -> String {
        format!("{}/{}", self.owner, self.repo_name)
    }

    pub fn from_pr_url(pr_url: &str) -> Result<Self, GhCliError> {
        let url = Url::parse(pr_url).map_err(|error| {
            GhCliError::UnexpectedOutput(format!("Invalid GitHub pull request URL: {error}"))
        })?;
        let segments = url
            .path_segments()
            .map(|segments| segments.collect::<Vec<_>>())
            .unwrap_or_default();
        if segments.len() < 4 || segments[2] != "pull" {
            return Err(GhCliError::UnexpectedOutput(format!(
                "Invalid GitHub pull request URL: {pr_url}"
            )));
        }

        Ok(Self {
            owner: segments[0].to_string(),
            repo_name: segments[1].trim_end_matches(".git").to_string(),
            hostname: url.host_str().map(String::from),
        })
    }
}

#[derive(Deserialize)]
struct GhRepoViewResponse {
    owner: GhRepoOwner,
    name: String,
    url: String,
}

#[derive(Deserialize)]
struct GhRepoOwner {
    login: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhCommentResponse {
    id: String,
    author: Option<GhUserLogin>,
    #[serde(default)]
    author_association: String,
    #[serde(default)]
    body: String,
    created_at: Option<DateTime<Utc>>,
    #[serde(default)]
    url: String,
}

#[derive(Deserialize)]
struct GhCommentsWrapper {
    comments: Vec<GhCommentResponse>,
}

#[derive(Deserialize)]
struct GhUserLogin {
    login: Option<String>,
}

#[derive(Deserialize)]
struct GhNamedUser {
    #[serde(default)]
    login: String,
}

#[derive(Deserialize)]
struct GhNamedTeam {
    #[serde(default)]
    slug: String,
}

#[derive(Deserialize)]
struct GhReviewRequestEvent {
    id: Option<i64>,
    node_id: Option<String>,
    event: String,
    actor: Option<GhNamedUser>,
    requested_reviewer: Option<GhNamedUser>,
    requested_team: Option<GhNamedTeam>,
    review_requester: Option<GhNamedUser>,
    created_at: Option<DateTime<Utc>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhReviewResponse {
    #[serde(default)]
    id: String,
    author: Option<GhNamedUser>,
    #[serde(default)]
    state: String,
    #[serde(default)]
    body: String,
    submitted_at: Option<DateTime<Utc>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhCommitResponse {
    #[serde(default)]
    oid: String,
    #[serde(default)]
    message_headline: String,
    #[serde(default)]
    authors: Vec<GhCommitAuthor>,
    committed_date: Option<DateTime<Utc>>,
}

#[derive(Deserialize)]
struct GhCommitAuthor {
    login: Option<String>,
    name: Option<String>,
}

#[derive(Deserialize)]
struct GhReviewCommentResponse {
    id: i64,
    user: Option<GhUserLogin>,
    #[serde(default)]
    body: String,
    created_at: Option<DateTime<Utc>>,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    path: String,
    line: Option<i64>,
    side: Option<String>,
    #[serde(default)]
    diff_hunk: String,
    #[serde(default)]
    author_association: String,
    in_reply_to_id: Option<i64>,
    pull_request_review_id: Option<i64>,
}

#[derive(Deserialize)]
struct GhReviewThreadsResponse {
    data: GhReviewThreadsData,
}

#[derive(Deserialize)]
struct GhReviewThreadsData {
    repository: GhReviewThreadsRepository,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhReviewThreadsRepository {
    pull_request: GhReviewThreadsPullRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhReviewThreadsPullRequest {
    review_threads: GhReviewThreadConnection,
}

#[derive(Deserialize)]
struct GhReviewThreadConnection {
    nodes: Vec<GhReviewThreadNode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhReviewThreadNode {
    id: String,
    is_resolved: bool,
    is_outdated: bool,
    comments: GhReviewThreadComments,
}

#[derive(Deserialize)]
struct GhReviewThreadComments {
    nodes: Vec<GhReviewThreadCommentNode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhReviewThreadCommentNode {
    database_id: Option<i64>,
}

#[derive(Deserialize)]
struct GhMergeCommit {
    oid: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPrResponse {
    number: i64,
    url: String,
    #[serde(default)]
    state: String,
    merged_at: Option<DateTime<Utc>>,
    merge_commit: Option<GhMergeCommit>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    body: String,
    author: Option<GhNamedUser>,
    #[serde(default)]
    assignees: Vec<GhNamedUser>,
    #[serde(default)]
    review_requests: Vec<GhNamedUser>,
    #[serde(default)]
    reviews: Vec<GhReviewResponse>,
    #[serde(default)]
    commits: Vec<GhCommitResponse>,
    review_decision: Option<String>,
    #[serde(default)]
    is_draft: bool,
    created_at: Option<DateTime<Utc>>,
    #[serde(default)]
    base_ref_name: Option<String>,
    #[serde(default)]
    head_ref_name: Option<String>,
    #[serde(default)]
    updated_at: Option<DateTime<Utc>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhSearchRepository {
    name_with_owner: String,
}

#[derive(Deserialize)]
struct GhSearchLabel {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhSearchPrResponse {
    number: i64,
    url: String,
    state: String,
    title: String,
    #[serde(default)]
    body: String,
    author: Option<GhNamedUser>,
    #[serde(default)]
    assignees: Vec<GhNamedUser>,
    #[serde(default)]
    labels: Vec<GhSearchLabel>,
    repository: GhSearchRepository,
    #[serde(default)]
    is_draft: bool,
    #[serde(default)]
    comments_count: i64,
    created_at: Option<DateTime<Utc>>,
    updated_at: Option<DateTime<Utc>>,
    closed_at: Option<DateTime<Utc>>,
}

#[derive(Deserialize)]
struct GhPullRequestListMetadataResponse {
    data: GhPullRequestListMetadataData,
}

#[derive(Deserialize)]
struct GhPullRequestListMetadataData {
    repository: GhPullRequestListMetadataRepository,
}

#[derive(Deserialize)]
struct GhPullRequestListMetadataRepository {
    #[serde(flatten)]
    pull_requests: HashMap<String, Option<GhPullRequestListMetadata>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPullRequestListMetadata {
    review_decision: Option<String>,
    review_requests: GhTotalCount,
    comments: GhTotalCount,
    review_threads: GhReviewThreadCountConnection,
}

struct PullRequestListMetadata {
    comments_count: i64,
    review_decision: Option<String>,
    is_review_requested: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhTotalCount {
    total_count: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhReviewThreadCountConnection {
    #[serde(default)]
    nodes: Vec<GhReviewThreadCommentCount>,
    page_info: GhPageInfo,
}

#[derive(Deserialize)]
struct GhReviewThreadCommentCount {
    comments: GhTotalCount,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPageInfo {
    has_next_page: bool,
}

/// GraphQL response for `node(id) { ... on Issue { linkedBranches } }`.
#[derive(Deserialize)]
struct GhLinkedBranchesResponse {
    data: GhLinkedBranchesData,
}

#[derive(Deserialize)]
struct GhLinkedBranchesData {
    node: Option<GhLinkedBranchesNode>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct GhLinkedBranchesNode {
    #[serde(default)]
    linked_branches: GhLinkedBranchConnection,
}

#[derive(Deserialize, Default)]
struct GhLinkedBranchConnection {
    #[serde(default)]
    nodes: Vec<GhLinkedBranchNode>,
}

#[derive(Deserialize)]
struct GhLinkedBranchNode {
    #[serde(rename = "ref")]
    branch_ref: Option<GhBranchRef>,
}

#[derive(Deserialize)]
struct GhBranchRef {
    name: String,
}

/// GraphQL response for the `createLinkedBranch` mutation.
#[derive(Deserialize)]
struct GhCreateLinkedBranchResponse {
    data: Option<GhCreateLinkedBranchData>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhCreateLinkedBranchData {
    create_linked_branch: Option<GhCreateLinkedBranchPayload>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhCreateLinkedBranchPayload {
    linked_branch: Option<GhLinkedBranchNode>,
}

/// REST response for `repos/{owner}/{repo}/git/ref/heads/{branch}`.
#[derive(Deserialize)]
struct GhRefObjectResponse {
    object: GhRefObject,
}

#[derive(Deserialize)]
struct GhRefObject {
    sha: String,
}

#[derive(Debug, Error)]
pub enum GhCliError {
    #[error("GitHub CLI (`gh`) executable not found or not runnable")]
    NotAvailable,
    #[error("GitHub CLI command failed: {0}")]
    CommandFailed(String),
    #[error("GitHub CLI authentication failed: {0}")]
    AuthFailed(String),
    #[error("GitHub CLI returned unexpected output: {0}")]
    UnexpectedOutput(String),
}

#[derive(Debug, Clone, Default)]
pub struct GhCli;

impl GhCli {
    pub fn new() -> Self {
        Self {}
    }

    /// Ensure the GitHub CLI binary is discoverable.
    fn ensure_available(&self) -> Result<(), GhCliError> {
        resolve_executable_path_blocking("gh").ok_or(GhCliError::NotAvailable)?;
        Ok(())
    }

    fn run<I, S>(&self, args: I, dir: Option<&Path>) -> Result<String, GhCliError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.run_for_host(args, dir, None)
    }

    fn run_for_host<I, S>(
        &self,
        args: I,
        dir: Option<&Path>,
        hostname: Option<&str>,
    ) -> Result<String, GhCliError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.ensure_available()?;
        let gh = resolve_executable_path_blocking("gh").ok_or(GhCliError::NotAvailable)?;
        let mut cmd = Command::new(&gh);
        if let Some(d) = dir {
            cmd.current_dir(d);
        }
        if let Some(hostname) = hostname {
            cmd.env("GH_HOST", hostname);
        }
        for arg in args {
            cmd.arg(arg);
        }
        let output = cmd
            .no_window()
            .output()
            .map_err(|err| GhCliError::CommandFailed(err.to_string()))?;

        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout).to_string());
        }

        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

        // Check exit code first - gh CLI uses exit code 4 for auth failures
        if output.status.code() == Some(4) {
            return Err(GhCliError::AuthFailed(stderr));
        }

        // Fall back to string matching for older gh versions or other auth scenarios
        let lower = stderr.to_ascii_lowercase();
        if lower.contains("authentication failed")
            || lower.contains("must authenticate")
            || lower.contains("bad credentials")
            || lower.contains("unauthorized")
            || lower.contains("gh auth login")
        {
            return Err(GhCliError::AuthFailed(stderr));
        }

        Err(GhCliError::CommandFailed(stderr))
    }

    pub fn get_repo_info(
        &self,
        remote_url: &str,
        repo_path: &Path,
    ) -> Result<GitHubRepoInfo, GhCliError> {
        let raw = self.run(
            ["repo", "view", remote_url, "--json", "owner,name,url"],
            Some(repo_path),
        )?;
        Self::parse_repo_info_response(&raw)
    }

    fn parse_repo_info_response(raw: &str) -> Result<GitHubRepoInfo, GhCliError> {
        let resp: GhRepoViewResponse = serde_json::from_str(raw).map_err(|e| {
            GhCliError::UnexpectedOutput(format!("Failed to parse gh repo view response: {e}"))
        })?;

        let hostname = Url::parse(&resp.url)
            .ok()
            .and_then(|u| u.host_str().map(String::from));

        Ok(GitHubRepoInfo {
            owner: resp.owner.login,
            repo_name: resp.name,
            hostname,
        })
    }

    /// Run `gh pr create` and parse the response.
    ///
    /// The `repo_path` parameter specifies the working directory for the command.
    /// This is required for compatibility with older `gh` CLI versions (e.g., v2.4.0)
    /// that require running from within a git repository.
    pub fn create_pr(
        &self,
        request: &CreatePrRequest,
        repo_info: &GitHubRepoInfo,
        repo_path: &Path,
    ) -> Result<PullRequestDetail, GhCliError> {
        // Write body to temp file to avoid shell escaping and length issues
        let body = request.body.as_deref().unwrap_or("");
        let mut body_file = NamedTempFile::new()
            .map_err(|e| GhCliError::CommandFailed(format!("Failed to create temp file: {e}")))?;
        body_file
            .write_all(body.as_bytes())
            .map_err(|e| GhCliError::CommandFailed(format!("Failed to write body: {e}")))?;

        let repo_spec = repo_info.repo_spec();

        let mut args: Vec<OsString> = Vec::with_capacity(14);
        args.push(OsString::from("pr"));
        args.push(OsString::from("create"));
        args.push(OsString::from("--repo"));
        args.push(OsString::from(&repo_spec));
        args.push(OsString::from("--head"));
        args.push(OsString::from(&request.head_branch));
        args.push(OsString::from("--base"));
        args.push(OsString::from(&request.base_branch));
        args.push(OsString::from("--title"));
        args.push(OsString::from(&request.title));
        args.push(OsString::from("--body-file"));
        args.push(body_file.path().as_os_str().to_os_string());

        // Auto-assign the PR to the authenticated gh user (the creator).
        args.push(OsString::from("--assignee"));
        args.push(OsString::from("@me"));

        if request.draft.unwrap_or(false) {
            args.push(OsString::from("--draft"));
        }

        let raw = self.run(args, Some(repo_path))?;
        Self::parse_pr_create_text(&raw, request)
    }

    /// Retrieve details for a pull request by URL.
    pub fn view_pr(&self, pr_url: &str) -> Result<PullRequestDetail, GhCliError> {
        let raw = self.run(
            [
                "pr",
                "view",
                pr_url,
                "--json",
                "number,url,state,mergedAt,mergeCommit,title,body,author,assignees,reviewRequests,reviews,commits,reviewDecision,isDraft,createdAt,updatedAt,baseRefName,headRefName",
            ],
            None,
        )?;
        Self::parse_pr_view(&raw)
    }

    pub fn get_pr_review_request_events(
        &self,
        pr_url: &str,
    ) -> Result<Vec<PullRequestReviewRequest>, GhCliError> {
        let repo_info = GitHubRepoInfo::from_pr_url(pr_url)?;
        let pr_number = Url::parse(pr_url)
            .ok()
            .and_then(|url| {
                url.path_segments()?
                    .nth(3)
                    .and_then(|value| value.parse::<i64>().ok())
            })
            .ok_or_else(|| {
                GhCliError::UnexpectedOutput(format!(
                    "Failed to parse PR number from URL '{pr_url}'"
                ))
            })?;
        let endpoint = format!(
            "repos/{}/{}/issues/{pr_number}/timeline?per_page=100",
            repo_info.owner, repo_info.repo_name
        );
        let raw = self.run_for_host(
            ["api", endpoint.as_str(), "--paginate", "--slurp"],
            None,
            repo_info.hostname.as_deref(),
        )?;
        Self::parse_pr_review_request_events(&raw)
    }

    fn parse_pr_review_request_events(
        raw: &str,
    ) -> Result<Vec<PullRequestReviewRequest>, GhCliError> {
        let pages: Vec<Vec<GhReviewRequestEvent>> =
            serde_json::from_str(raw.trim()).map_err(|err| {
                GhCliError::UnexpectedOutput(format!(
                    "Failed to parse PR timeline events: {err}; raw: {raw}"
                ))
            })?;
        let mut previously_requested = HashSet::new();
        let mut review_requests = Vec::new();

        for event in pages.into_iter().flatten() {
            if event.event != "review_requested" {
                continue;
            }
            let target = event
                .requested_reviewer
                .map(|reviewer| (format!("user:{}", reviewer.login), reviewer.login))
                .or_else(|| {
                    event
                        .requested_team
                        .map(|team| (format!("team:{}", team.slug), team.slug))
                });
            let Some((target_key, target_name)) = target else {
                continue;
            };
            let Some(created_at) = event.created_at else {
                continue;
            };
            let Some(id) = event.id.map(|id| id.to_string()).or(event.node_id) else {
                continue;
            };
            let action = if previously_requested.insert(target_key) {
                PullRequestReviewRequestAction::Requested
            } else {
                PullRequestReviewRequestAction::Rerequested
            };
            let actor = event
                .review_requester
                .or(event.actor)
                .map(|user| user.login)
                .unwrap_or_default();
            review_requests.push(PullRequestReviewRequest {
                id,
                actor,
                requested_reviewer: target_name,
                action,
                created_at,
            });
        }

        Ok(review_requests)
    }

    pub fn list_pull_request_summaries(
        &self,
        repository: &str,
        hostname: Option<&str>,
        involves_me: bool,
    ) -> Result<Vec<PullRequestSummary>, GhCliError> {
        let args = pull_request_search_args(repository, involves_me);
        let raw = self.run_for_host(args, None, hostname)?;
        let prs: Vec<GhSearchPrResponse> = serde_json::from_str(raw.trim()).map_err(|err| {
            GhCliError::UnexpectedOutput(format!(
                "Failed to parse gh search prs response: {err}; raw: {raw}"
            ))
        })?;

        let metadata = self
            .fetch_pull_request_list_metadata(
                repository,
                hostname,
                &prs.iter().map(|pr| pr.number).collect::<Vec<_>>(),
            )
            .unwrap_or_else(|error| {
                tracing::warn!("Failed to include pull request list metadata: {error}");
                HashMap::new()
            });

        Ok(prs
            .into_iter()
            .map(|pr| PullRequestSummary {
                number: pr.number,
                url: pr.url,
                status: match pr.state.to_ascii_uppercase().as_str() {
                    "OPEN" => MergeStatus::Open,
                    "MERGED" => MergeStatus::Merged,
                    "CLOSED" => MergeStatus::Closed,
                    _ => MergeStatus::Unknown,
                },
                title: pr.title,
                body: pr.body,
                author: pr.author.map(|author| author.login),
                assignees: pr.assignees.into_iter().map(|user| user.login).collect(),
                labels: pr.labels.into_iter().map(|label| label.name).collect(),
                repository: pr.repository.name_with_owner,
                is_draft: pr.is_draft,
                review_decision: metadata
                    .get(&pr.number)
                    .and_then(|metadata| metadata.review_decision.clone()),
                is_review_requested: metadata
                    .get(&pr.number)
                    .is_some_and(|metadata| metadata.is_review_requested),
                comments_count: metadata
                    .get(&pr.number)
                    .map(|metadata| metadata.comments_count)
                    .unwrap_or(pr.comments_count),
                created_at: pr.created_at,
                updated_at: pr.updated_at,
                closed_at: pr.closed_at,
            })
            .collect())
    }

    fn fetch_pull_request_list_metadata(
        &self,
        repository: &str,
        hostname: Option<&str>,
        pull_request_numbers: &[i64],
    ) -> Result<HashMap<i64, PullRequestListMetadata>, GhCliError> {
        let (owner, name) = repository.split_once('/').ok_or_else(|| {
            GhCliError::UnexpectedOutput(format!(
                "Invalid GitHub repository name for comment count query: {repository}"
            ))
        })?;
        let owner = serde_json::to_string(owner).map_err(|err| {
            GhCliError::UnexpectedOutput(format!("Failed to encode repository owner: {err}"))
        })?;
        let name = serde_json::to_string(name).map_err(|err| {
            GhCliError::UnexpectedOutput(format!("Failed to encode repository name: {err}"))
        })?;
        let mut result = HashMap::new();

        // Keep each GraphQL request bounded while avoiding one REST request per PR.
        for batch in pull_request_numbers.chunks(50) {
            let query = pull_request_list_metadata_query(&owner, &name, batch);
            let raw = self.run_for_host(
                ["api", "graphql", "-f", &format!("query={query}")],
                None,
                hostname,
            )?;
            result.extend(parse_pull_request_list_metadata(&raw, batch)?);
        }

        Ok(result)
    }

    /// List pull requests for a branch (includes closed/merged).
    pub fn list_prs_for_branch(
        &self,
        repo_info: &GitHubRepoInfo,
        branch: &str,
    ) -> Result<Vec<PullRequestDetail>, GhCliError> {
        let repo_spec = repo_info.repo_spec();
        let raw = self.run(
            [
                "pr",
                "list",
                "--repo",
                &repo_spec,
                "--state",
                "all",
                "--head",
                branch,
                "--json",
                "number,url,title,headRefName,baseRefName,state,mergedAt,mergeCommit",
            ],
            None,
        )?;
        Self::parse_pr_list(&raw)
    }

    pub fn list_prs(&self, owner: &str, repo: &str) -> Result<Vec<PullRequestDetail>, GhCliError> {
        let repo_spec = format!("{owner}/{repo}");
        let json_fields =
            "number,url,title,headRefName,baseRefName,state,mergedAt,mergeCommit,updatedAt";

        let open_raw = self.run(
            [
                "pr",
                "list",
                "--repo",
                &repo_spec,
                "--state",
                "open",
                "--json",
                json_fields,
            ],
            None,
        )?;

        let closed_raw = self.run(
            [
                "pr",
                "list",
                "--repo",
                &repo_spec,
                "--state",
                "closed",
                "--limit",
                "20",
                "--json",
                json_fields,
            ],
            None,
        )?;

        let mut open_prs: Vec<GhPrResponse> =
            serde_json::from_str(open_raw.trim()).map_err(|err| {
                GhCliError::UnexpectedOutput(format!(
                    "Failed to parse gh pr list (open) response: {err}; raw: {open_raw}"
                ))
            })?;
        let closed_prs: Vec<GhPrResponse> =
            serde_json::from_str(closed_raw.trim()).map_err(|err| {
                GhCliError::UnexpectedOutput(format!(
                    "Failed to parse gh pr list (closed) response: {err}; raw: {closed_raw}"
                ))
            })?;

        open_prs.extend(closed_prs);
        open_prs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

        Ok(open_prs
            .into_iter()
            .map(Self::pr_response_to_detail)
            .collect())
    }

    /// Fetch comments for a pull request.
    pub fn get_pr_comments(
        &self,
        repo_info: &GitHubRepoInfo,
        pr_number: i64,
    ) -> Result<Vec<PrComment>, GhCliError> {
        let repo_spec = repo_info.repo_spec();
        let raw = self.run(
            [
                "pr",
                "view",
                &pr_number.to_string(),
                "--repo",
                &repo_spec,
                "--json",
                "comments",
            ],
            None,
        )?;
        Self::parse_pr_comments(&raw)
    }

    /// Fetch inline review comments for a pull request via API.
    pub fn get_pr_review_comments(
        &self,
        repo_info: &GitHubRepoInfo,
        pr_number: i64,
    ) -> Result<Vec<PrReviewComment>, GhCliError> {
        let mut args = vec![
            "api".to_string(),
            format!(
                "repos/{}/{}/pulls/{}/comments",
                repo_info.owner, repo_info.repo_name, pr_number
            ),
        ];
        if let Some(ref host) = repo_info.hostname {
            args.push("--hostname".to_string());
            args.push(host.clone());
        }
        let raw = self.run(args, None)?;
        Self::parse_pr_review_comments(&raw)
    }

    pub fn get_pr_review_threads(
        &self,
        repo_info: &GitHubRepoInfo,
        pr_number: i64,
    ) -> Result<Vec<PrReviewThread>, GhCliError> {
        const QUERY: &str = r#"query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved isOutdated comments(first:100){nodes{databaseId}}}}}}}"#;
        let mut args = vec![
            "api".to_string(),
            "graphql".to_string(),
            "-f".to_string(),
            format!("query={QUERY}"),
            "-F".to_string(),
            format!("owner={}", repo_info.owner),
            "-F".to_string(),
            format!("name={}", repo_info.repo_name),
            "-F".to_string(),
            format!("number={pr_number}"),
        ];
        if let Some(ref host) = repo_info.hostname {
            args.push("--hostname".to_string());
            args.push(host.clone());
        }
        let raw = self.run(args, None)?;
        Self::parse_pr_review_threads(&raw)
    }

    pub fn set_pr_review_thread_resolved(
        &self,
        repo_info: &GitHubRepoInfo,
        thread_id: &str,
        resolved: bool,
    ) -> Result<(), GhCliError> {
        let mutation = if resolved {
            "mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}"
        } else {
            "mutation($threadId:ID!){unresolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}"
        };
        let mut args = vec![
            "api".to_string(),
            "graphql".to_string(),
            "-f".to_string(),
            format!("query={mutation}"),
            "-F".to_string(),
            format!("threadId={thread_id}"),
        ];
        if let Some(ref host) = repo_info.hostname {
            args.push("--hostname".to_string());
            args.push(host.clone());
        }
        self.run(args, None)?;
        Ok(())
    }

    pub fn pr_checkout(
        &self,
        repo_path: &Path,
        owner: &str,
        repo: &str,
        pr_number: i64,
    ) -> Result<(), GhCliError> {
        self.run(
            [
                "pr",
                "checkout",
                &pr_number.to_string(),
                "--repo",
                &format!("{owner}/{repo}"),
                "--force",
            ],
            Some(repo_path),
        )?;
        Ok(())
    }

    /// List the branch names linked to a GitHub issue's "Development" section,
    /// looked up by the issue's GraphQL node id. Note: a linked branch that has
    /// been turned into a PR no longer appears here (GitHub moves it to the
    /// issue's timeline), so an empty result does not prove no branch was ever
    /// linked.
    pub fn list_issue_linked_branches(
        &self,
        issue_node_id: &str,
        hostname: Option<&str>,
    ) -> Result<Vec<String>, GhCliError> {
        const QUERY: &str = r#"query($id:ID!){node(id:$id){... on Issue{linkedBranches(first:50){nodes{ref{name}}}}}}"#;
        let mut args = vec![
            "api".to_string(),
            "graphql".to_string(),
            "-f".to_string(),
            format!("query={QUERY}"),
            "-f".to_string(),
            format!("id={issue_node_id}"),
        ];
        if let Some(host) = hostname {
            args.push("--hostname".to_string());
            args.push(host.to_string());
        }
        let raw = self.run(args, None)?;
        Self::parse_issue_linked_branches(&raw)
    }

    /// Create a branch linked to a GitHub issue — the API equivalent of the
    /// "Create a branch for this issue" button — forked from `oid`. Returns the
    /// created branch's ref name. `name` overrides GitHub's default
    /// `<number>-<title-slug>` name when supplied.
    pub fn create_issue_linked_branch(
        &self,
        issue_node_id: &str,
        oid: &str,
        name: Option<&str>,
        hostname: Option<&str>,
    ) -> Result<String, GhCliError> {
        // Two query shapes so an absent name is not sent as an explicit null.
        const MUTATION_WITH_NAME: &str = r#"mutation($issueId:ID!,$oid:GitObjectID!,$name:String){createLinkedBranch(input:{issueId:$issueId,oid:$oid,name:$name}){linkedBranch{ref{name}}}}"#;
        const MUTATION_NO_NAME: &str = r#"mutation($issueId:ID!,$oid:GitObjectID!){createLinkedBranch(input:{issueId:$issueId,oid:$oid}){linkedBranch{ref{name}}}}"#;

        let query = if name.is_some() {
            MUTATION_WITH_NAME
        } else {
            MUTATION_NO_NAME
        };
        let mut args = vec![
            "api".to_string(),
            "graphql".to_string(),
            "-f".to_string(),
            format!("query={query}"),
            "-f".to_string(),
            format!("issueId={issue_node_id}"),
            "-f".to_string(),
            format!("oid={oid}"),
        ];
        if let Some(name) = name {
            args.push("-f".to_string());
            args.push(format!("name={name}"));
        }
        if let Some(host) = hostname {
            args.push("--hostname".to_string());
            args.push(host.to_string());
        }
        let raw = self.run(args, None)?;
        Self::parse_created_linked_branch(&raw)
    }

    /// Resolve the current tip commit SHA of `branch` on the remote (the base a
    /// linked branch is forked from — i.e. "latest origin/<branch>") via the
    /// REST git-refs API, without needing a local fetch first.
    pub fn resolve_remote_branch_oid(
        &self,
        owner: &str,
        repo: &str,
        branch: &str,
        hostname: Option<&str>,
    ) -> Result<String, GhCliError> {
        let endpoint = format!("repos/{owner}/{repo}/git/ref/heads/{branch}");
        let mut args = vec!["api".to_string(), endpoint];
        if let Some(host) = hostname {
            args.push("--hostname".to_string());
            args.push(host.to_string());
        }
        let raw = self.run(args, None)?;
        Self::parse_ref_object_sha(&raw)
    }
}

fn pull_request_list_metadata_query(owner: &str, name: &str, numbers: &[i64]) -> String {
    let pull_requests = numbers
        .iter()
        .map(|number| {
            format!(
                "pr_{number}: pullRequest(number: {number}) {{ \
                    reviewDecision \
                    reviewRequests(first: 1) {{ totalCount }} \
                    comments {{ totalCount }} \
                    reviewThreads(first: 100) {{ \
                        nodes {{ comments {{ totalCount }} }} \
                        pageInfo {{ hasNextPage }} \
                    }} \
                }}"
            )
        })
        .collect::<Vec<_>>()
        .join(" ");
    format!("query {{ repository(owner: {owner}, name: {name}) {{ {pull_requests} }} }}")
}

fn parse_pull_request_list_metadata(
    raw: &str,
    numbers: &[i64],
) -> Result<HashMap<i64, PullRequestListMetadata>, GhCliError> {
    let mut response: GhPullRequestListMetadataResponse = serde_json::from_str(raw.trim())
        .map_err(|err| {
            GhCliError::UnexpectedOutput(format!(
                "Failed to parse pull request list metadata response: {err}; raw: {raw}"
            ))
        })?;
    let mut result = HashMap::new();

    for number in numbers {
        let alias = format!("pr_{number}");
        let Some(Some(counts)) = response.data.repository.pull_requests.remove(&alias) else {
            continue;
        };
        if counts.review_threads.page_info.has_next_page {
            return Err(GhCliError::UnexpectedOutput(format!(
                "Pull request #{number} has more than 100 review threads"
            )));
        }
        let review_comments = counts
            .review_threads
            .nodes
            .into_iter()
            .map(|thread| thread.comments.total_count)
            .sum::<i64>();
        result.insert(
            *number,
            PullRequestListMetadata {
                comments_count: counts.comments.total_count + review_comments,
                review_decision: counts.review_decision,
                is_review_requested: counts.review_requests.total_count > 0,
            },
        );
    }

    Ok(result)
}

fn pull_request_search_args(repository: &str, involves_me: bool) -> Vec<String> {
    let mut args = vec![
        "search".to_string(),
        "prs".to_string(),
        "--repo".to_string(),
        repository.to_string(),
        "--limit".to_string(),
        "300".to_string(),
        "--sort".to_string(),
        "updated".to_string(),
        "--order".to_string(),
        "desc".to_string(),
        "--json".to_string(),
        "number,url,state,title,body,author,assignees,labels,repository,isDraft,commentsCount,createdAt,updatedAt,closedAt".to_string(),
    ];
    if involves_me {
        args.extend(["--involves".to_string(), "@me".to_string()]);
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pull_request_search_is_scoped_to_repository() {
        let involved_args = pull_request_search_args("acme/widgets", true);
        assert!(involved_args.ends_with(&["--involves".to_string(), "@me".to_string()]));
        assert!(
            involved_args
                .windows(2)
                .any(|args| args == ["--repo", "acme/widgets"])
        );

        let all_args = pull_request_search_args("acme/widgets", false);
        assert!(!all_args.iter().any(|arg| arg == "--involves"));
        assert!(!all_args.iter().any(|arg| arg == "--author"));
        assert!(all_args.windows(2).any(|args| args == ["--limit", "300"]));
    }

    #[test]
    fn pull_request_metadata_includes_review_decision_and_thread_comments() {
        let metadata = parse_pull_request_list_metadata(
            r#"{
                "data": {
                    "repository": {
                        "pr_42": {
                            "reviewDecision": "APPROVED",
                            "reviewRequests": {"totalCount": 1},
                            "comments": {"totalCount": 6},
                            "reviewThreads": {
                                "nodes": [
                                    {"comments": {"totalCount": 2}},
                                    {"comments": {"totalCount": 5}}
                                ],
                                "pageInfo": {"hasNextPage": false}
                            }
                        }
                    }
                }
            }"#,
            &[42],
        )
        .unwrap();

        let pr_metadata = metadata.get(&42).unwrap();
        assert_eq!(pr_metadata.comments_count, 13);
        assert_eq!(pr_metadata.review_decision.as_deref(), Some("APPROVED"));
        assert!(pr_metadata.is_review_requested);
    }

    #[test]
    fn pull_request_metadata_query_batches_multiple_prs() {
        let query = pull_request_list_metadata_query("\"acme\"", "\"widgets\"", &[12, 34]);

        assert!(query.contains("repository(owner: \"acme\", name: \"widgets\")"));
        assert!(query.contains("pr_12: pullRequest(number: 12)"));
        assert!(query.contains("pr_34: pullRequest(number: 34)"));
        assert!(query.contains("reviewDecision"));
        assert!(query.contains("reviewRequests(first: 1)"));
        assert!(query.contains("reviewThreads(first: 100)"));
    }

    #[test]
    fn parses_repository_info_from_pull_request_url() {
        let info =
            GitHubRepoInfo::from_pr_url("https://github.example.com/acme/widgets/pull/42").unwrap();

        assert_eq!(info.owner, "acme");
        assert_eq!(info.repo_name, "widgets");
        assert_eq!(info.hostname.as_deref(), Some("github.example.com"));
        assert_eq!(info.search_repo_spec(), "acme/widgets");
    }

    #[test]
    fn parse_pr_view_preserves_conversation_activity() {
        let detail = GhCli::parse_pr_view(
            r#"{
                "number": 12,
                "url": "https://github.com/example/repo/pull/12",
                "state": "OPEN",
                "title": "Conversation",
                "author": {"login": "author"},
                "reviews": [{
                    "id": "review-1",
                    "author": {"login": "reviewer"},
                    "state": "APPROVED",
                    "body": "Looks good",
                    "submittedAt": "2026-01-02T00:00:00Z"
                }],
                "commits": [{
                    "oid": "abcdef123456",
                    "messageHeadline": "Add conversation",
                    "authors": [{"login": "author", "name": "Author"}],
                    "committedDate": "2026-01-01T00:00:00Z"
                }]
            }"#,
        )
        .unwrap();

        assert_eq!(detail.reviews[0].body, "Looks good");
        assert_eq!(detail.commits[0].oid, "abcdef123456");
        assert_eq!(detail.commits[0].authors, vec!["author"]);
    }

    #[test]
    fn parses_review_request_and_rerequest_timeline_events() {
        let events = GhCli::parse_pr_review_request_events(
            r#"[[
                {
                    "sha": "abc123",
                    "node_id": "commit-node",
                    "event": "committed"
                },
                {
                    "id": 1,
                    "event": "review_requested",
                    "actor": {"login": "author"},
                    "requested_reviewer": {"login": "reviewer"},
                    "review_requester": {"login": "author"},
                    "created_at": "2026-01-01T00:00:00Z"
                },
                {
                    "id": 2,
                    "event": "review_request_removed",
                    "actor": {"login": "author"},
                    "requested_reviewer": {"login": "reviewer"},
                    "created_at": "2026-01-02T00:00:00Z"
                }
            ], [
                {
                    "id": 3,
                    "event": "review_requested",
                    "actor": {"login": "author"},
                    "requested_reviewer": {"login": "reviewer"},
                    "created_at": "2026-01-03T00:00:00Z"
                },
                {
                    "id": 4,
                    "event": "review_requested",
                    "actor": {"login": "author"},
                    "requested_team": {"slug": "platform-reviewers"},
                    "created_at": "2026-01-04T00:00:00Z"
                }
            ]]"#,
        )
        .unwrap();

        assert_eq!(events.len(), 3);
        assert_eq!(events[0].action, PullRequestReviewRequestAction::Requested);
        assert_eq!(
            events[1].action,
            PullRequestReviewRequestAction::Rerequested
        );
        assert_eq!(events[1].actor, "author");
        assert_eq!(events[1].requested_reviewer, "reviewer");
        assert_eq!(events[2].action, PullRequestReviewRequestAction::Requested);
        assert_eq!(events[2].requested_reviewer, "platform-reviewers");
    }

    #[test]
    fn parse_review_comments_preserves_reply_relationship() {
        let comments = GhCli::parse_pr_review_comments(
            r#"[{
                "id": 2,
                "user": {"login": "author"},
                "body": "Fixed",
                "created_at": "2026-01-02T00:00:00Z",
                "path": "src/file.ts",
                "in_reply_to_id": 1,
                "pull_request_review_id": 7
            }]"#,
        )
        .unwrap();

        assert_eq!(comments[0].in_reply_to_id, Some(1));
        assert_eq!(comments[0].pull_request_review_id, Some(7));
    }

    #[test]
    fn parse_review_threads_preserves_resolution_and_comment_mapping() {
        let threads = GhCli::parse_pr_review_threads(
            r#"{
                "data": {
                    "repository": {
                        "pullRequest": {
                            "reviewThreads": {
                                "nodes": [{
                                    "id": "PRRT_thread",
                                    "isResolved": true,
                                    "isOutdated": false,
                                    "comments": {
                                        "nodes": [
                                            {"databaseId": 10},
                                            {"databaseId": 11}
                                        ]
                                    }
                                }]
                            }
                        }
                    }
                }
            }"#,
        )
        .unwrap();

        assert_eq!(threads[0].id, "PRRT_thread");
        assert_eq!(threads[0].comment_ids, vec![10, 11]);
        assert!(threads[0].is_resolved);
        assert!(!threads[0].is_outdated);
    }

    #[test]
    fn parses_issue_linked_branches() {
        let branches = GhCli::parse_issue_linked_branches(
            r#"{
                "data": {
                    "node": {
                        "linkedBranches": {
                            "nodes": [
                                {"ref": {"name": "123-fix-the-thing"}},
                                {"ref": {"name": "123-fix-the-thing-2"}}
                            ]
                        }
                    }
                }
            }"#,
        )
        .unwrap();

        assert_eq!(branches, vec!["123-fix-the-thing", "123-fix-the-thing-2"]);
    }

    #[test]
    fn parses_empty_issue_linked_branches_when_node_missing() {
        let branches = GhCli::parse_issue_linked_branches(r#"{"data": {"node": null}}"#).unwrap();
        assert!(branches.is_empty());
    }

    #[test]
    fn parses_created_linked_branch_ref_name() {
        let name = GhCli::parse_created_linked_branch(
            r#"{
                "data": {
                    "createLinkedBranch": {
                        "linkedBranch": {"ref": {"name": "42-new-linked-branch"}}
                    }
                }
            }"#,
        )
        .unwrap();

        assert_eq!(name, "42-new-linked-branch");
    }

    #[test]
    fn errors_when_created_linked_branch_has_no_ref() {
        let result = GhCli::parse_created_linked_branch(
            r#"{"data": {"createLinkedBranch": {"linkedBranch": null}}}"#,
        );
        assert!(result.is_err());
    }

    #[test]
    fn parses_ref_object_sha() {
        let sha = GhCli::parse_ref_object_sha(
            r#"{"ref": "refs/heads/develop", "object": {"sha": "b6a466b91ddcde88", "type": "commit"}}"#,
        )
        .unwrap();
        assert_eq!(sha, "b6a466b91ddcde88");
    }
}

impl GhCli {
    fn parse_pr_create_text(
        raw: &str,
        request: &CreatePrRequest,
    ) -> Result<PullRequestDetail, GhCliError> {
        let pr_url = raw
            .lines()
            .rev()
            .flat_map(|line| line.split_whitespace())
            .map(|token| token.trim_matches(|c: char| c == '<' || c == '>'))
            .find(|token| token.starts_with("http") && token.contains("/pull/"))
            .ok_or_else(|| {
                GhCliError::UnexpectedOutput(format!(
                    "gh pr create did not return a pull request URL; raw output: {raw}"
                ))
            })?
            .trim_end_matches(['.', ',', ';'])
            .to_string();

        let number = pr_url
            .rsplit('/')
            .next()
            .ok_or_else(|| {
                GhCliError::UnexpectedOutput(format!(
                    "Failed to extract PR number from URL '{pr_url}'"
                ))
            })?
            .trim_end_matches(|c: char| !c.is_ascii_digit())
            .parse::<i64>()
            .map_err(|err| {
                GhCliError::UnexpectedOutput(format!(
                    "Failed to parse PR number from URL '{pr_url}': {err}"
                ))
            })?;

        Ok(PullRequestDetail {
            number,
            url: pr_url,
            status: MergeStatus::Open,
            merged_at: None,
            merge_commit_sha: None,
            title: request.title.clone(),
            body: request.body.clone().unwrap_or_default(),
            author: None,
            assignees: Vec::new(),
            reviewers: Vec::new(),
            reviews: Vec::new(),
            review_requests: Vec::new(),
            commits: Vec::new(),
            review_decision: None,
            is_draft: request.draft.unwrap_or(false),
            created_at: None,
            updated_at: None,
            base_branch: request.base_branch.clone(),
            head_branch: request.head_branch.clone(),
        })
    }

    fn parse_pr_view(raw: &str) -> Result<PullRequestDetail, GhCliError> {
        let pr: GhPrResponse = serde_json::from_str(raw.trim()).map_err(|err| {
            GhCliError::UnexpectedOutput(format!(
                "Failed to parse gh pr view response: {err}; raw: {raw}"
            ))
        })?;
        Ok(Self::pr_response_to_detail(pr))
    }

    fn parse_pr_list(raw: &str) -> Result<Vec<PullRequestDetail>, GhCliError> {
        let prs: Vec<GhPrResponse> = serde_json::from_str(raw.trim()).map_err(|err| {
            GhCliError::UnexpectedOutput(format!(
                "Failed to parse gh pr list response: {err}; raw: {raw}"
            ))
        })?;
        Ok(prs.into_iter().map(Self::pr_response_to_detail).collect())
    }

    fn pr_response_to_detail(pr: GhPrResponse) -> PullRequestDetail {
        let state = if pr.state.is_empty() {
            "OPEN"
        } else {
            &pr.state
        };
        PullRequestDetail {
            number: pr.number,
            url: pr.url,
            status: match state.to_ascii_uppercase().as_str() {
                "OPEN" => MergeStatus::Open,
                "MERGED" => MergeStatus::Merged,
                "CLOSED" => MergeStatus::Closed,
                _ => MergeStatus::Unknown,
            },
            merged_at: pr.merged_at,
            merge_commit_sha: pr.merge_commit.and_then(|c| c.oid),
            title: pr.title.unwrap_or_default(),
            body: pr.body,
            author: pr.author.map(|author| author.login),
            assignees: pr.assignees.into_iter().map(|user| user.login).collect(),
            reviewers: pr
                .review_requests
                .into_iter()
                .map(|user| user.login)
                .collect(),
            reviews: pr
                .reviews
                .into_iter()
                .map(|review| PullRequestReview {
                    id: review.id,
                    author: review.author.map(|author| author.login).unwrap_or_default(),
                    state: review.state,
                    body: review.body,
                    submitted_at: review.submitted_at,
                })
                .collect(),
            review_requests: Vec::new(),
            commits: pr
                .commits
                .into_iter()
                .map(|commit| PullRequestCommit {
                    oid: commit.oid,
                    message: commit.message_headline,
                    authors: commit
                        .authors
                        .into_iter()
                        .filter_map(|author| author.login.or(author.name))
                        .collect(),
                    committed_at: commit.committed_date,
                })
                .collect(),
            review_decision: pr.review_decision,
            is_draft: pr.is_draft,
            created_at: pr.created_at,
            updated_at: pr.updated_at,
            base_branch: pr.base_ref_name.unwrap_or_default(),
            head_branch: pr.head_ref_name.unwrap_or_default(),
        }
    }

    fn parse_pr_comments(raw: &str) -> Result<Vec<PrComment>, GhCliError> {
        let wrapper: GhCommentsWrapper = serde_json::from_str(raw.trim()).map_err(|err| {
            GhCliError::UnexpectedOutput(format!(
                "Failed to parse gh pr view --json comments response: {err}; raw: {raw}"
            ))
        })?;

        Ok(wrapper
            .comments
            .into_iter()
            .map(|c| PrComment {
                id: c.id,
                author: PrCommentAuthor {
                    login: c
                        .author
                        .and_then(|a| a.login)
                        .unwrap_or_else(|| "unknown".to_string()),
                },
                author_association: c.author_association,
                body: c.body,
                created_at: c.created_at.unwrap_or_else(Utc::now),
                url: c.url,
            })
            .collect())
    }

    fn parse_pr_review_comments(raw: &str) -> Result<Vec<PrReviewComment>, GhCliError> {
        let items: Vec<GhReviewCommentResponse> =
            serde_json::from_str(raw.trim()).map_err(|err| {
                GhCliError::UnexpectedOutput(format!(
                    "Failed to parse review comments API response: {err}; raw: {raw}"
                ))
            })?;

        Ok(items
            .into_iter()
            .map(|c| PrReviewComment {
                id: c.id,
                user: ReviewCommentUser {
                    login: c
                        .user
                        .and_then(|u| u.login)
                        .unwrap_or_else(|| "unknown".to_string()),
                },
                body: c.body,
                created_at: c.created_at.unwrap_or_else(Utc::now),
                html_url: c.html_url,
                path: c.path,
                line: c.line,
                side: c.side,
                diff_hunk: c.diff_hunk,
                author_association: c.author_association,
                in_reply_to_id: c.in_reply_to_id,
                pull_request_review_id: c.pull_request_review_id,
            })
            .collect())
    }

    fn parse_pr_review_threads(raw: &str) -> Result<Vec<PrReviewThread>, GhCliError> {
        let response: GhReviewThreadsResponse =
            serde_json::from_str(raw.trim()).map_err(|err| {
                GhCliError::UnexpectedOutput(format!(
                    "Failed to parse review threads GraphQL response: {err}; raw: {raw}"
                ))
            })?;
        Ok(response
            .data
            .repository
            .pull_request
            .review_threads
            .nodes
            .into_iter()
            .map(|thread| PrReviewThread {
                id: thread.id,
                comment_ids: thread
                    .comments
                    .nodes
                    .into_iter()
                    .filter_map(|comment| comment.database_id)
                    .collect(),
                is_resolved: thread.is_resolved,
                is_outdated: thread.is_outdated,
            })
            .collect())
    }

    fn parse_issue_linked_branches(raw: &str) -> Result<Vec<String>, GhCliError> {
        let response: GhLinkedBranchesResponse =
            serde_json::from_str(raw.trim()).map_err(|err| {
                GhCliError::UnexpectedOutput(format!(
                    "Failed to parse issue linked branches response: {err}; raw: {raw}"
                ))
            })?;
        Ok(response
            .data
            .node
            .unwrap_or_default()
            .linked_branches
            .nodes
            .into_iter()
            .filter_map(|node| node.branch_ref.map(|r| r.name))
            .collect())
    }

    fn parse_created_linked_branch(raw: &str) -> Result<String, GhCliError> {
        let response: GhCreateLinkedBranchResponse =
            serde_json::from_str(raw.trim()).map_err(|err| {
                GhCliError::UnexpectedOutput(format!(
                    "Failed to parse createLinkedBranch response: {err}; raw: {raw}"
                ))
            })?;
        response
            .data
            .and_then(|data| data.create_linked_branch)
            .and_then(|payload| payload.linked_branch)
            .and_then(|branch| branch.branch_ref)
            .map(|r| r.name)
            .ok_or_else(|| {
                GhCliError::UnexpectedOutput(format!(
                    "createLinkedBranch did not return a branch ref; raw: {raw}"
                ))
            })
    }

    fn parse_ref_object_sha(raw: &str) -> Result<String, GhCliError> {
        let response: GhRefObjectResponse = serde_json::from_str(raw.trim()).map_err(|err| {
            GhCliError::UnexpectedOutput(format!(
                "Failed to parse git ref response: {err}; raw: {raw}"
            ))
        })?;
        Ok(response.object.sha)
    }
}
