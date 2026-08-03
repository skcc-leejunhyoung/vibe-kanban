//! GitHub hosting service implementation.

mod cli;

use std::{collections::HashMap, path::Path, time::Duration};

use async_trait::async_trait;
use backon::{ExponentialBuilder, Retryable};
pub use cli::GhCli;
use cli::{GhCliError, GitHubRepoInfo};
use tokio::task;
use tracing::info;

use crate::{
    GitHostProvider,
    types::{
        CreatePrRequest, GitHostError, PrComment, PrReviewComment, PrReviewThread, ProviderKind,
        PullRequestDetail, PullRequestSummary, UnifiedPrComment,
    },
};

#[derive(Debug, Clone)]
pub struct GitHubProvider {
    gh_cli: GhCli,
}

impl GitHubProvider {
    pub fn new() -> Result<Self, GitHostError> {
        Ok(Self {
            gh_cli: GhCli::new(),
        })
    }

    pub async fn list_pull_request_summaries(
        &self,
        repo_path: &Path,
        remote_url: &str,
        involves_me: bool,
    ) -> Result<Vec<PullRequestSummary>, GitHostError> {
        let repo_info = self.get_repo_info(remote_url, repo_path).await?;
        let repository = repo_info.search_repo_spec();
        let hostname = repo_info.hostname;
        let cli = self.gh_cli.clone();
        task::spawn_blocking(move || {
            cli.list_pull_request_summaries(&repository, hostname.as_deref(), involves_me)
        })
        .await
        .map_err(|err| {
            GitHostError::PullRequest(format!(
                "Failed to execute GitHub CLI for pull request search: {err}"
            ))
        })?
        .map_err(Into::into)
    }

    async fn get_repo_info(
        &self,
        remote_url: &str,
        repo_path: &Path,
    ) -> Result<GitHubRepoInfo, GitHostError> {
        let cli = self.gh_cli.clone();
        let url = remote_url.to_string();
        let path = repo_path.to_path_buf();
        task::spawn_blocking(move || cli.get_repo_info(&url, &path))
            .await
            .map_err(|err| {
                GitHostError::Repository(format!("Failed to get repo info from URL: {err}"))
            })?
            .map_err(Into::into)
    }

    async fn fetch_general_comments(
        &self,
        cli: &GhCli,
        repo_info: &GitHubRepoInfo,
        pr_number: i64,
    ) -> Result<Vec<PrComment>, GitHostError> {
        let cli = cli.clone();
        let repo_info = repo_info.clone();

        (|| async {
            let cli = cli.clone();
            let repo_info = repo_info.clone();

            let comments = task::spawn_blocking(move || cli.get_pr_comments(&repo_info, pr_number))
                .await
                .map_err(|err| {
                    GitHostError::PullRequest(format!(
                        "Failed to execute GitHub CLI for fetching PR comments: {err}"
                    ))
                })?;
            comments.map_err(GitHostError::from)
        })
        .retry(
            &ExponentialBuilder::default()
                .with_min_delay(Duration::from_secs(1))
                .with_max_delay(Duration::from_secs(30))
                .with_max_times(3)
                .with_jitter(),
        )
        .when(|e: &GitHostError| e.should_retry())
        .notify(|err: &GitHostError, dur: Duration| {
            tracing::warn!(
                "GitHub API call failed, retrying after {:.2}s: {}",
                dur.as_secs_f64(),
                err
            );
        })
        .await
    }

    async fn fetch_review_comments(
        &self,
        cli: &GhCli,
        repo_info: &GitHubRepoInfo,
        pr_number: i64,
    ) -> Result<Vec<PrReviewComment>, GitHostError> {
        let cli = cli.clone();
        let repo_info = repo_info.clone();

        (|| async {
            let cli = cli.clone();
            let repo_info = repo_info.clone();

            let comments =
                task::spawn_blocking(move || cli.get_pr_review_comments(&repo_info, pr_number))
                    .await
                    .map_err(|err| {
                        GitHostError::PullRequest(format!(
                            "Failed to execute GitHub CLI for fetching review comments: {err}"
                        ))
                    })?;
            comments.map_err(GitHostError::from)
        })
        .retry(
            &ExponentialBuilder::default()
                .with_min_delay(Duration::from_secs(1))
                .with_max_delay(Duration::from_secs(30))
                .with_max_times(3)
                .with_jitter(),
        )
        .when(|e: &GitHostError| e.should_retry())
        .notify(|err: &GitHostError, dur: Duration| {
            tracing::warn!(
                "GitHub API call failed, retrying after {:.2}s: {}",
                dur.as_secs_f64(),
                err
            );
        })
        .await
    }

    async fn fetch_review_threads(
        &self,
        cli: &GhCli,
        repo_info: &GitHubRepoInfo,
        pr_number: i64,
    ) -> Result<Vec<PrReviewThread>, GitHostError> {
        let cli = cli.clone();
        let repo_info = repo_info.clone();
        task::spawn_blocking(move || cli.get_pr_review_threads(&repo_info, pr_number))
            .await
            .map_err(|err| {
                GitHostError::PullRequest(format!(
                    "Failed to execute GitHub CLI for fetching review threads: {err}"
                ))
            })?
            .map_err(Into::into)
    }

    async fn get_comments_for_repo(
        &self,
        repo_info: &GitHubRepoInfo,
        pr_number: i64,
    ) -> Result<Vec<UnifiedPrComment>, GitHostError> {
        let cli1 = self.gh_cli.clone();
        let cli2 = self.gh_cli.clone();
        let cli3 = self.gh_cli.clone();

        let (general_result, review_result, threads_result) = tokio::join!(
            self.fetch_general_comments(&cli1, repo_info, pr_number),
            self.fetch_review_comments(&cli2, repo_info, pr_number),
            self.fetch_review_threads(&cli3, repo_info, pr_number)
        );

        let (general_comments, review_comments) = match (general_result, review_result) {
            (Ok(general), Ok(review)) => (general, review),
            (Ok(general), Err(error)) => {
                tracing::warn!(
                    "Failed to fetch inline comments for PR #{pr_number}; showing general comments: {error}"
                );
                (general, Vec::new())
            }
            (Err(error), Ok(review)) => {
                tracing::warn!(
                    "Failed to fetch general comments for PR #{pr_number}; showing inline comments: {error}"
                );
                (Vec::new(), review)
            }
            (Err(error), Err(_)) => return Err(error),
        };
        let review_threads = threads_result.unwrap_or_else(|error| {
            tracing::warn!("Failed to fetch review thread metadata for PR #{pr_number}: {error}");
            Vec::new()
        });
        let thread_by_comment: HashMap<i64, &PrReviewThread> = review_threads
            .iter()
            .flat_map(|thread| {
                thread
                    .comment_ids
                    .iter()
                    .map(move |comment_id| (*comment_id, thread))
            })
            .collect();

        let mut unified: Vec<UnifiedPrComment> = general_comments
            .into_iter()
            .map(|comment| UnifiedPrComment::General {
                id: comment.id,
                author: comment.author.login,
                author_association: Some(comment.author_association),
                body: comment.body,
                created_at: comment.created_at,
                url: Some(comment.url),
                parent_id: None,
            })
            .collect();

        unified.extend(review_comments.into_iter().map(|comment| {
            let thread = thread_by_comment.get(&comment.id);
            UnifiedPrComment::Review {
                id: comment.id.to_string(),
                author: comment.user.login,
                author_association: Some(comment.author_association),
                body: comment.body,
                created_at: comment.created_at,
                url: Some(comment.html_url),
                path: comment.path,
                line: comment.line,
                side: comment.side,
                diff_hunk: Some(comment.diff_hunk),
                parent_id: comment.in_reply_to_id.map(|id| id.to_string()),
                review_id: comment.pull_request_review_id.map(|id| id.to_string()),
                thread_id: thread.map(|thread| thread.id.clone()),
                is_resolved: thread.map(|thread| thread.is_resolved),
                is_outdated: thread.map(|thread| thread.is_outdated),
            }
        }));

        unified.sort_by_key(|comment| comment.created_at());
        Ok(unified)
    }
}

impl From<GhCliError> for GitHostError {
    fn from(error: GhCliError) -> Self {
        match &error {
            GhCliError::AuthFailed(msg) => GitHostError::AuthFailed(msg.clone()),
            GhCliError::NotAvailable => GitHostError::CliNotInstalled {
                provider: ProviderKind::GitHub,
            },
            GhCliError::CommandFailed(msg) => {
                let lower = msg.to_ascii_lowercase();
                if lower.contains("403") || lower.contains("forbidden") {
                    GitHostError::InsufficientPermissions(msg.clone())
                } else if lower.contains("404") || lower.contains("not found") {
                    GitHostError::RepoNotFoundOrNoAccess(msg.clone())
                } else if lower.contains("not a git repository") {
                    GitHostError::NotAGitRepository(msg.clone())
                } else {
                    GitHostError::PullRequest(msg.clone())
                }
            }
            GhCliError::UnexpectedOutput(msg) => GitHostError::UnexpectedOutput(msg.clone()),
        }
    }
}

#[async_trait]
impl GitHostProvider for GitHubProvider {
    async fn create_pr(
        &self,
        repo_path: &Path,
        remote_url: &str,
        request: &CreatePrRequest,
    ) -> Result<PullRequestDetail, GitHostError> {
        // Get owner/repo from the remote URL (target repo for the PR).
        let target_repo_info = self.get_repo_info(remote_url, repo_path).await?;

        // For cross-fork PRs, get the head repo info to format head_branch as "owner:branch".
        let head_branch = if let Some(head_url) = &request.head_repo_url {
            let head_repo_info = self.get_repo_info(head_url, repo_path).await?;
            if head_repo_info.owner != target_repo_info.owner {
                format!("{}:{}", head_repo_info.owner, request.head_branch)
            } else {
                request.head_branch.clone()
            }
        } else {
            request.head_branch.clone()
        };

        let mut request_clone = request.clone();
        request_clone.head_branch = head_branch;

        (|| async {
            let cli = self.gh_cli.clone();
            let request = request_clone.clone();
            let target_repo = target_repo_info.clone();
            let repo_path = repo_path.to_path_buf();

            let cli_result =
                task::spawn_blocking(move || cli.create_pr(&request, &target_repo, &repo_path))
                    .await
                    .map_err(|err| {
                        GitHostError::PullRequest(format!(
                            "Failed to execute GitHub CLI for PR creation: {err}"
                        ))
                    })?
                    .map_err(GitHostError::from)?;

            info!(
                "Created GitHub PR #{} for branch {}",
                cli_result.number, request_clone.head_branch
            );

            Ok(cli_result)
        })
        .retry(
            &ExponentialBuilder::default()
                .with_min_delay(Duration::from_secs(1))
                .with_max_delay(Duration::from_secs(30))
                .with_max_times(3)
                .with_jitter(),
        )
        .when(|e: &GitHostError| e.should_retry())
        .notify(|err: &GitHostError, dur: Duration| {
            tracing::warn!(
                "GitHub API call failed, retrying after {:.2}s: {}",
                dur.as_secs_f64(),
                err
            );
        })
        .await
    }

    async fn get_pr_status(&self, pr_url: &str) -> Result<PullRequestDetail, GitHostError> {
        let detail_cli = self.gh_cli.clone();
        let events_cli = self.gh_cli.clone();
        let url = pr_url.to_string();

        (|| async {
            let detail_cli = detail_cli.clone();
            let events_cli = events_cli.clone();
            let detail_url = url.clone();
            let events_url = url.clone();
            let (detail_result, events_result) = tokio::join!(
                task::spawn_blocking(move || detail_cli.view_pr(&detail_url)),
                task::spawn_blocking(move || {
                    events_cli.get_pr_review_request_events(&events_url)
                })
            );
            let mut detail = detail_result.map_err(|err| {
                GitHostError::PullRequest(format!(
                    "Failed to execute GitHub CLI for viewing PR: {err}"
                ))
            })??;
            match events_result {
                Ok(Ok(review_requests)) => detail.review_requests = review_requests,
                Ok(Err(error)) => tracing::warn!(
                    %error,
                    "Failed to load PR review request timeline; continuing without it"
                ),
                Err(error) => tracing::warn!(
                    %error,
                    "Failed to join PR review request timeline task; continuing without it"
                ),
            }
            Ok(detail)
        })
        .retry(
            &ExponentialBuilder::default()
                .with_min_delay(Duration::from_secs(1))
                .with_max_delay(Duration::from_secs(30))
                .with_max_times(3)
                .with_jitter(),
        )
        .when(|err: &GitHostError| err.should_retry())
        .notify(|err: &GitHostError, dur: Duration| {
            tracing::warn!(
                "GitHub API call failed, retrying after {:.2}s: {}",
                dur.as_secs_f64(),
                err
            );
        })
        .await
    }

    async fn list_prs_for_branch(
        &self,
        repo_path: &Path,
        remote_url: &str,
        branch_name: &str,
    ) -> Result<Vec<PullRequestDetail>, GitHostError> {
        let repo_info = self.get_repo_info(remote_url, repo_path).await?;

        let cli = self.gh_cli.clone();
        let branch = branch_name.to_string();

        (|| async {
            let cli = cli.clone();
            let repo_info = repo_info.clone();
            let branch = branch.clone();

            let prs = task::spawn_blocking(move || cli.list_prs_for_branch(&repo_info, &branch))
                .await
                .map_err(|err| {
                    GitHostError::PullRequest(format!(
                        "Failed to execute GitHub CLI for listing PRs: {err}"
                    ))
                })?;
            prs.map_err(GitHostError::from)
        })
        .retry(
            &ExponentialBuilder::default()
                .with_min_delay(Duration::from_secs(1))
                .with_max_delay(Duration::from_secs(30))
                .with_max_times(3)
                .with_jitter(),
        )
        .when(|e: &GitHostError| e.should_retry())
        .notify(|err: &GitHostError, dur: Duration| {
            tracing::warn!(
                "GitHub API call failed, retrying after {:.2}s: {}",
                dur.as_secs_f64(),
                err
            );
        })
        .await
    }

    async fn get_pr_comments(
        &self,
        repo_path: &Path,
        remote_url: &str,
        pr_number: i64,
    ) -> Result<Vec<UnifiedPrComment>, GitHostError> {
        let repo_info = self.get_repo_info(remote_url, repo_path).await?;
        self.get_comments_for_repo(&repo_info, pr_number).await
    }

    async fn get_pr_comments_by_url(
        &self,
        pr_url: &str,
        pr_number: i64,
    ) -> Result<Vec<UnifiedPrComment>, GitHostError> {
        let repo_info = GitHubRepoInfo::from_pr_url(pr_url)?;
        self.get_comments_for_repo(&repo_info, pr_number).await
    }

    async fn set_pr_review_thread_resolved(
        &self,
        repo_path: &Path,
        remote_url: &str,
        _pr_number: i64,
        thread_id: &str,
        resolved: bool,
    ) -> Result<(), GitHostError> {
        let repo_info = self.get_repo_info(remote_url, repo_path).await?;
        let cli = self.gh_cli.clone();
        let thread_id = thread_id.to_string();
        task::spawn_blocking(move || {
            cli.set_pr_review_thread_resolved(&repo_info, &thread_id, resolved)
        })
        .await
        .map_err(|err| {
            GitHostError::PullRequest(format!(
                "Failed to execute GitHub CLI for updating review thread: {err}"
            ))
        })?
        .map_err(Into::into)
    }

    async fn set_pr_review_thread_resolved_by_url(
        &self,
        pr_url: &str,
        _pr_number: i64,
        thread_id: &str,
        resolved: bool,
    ) -> Result<(), GitHostError> {
        let repo_info = GitHubRepoInfo::from_pr_url(pr_url)?;
        let cli = self.gh_cli.clone();
        let thread_id = thread_id.to_string();
        task::spawn_blocking(move || {
            cli.set_pr_review_thread_resolved(&repo_info, &thread_id, resolved)
        })
        .await
        .map_err(|err| {
            GitHostError::PullRequest(format!(
                "Failed to execute GitHub CLI for updating review thread: {err}"
            ))
        })?
        .map_err(Into::into)
    }

    async fn list_open_prs(
        &self,
        repo_path: &Path,
        remote_url: &str,
    ) -> Result<Vec<PullRequestDetail>, GitHostError> {
        let repo_info = self.get_repo_info(remote_url, repo_path).await?;

        let cli = self.gh_cli.clone();

        (|| async {
            let cli = cli.clone();
            let owner = repo_info.owner.clone();
            let repo_name = repo_info.repo_name.clone();

            let prs = task::spawn_blocking(move || cli.list_prs(&owner, &repo_name))
                .await
                .map_err(|err| {
                    GitHostError::PullRequest(format!(
                        "Failed to execute GitHub CLI for listing PRs: {err}"
                    ))
                })?;
            prs.map_err(GitHostError::from)
        })
        .retry(
            &ExponentialBuilder::default()
                .with_min_delay(Duration::from_secs(1))
                .with_max_delay(Duration::from_secs(30))
                .with_max_times(3)
                .with_jitter(),
        )
        .when(|e: &GitHostError| e.should_retry())
        .notify(|err: &GitHostError, dur: Duration| {
            tracing::warn!(
                "GitHub API call failed, retrying after {:.2}s: {}",
                dur.as_secs_f64(),
                err
            );
        })
        .await
    }

    fn provider_kind(&self) -> ProviderKind {
        ProviderKind::GitHub
    }
}
