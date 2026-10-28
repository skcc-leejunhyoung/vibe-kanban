#![cfg(unix)]

use std::{fs, os::unix::fs::PermissionsExt, path::Path, process::Command};

use chrono::Utc;
use db::models::{
    repo::Repo,
    requests::PrReviewInput,
    workspace::{CreateWorkspace, Workspace},
    workspace_repo::{CreateWorkspaceRepo, WorkspaceRepo},
};
use git::{GitCli, GitRemote, GitService};
use serde_json::json;
use sqlx::sqlite::SqlitePoolOptions;
use tempfile::TempDir;
use uuid::Uuid;
use workspace_manager::{RepoWorkspaceInput, WorkspaceManager};

use super::{checkout_pr_head, cleanup_failed_pr_workspace};

// Replace only GitHub metadata/network access; checkout and reset use native Git.
const GH_FIXTURE: &str = r#"#!/bin/sh
set -eu
if [ "$1" = repo ]; then
  printf '%s\n' '{"owner":{"login":"acme"},"name":"widgets","url":"https://github.com/acme/widgets"}'
  exit 0
fi
[ "$1" = pr ] && [ "$2" = checkout ]
[ "$3" != 404 ] || { echo 'fixture: PR unavailable' >&2; exit 1; }
shift 3
branch=feature/review-fixture
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) shift 2 ;;
    --force) shift ;;
    --branch) branch=$2; shift 2 ;;
    *) exit 2 ;;
  esac
done
"$VK_REVIEW_TEST_GIT" fetch origin +refs/heads/feature/review-fixture:refs/remotes/origin/feature/review-fixture --no-tags
if "$VK_REVIEW_TEST_GIT" show-ref --verify --quiet "refs/heads/$branch"; then
  "$VK_REVIEW_TEST_GIT" checkout "$branch"
  "$VK_REVIEW_TEST_GIT" reset --hard refs/remotes/origin/feature/review-fixture
else
  "$VK_REVIEW_TEST_GIT" checkout -b "$branch" --track origin/feature/review-fixture
fi
"#;

fn commit(cli: &GitCli, path: &Path) {
    cli.git(path, ["add", "tracked.txt"]).unwrap();
    cli.git(
        path,
        ["-c", "commit.gpgsign=false", "commit", "-m", "fixture"],
    )
    .unwrap();
}

#[tokio::test]
async fn review_checkout_preserves_author_and_recreates_private_branch() {
    let Some(root) = std::env::var_os("VK_REVIEW_CHECKOUT_TEST_ROOT") else {
        // A child process keeps the fake executable out of other tests' PATH.
        let temp = TempDir::new().unwrap();
        let bin = temp.path().join("bin");
        fs::create_dir(&bin).unwrap();
        let gh = bin.join("gh");
        fs::write(&gh, GH_FIXTURE).unwrap();
        fs::set_permissions(&gh, fs::Permissions::from_mode(0o755)).unwrap();
        let path = std::env::join_paths(
            std::iter::once(bin).chain(std::env::split_paths(&std::env::var_os("PATH").unwrap())),
        )
        .unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "routes::workspaces::pr::review_checkout_tests::review_checkout_preserves_author_and_recreates_private_branch",
                "--nocapture",
            ])
            .env("VK_REVIEW_CHECKOUT_TEST_ROOT", temp.path())
            .env(
                "VK_REVIEW_TEST_GIT",
                utils::shell::resolve_executable_path_blocking("git").unwrap(),
            )
            .env("PATH", path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
        return;
    };

    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::raw_sql(
        "CREATE TABLE workspaces (
        id BLOB PRIMARY KEY, task_id BLOB, container_ref TEXT, branch TEXT NOT NULL,
        setup_completed_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
        archived INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
        name TEXT, worktree_deleted INTEGER NOT NULL DEFAULT 0,
        ephemeral INTEGER NOT NULL DEFAULT 0, in_place INTEGER NOT NULL DEFAULT 0,
        autopilot INTEGER NOT NULL DEFAULT 0, cleanup_blocked_reason TEXT,
        status_note TEXT, status_updated_at TEXT
    );
    CREATE TABLE repos (
        id BLOB PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, display_name TEXT NOT NULL,
        setup_script TEXT, cleanup_script TEXT, archive_script TEXT, copy_files TEXT,
        parallel_setup_script INTEGER NOT NULL DEFAULT 0, dev_server_script TEXT,
        default_target_branch TEXT, default_working_dir TEXT, primary_remote TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE workspace_repos (
        id BLOB PRIMARY KEY, workspace_id BLOB NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        repo_id BLOB NOT NULL REFERENCES repos(id), target_branch TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )",
    )
    .execute(&pool)
    .await
    .unwrap();

    let root = Path::new(&root);
    let cli = GitCli::new();
    let git = GitService::new();
    for partial in [false, true] {
        let case = root.join(if partial { "partial" } else { "ordinary" });
        fs::create_dir(&case).unwrap();
        let seed = case.join("seed");
        git.initialize_repo_with_main_branch(&seed).unwrap();
        fs::write(seed.join("tracked.txt"), "base\n").unwrap();
        commit(&cli, &seed);
        cli.git(&seed, ["branch", "dev"]).unwrap();
        cli.git(&seed, ["checkout", "-b", "feature/review-fixture"])
            .unwrap();
        fs::write(seed.join("tracked.txt"), "first head\n").unwrap();
        commit(&cli, &seed);
        cli.git(&seed, ["config", "uploadpack.allowFilter", "true"])
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
        args.extend([&url, "source"]);
        cli.git(&case, args).unwrap();
        let source = case.join("source");
        let author_head = cli.git(&source, ["rev-parse", "HEAD"]).unwrap();
        fs::write(source.join("tracked.txt"), "author edits\n").unwrap();
        fs::write(source.join("untracked.txt"), "author notes\n").unwrap();
        assert!(!git.check_branch_exists(&source, "origin/dev").unwrap());
        git.ensure_remote_branch(&source, "origin", "dev").unwrap();

        // The remote advances while the author retains a dirty, older checkout.
        fs::write(seed.join("tracked.txt"), "latest PR head\n").unwrap();
        commit(&cli, &seed);
        let latest_head = cli.git(&seed, ["rev-parse", "HEAD"]).unwrap();
        let repo: Repo = serde_json::from_value(json!({
            "id": Uuid::new_v4(), "path": source, "name": "widgets", "display_name": "widgets",
            "setup_script": null, "cleanup_script": null, "archive_script": null,
            "copy_files": null, "parallel_setup_script": false, "dev_server_script": null,
            "default_target_branch": null, "default_working_dir": null,
            "primary_remote": "origin", "created_at": Utc::now(), "updated_at": Utc::now()
        }))
        .unwrap();
        sqlx::query("INSERT INTO repos (id, path, name, display_name) VALUES (?, ?, ?, ?)")
            .bind(repo.id)
            .bind(source.to_str().unwrap())
            .bind(&repo.name)
            .bind(&repo.display_name)
            .execute(&pool)
            .await
            .unwrap();
        let inputs = vec![RepoWorkspaceInput::new(repo, "origin/dev".into())];
        let remote = GitRemote {
            name: "origin".into(),
            url: "https://github.com/acme/widgets.git".into(),
        };
        let mut pr = PrReviewInput {
            repo_id: inputs[0].repo.id,
            pr_number: 42,
            pr_title: "Review".into(),
            pr_url: "https://github.com/acme/widgets/pull/42".into(),
            head_branch: "feature/review-fixture".into(),
            base_branch: "dev".into(),
            remote_name: Some("origin".into()),
        };

        let mut ready_workspaces = Vec::new();
        for _ in 0..2 {
            let id = Uuid::new_v4();
            let pending = Workspace::create(
                &pool,
                &CreateWorkspace {
                    branch: "origin/dev".into(),
                    name: Some("PR review".into()),
                },
                id,
            )
            .await
            .unwrap();
            let review_branch = Workspace::review_branch_name(id);
            let directory = case.join(id.to_string());
            WorkspaceManager::ensure_workspace_exists(&directory, &inputs, &review_branch)
                .await
                .unwrap();
            let worktree = directory.join("widgets");
            assert_eq!(
                Workspace::find_by_id(&pool, id)
                    .await
                    .unwrap()
                    .unwrap()
                    .branch,
                pending.branch
            );

            let ready = checkout_pr_head(&pool, &pending, &worktree, &remote, &pr)
                .await
                .unwrap();
            assert_eq!(ready.branch, review_branch);
            assert!(ready.pr_head_is_work_branch(Some(&pr.head_branch)));
            let mut normal = ready.clone();
            normal.branch = "work".into();
            assert!(normal.pr_head_is_work_branch(None));
            assert!(normal.pr_head_is_work_branch(Some("work")));
            assert!(!normal.pr_head_is_work_branch(Some("feature")));
            assert_eq!(
                cli.git(&worktree, ["branch", "--show-current"])
                    .unwrap()
                    .trim(),
                ready.branch
            );
            assert_eq!(
                cli.git(&worktree, ["rev-parse", "HEAD"]).unwrap(),
                latest_head
            );

            git.remove_worktree(&source, &worktree, false).unwrap();
            WorkspaceManager::ensure_workspace_exists(&directory, &inputs, &ready.branch)
                .await
                .unwrap();
            assert_eq!(
                cli.git(&worktree, ["rev-parse", "HEAD"]).unwrap(),
                latest_head
            );
            assert_eq!(
                cli.git(&worktree, ["branch", "--show-current"])
                    .unwrap()
                    .trim(),
                ready.branch
            );
            ready_workspaces.push((worktree, ready.branch));
        }
        let id = Uuid::new_v4();
        let pending = Workspace::create(
            &pool,
            &CreateWorkspace {
                branch: "origin/dev".into(),
                name: None,
            },
            id,
        )
        .await
        .unwrap();
        let directory = case.join("failed");
        WorkspaceManager::ensure_workspace_exists(
            &directory,
            &inputs,
            &Workspace::review_branch_name(id),
        )
        .await
        .unwrap();
        Workspace::update_container_ref(&pool, id, directory.to_str().unwrap())
            .await
            .unwrap();
        WorkspaceRepo::create_many(
            &pool,
            id,
            &[CreateWorkspaceRepo {
                repo_id: inputs[0].repo.id,
                target_branch: "origin/dev".into(),
            }],
        )
        .await
        .unwrap();
        pr.pr_number = 404;
        let error = checkout_pr_head(&pool, &pending, &directory.join("widgets"), &remote, &pr)
            .await
            .unwrap_err();
        assert!(error.contains("PR unavailable"), "{error}");
        assert_eq!(
            Workspace::find_by_id(&pool, id)
                .await
                .unwrap()
                .unwrap()
                .branch,
            pending.branch
        );
        let failed = Workspace::find_by_id(&pool, id).await.unwrap().unwrap();
        cleanup_failed_pr_workspace(&pool, &failed).await;
        assert!(Workspace::find_by_id(&pool, id).await.unwrap().is_none());
        assert!(
            WorkspaceRepo::find_repos_for_workspace(&pool, id)
                .await
                .unwrap()
                .is_empty()
        );
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while directory.exists()
                || git
                    .check_local_branch_exists(&source, &Workspace::review_branch_name(id))
                    .unwrap()
            {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        for (worktree, branch) in ready_workspaces {
            assert!(worktree.exists());
            assert!(git.check_local_branch_exists(&source, &branch).unwrap());
        }
        assert_eq!(
            cli.git(&source, ["branch", "--show-current"])
                .unwrap()
                .trim(),
            "feature/review-fixture"
        );
        assert_eq!(
            cli.git(&source, ["rev-parse", "HEAD"]).unwrap(),
            author_head
        );
        assert_eq!(
            fs::read_to_string(source.join("tracked.txt")).unwrap(),
            "author edits\n"
        );
        assert_eq!(
            fs::read_to_string(source.join("untracked.txt")).unwrap(),
            "author notes\n"
        );
        assert!(
            !git.check_local_branch_exists(&source, "origin/dev")
                .unwrap()
        );
        if partial {
            assert_eq!(
                cli.git(&source, ["config", "remote.origin.partialclonefilter"])
                    .unwrap()
                    .trim(),
                "blob:none"
            );
        }
    }
}
