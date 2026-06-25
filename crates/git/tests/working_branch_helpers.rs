// Covers the git helpers behind the workspace "working branch" selector:
//   - is_branch_checked_out: rejecting reuse of an already-checked-out branch.
//   - forking a local tracking branch from a remote-only branch, so a
//     continue-work selection lands on a real branch (not a detached HEAD).
use git::{GitCli, GitService};
use tempfile::TempDir;

/// A repo with one commit on `main` and a `feature` branch that exists but is
/// not checked out anywhere.
fn repo_with_unchecked_branch(root: &TempDir) -> std::path::PathBuf {
    let cli = GitCli::new();
    let work = root.path().join("work");
    let work_s = work.to_str().unwrap();
    cli.git(root.path(), ["init", "-q", work_s]).unwrap();
    let w = work.as_path();
    cli.git(w, ["config", "user.email", "t@t.com"]).unwrap();
    cli.git(w, ["config", "user.name", "t"]).unwrap();
    std::fs::write(work.join("a.txt"), "a").unwrap();
    cli.git(w, ["add", "a.txt"]).unwrap();
    cli.git(w, ["commit", "-qm", "init"]).unwrap();
    cli.git(w, ["branch", "-M", "main"]).unwrap();
    cli.git(w, ["branch", "feature"]).unwrap();
    work
}

#[test]
fn is_branch_checked_out_tracks_main_and_linked_worktrees() {
    let root = TempDir::new().unwrap();
    let work = repo_with_unchecked_branch(&root);
    let git = GitService::new();

    // `main` is the main worktree's HEAD; `feature` merely exists.
    assert!(git.is_branch_checked_out(&work, "main").unwrap());
    assert!(!git.is_branch_checked_out(&work, "feature").unwrap());
    assert!(!git.is_branch_checked_out(&work, "missing").unwrap());

    // Check `feature` out in a linked worktree -> now reported as checked out.
    let wt = root.path().join("wt-feature");
    git.add_worktree(&work, &wt, "feature", false).unwrap();
    assert!(git.is_branch_checked_out(&work, "feature").unwrap());
}

#[test]
fn fork_local_branch_from_remote_only_branch_is_not_detached() {
    let root = TempDir::new().unwrap();
    let cli = GitCli::new();
    let remote = root.path().join("remote.git");
    let work = root.path().join("work");
    let remote_s = remote.to_str().unwrap();
    let work_s = work.to_str().unwrap();

    cli.git(root.path(), ["init", "-q", "--bare", remote_s])
        .unwrap();
    cli.git(root.path(), ["clone", "-q", remote_s, work_s])
        .unwrap();
    let w = work.as_path();
    cli.git(w, ["config", "user.email", "t@t.com"]).unwrap();
    cli.git(w, ["config", "user.name", "t"]).unwrap();
    std::fs::write(work.join("a.txt"), "a").unwrap();
    cli.git(w, ["add", "a.txt"]).unwrap();
    cli.git(w, ["commit", "-qm", "init"]).unwrap();
    cli.git(w, ["branch", "-M", "main"]).unwrap();
    cli.git(w, ["push", "-q", "origin", "main"]).unwrap();
    // `feature` ends up only on the remote.
    cli.git(w, ["checkout", "-qb", "feature"]).unwrap();
    std::fs::write(work.join("b.txt"), "b").unwrap();
    cli.git(w, ["add", "b.txt"]).unwrap();
    cli.git(w, ["commit", "-qm", "feat"]).unwrap();
    cli.git(w, ["push", "-q", "origin", "feature"]).unwrap();
    cli.git(w, ["checkout", "-q", "main"]).unwrap();
    cli.git(w, ["branch", "-D", "feature"]).unwrap();

    let git = GitService::new();
    assert!(!git.check_local_branch_exists(w, "feature").unwrap());

    // Fork a local branch from the remote-tracking branch (what resolve_working_branch
    // does for an Existing selection surfaced as "origin/feature").
    git.create_branch(w, "feature", "origin/feature").unwrap();
    assert!(git.check_local_branch_exists(w, "feature").unwrap());

    // The worktree must land on the real branch, not a detached HEAD.
    let wt = root.path().join("wt");
    git.add_worktree(w, &wt, "feature", false).unwrap();
    let wt_repo = git2::Repository::open(&wt).unwrap();
    let head = wt_repo.head().unwrap();
    assert!(
        head.is_branch(),
        "worktree HEAD should be a branch, not detached"
    );
    assert_eq!(head.name(), Some("refs/heads/feature"));
}
