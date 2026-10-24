//! Pure decision logic for "review mode" workspace creation.
//!
//! Review mode lets a workspace created from a `review`-tagged issue work
//! directly on an existing PR's head branch (no new `vk/` worktree branch) and
//! auto-link that PR. This module holds only the *pure* decisions; the
//! side-effecting setup (gh pr checkout, DB writes, worktree creation) lives in
//! the handler shell so it can be exercised by `cargo test` without git/gh.

use db::models::requests::{PrReviewInput, WorkspaceRepoInput};
use git::GitRemote;
use thiserror::Error;
use utils::repo_url::{pr_in_remote, pr_repo_key};

/// How a workspace's git branch should be set up.
#[derive(Debug)]
pub enum BranchSetup<'a> {
    /// Default: create a new `vk/`-prefixed worktree branch from the target branch.
    NewWorktreeBranch,
    /// Review mode: check out an existing PR head branch and link the PR.
    ExistingPrBranch(&'a PrReviewInput),
}

/// Why a review-mode request was rejected. Mapped to `ApiError::BadRequest` by
/// the handler shell.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ReviewModeError {
    #[error("review mode supports exactly one repository, got {0}")]
    MultiRepoUnsupported(usize),
    #[error("review mode repo_id does not match the workspace repository")]
    RepoMismatch,
    #[error("review mode requires a non-empty head branch")]
    MissingHeadBranch,
    #[error("review mode requires a non-empty base branch")]
    MissingBaseBranch,
    #[error("review mode requires a positive PR number, got {0}")]
    InvalidPrNumber(i64),
    #[error(
        "PR {pr_url} is not in this repository (remotes: {remotes}); create the review in the repository that clones it"
    )]
    PrNotInRepository { pr_url: String, remotes: String },
    #[error("remote '{0}' does not exist in this repository")]
    UnknownRemote(String),
    #[error("the repository has no remote to check the PR out from")]
    NoRemote,
}

/// Decide how to set up the workspace branch from the create-request parts.
///
/// Returns [`BranchSetup::ExistingPrBranch`] when `pr_review` is present and
/// valid, otherwise [`BranchSetup::NewWorktreeBranch`]. Validates the review
/// payload against the repo list (single repo, matching id, sane PR fields).
pub fn plan_branch_setup<'a>(
    repos: &[WorkspaceRepoInput],
    pr_review: Option<&'a PrReviewInput>,
) -> Result<BranchSetup<'a>, ReviewModeError> {
    let Some(pr) = pr_review else {
        return Ok(BranchSetup::NewWorktreeBranch);
    };

    if repos.len() != 1 {
        return Err(ReviewModeError::MultiRepoUnsupported(repos.len()));
    }
    if repos[0].repo_id != pr.repo_id {
        return Err(ReviewModeError::RepoMismatch);
    }
    if pr.head_branch.trim().is_empty() {
        return Err(ReviewModeError::MissingHeadBranch);
    }
    if pr.base_branch.trim().is_empty() {
        return Err(ReviewModeError::MissingBaseBranch);
    }
    if pr.pr_number <= 0 {
        return Err(ReviewModeError::InvalidPrNumber(pr.pr_number));
    }

    Ok(BranchSetup::ExistingPrBranch(pr))
}

/// The remote of the review repository that hosts the PR: the requested one
/// (which must), else the default remote when it does, else any that does. A
/// PR URL naming no comparable repository keeps the requested-else-default
/// choice, so providers without a parsable PR URL are unaffected.
pub fn pick_review_remote<'a>(
    pr_url: &str,
    remotes: &'a [GitRemote],
    requested: Option<&str>,
    default: Option<&str>,
) -> Result<&'a GitRemote, ReviewModeError> {
    let by_name = |name: &str| {
        remotes
            .iter()
            .find(|r| r.name == name)
            .ok_or_else(|| ReviewModeError::UnknownRemote(name.to_string()))
    };
    if pr_repo_key(pr_url).is_none() {
        return by_name(requested.or(default).ok_or(ReviewModeError::NoRemote)?);
    }
    let hosts_pr = |r: &&GitRemote| pr_in_remote(pr_url, &r.url);
    let picked = match requested {
        Some(name) => Some(by_name(name)?).filter(hosts_pr),
        None => default
            .and_then(|name| by_name(name).ok())
            .filter(hosts_pr)
            .or_else(|| remotes.iter().find(hosts_pr)),
    };
    picked.ok_or_else(|| ReviewModeError::PrNotInRepository {
        pr_url: pr_url.to_string(),
        remotes: remotes
            .iter()
            .map(|r| format!("{}={}", r.name, r.url))
            .collect::<Vec<_>>()
            .join(", "),
    })
}

/// Build the initial worktree ref for a review-mode workspace: `"{remote}/{base}"`.
/// Mirrors the existing create-from-PR flow so merges/new PRs target the base.
pub fn review_target_branch_ref(remote_name: &str, base_branch: &str) -> String {
    format!("{remote_name}/{base_branch}")
}

#[cfg(test)]
mod tests {
    use db::models::requests::{PrReviewInput, WorkspaceRepoInput};
    use uuid::Uuid;

    use super::*;

    fn repo(repo_id: Uuid) -> WorkspaceRepoInput {
        WorkspaceRepoInput {
            repo_id,
            target_branch: "main".to_string(),
            create_target_branch: false,
            github_linked_branch: None,
        }
    }

    fn pr_review(repo_id: Uuid) -> PrReviewInput {
        PrReviewInput {
            repo_id,
            pr_number: 42,
            pr_title: "Fix things".to_string(),
            pr_url: "https://github.com/o/r/pull/42".to_string(),
            head_branch: "feature-x".to_string(),
            base_branch: "main".to_string(),
            remote_name: Some("origin".to_string()),
        }
    }

    #[test]
    fn no_pr_review_is_new_worktree_branch() {
        let repos = vec![repo(Uuid::new_v4())];
        let plan = plan_branch_setup(&repos, None).expect("normal plan");
        assert!(matches!(plan, BranchSetup::NewWorktreeBranch));
    }

    #[test]
    fn valid_pr_review_single_repo_is_existing_pr_branch() {
        let repo_id = Uuid::new_v4();
        let repos = vec![repo(repo_id)];
        let pr = pr_review(repo_id);
        match plan_branch_setup(&repos, Some(&pr)).expect("review plan") {
            BranchSetup::ExistingPrBranch(got) => {
                assert_eq!(got.head_branch, "feature-x");
                assert_eq!(got.pr_number, 42);
            }
            BranchSetup::NewWorktreeBranch => panic!("expected ExistingPrBranch"),
        }
    }

    #[test]
    fn multi_repo_review_is_rejected() {
        let repo_id = Uuid::new_v4();
        let repos = vec![repo(repo_id), repo(Uuid::new_v4())];
        let pr = pr_review(repo_id);
        assert!(matches!(
            plan_branch_setup(&repos, Some(&pr)),
            Err(ReviewModeError::MultiRepoUnsupported(2))
        ));
    }

    #[test]
    fn repo_id_mismatch_is_rejected() {
        let repos = vec![repo(Uuid::new_v4())];
        let pr = pr_review(Uuid::new_v4());
        assert!(matches!(
            plan_branch_setup(&repos, Some(&pr)),
            Err(ReviewModeError::RepoMismatch)
        ));
    }

    #[test]
    fn blank_head_branch_is_rejected() {
        let repo_id = Uuid::new_v4();
        let repos = vec![repo(repo_id)];
        let mut pr = pr_review(repo_id);
        pr.head_branch = "   ".to_string();
        assert!(matches!(
            plan_branch_setup(&repos, Some(&pr)),
            Err(ReviewModeError::MissingHeadBranch)
        ));
    }

    #[test]
    fn blank_base_branch_is_rejected() {
        let repo_id = Uuid::new_v4();
        let repos = vec![repo(repo_id)];
        let mut pr = pr_review(repo_id);
        pr.base_branch = String::new();
        assert!(matches!(
            plan_branch_setup(&repos, Some(&pr)),
            Err(ReviewModeError::MissingBaseBranch)
        ));
    }

    #[test]
    fn non_positive_pr_number_is_rejected() {
        let repo_id = Uuid::new_v4();
        let repos = vec![repo(repo_id)];
        let mut pr = pr_review(repo_id);
        pr.pr_number = 0;
        assert!(matches!(
            plan_branch_setup(&repos, Some(&pr)),
            Err(ReviewModeError::InvalidPrNumber(0))
        ));
    }

    fn remotes() -> Vec<GitRemote> {
        [
            ("origin", "git@github.com:me/widgets.git"),
            ("upstream", "https://github.com/acme/widgets"),
        ]
        .into_iter()
        .map(|(name, url)| GitRemote {
            name: name.to_string(),
            url: url.to_string(),
        })
        .collect()
    }

    #[test]
    fn review_remote_is_the_one_hosting_the_pr() {
        let remotes = remotes();
        let pr = "https://github.com/acme/widgets/pull/42";
        // Default remote is the fork: the upstream that hosts the PR wins.
        let picked = pick_review_remote(pr, &remotes, None, Some("origin")).unwrap();
        assert_eq!(picked.name, "upstream");
        let picked = pick_review_remote(pr, &remotes, Some("upstream"), Some("origin")).unwrap();
        assert_eq!(picked.name, "upstream");
    }

    #[test]
    fn review_in_the_wrong_repository_is_rejected_before_checkout() {
        let remotes = remotes();
        let other = "https://github.com/acme/other/pull/42";
        let error = pick_review_remote(other, &remotes, None, Some("origin")).unwrap_err();
        assert!(matches!(error, ReviewModeError::PrNotInRepository { .. }));
        assert!(
            error
                .to_string()
                .contains("upstream=https://github.com/acme/widgets")
        );
        assert!(matches!(
            pick_review_remote(
                "https://github.com/acme/widgets/pull/1",
                &remotes,
                Some("origin"),
                None
            ),
            Err(ReviewModeError::PrNotInRepository { .. })
        ));
        assert_eq!(
            pick_review_remote(other, &remotes, Some("nope"), None).unwrap_err(),
            ReviewModeError::UnknownRemote("nope".to_string())
        );
    }

    #[test]
    fn unparsable_pr_url_keeps_requested_or_default_remote() {
        let remotes = remotes();
        let url = "https://git.example.com/acme/widgets/merge_requests/1";
        assert_eq!(
            pick_review_remote(url, &remotes, None, Some("origin"))
                .unwrap()
                .name,
            "origin"
        );
        assert_eq!(
            pick_review_remote(url, &remotes, None, None).unwrap_err(),
            ReviewModeError::NoRemote
        );
    }

    #[test]
    fn review_target_branch_ref_formats_remote_and_base() {
        assert_eq!(review_target_branch_ref("origin", "main"), "origin/main");
    }
}
