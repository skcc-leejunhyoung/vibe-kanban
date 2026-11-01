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

#[test]
fn review_base_outside_single_branch_mapping_resolves_and_refreshes_status() {
    for partial in [false, true] {
        for remote_name in ["origin", "mirror/team"] {
            let temp = TempDir::new().unwrap();
            let path = single_branch_clone(&temp, partial);
            let repo = Repository::open(&path).unwrap();
            if remote_name != "origin" {
                repo.remote_rename("origin", remote_name).unwrap();
                // Both prefixes match; only the longer registered name owns this ref.
                repo.remote("mirror", "/unused-shorter-remote").unwrap();
                repo.config()
                    .unwrap()
                    .set_str(
                        "remote.mirror.fetch",
                        "+refs/heads/other:refs/remotes/mirror/other",
                    )
                    .unwrap();
            }
            let original_head = repo.head().unwrap().target();
            let review_branch = "review/00000000-0000-4000-8000-000000000004";
            repo.branch(
                review_branch,
                &repo.head().unwrap().peel_to_commit().unwrap(),
                false,
            )
            .unwrap();
            let config_key = format!("remote.{remote_name}.fetch");
            let original_fetch = repo.config().unwrap().get_string(&config_key).unwrap();
            fs::write(path.join("tracked.txt"), "author edits\n").unwrap();
            fs::write(path.join("notes.txt"), "author notes\n").unwrap();

            let git = GitService::new();
            git.ensure_remote_branch(&path, remote_name, "dev").unwrap();
            let base = format!("{remote_name}/dev");
            assert_eq!(
                git.get_remote_from_branch_name(&path, &base).unwrap().name,
                remote_name
            );
            assert_eq!(git.local_target_branch_name(&path, &base).unwrap(), "dev");
            assert_eq!(
                git.get_remote_branch_status(&path, review_branch, Some(&base))
                    .unwrap(),
                (1, 0)
            );

            // Polling must compare against the newly fetched base, not the old ref handle.
            let seed = Repository::open(temp.path().join("seed")).unwrap();
            let old_base = seed
                .find_reference("refs/heads/dev")
                .unwrap()
                .peel_to_commit()
                .unwrap();
            let signature =
                git2::Signature::now("Synthetic Test", "fixture@example.invalid").unwrap();
            let new_base = seed
                .commit(
                    Some("refs/heads/dev"),
                    &signature,
                    &signature,
                    "advance synthetic base",
                    &old_base.tree().unwrap(),
                    &[&old_base],
                )
                .unwrap();
            assert_eq!(
                git.get_remote_branch_status(&path, review_branch, Some(&base))
                    .unwrap(),
                (1, 1)
            );
            assert_eq!(
                repo.refname_to_id(&format!("refs/remotes/{base}")).unwrap(),
                new_base
            );
            assert_eq!(repo.head().unwrap().target(), original_head);
            assert_eq!(
                repo.head().unwrap().shorthand().unwrap(),
                "feature/review-fixture"
            );
            assert_eq!(
                fs::read_to_string(path.join("tracked.txt")).unwrap(),
                "author edits\n"
            );
            assert_eq!(
                fs::read_to_string(path.join("notes.txt")).unwrap(),
                "author notes\n"
            );
            assert_eq!(
                repo.config().unwrap().get_string(&config_key).unwrap(),
                original_fetch
            );
            assert!(
                repo.find_reference(&format!("refs/remotes/{remote_name}/main"))
                    .is_err()
            );
            assert!(!git.check_local_branch_exists(&path, "dev").unwrap());
            if partial {
                assert_eq!(
                    repo.config()
                        .unwrap()
                        .get_string(&format!("remote.{remote_name}.partialclonefilter"))
                        .unwrap(),
                    "blob:none"
                );
            }
        }
    }
}

#[test]
fn review_base_status_fetch_respects_custom_destination_mappings() {
    for partial in [false, true] {
        let temp = TempDir::new().unwrap();
        let path = single_branch_clone(&temp, partial);
        let cli = GitCli::new();
        cli.git(
            &path,
            [
                "config",
                "--add",
                "remote.origin.fetch",
                "+refs/heads/dev:refs/remotes/cache/base",
            ],
        )
        .unwrap();
        cli.fetch_with_refspec(&path, "origin", "refs/heads/dev:refs/remotes/cache/base")
            .unwrap();
        let original_fetch = cli
            .git(&path, ["config", "--get-all", "remote.origin.fetch"])
            .unwrap();
        let git = GitService::new();
        assert_eq!(
            git.get_remote_from_branch_name(&path, "cache/base")
                .unwrap()
                .name,
            "origin"
        );
        assert_eq!(
            git.get_remote_branch_status(&path, "feature/review-fixture", Some("cache/base"))
                .unwrap(),
            (1, 0)
        );
        assert_eq!(
            cli.git(&path, ["config", "--get-all", "remote.origin.fetch"])
                .unwrap(),
            original_fetch
        );
        let repo = Repository::open(&path).unwrap();
        assert!(repo.find_reference("refs/remotes/origin/dev").is_err());
        assert!(repo.find_reference("refs/remotes/origin/main").is_err());
    }
}

#[test]
fn remote_resolution_preserves_custom_mappings_and_rejects_unknown_or_ambiguous_refs() {
    let temp = TempDir::new().unwrap();
    let git = GitService::new();
    git.initialize_repo_with_main_branch(temp.path()).unwrap();
    let repo = Repository::open(temp.path()).unwrap();
    let head = repo.head().unwrap().target().unwrap();
    repo.remote("configured", "/unused-configured-remote")
        .unwrap();
    repo.remote("cache", "/unused-prefix-remote").unwrap();
    let mut config = repo.config().unwrap();
    config
        .set_str(
            "remote.configured.fetch",
            "+refs/heads/*:refs/remotes/cache/*",
        )
        .unwrap();
    config
        .set_str(
            "remote.cache.fetch",
            "+refs/heads/other:refs/remotes/cache/other",
        )
        .unwrap();
    repo.reference("refs/remotes/cache/dev", head, true, "synthetic base")
        .unwrap();
    assert_eq!(
        git.get_remote_from_branch_name(temp.path(), "cache/dev")
            .unwrap()
            .name,
        "configured"
    );
    repo.reference("refs/remotes/cache-extra/dev", head, true, "unknown remote")
        .unwrap();
    assert!(
        git.get_remote_from_branch_name(temp.path(), "cache-extra/dev")
            .is_err()
    );

    repo.remote("second", "/unused-second-remote").unwrap();
    config
        .set_str("remote.second.fetch", "+refs/heads/*:refs/remotes/cache/*")
        .unwrap();
    let error = git
        .get_remote_from_branch_name(temp.path(), "cache/dev")
        .unwrap_err();
    assert!(
        matches!(error, git::GitServiceError::Git(ref error) if error.code() == git2::ErrorCode::Ambiguous)
    );
}

#[test]
fn publishing_from_single_branch_clone_tracks_only_the_published_head() {
    for partial in [false, true] {
        for branch in [
            "review/00000000-0000-4000-8000-000000000003",
            "feature/new-pr",
        ] {
            let temp = TempDir::new().unwrap();
            let path = single_branch_clone(&temp, partial);
            let repo = Repository::open(&path).unwrap();
            let author_head = repo.head().unwrap().peel_to_commit().unwrap();
            repo.branch(branch, &author_head, false).unwrap();
            GitCli::new().git(&path, ["checkout", branch]).unwrap();
            let mut config = repo.config().unwrap();
            config
                .set_str(&format!("branch.{branch}.remote"), "origin")
                .unwrap();
            config
                .set_str(
                    &format!("branch.{branch}.merge"),
                    "refs/heads/feature/review-fixture",
                )
                .unwrap();
            let original_fetch = config.get_string("remote.origin.fetch").unwrap();
            let git = GitService::new();
            let expected_fetch = vec![
                original_fetch,
                format!("+refs/heads/{branch}:refs/remotes/origin/{branch}"),
            ];

            // Both initial publication and retries must succeed without widening to '*'.
            for _ in 0..2 {
                git.push_branch_to_named_remote(&path, branch, "origin", false, false)
                    .unwrap();
                let fetch: Vec<_> = repo
                    .find_remote("origin")
                    .unwrap()
                    .fetch_refspecs()
                    .unwrap()
                    .iter()
                    .map(|value| value.unwrap().unwrap().to_string())
                    .collect();
                assert_eq!(fetch, expected_fetch);
                assert_eq!(
                    repo.find_branch(branch, git2::BranchType::Local)
                        .unwrap()
                        .upstream()
                        .unwrap()
                        .name()
                        .unwrap(),
                    Some(format!("origin/{branch}").as_str())
                );
            }

            fs::write(path.join("tracked.txt"), "new PR fix\n").unwrap();
            git.commit(&path, "new PR fix").unwrap();
            git.push_to_remote(&path, branch, false, false).unwrap();
            let upstream = Repository::open(temp.path().join("seed")).unwrap();
            assert_eq!(
                upstream
                    .refname_to_id(&format!("refs/heads/{branch}"))
                    .unwrap(),
                repo.head().unwrap().target().unwrap()
            );
            assert_eq!(
                upstream
                    .refname_to_id("refs/heads/feature/review-fixture")
                    .unwrap(),
                author_head.id()
            );
            assert_eq!(
                repo.refname_to_id("refs/heads/feature/review-fixture")
                    .unwrap(),
                author_head.id()
            );
            if partial {
                assert_eq!(
                    config
                        .get_string("remote.origin.partialclonefilter")
                        .unwrap(),
                    "blob:none"
                );
            }
        }
    }
}
