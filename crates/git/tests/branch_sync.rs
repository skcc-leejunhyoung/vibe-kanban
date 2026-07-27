//! Tests for the work-branch sync operations: `pull_workspace_branch`
//! (fast-forward from the branch's own remote) and `merge_base_into_workspace`
//! (merge the base branch into the work branch).

use std::{fs, io::Write, path::Path};

use git::{ConflictOp, GitService, GitServiceError, PullOutcome};
use git2::{PushOptions, Repository, build::CheckoutBuilder};
use tempfile::TempDir;

fn write_file<P: AsRef<Path>>(base: P, rel: &str, content: &str) {
    let path = base.as_ref().join(rel);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    let mut f = fs::File::create(&path).unwrap();
    f.write_all(content.as_bytes()).unwrap();
}

fn configure_user(repo: &Repository) {
    let mut cfg = repo.config().unwrap();
    cfg.set_str("user.name", "Test User").unwrap();
    cfg.set_str("user.email", "test@example.com").unwrap();
}

fn commit_all(repo: &Repository, message: &str) -> git2::Oid {
    let mut index = repo.index().unwrap();
    index
        .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
        .unwrap();
    index.write().unwrap();
    let tree_id = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_id).unwrap();
    let sig = repo.signature().unwrap();
    let parents: Vec<git2::Commit> = match repo.head() {
        Ok(h) => vec![h.peel_to_commit().unwrap()],
        Err(e) if e.code() == git2::ErrorCode::UnbornBranch => vec![],
        Err(e) => panic!("failed to read HEAD: {e}"),
    };
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
    let update_ref = if repo.head().is_ok() {
        Some("HEAD")
    } else {
        None
    };
    repo.commit(update_ref, &sig, &sig, message, &tree, &parent_refs)
        .unwrap()
}

fn checkout_branch(repo: &Repository, name: &str) {
    repo.set_head(&format!("refs/heads/{name}")).unwrap();
    let mut co = CheckoutBuilder::new();
    co.force();
    repo.checkout_head(Some(&mut co)).unwrap();
}

fn create_branch_from_head(repo: &Repository, name: &str) {
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    repo.branch(name, &head, true).unwrap();
}

fn push_ref(repo: &Repository, refspec_local: &str, refspec_remote: &str) {
    let mut remote = repo.find_remote("origin").unwrap();
    let mut opts = PushOptions::new();
    let spec = format!("+{refspec_local}:{refspec_remote}");
    remote.push(&[spec.as_str()], Some(&mut opts)).unwrap();
}

/// Create a bare remote seeded with `main` and a `feature` branch, then clone it
/// into `local` with a local `feature` branch checked out. Returns the remote
/// URL so further clones (e.g. a collaborator) can be made.
fn setup_remote_and_local_feature(temp: &TempDir) -> String {
    let remote_path = temp.path().join("remote.git");
    Repository::init_bare(&remote_path).unwrap();
    let remote_url = remote_path.to_str().unwrap().to_string();

    let seed_path = temp.path().join("seed");
    let service = GitService::new();
    service
        .initialize_repo_with_main_branch(&seed_path)
        .unwrap();
    let seed = Repository::open(&seed_path).unwrap();
    configure_user(&seed);
    checkout_branch(&seed, "main");
    write_file(&seed_path, "common.txt", "base\n");
    commit_all(&seed, "init main");
    create_branch_from_head(&seed, "feature");
    checkout_branch(&seed, "feature");
    write_file(&seed_path, "feature.txt", "v1\n");
    commit_all(&seed, "feature v1");
    seed.remote("origin", &remote_url).unwrap();
    push_ref(&seed, "refs/heads/main", "refs/heads/main");
    push_ref(&seed, "refs/heads/feature", "refs/heads/feature");

    let local_path = temp.path().join("local");
    let local = Repository::clone(&remote_url, &local_path).unwrap();
    configure_user(&local);
    let feat = local
        .find_reference("refs/remotes/origin/feature")
        .unwrap()
        .peel_to_commit()
        .unwrap();
    local.branch("feature", &feat, false).unwrap();
    checkout_branch(&local, "feature");

    remote_url
}

/// Push a new commit to `feature` from a second clone, simulating a collaborator.
fn collaborator_push_feature_commit(temp: &TempDir, remote_url: &str, content: &str) {
    let updater_path = temp.path().join("updater");
    let updater = Repository::clone(remote_url, &updater_path).unwrap();
    configure_user(&updater);
    let feat = updater
        .find_reference("refs/remotes/origin/feature")
        .unwrap()
        .peel_to_commit()
        .unwrap();
    updater.branch("feature", &feat, false).unwrap();
    checkout_branch(&updater, "feature");
    write_file(&updater_path, "feature.txt", content);
    commit_all(&updater, "collaborator commit");
    push_ref(&updater, "refs/heads/feature", "refs/heads/feature");
}

#[test]
fn pull_fast_forwards_local_branch_to_remote() {
    let temp = TempDir::new().unwrap();
    let remote_url = setup_remote_and_local_feature(&temp);
    let local_path = temp.path().join("local");

    collaborator_push_feature_commit(&temp, &remote_url, "v2\n");

    let s = GitService::new();
    let outcome = s.pull_workspace_branch(&local_path, "feature").unwrap();
    match outcome {
        PullOutcome::FastForwarded { commits, .. } => assert_eq!(commits, 1),
        other => panic!("expected FastForwarded, got {other:?}"),
    }

    // The working tree was advanced to the collaborator's content.
    let content = fs::read_to_string(local_path.join("feature.txt")).unwrap();
    assert_eq!(content, "v2\n");
}

#[test]
fn pull_reports_up_to_date_when_remote_unchanged() {
    let temp = TempDir::new().unwrap();
    setup_remote_and_local_feature(&temp);
    let local_path = temp.path().join("local");

    let s = GitService::new();
    let outcome = s.pull_workspace_branch(&local_path, "feature").unwrap();
    assert!(
        matches!(outcome, PullOutcome::UpToDate),
        "expected UpToDate, got {outcome:?}"
    );
}

#[test]
fn pull_reports_diverged_without_touching_local_branch() {
    let temp = TempDir::new().unwrap();
    let remote_url = setup_remote_and_local_feature(&temp);
    let local_path = temp.path().join("local");

    // Local makes its own commit, and a collaborator pushes a different one:
    // the branches now diverge and a fast-forward is impossible.
    let local = Repository::open(&local_path).unwrap();
    write_file(&local_path, "local.txt", "local-only\n");
    let local_tip = commit_all(&local, "local commit");
    collaborator_push_feature_commit(&temp, &remote_url, "v2\n");

    let s = GitService::new();
    let outcome = s.pull_workspace_branch(&local_path, "feature").unwrap();
    match outcome {
        PullOutcome::Diverged { ahead, behind } => {
            assert_eq!(ahead, 1);
            assert_eq!(behind, 1);
        }
        other => panic!("expected Diverged, got {other:?}"),
    }

    // The local branch tip must be unchanged (we never rewrote or moved it).
    let head = Repository::open(&local_path)
        .unwrap()
        .head()
        .unwrap()
        .peel_to_commit()
        .unwrap()
        .id();
    assert_eq!(head, local_tip);
}

#[test]
fn merge_base_brings_base_commits_into_work_branch() {
    let temp = TempDir::new().unwrap();
    let repo_path = temp.path().join("repo");
    let worktree_path = temp.path().join("wt-feature");
    let s = GitService::new();

    s.initialize_repo_with_main_branch(&repo_path).unwrap();
    let repo = Repository::open(&repo_path).unwrap();
    configure_user(&repo);
    checkout_branch(&repo, "main");
    write_file(&repo_path, "common.txt", "base\n");
    commit_all(&repo, "init main");

    // Fork `feature` and give it its own commit in a worktree.
    create_branch_from_head(&repo, "feature");
    s.add_worktree(&repo_path, &worktree_path, "feature", false)
        .unwrap();
    {
        let wt = Repository::open(&worktree_path).unwrap();
        configure_user(&wt);
        write_file(&worktree_path, "feature.txt", "feat\n");
        commit_all(&wt, "feature commit");
    }

    // Advance the base branch so it is ahead of the fork point.
    checkout_branch(&repo, "main");
    write_file(&repo_path, "base2.txt", "from base\n");
    commit_all(&repo, "advance base");

    let merged = s
        .merge_base_into_workspace(&repo_path, &worktree_path, "feature", "main")
        .unwrap();
    assert!(merged, "expected a merge to be performed");

    // The base commit's file is now present on the work branch, and HEAD is a
    // merge commit (two parents) — history was preserved, not rewritten.
    assert!(worktree_path.join("base2.txt").exists());
    let parent_count = Repository::open(&worktree_path)
        .unwrap()
        .head()
        .unwrap()
        .peel_to_commit()
        .unwrap()
        .parent_count();
    assert_eq!(parent_count, 2);
}

#[test]
fn merge_base_updates_unchecked_target_branch_in_temporary_worktree() {
    let temp = TempDir::new().unwrap();
    let repo_path = temp.path().join("repo");
    let s = GitService::new();

    s.initialize_repo_with_main_branch(&repo_path).unwrap();
    let repo = Repository::open(&repo_path).unwrap();
    configure_user(&repo);
    checkout_branch(&repo, "main");
    write_file(&repo_path, "common.txt", "base\n");
    commit_all(&repo, "init main");

    create_branch_from_head(&repo, "feature");
    checkout_branch(&repo, "feature");
    write_file(&repo_path, "feature.txt", "feature\n");
    commit_all(&repo, "feature commit");

    checkout_branch(&repo, "main");
    write_file(&repo_path, "base2.txt", "from base\n");
    commit_all(&repo, "advance base");

    assert!(!s.is_branch_checked_out(&repo_path, "feature").unwrap());

    let merged = s
        .merge_base_into_branch_checkout(&repo_path, "feature", "main")
        .unwrap();
    assert!(merged, "expected a merge to be performed");
    assert!(
        !s.is_branch_checked_out(&repo_path, "feature").unwrap(),
        "temporary worktree should be removed"
    );

    let updated_repo = Repository::open(&repo_path).unwrap();
    let feature = updated_repo
        .find_branch("feature", git2::BranchType::Local)
        .unwrap()
        .into_reference()
        .peel_to_commit()
        .unwrap();
    assert_eq!(feature.parent_count(), 2);
}

#[test]
fn merge_base_aborts_and_removes_temporary_worktree_after_conflict() {
    let temp = TempDir::new().unwrap();
    let repo_path = temp.path().join("repo");
    let s = GitService::new();

    s.initialize_repo_with_main_branch(&repo_path).unwrap();
    let repo = Repository::open(&repo_path).unwrap();
    configure_user(&repo);
    checkout_branch(&repo, "main");
    write_file(&repo_path, "shared.txt", "base\n");
    commit_all(&repo, "init main");

    create_branch_from_head(&repo, "feature");
    checkout_branch(&repo, "feature");
    write_file(&repo_path, "shared.txt", "feature change\n");
    let feature_tip = commit_all(&repo, "feature change");

    checkout_branch(&repo, "main");
    write_file(&repo_path, "shared.txt", "base change\n");
    commit_all(&repo, "base change");

    let err = s
        .merge_base_into_branch_checkout(&repo_path, "feature", "main")
        .unwrap_err();
    assert!(matches!(err, GitServiceError::InvalidRepository(_)));
    assert!(
        !s.is_branch_checked_out(&repo_path, "feature").unwrap(),
        "temporary conflict worktree should be removed"
    );

    let feature_head = Repository::open(&repo_path)
        .unwrap()
        .find_branch("feature", git2::BranchType::Local)
        .unwrap()
        .into_reference()
        .target()
        .unwrap();
    assert_eq!(feature_head, feature_tip);
}

#[test]
fn merge_base_is_noop_when_already_up_to_date() {
    let temp = TempDir::new().unwrap();
    let repo_path = temp.path().join("repo");
    let worktree_path = temp.path().join("wt-feature");
    let s = GitService::new();

    s.initialize_repo_with_main_branch(&repo_path).unwrap();
    let repo = Repository::open(&repo_path).unwrap();
    configure_user(&repo);
    checkout_branch(&repo, "main");
    write_file(&repo_path, "common.txt", "base\n");
    commit_all(&repo, "init main");

    // Feature is ahead of main but main never moved, so there is nothing to merge.
    create_branch_from_head(&repo, "feature");
    s.add_worktree(&repo_path, &worktree_path, "feature", false)
        .unwrap();
    {
        let wt = Repository::open(&worktree_path).unwrap();
        configure_user(&wt);
        write_file(&worktree_path, "feature.txt", "feat\n");
        commit_all(&wt, "feature commit");
    }

    let merged = s
        .merge_base_into_workspace(&repo_path, &worktree_path, "feature", "main")
        .unwrap();
    assert!(!merged, "expected no merge when already up to date");
}

#[test]
fn merge_base_surfaces_conflicts_and_leaves_merge_in_progress() {
    let temp = TempDir::new().unwrap();
    let repo_path = temp.path().join("repo");
    let worktree_path = temp.path().join("wt-feature");
    let s = GitService::new();

    s.initialize_repo_with_main_branch(&repo_path).unwrap();
    let repo = Repository::open(&repo_path).unwrap();
    configure_user(&repo);
    checkout_branch(&repo, "main");
    write_file(&repo_path, "shared.txt", "base\n");
    commit_all(&repo, "init main");

    // Feature and base edit the same file differently -> merge conflict.
    create_branch_from_head(&repo, "feature");
    s.add_worktree(&repo_path, &worktree_path, "feature", false)
        .unwrap();
    {
        let wt = Repository::open(&worktree_path).unwrap();
        configure_user(&wt);
        write_file(&worktree_path, "shared.txt", "feature change\n");
        commit_all(&wt, "feature edits shared");
    }

    checkout_branch(&repo, "main");
    write_file(&repo_path, "shared.txt", "base change\n");
    commit_all(&repo, "base edits shared");

    let err = s
        .merge_base_into_workspace(&repo_path, &worktree_path, "feature", "main")
        .unwrap_err();
    match err {
        GitServiceError::MergeConflicts {
            conflicted_files, ..
        } => {
            assert!(
                conflicted_files.iter().any(|f| f == "shared.txt"),
                "conflicted files: {conflicted_files:?}"
            );
        }
        other => panic!("expected MergeConflicts, got {other:?}"),
    }

    // The worktree is left mid-merge so the existing conflict UI / abort flow
    // (which already handles ConflictOp::Merge) can take over.
    assert_eq!(
        s.detect_conflict_op(&worktree_path).unwrap(),
        Some(ConflictOp::Merge)
    );
}
