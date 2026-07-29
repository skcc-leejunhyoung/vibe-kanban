//! Minimal helpers around the Azure CLI (`az repos`).
//!
//! This module provides low-level access to the Azure CLI for Azure DevOps
//! repository and pull request operations.

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
use utils::{command_ext::NoWindowExt, shell::resolve_executable_path_blocking};

use crate::types::{CreatePrRequest, PullRequestDetail, UnifiedPrComment};

#[derive(Debug, Clone)]
pub struct AzureRepoInfo {
    pub organization_url: String,
    pub project: String,
    pub project_id: String,
    pub repo_name: String,
    pub repo_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AzPrResponse {
    pull_request_id: i64,
    status: Option<String>,
    closed_date: Option<String>,
    repository: Option<AzRepository>,
    last_merge_commit: Option<AzCommit>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
    created_by: Option<AzAuthor>,
    #[serde(default)]
    reviewers: Vec<AzReviewer>,
    creation_date: Option<String>,
    #[serde(default)]
    is_draft: bool,
    #[serde(default)]
    target_ref_name: Option<String>,
    #[serde(default)]
    source_ref_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AzReviewer {
    display_name: Option<String>,
    vote: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AzRepository {
    web_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AzCommit {
    commit_id: Option<String>,
}

#[derive(Deserialize)]
struct AzThreadsResponse {
    value: Vec<AzThread>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AzThread {
    id: Option<i64>,
    status: Option<String>,
    comments: Option<Vec<AzThreadComment>>,
    thread_context: Option<AzThreadContext>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AzThreadContext {
    file_path: Option<String>,
    right_file_start: Option<AzFilePosition>,
}

#[derive(Deserialize)]
struct AzFilePosition {
    line: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AzThreadComment {
    id: Option<i64>,
    author: Option<AzAuthor>,
    content: Option<String>,
    published_date: Option<String>,
    comment_type: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AzAuthor {
    display_name: Option<String>,
}

/// Response item from `az repos list`
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AzRepoListItem {
    id: String,
    name: String,
    project: AzRepoProject,
    remote_url: String,
    ssh_url: Option<String>,
}

#[derive(Deserialize)]
struct AzRepoProject {
    id: String,
    name: String,
}

#[derive(Debug, Error)]
pub enum AzCliError {
    #[error("Azure CLI (`az`) executable not found or not runnable")]
    NotAvailable,
    #[error("Azure CLI command failed: {0}")]
    CommandFailed(String),
    #[error("Azure CLI authentication failed: {0}")]
    AuthFailed(String),
    #[error("Azure CLI returned unexpected output: {0}")]
    UnexpectedOutput(String),
}

#[derive(Debug, Clone, Default)]
pub struct AzCli;

impl AzCli {
    pub fn new() -> Self {
        Self {}
    }

    /// Ensure the Azure CLI binary is discoverable.
    fn ensure_available(&self) -> Result<(), AzCliError> {
        resolve_executable_path_blocking("az").ok_or(AzCliError::NotAvailable)?;
        Ok(())
    }

    fn run<I, S>(&self, args: I, dir: Option<&Path>) -> Result<String, AzCliError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.ensure_available()?;
        let az = resolve_executable_path_blocking("az").ok_or(AzCliError::NotAvailable)?;
        let mut cmd = Command::new(&az);

        if let Some(d) = dir {
            cmd.current_dir(d);
        }

        for arg in args {
            cmd.arg(arg);
        }
        tracing::debug!("Running Azure CLI command: {:?} {:?}", az, cmd.get_args());

        let output = cmd
            .no_window()
            .output()
            .map_err(|err| AzCliError::CommandFailed(err.to_string()))?;

        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout).to_string());
        }

        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

        // Check for authentication errors
        let lower = stderr.to_ascii_lowercase();
        if lower.contains("az login")
            || lower.contains("not logged in")
            || lower.contains("authentication")
            || lower.contains("unauthorized")
            || lower.contains("credentials")
            || lower.contains("please run 'az login'")
        {
            return Err(AzCliError::AuthFailed(stderr));
        }

        Err(AzCliError::CommandFailed(stderr))
    }
    pub fn get_repo_info(
        &self,
        repo_path: &Path,
        remote_url: &str,
    ) -> Result<AzureRepoInfo, AzCliError> {
        let raw = self.run(
            ["repos", "list", "--detect", "true", "--output", "json"],
            Some(repo_path),
        )?;

        let repos: Vec<AzRepoListItem> = serde_json::from_str(raw.trim()).map_err(|e| {
            AzCliError::UnexpectedOutput(format!("Failed to parse repos list: {e}; raw: {raw}"))
        })?;

        // Find the repo that matches our remote URL (check both HTTPS and SSH)
        let is_ssh = remote_url.starts_with("git@") || remote_url.starts_with("ssh://");
        let repo = repos
            .into_iter()
            .find(|r| {
                if is_ssh {
                    r.ssh_url
                        .as_ref()
                        .map(|ssh| Self::urls_match(ssh, remote_url))
                        .unwrap_or(false)
                } else {
                    Self::urls_match(&r.remote_url, remote_url)
                }
            })
            .ok_or_else(|| {
                AzCliError::UnexpectedOutput(format!(
                    "No repo found matching remote URL: {}",
                    remote_url
                ))
            })?;

        let organization_url =
            Self::extract_organization_url(&repo.remote_url).ok_or_else(|| {
                AzCliError::UnexpectedOutput(format!(
                    "Could not extract organization URL from: {}",
                    repo.remote_url
                ))
            })?;

        tracing::debug!(
            "Got Azure DevOps repo info: org_url='{}', project='{}' ({}), repo='{}' ({})",
            organization_url,
            repo.project.name,
            repo.project.id,
            repo.name,
            repo.id
        );

        Ok(AzureRepoInfo {
            organization_url,
            project: repo.project.name,
            project_id: repo.project.id,
            repo_name: repo.name,
            repo_id: repo.id,
        })
    }

    fn urls_match(url1: &str, url2: &str) -> bool {
        let normalize = |url: &str| {
            let mut s = url.to_lowercase();
            // Normalize ssh:// prefix to scp-style
            if let Some(rest) = s.strip_prefix("ssh://") {
                s = rest.to_string();
            }
            s.trim_end_matches('/').trim_end_matches(".git").to_string()
        };
        normalize(url1) == normalize(url2)
    }

    /// Extract the organization URL from a remote URL.
    /// Returns the base URL that can be used with Azure CLI commands.
    fn extract_organization_url(url: &str) -> Option<String> {
        // dev.azure.com format: https://dev.azure.com/{org}/... -> https://dev.azure.com/{org}
        if url.contains("dev.azure.com") {
            let parts: Vec<&str> = url.split('/').collect();
            let azure_idx = parts.iter().position(|&p| p.contains("dev.azure.com"))?;
            let org = parts.get(azure_idx + 1)?;
            return Some(format!("https://dev.azure.com/{}", org));
        }

        // Legacy format: https://{org}.visualstudio.com/... -> https://{org}.visualstudio.com
        if url.contains(".visualstudio.com") {
            let parts: Vec<&str> = url.split('/').collect();
            for part in parts.iter() {
                if part.contains(".visualstudio.com") {
                    return Some(format!("https://{}", part));
                }
            }
        }

        None
    }

    pub fn create_pr(
        &self,
        request: &CreatePrRequest,
        organization_url: &str,
        project: &str,
        repo_name: &str,
    ) -> Result<PullRequestDetail, AzCliError> {
        let body = request.body.as_deref().unwrap_or("");

        let mut args: Vec<OsString> = Vec::with_capacity(20);
        args.push(OsString::from("repos"));
        args.push(OsString::from("pr"));
        args.push(OsString::from("create"));
        args.push(OsString::from("--organization"));
        args.push(OsString::from(organization_url));
        args.push(OsString::from("--project"));
        args.push(OsString::from(project));
        args.push(OsString::from("--repository"));
        args.push(OsString::from(repo_name));
        args.push(OsString::from("--source-branch"));
        args.push(OsString::from(&request.head_branch));
        args.push(OsString::from("--target-branch"));
        args.push(OsString::from(&request.base_branch));
        args.push(OsString::from("--title"));
        args.push(OsString::from(&request.title));
        args.push(OsString::from("--description"));
        args.push(OsString::from(body));
        args.push(OsString::from("--output"));
        args.push(OsString::from("json"));

        if request.draft.unwrap_or(false) {
            args.push(OsString::from("--draft"));
        }

        let raw = self.run(args, None)?;
        Self::parse_pr_response(&raw)
    }

    pub fn view_pr(&self, pr_url: &str) -> Result<PullRequestDetail, AzCliError> {
        let (organization, pr_id) = Self::parse_pr_url(pr_url).ok_or_else(|| {
            AzCliError::UnexpectedOutput(format!("Could not parse Azure DevOps PR URL: {pr_url}"))
        })?;

        let org_url = format!("https://dev.azure.com/{}", organization);

        let raw = self.run(
            [
                "repos",
                "pr",
                "show",
                "--id",
                &pr_id.to_string(),
                "--organization",
                &org_url,
                "--output",
                "json",
            ],
            None,
        )?;

        Self::parse_pr_response(&raw)
    }

    pub fn list_prs_for_branch(
        &self,
        organization_url: &str,
        project: &str,
        repo_name: &str,
        branch: &str,
    ) -> Result<Vec<PullRequestDetail>, AzCliError> {
        let raw = self.run(
            [
                "repos",
                "pr",
                "list",
                "--organization",
                organization_url,
                "--project",
                project,
                "--repository",
                repo_name,
                "--source-branch",
                branch,
                "--status",
                "all",
                "--output",
                "json",
            ],
            None,
        )?;

        Self::parse_pr_list_response(&raw)
    }

    pub fn get_pr_threads(
        &self,
        organization_url: &str,
        project_id: &str,
        repo_id: &str,
        pr_id: i64,
    ) -> Result<Vec<UnifiedPrComment>, AzCliError> {
        let mut args: Vec<OsString> = Vec::with_capacity(16);
        args.push(OsString::from("devops"));
        args.push(OsString::from("invoke"));
        args.push(OsString::from("--area"));
        args.push(OsString::from("git"));
        args.push(OsString::from("--resource"));
        args.push(OsString::from("pullRequestThreads"));
        args.push(OsString::from("--route-parameters"));
        args.push(OsString::from(format!("project={}", project_id)));
        args.push(OsString::from(format!("repositoryId={}", repo_id)));
        args.push(OsString::from(format!("pullRequestId={}", pr_id)));
        args.push(OsString::from("--organization"));
        args.push(OsString::from(organization_url));
        args.push(OsString::from("--api-version"));
        args.push(OsString::from("7.0"));
        args.push(OsString::from("--output"));
        args.push(OsString::from("json"));

        let raw = self.run(args, None)?;
        Self::parse_pr_threads(&raw)
    }

    pub fn set_pr_thread_resolved(
        &self,
        organization_url: &str,
        project_id: &str,
        repo_id: &str,
        pr_id: i64,
        thread_id: &str,
        resolved: bool,
    ) -> Result<(), AzCliError> {
        let mut body =
            NamedTempFile::new().map_err(|error| AzCliError::CommandFailed(error.to_string()))?;
        write!(
            body,
            r#"{{"status":"{}"}}"#,
            if resolved { "fixed" } else { "active" }
        )
        .map_err(|error| AzCliError::CommandFailed(error.to_string()))?;

        self.run(
            [
                "devops",
                "invoke",
                "--area",
                "git",
                "--resource",
                "pullRequestThreads",
                "--route-parameters",
                &format!(
                    "project={project_id} repositoryId={repo_id} pullRequestId={pr_id} threadId={thread_id}"
                ),
                "--organization",
                organization_url,
                "--api-version",
                "7.0",
                "--http-method",
                "PATCH",
                "--in-file",
                body.path()
                    .to_str()
                    .ok_or_else(|| AzCliError::CommandFailed("Invalid temp path".to_string()))?,
                "--output",
                "none",
            ],
            None,
        )?;
        Ok(())
    }

    /// Parse PR URL to extract organization and PR ID.
    ///
    /// Only extracts the minimal info needed for `az repos pr show`.
    /// Format: `https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}`
    pub fn parse_pr_url(url: &str) -> Option<(String, i64)> {
        let url_lower = url.to_lowercase();

        if url_lower.contains("dev.azure.com") && url_lower.contains("/pullrequest/") {
            let parts: Vec<&str> = url.split('/').collect();
            if let Some(pr_idx) = parts.iter().position(|&p| p == "pullrequest")
                && parts.len() > pr_idx + 1
            {
                let pr_id: i64 = parts[pr_idx + 1].parse().ok()?;
                if let Some(azure_idx) = parts.iter().position(|&p| p.contains("dev.azure.com"))
                    && parts.len() > azure_idx + 1
                {
                    let organization = parts[azure_idx + 1].to_string();
                    return Some((organization, pr_id));
                }
            }
        }

        // Legacy format: https://{org}.visualstudio.com/{project}/_git/{repo}/pullrequest/{id}
        if url_lower.contains(".visualstudio.com") && url_lower.contains("/pullrequest/") {
            let parts: Vec<&str> = url.split('/').collect();
            for part in parts.iter() {
                if let Some(org) = part.strip_suffix(".visualstudio.com")
                    && let Some(pr_idx) = parts.iter().position(|&p| p == "pullrequest")
                    && parts.len() > pr_idx + 1
                {
                    let pr_id: i64 = parts[pr_idx + 1].parse().ok()?;
                    return Some((org.to_string(), pr_id));
                }
            }
        }

        None
    }

    pub fn parse_pr_repository_url(url: &str) -> Option<(AzureRepoInfo, i64)> {
        let parsed = url::Url::parse(url).ok()?;
        let host = parsed.host_str()?;
        let parts = parsed
            .path_segments()?
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>();
        let git_index = parts.iter().position(|part| *part == "_git")?;
        let pr_index = parts.iter().position(|part| *part == "pullrequest")?;
        let pr_id = parts.get(pr_index + 1)?.parse().ok()?;
        let repo_name = parts.get(git_index + 1)?.to_string();

        let (organization_url, project) = if host.eq_ignore_ascii_case("dev.azure.com") {
            (
                format!("https://dev.azure.com/{}", parts.first()?),
                parts.get(1)?.to_string(),
            )
        } else {
            host.strip_suffix(".visualstudio.com")?;
            (
                format!("https://{host}"),
                parts.first().map(|part| part.to_string())?,
            )
        };

        Some((
            AzureRepoInfo {
                organization_url,
                project: project.clone(),
                project_id: project,
                repo_name: repo_name.clone(),
                repo_id: repo_name,
            },
            pr_id,
        ))
    }
}

impl AzCli {
    /// Parse PR response from Azure CLI.
    /// Works for both `az repos pr create` and `az repos pr show`.
    fn parse_pr_response(raw: &str) -> Result<PullRequestDetail, AzCliError> {
        let pr: AzPrResponse = serde_json::from_str(raw.trim()).map_err(|e| {
            AzCliError::UnexpectedOutput(format!("Failed to parse PR response: {e}; raw: {raw}"))
        })?;
        Ok(Self::az_pr_to_info(pr))
    }

    fn parse_pr_list_response(raw: &str) -> Result<Vec<PullRequestDetail>, AzCliError> {
        let prs: Vec<AzPrResponse> = serde_json::from_str(raw.trim()).map_err(|e| {
            AzCliError::UnexpectedOutput(format!("Failed to parse PR list: {e}; raw: {raw}"))
        })?;
        Ok(prs.into_iter().map(Self::az_pr_to_info).collect())
    }

    fn az_pr_to_info(pr: AzPrResponse) -> PullRequestDetail {
        let url = pr
            .repository
            .and_then(|r| r.web_url)
            .map(|u| format!("{}/pullrequest/{}", u, pr.pull_request_id))
            .unwrap_or_else(|| format!("pullrequest/{}", pr.pull_request_id));

        let status = pr.status.as_deref().unwrap_or("active");
        let merged_at = pr
            .closed_date
            .and_then(|s| DateTime::parse_from_rfc3339(&s).ok())
            .map(|dt| dt.with_timezone(&Utc));
        let merge_commit_sha = pr.last_merge_commit.and_then(|c| c.commit_id);

        PullRequestDetail {
            number: pr.pull_request_id,
            url,
            status: Self::map_azure_status(status),
            merged_at,
            merge_commit_sha,
            title: pr.title.unwrap_or_default(),
            body: pr.description.unwrap_or_default(),
            author: pr.created_by.and_then(|author| author.display_name),
            assignees: Vec::new(),
            reviewers: pr
                .reviewers
                .iter()
                .filter_map(|reviewer| reviewer.display_name.clone())
                .collect(),
            reviews: pr
                .reviewers
                .into_iter()
                .filter_map(|reviewer| {
                    let state = match reviewer.vote.unwrap_or_default() {
                        10 => "APPROVED",
                        5 => "APPROVED_WITH_SUGGESTIONS",
                        -5 => "WAITING_FOR_AUTHOR",
                        -10 => "CHANGES_REQUESTED",
                        _ => return None,
                    };
                    Some(crate::types::PullRequestReview {
                        id: String::new(),
                        author: reviewer.display_name.unwrap_or_default(),
                        state: state.to_string(),
                        body: String::new(),
                        submitted_at: None,
                    })
                })
                .collect(),
            commits: Vec::new(),
            review_decision: None,
            is_draft: pr.is_draft,
            created_at: pr
                .creation_date
                .and_then(|date| DateTime::parse_from_rfc3339(&date).ok())
                .map(|date| date.with_timezone(&Utc)),
            updated_at: None,
            base_branch: pr
                .target_ref_name
                .map(|r| r.strip_prefix("refs/heads/").unwrap_or(&r).to_string())
                .unwrap_or_default(),
            head_branch: pr
                .source_ref_name
                .map(|r| r.strip_prefix("refs/heads/").unwrap_or(&r).to_string())
                .unwrap_or_default(),
        }
    }

    fn parse_pr_threads(raw: &str) -> Result<Vec<UnifiedPrComment>, AzCliError> {
        // REST API returns { "value": [...threads...] } wrapper
        let response: AzThreadsResponse = serde_json::from_str(raw.trim()).map_err(|e| {
            AzCliError::UnexpectedOutput(format!("Failed to parse threads: {e}; raw: {raw}"))
        })?;
        let threads = response.value;

        let mut comments = Vec::new();

        for thread in threads {
            let thread_id = thread.id.unwrap_or_default();
            let is_resolved = thread.status.as_deref().is_some_and(|status| {
                !matches!(
                    status.to_ascii_lowercase().as_str(),
                    "active" | "pending" | "unknown"
                )
            });
            let file_path = thread
                .thread_context
                .as_ref()
                .and_then(|c| c.file_path.clone());
            let line = thread
                .thread_context
                .as_ref()
                .and_then(|c| c.right_file_start.as_ref())
                .and_then(|p| p.line);

            if let Some(thread_comments) = thread.comments {
                let mut root_id = None;
                for c in thread_comments {
                    // Skip system-generated comments
                    if c.comment_type.as_deref() == Some("system") {
                        continue;
                    }

                    let id = format!("{thread_id}:{}", c.id.unwrap_or_default());
                    let parent_id = root_id.clone();
                    root_id.get_or_insert_with(|| id.clone());
                    let author = c
                        .author
                        .and_then(|a| a.display_name)
                        .unwrap_or_else(|| "unknown".to_string());
                    let body = c.content.unwrap_or_default();
                    let created_at = c
                        .published_date
                        .and_then(|s| DateTime::parse_from_rfc3339(&s).ok())
                        .map(|dt| dt.with_timezone(&Utc))
                        .unwrap_or_else(Utc::now);

                    if let Some(ref path) = file_path {
                        comments.push(UnifiedPrComment::Review {
                            id,
                            author,
                            author_association: None,
                            body,
                            created_at,
                            url: None,
                            path: path.clone(),
                            line,
                            side: None,
                            diff_hunk: None,
                            parent_id,
                            review_id: Some(thread_id.to_string()),
                            thread_id: Some(thread_id.to_string()),
                            is_resolved: Some(is_resolved),
                            is_outdated: None,
                        });
                    } else {
                        comments.push(UnifiedPrComment::General {
                            id,
                            author,
                            author_association: None,
                            body,
                            created_at,
                            url: None,
                            parent_id,
                        });
                    }
                }
            }
        }

        comments.sort_by_key(|c| c.created_at());
        Ok(comments)
    }

    /// Map Azure DevOps PR status to MergeStatus
    fn map_azure_status(status: &str) -> MergeStatus {
        match status.to_lowercase().as_str() {
            "active" => MergeStatus::Open,
            "completed" => MergeStatus::Merged,
            "abandoned" => MergeStatus::Closed,
            _ => MergeStatus::Unknown,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_pr_url() {
        // dev.azure.com format
        let (org, id) = AzCli::parse_pr_url(
            "https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequest/123",
        )
        .unwrap();
        assert_eq!(org, "myorg");
        assert_eq!(id, 123);
    }

    #[test]
    fn test_parse_pr_url_visualstudio() {
        // Legacy visualstudio.com format
        let (org, id) = AzCli::parse_pr_url(
            "https://myorg.visualstudio.com/myproject/_git/myrepo/pullrequest/456",
        )
        .unwrap();
        assert_eq!(org, "myorg");
        assert_eq!(id, 456);
    }

    #[test]
    fn test_parse_pr_url_invalid() {
        // GitHub URL should return None
        assert!(AzCli::parse_pr_url("https://github.com/owner/repo/pull/123").is_none());
        // Missing pullrequest path
        assert!(AzCli::parse_pr_url("https://dev.azure.com/myorg/myproject/_git/myrepo").is_none());
    }

    #[test]
    fn test_parse_pr_repository_url() {
        let (repo, pr_id) = AzCli::parse_pr_repository_url(
            "https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequest/123",
        )
        .unwrap();

        assert_eq!(repo.organization_url, "https://dev.azure.com/myorg");
        assert_eq!(repo.project_id, "myproject");
        assert_eq!(repo.repo_id, "myrepo");
        assert_eq!(pr_id, 123);
    }

    #[test]
    fn test_map_azure_status() {
        assert!(matches!(
            AzCli::map_azure_status("active"),
            MergeStatus::Open
        ));
        assert!(matches!(
            AzCli::map_azure_status("completed"),
            MergeStatus::Merged
        ));
        assert!(matches!(
            AzCli::map_azure_status("abandoned"),
            MergeStatus::Closed
        ));
        assert!(matches!(
            AzCli::map_azure_status("unknown"),
            MergeStatus::Unknown
        ));
    }

    #[test]
    fn test_parse_pr_response_preserves_draft_status() {
        let detail = AzCli::parse_pr_response(
            r#"{
                "pullRequestId": 123,
                "status": "active",
                "isDraft": true,
                "repository": {
                    "webUrl": "https://dev.azure.com/org/project/_git/repo"
                }
            }"#,
        )
        .unwrap();

        assert!(detail.is_draft);
    }

    #[test]
    fn test_parse_pr_threads_uses_thread_scoped_comment_ids() {
        let comments = AzCli::parse_pr_threads(
            r#"{
                "value": [
                    {
                        "id": 10,
                        "comments": [{"id": 1, "content": "first"}]
                    },
                    {
                        "id": 20,
                        "comments": [{"id": 1, "content": "second"}]
                    }
                ]
            }"#,
        )
        .unwrap();

        let ids = comments
            .iter()
            .map(|comment| match comment {
                UnifiedPrComment::General { id, .. } | UnifiedPrComment::Review { id, .. } => {
                    id.as_str()
                }
            })
            .collect::<Vec<_>>();

        assert_eq!(ids, vec!["10:1", "20:1"]);
    }

    #[test]
    fn test_parse_pr_threads_nests_replies_under_thread_root() {
        let comments = AzCli::parse_pr_threads(
            r#"{
                "value": [{
                    "id": 10,
                    "status": "fixed",
                    "threadContext": {
                        "filePath": "src/file.ts",
                        "rightFileStart": {"line": 4}
                    },
                    "comments": [
                        {"id": 1, "content": "root"},
                        {"id": 2, "content": "reply"}
                    ]
                }]
            }"#,
        )
        .unwrap();

        let parent_id = match &comments[1] {
            UnifiedPrComment::General { parent_id, .. }
            | UnifiedPrComment::Review { parent_id, .. } => parent_id.as_deref(),
        };
        assert_eq!(parent_id, Some("10:1"));
        let resolved = match &comments[0] {
            UnifiedPrComment::Review { is_resolved, .. } => *is_resolved,
            UnifiedPrComment::General { .. } => None,
        };
        assert_eq!(resolved, Some(true));
    }

    #[test]
    fn test_urls_match() {
        // Exact match
        assert!(AzCli::urls_match(
            "https://dev.azure.com/myorg/myproject/_git/myrepo",
            "https://dev.azure.com/myorg/myproject/_git/myrepo"
        ));

        // Trailing slash
        assert!(AzCli::urls_match(
            "https://dev.azure.com/myorg/myproject/_git/myrepo/",
            "https://dev.azure.com/myorg/myproject/_git/myrepo"
        ));

        // .git suffix
        assert!(AzCli::urls_match(
            "https://dev.azure.com/myorg/myproject/_git/myrepo.git",
            "https://dev.azure.com/myorg/myproject/_git/myrepo"
        ));

        // Case insensitive
        assert!(AzCli::urls_match(
            "https://dev.azure.com/MyOrg/MyProject/_git/MyRepo",
            "https://dev.azure.com/myorg/myproject/_git/myrepo"
        ));

        // Different repos should not match
        assert!(!AzCli::urls_match(
            "https://dev.azure.com/myorg/myproject/_git/repo1",
            "https://dev.azure.com/myorg/myproject/_git/repo2"
        ));

        // SSH URLs
        assert!(AzCli::urls_match(
            "git@ssh.dev.azure.com:v3/myorg/myproject/myrepo",
            "git@ssh.dev.azure.com:v3/myorg/myproject/myrepo"
        ));

        // SSH URL with ssh:// prefix should match scp-style
        assert!(AzCli::urls_match(
            "ssh://git@ssh.dev.azure.com:v3/myorg/myproject/myrepo",
            "git@ssh.dev.azure.com:v3/myorg/myproject/myrepo"
        ));
    }

    #[test]
    fn test_extract_organization_url_dev_azure() {
        let org_url =
            AzCli::extract_organization_url("https://dev.azure.com/myorg/myproject/_git/myrepo")
                .unwrap();
        assert_eq!(org_url, "https://dev.azure.com/myorg");
    }

    #[test]
    fn test_extract_organization_url_visualstudio() {
        let org_url =
            AzCli::extract_organization_url("https://myorg.visualstudio.com/myproject/_git/myrepo")
                .unwrap();
        assert_eq!(org_url, "https://myorg.visualstudio.com");
    }

    #[test]
    fn test_extract_organization_url_invalid() {
        assert!(AzCli::extract_organization_url("https://github.com/owner/repo").is_none());
    }
}
