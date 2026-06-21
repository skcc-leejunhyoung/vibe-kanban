//! Pure decision logic for "review mode" workspace creation.
//!
//! Review mode lets a workspace created from a `review`-tagged issue work
//! directly on an existing PR's head branch (no new `vk/` worktree branch) and
//! auto-link that PR. This module holds only the *pure* decisions; the
//! side-effecting setup (gh pr checkout, DB writes, worktree creation) lives in
//! the handler shell so it can be exercised by `cargo test` without git/gh.

use db::models::requests::{PrReviewInput, WorkspaceRepoInput};
use thiserror::Error;

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

    #[test]
    fn review_target_branch_ref_formats_remote_and_base() {
        assert_eq!(review_target_branch_ref("origin", "main"), "origin/main");
    }
}
