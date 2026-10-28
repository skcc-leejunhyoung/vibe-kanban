use std::{fs, path::PathBuf};

use git::{GitCli, GitService};
use git2::Repository;
use tempfile::TempDir;
use utils::repo_url::pr_in_remote;

#[test]
fn review_remote_urls_ignore_partial_clone_annotations_and_push_urls() {
    let temp = TempDir::new().unwrap();
    let repo = Repository::init(temp.path()).unwrap();
    let git = GitService::new();
    assert!(git.list_remotes(temp.path()).unwrap().is_empty());

    for url in [
        "https://github.com/example/search.git",
        "git@github.com:example/search.git",
        "ssh://git@github.com/example/search.git",
    ] {
        for filter in [None, Some("blob:none"), Some("blob:limit=1024")] {
            let mut config = repo.config().unwrap();
            config.set_str("remote.origin.url", url).unwrap();
            config
                .set_str("remote.origin.pushurl", "https://example.com/other.git")
                .unwrap();
            if let Some(filter) = filter {
                config.set_bool("remote.origin.promisor", true).unwrap();
                config
                    .set_str("remote.origin.partialclonefilter", filter)
                    .unwrap();
            } else {
                let _ = config.remove("remote.origin.partialclonefilter");
            }
            if let Some(filter) = filter {
                assert!(
                    GitCli::new()
                        .git(temp.path(), ["remote", "-v"])
                        .unwrap()
                        .contains(&format!("(fetch) [{filter}]"))
                );
            }

            let remotes = git.list_remotes(temp.path()).unwrap();
            assert_eq!(remotes.len(), 1);
            assert_eq!(remotes[0].name, "origin");
            assert_eq!(remotes[0].url, url);
            assert!(pr_in_remote(
                "https://github.com/example/search/pull/42",
                &remotes[0].url
            ));
            assert!(!pr_in_remote(
                "https://github.com/example/other/pull/42",
                &remotes[0].url
            ));
        }
    }
}

#[test]
fn review_remote_urls_preserve_git_url_rewrites_and_local_path_spaces() {
    let temp = TempDir::new().unwrap();
    let repo = Repository::init(temp.path()).unwrap();
    let mut config = repo.config().unwrap();
    config
        .set_str("remote.origin.url", "review-test:example/search.git")
        .unwrap();
    config
        .set_str("url.https://github.com/.insteadOf", "review-test:")
        .unwrap();
    config
        .set_str("remote.backup.url", "/tmp/review repo (fetch) [blob:none]")
        .unwrap();
    let remotes = GitService::new().list_remotes(temp.path()).unwrap();
    assert_eq!(remotes.len(), 2);
    assert_eq!(remotes[0].name, "backup");
    assert_eq!(remotes[0].url, "/tmp/review repo (fetch) [blob:none]");
    assert_eq!(remotes[1].url, "https://github.com/example/search.git");
}

fn single_branch_clone(temp: &TempDir, partial: bool) -> PathBuf {
    let seed = temp.path().join("seed");
    GitService::new()
        .initialize_repo_with_main_branch(&seed)
        .unwrap();
    let repo = Repository::open(&seed).unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    let sig = git2::Signature::now("Review Test", "review@example.com").unwrap();
    let mut tree = repo.treebuilder(None).unwrap();
    tree.insert("tracked.txt", repo.blob(b"base\n").unwrap(), 0o100644)
        .unwrap();
    let base_tree = repo.find_tree(tree.write().unwrap()).unwrap();
    let base = repo
        .commit(
            Some("refs/heads/dev"),
            &sig,
            &sig,
            "base",
            &base_tree,
            &[&head],
        )
        .unwrap();
    tree.insert("tracked.txt", repo.blob(b"feature\n").unwrap(), 0o100644)
        .unwrap();
    let feature_tree = repo.find_tree(tree.write().unwrap()).unwrap();
    repo.commit(
        Some("refs/heads/feature/review-fixture"),
        &sig,
        &sig,
        "feature",
        &feature_tree,
        &[&repo.find_commit(base).unwrap()],
    )
    .unwrap();
    repo.config()
        .unwrap()
        .set_bool("uploadpack.allowFilter", true)
        .unwrap();

    let url = format!("file://{}", seed.display());
    let mut args = vec![
        "clone",
        "--single-branch",
        "--branch",
        "feature/review-fixture",
    ];
    if partial {
        args.push("--filter=blob:none");
    }
    args.extend([url.as_str(), "clone"]);
    GitCli::new().git(temp.path(), args).unwrap();
    temp.path().join("clone")
}

#[test]
fn single_branch_review_fetches_only_missing_base_without_switching_checkout() {
    for partial in [false, true] {
        let temp = TempDir::new().unwrap();
        let path = single_branch_clone(&temp, partial);
        let repo = Repository::open(&path).unwrap();
        let before = repo.head().unwrap().target();
        let base = Repository::open(temp.path().join("seed"))
            .unwrap()
            .find_reference("refs/heads/dev")
            .unwrap()
            .target();
        let remote_url = repo
            .find_remote("origin")
            .unwrap()
            .url()
            .unwrap()
            .to_string();
        let fetch = repo
            .config()
            .unwrap()
            .get_string("remote.origin.fetch")
            .unwrap();
        assert!(repo.find_reference("refs/remotes/origin/dev").is_err());
        fs::write(path.join("user-work.txt"), "keep me\n").unwrap();
        fs::write(path.join("tracked.txt"), "user edits\n").unwrap();

        let git = GitService::new();
        git.ensure_remote_branch(&path, "origin", "dev").unwrap();
        // Existing bases need no network access on a retry.
        repo.remote_set_url("origin", "/missing-review-remote")
            .unwrap();
        git.ensure_remote_branch(&path, "origin", "dev").unwrap();
        assert_eq!(repo.head().unwrap().target(), before);
        assert_eq!(
            repo.head().unwrap().shorthand().unwrap(),
            "feature/review-fixture"
        );
        assert_eq!(
            fs::read_to_string(path.join("user-work.txt")).unwrap(),
            "keep me\n"
        );
        assert_eq!(
            fs::read_to_string(path.join("tracked.txt")).unwrap(),
            "user edits\n"
        );
        assert_eq!(
            repo.config()
                .unwrap()
                .get_string("remote.origin.fetch")
                .unwrap(),
            fetch
        );
        assert!(repo.find_branch("dev", git2::BranchType::Local).is_err());
        assert!(repo.find_reference("refs/remotes/origin/main").is_err());
        assert_eq!(
            repo.find_reference("refs/remotes/origin/dev")
                .unwrap()
                .target(),
            base
        );
        if partial {
            assert_eq!(
                repo.config()
                    .unwrap()
                    .get_string("remote.origin.partialclonefilter")
                    .unwrap(),
                "blob:none"
            );
        }

        repo.remote_set_url("origin", &remote_url).unwrap();
        let worktree = temp.path().join("review");
        git.add_worktree(&path, &worktree, "origin/dev", false)
            .unwrap();
        assert_eq!(
            repo.head().unwrap().shorthand().unwrap(),
            "feature/review-fixture"
        );
        assert_eq!(
            Repository::open(&worktree)
                .unwrap()
                .head()
                .unwrap()
                .target(),
            base
        );
        assert_eq!(
            fs::read_to_string(worktree.join("tracked.txt")).unwrap(),
            "base\n"
        );
    }
}

#[test]
fn missing_or_invalid_review_base_fails_without_creating_refs_or_switching_checkout() {
    let temp = TempDir::new().unwrap();
    let path = single_branch_clone(&temp, true);
    let repo = Repository::open(&path).unwrap();
    let git = GitService::new();
    for branch in ["missing", "dev:refs/heads/injected", "../dev", ""] {
        assert!(git.ensure_remote_branch(&path, "origin", branch).is_err());
    }
    assert!(git.ensure_remote_branch(&path, "unknown", "dev").is_err());
    assert!(repo.find_reference("refs/heads/injected").is_err());
    assert!(repo.find_reference("refs/remotes/origin/missing").is_err());
    assert_eq!(
        repo.head().unwrap().shorthand().unwrap(),
        "feature/review-fixture"
    );
}
