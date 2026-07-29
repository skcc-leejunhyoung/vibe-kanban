//! Minimal helpers around the GitHub CLI (`gh`).
//!
//! This module provides low-level access to the GitHub CLI for operations
//! the REST client does not cover well.

use std::{
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
    PullRequestCommit, PullRequestDetail, PullRequestReview, ReviewCommentUser,
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
        self.ensure_available()?;
        let gh = resolve_executable_path_blocking("gh").ok_or(GhCliError::NotAvailable)?;
        let mut cmd = Command::new(&gh);
        if let Some(d) = dir {
            cmd.current_dir(d);
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
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
