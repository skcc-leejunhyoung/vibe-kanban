//! Confirm PR destinations before any review, merge, push or PR side effects.
use std::collections::HashSet;

use db::models::{
    merge::{Merge, MergeStatus},
    vibe_run::{PrBase, PrBaseSelection, VibeRun},
    workspace::Workspace,
    workspace_repo::{RepoWithTargetBranch, WorkspaceRepo},
};
use git::GitService;
use sqlx::SqlitePool;
use utils::repo_url::normalized_repo_key;

/// Head remains a prediction until the merge completes; never persist it.
pub fn pr_head<'a>(
    merges: &'a [Merge],
    work: &'a str,
    target: &'a str,
    after_merge: bool,
    pending_merge: bool,
) -> &'a str {
    let has_open_pr = merges
        .iter()
        .any(|merge| matches!(merge, Merge::Pr(pr) if pr.pr_info.status == MergeStatus::Open));
    if !after_merge && !has_open_pr && pending_merge {
        return target;
    }
    if let Some(feature) = merges.iter().find_map(|merge| match merge {
        Merge::Direct(direct) => Some(direct.target_branch_name.as_str()),
        _ => None,
    }) {
        return feature;
    }
    if after_merge || has_open_pr {
        work
    } else {
        target
    }
}

/// Use the same skip condition as the local merge, rather than a historical head.
pub fn expected_head(
    git: &GitService,
    path: &std::path::Path,
    merges: &[Merge],
    work: &str,
    target: &str,
    after_merge: bool,
) -> Result<String, String> {
    let has_open_pr = merges
        .iter()
        .any(|m| matches!(m, Merge::Pr(pr) if pr.pr_info.status == MergeStatus::Open));
    let pending =
        if !after_merge && !has_open_pr && merges.iter().any(|m| matches!(m, Merge::Direct(_))) {
            git.get_branch_status(path, work, target)
                .map_err(|e| e.to_string())?
                .0
                > 0
        } else {
            true
        };
    let target = git
        .local_target_branch_name(path, target)
        .map_err(|e| e.to_string())?;
    Ok(pr_head(merges, work, &target, after_merge, pending).to_string())
}

/// Preserve the remote-qualified selection; only normalize for comparison.
pub async fn validate_base(
    git: &GitService,
    path: &std::path::Path,
    head: &str,
    base: &str,
) -> Result<(), String> {
    git.local_target_branch_name(path, base).map_err(|e| {
        format!("PR base '{base}' is unavailable: {e}. Select an existing PR base, then retry.")
    })?;
    let push_remote = git
        .resolve_remote_for_branch(path, head)
        .map_err(|e| e.to_string())?;
    let (base_remote, remote_branch) = git.pr_base_remote(path, base, &push_remote);
    if head == remote_branch
        && normalized_repo_key(&push_remote.url) == normalized_repo_key(&base_remote.url)
    {
        return Err(format!(
            "PR head and base are both '{head}'. Select a different PR base (pr_bases) or fix the repository default target branch, then retry."
        ));
    }
    let (git, path, remote_url) = (git.clone(), path.to_path_buf(), base_remote.url.clone());
    let exists = tokio::task::spawn_blocking(move || {
        git.check_remote_branch_exists(&path, &remote_url, &remote_branch)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| {
        format!("Could not verify PR base '{base}': {e}. Check remote access and retry.")
    })?;
    if !exists {
        return Err(format!(
            "PR base '{base}' does not exist on remote '{}'. Fetch and select a PR base that exists on this remote, then retry.",
            base_remote.name
        ));
    }
    Ok(())
}

/// An explicit selection is scoped to this run. A saved base wins over later
/// repository defaults; a changed merge target requires explicit confirmation.
pub async fn resolve(
    pool: &SqlitePool,
    git: &GitService,
    workspace: &Workspace,
    selections: Option<&[PrBaseSelection]>,
    saved: Option<&[PrBase]>,
    after_merge: bool,
) -> Result<Vec<PrBase>, String> {
    let repos = WorkspaceRepo::find_repos_with_target_branch_for_workspace(pool, workspace.id)
        .await
        .map_err(|e| e.to_string())?;
    if repos.is_empty() {
        return Err("No repositories to create pull requests for".into());
    }
    if let Some(selections) = selections {
        let mut seen = HashSet::new();
        if selections
            .iter()
            .any(|s| !seen.insert(s.repo_id) || !repos.iter().any(|r| r.repo.id == s.repo_id))
        {
            return Err("PR bases contain a duplicate or unknown repository".into());
        }
    }
    if saved.is_some_and(|bases| bases.len() != repos.len()) {
        return Err("Workspace repositories changed. Confirm PR bases for every repository, then retry with pr_bases.".into());
    }
    let mut bases = Vec::new();
    for repo in repos {
        let target = git
            .local_target_branch_name(&repo.repo.path, &repo.target_branch)
            .map_err(|e| format!("{}: {e}", repo.repo.name))?;
        let merges = Merge::find_by_workspace_and_repo_id(pool, workspace.id, repo.repo.id)
            .await
            .map_err(|e| e.to_string())?;
        let head = expected_head(
            git,
            &repo.repo.path,
            &merges,
            &workspace.branch,
            &repo.target_branch,
            after_merge,
        )?;
        // The follow-up pushes the merge target, so it must still name the actual head.
        if let Some(Merge::Direct(merged)) = merges.iter().find(|m| matches!(m, Merge::Direct(_)))
            && head == merged.target_branch_name
            && merged.target_branch_name != target
        {
            return Err(format!(
                "{}: the merge target changed after the merge. Restore the workspace target to '{}' and retry the failed step; completed review and merge steps will not repeat.",
                repo.repo.name, merged.target_branch_name
            ));
        }
        let explicit = selections.and_then(|s| s.iter().find(|s| s.repo_id == repo.repo.id));
        let previous = saved.and_then(|s| s.iter().find(|s| s.repo_id == repo.repo.id));
        if selections.is_some() && explicit.is_none() {
            return Err(format!(
                "{}: confirm a PR base for every repository",
                repo.repo.name
            ));
        }
        if selections.is_none()
            && saved.is_some()
            && previous.is_none_or(|s| s.target_branch != target)
        {
            return Err(format!(
                "{}: the merge target changed. Confirm the PR base and new target, then retry with pr_bases.",
                repo.repo.name
            ));
        }
        let base = explicit.map(|s| s.base_branch.as_str())
            .or_else(|| previous.map(|s| s.base_branch.as_str()))
            .or_else(|| if head == workspace.branch { Some(repo.target_branch.as_str()) } else { repo.repo.default_target_branch.as_deref() })
            .map(str::trim).filter(|s| !s.is_empty())
            .ok_or_else(|| format!("{}: final PR base is not configured (head: '{head}'). Set the repository default target branch or select a PR base for this run (pr_bases) before starting review.", repo.repo.name))?;
        validate_base(git, &repo.repo.path, &head, base)
            .await
            .map_err(|e| format!("{}: {e}", repo.repo.name))?;
        bases.push(PrBase {
            repo_id: repo.repo.id,
            base_branch: base.to_string(),
            target_branch: target,
        });
    }
    Ok(bases)
}

pub async fn validate(
    pool: &SqlitePool,
    git: &GitService,
    workspace: &Workspace,
    run: &VibeRun,
    after_merge: bool,
) -> Result<Vec<PrBase>, String> {
    let saved = run.pr_bases.as_ref().ok_or_else(||
        "This run has no confirmed PR bases. Confirm a PR base for every repository, then retry the failed step (pr_bases); review and completed steps will not repeat.".to_string())?;
    let current = VibeRun::find_by_workspace_id(pool, workspace.id)
        .await
        .map_err(|e| e.to_string())?;
    if current.is_none_or(|current| current.generation != run.generation) {
        return Err("This run was superseded. Refresh its status before retrying.".into());
    }
    resolve(pool, git, workspace, None, Some(&saved.0), after_merge).await
}

/// Freeze the raw merge targets checked against the run, including remote refs.
pub async fn confirmed_merge_repos(
    pool: &SqlitePool,
    git: &GitService,
    workspace: &Workspace,
    bases: &[PrBase],
) -> Result<Vec<RepoWithTargetBranch>, String> {
    let repos = WorkspaceRepo::find_repos_with_target_branch_for_workspace(pool, workspace.id)
        .await
        .map_err(|e| e.to_string())?;
    if repos.len() != bases.len() {
        return Err(
            "Workspace repositories changed. Confirm PR bases for every repository, then retry."
                .into(),
        );
    }
    for repo in &repos {
        let target = git
            .local_target_branch_name(&repo.repo.path, &repo.target_branch)
            .map_err(|e| e.to_string())?;
        if !bases
            .iter()
            .any(|base| base.repo_id == repo.repo.id && base.target_branch == target)
        {
            return Err(format!(
                "{}: the merge target changed. Confirm the PR base and target before retrying.",
                repo.repo.name
            ));
        }
    }
    Ok(repos)
}

#[cfg(test)]
mod tests {
    use std::{path::Path, process::Command};

    use db::models::{repo::Repo, vibe_run::PrRequest, workspace_repo::CreateWorkspaceRepo};
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use uuid::Uuid;

    use super::*;

    fn git(path: &Path, args: &[&str]) {
        let result = Command::new("git")
            .current_dir(path)
            .args([
                "-c",
                "user.name=Example",
                "-c",
                "user.email=example@example.invalid",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }

    struct Fixture {
        dir: tempfile::TempDir,
        pool: SqlitePool,
        workspace: Workspace,
        repo: Repo,
        git: GitService,
    }

    impl Fixture {
        async fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(
                    SqliteConnectOptions::new()
                        .filename(dir.path().join("test.db"))
                        .create_if_missing(true),
                )
                .await
                .unwrap();
            sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
            let id = Uuid::new_v4();
            sqlx::query("INSERT INTO workspaces (id, branch) VALUES (?, 'vk/work')")
                .bind(id)
                .execute(&pool)
                .await
                .unwrap();
            let workspace = Workspace::find_by_id(&pool, id).await.unwrap().unwrap();
            let repo = Self::add_repo(&pool, &workspace, dir.path(), "widgets").await;
            Self {
                dir,
                pool,
                workspace,
                repo,
                git: GitService::new(),
            }
        }

        async fn add_repo(
            pool: &SqlitePool,
            workspace: &Workspace,
            root: &Path,
            name: &str,
        ) -> Repo {
            git(root, &["init", "-b", "integration", name]);
            let path = root.join(name);
            git(
                &path,
                &["commit", "--allow-empty", "-m", "Initial synthetic commit"],
            );
            for branch in ["feature/example", "other", "vk/work"] {
                git(&path, &["branch", branch]);
            }
            git(&path, &["remote", "add", "origin", "."]);
            let repo = Repo::find_or_create(pool, &path, name).await.unwrap();
            WorkspaceRepo::create_many(
                pool,
                workspace.id,
                &[CreateWorkspaceRepo {
                    repo_id: repo.id,
                    target_branch: "feature/example".into(),
                }],
            )
            .await
            .unwrap();
            repo
        }

        fn selection(&self, base: &str) -> Vec<PrBaseSelection> {
            vec![PrBaseSelection {
                repo_id: self.repo.id,
                base_branch: base.into(),
            }]
        }

        async fn resolve(
            &self,
            selections: Option<&[PrBaseSelection]>,
            saved: Option<&[PrBase]>,
            after_merge: bool,
        ) -> Result<Vec<PrBase>, String> {
            resolve(
                &self.pool,
                &self.git,
                &self.workspace,
                selections,
                saved,
                after_merge,
            )
            .await
        }

        async fn start(&self, bases: Vec<PrBase>) -> VibeRun {
            let session = Uuid::new_v4();
            sqlx::query("INSERT INTO sessions (id, workspace_id) VALUES (?, ?)")
                .bind(session)
                .bind(self.workspace.id)
                .execute(&self.pool)
                .await
                .unwrap();
            VibeRun::get_or_create(&self.pool, self.workspace.id, Uuid::new_v4())
                .await
                .unwrap();
            VibeRun::begin_review(
                &self.pool,
                self.workspace.id,
                session,
                Some(&PrRequest {
                    bases,
                    executor_config: None,
                }),
            )
            .await
            .unwrap();
            VibeRun::find_by_workspace_id(&self.pool, self.workspace.id)
                .await
                .unwrap()
                .unwrap()
        }
    }

    #[tokio::test]
    async fn final_base_is_required_before_review_but_not_for_a_work_branch_pr() {
        let f = Fixture::new().await;
        assert!(
            f.resolve(None, None, false)
                .await
                .unwrap_err()
                .contains("not configured")
        );
        assert!(
            VibeRun::find_non_terminal(&f.pool)
                .await
                .unwrap()
                .is_empty()
        );
        // A standalone PR before a direct merge retains work -> target with no default.
        assert_eq!(
            f.resolve(None, None, true).await.unwrap()[0].base_branch,
            "feature/example"
        );
        for invalid in ["feature/example", "  feature/example  "] {
            assert!(
                f.resolve(Some(&f.selection(invalid)), None, false)
                    .await
                    .unwrap_err()
                    .contains("head and base")
            );
        }
        assert!(
            f.resolve(Some(&f.selection("missing")), None, false)
                .await
                .unwrap_err()
                .contains("unavailable")
        );
        // Resolve remote aliases through git, never by guessing a remote prefix.
        git(&f.repo.path, &["remote", "add", "upstream", "."]);
        git(&f.repo.path, &["fetch", "upstream"]);
        assert!(
            f.resolve(Some(&f.selection("upstream/feature/example")), None, false)
                .await
                .unwrap_err()
                .contains("head and base")
        );
    }

    #[tokio::test]
    async fn same_repository_url_aliases_are_refused_before_remote_access_or_review() {
        let f = Fixture::new().await;
        git(
            &f.repo.path,
            &[
                "remote",
                "set-url",
                "origin",
                "https://git.example.invalid/example/widgets.git",
            ],
        );
        git(
            &f.repo.path,
            &[
                "remote",
                "add",
                "upstream",
                "git@git.example.invalid:example/widgets.git",
            ],
        );
        git(
            &f.repo.path,
            &[
                "update-ref",
                "refs/remotes/upstream/feature/example",
                "refs/heads/feature/example",
            ],
        );
        let error = f
            .resolve(Some(&f.selection("upstream/feature/example")), None, false)
            .await
            .unwrap_err();
        assert!(error.contains("head and base"), "{error}");
        assert!(
            VibeRun::find_non_terminal(&f.pool)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            Merge::find_by_workspace_id(&f.pool, f.workspace.id)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn a_remote_only_base_remains_resolvable_without_creating_a_local_branch() {
        let f = Fixture::new().await;
        let upstream = f.dir.path().join("upstream.git");
        git(
            f.dir.path(),
            &[
                "clone",
                "--bare",
                f.repo.path.to_str().unwrap(),
                upstream.to_str().unwrap(),
            ],
        );
        git(
            &f.repo.path,
            &["remote", "add", "upstream", upstream.to_str().unwrap()],
        );
        git(&f.repo.path, &["fetch", "upstream"]);
        git(&f.repo.path, &["branch", "-m", "integration", "renamed"]);
        let bases = f
            .resolve(Some(&f.selection("upstream/integration")), None, false)
            .await
            .unwrap();
        assert_eq!(bases[0].base_branch, "upstream/integration");
        let run = f.start(bases).await;
        assert_eq!(
            validate(&f.pool, &f.git, &f.workspace, &run, false)
                .await
                .unwrap()[0]
                .base_branch,
            "upstream/integration"
        );
        assert!(
            !f.git
                .check_local_branch_exists(&f.repo.path, "integration")
                .unwrap()
        );
    }

    #[tokio::test]
    async fn explicit_base_survives_default_changes_and_database_reopen() {
        let f = Fixture::new().await;
        let bases = f
            .resolve(Some(&f.selection("integration")), None, false)
            .await
            .unwrap();
        assert_eq!(
            Repo::find_by_id(&f.pool, f.repo.id)
                .await
                .unwrap()
                .unwrap()
                .default_target_branch,
            None
        );
        let run = f.start(bases.clone()).await;
        sqlx::query("UPDATE repos SET default_target_branch = 'other'")
            .execute(&f.pool)
            .await
            .unwrap();
        Merge::create_direct(
            &f.pool,
            f.workspace.id,
            f.repo.id,
            "feature/example",
            "synthetic-merge",
        )
        .await
        .unwrap();
        VibeRun::finish_merge(&f.pool, f.workspace.id, run.generation)
            .await
            .unwrap();
        f.pool.close().await;
        let reopened = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(SqliteConnectOptions::new().filename(f.dir.path().join("test.db")))
            .await
            .unwrap();
        let restored = VibeRun::find_by_workspace_id(&reopened, f.workspace.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(restored.pr_bases.as_ref().unwrap().0, bases);
        assert_eq!(restored.review_session_id, run.review_session_id);
        assert_eq!(
            validate(&reopened, &f.git, &f.workspace, &restored, true)
                .await
                .unwrap()[0]
                .base_branch,
            "integration"
        );
        let merges = Merge::find_by_workspace_and_repo_id(&reopened, f.workspace.id, f.repo.id)
            .await
            .unwrap();
        assert_eq!(
            pr_head(&merges, "vk/work", "other", true, true),
            "feature/example"
        );
    }

    #[tokio::test]
    async fn default_is_confirmed_once_and_target_changes_require_explicit_retry() {
        let f = Fixture::new().await;
        sqlx::query("UPDATE repos SET default_target_branch = 'integration'")
            .execute(&f.pool)
            .await
            .unwrap();
        let bases = f.resolve(None, None, false).await.unwrap();
        let run = f.start(bases.clone()).await;
        WorkspaceRepo::update_target_branch(&f.pool, f.workspace.id, f.repo.id, "other")
            .await
            .unwrap();
        assert!(
            validate(&f.pool, &f.git, &f.workspace, &run, false)
                .await
                .unwrap_err()
                .contains("merge target changed")
        );
        VibeRun::record_merge_failure(
            &f.pool,
            f.workspace.id,
            run.generation,
            "blocked",
            "target changed",
            None,
        )
        .await
        .unwrap();
        let confirmed = f
            .resolve(Some(&f.selection("integration")), None, false)
            .await
            .unwrap();
        VibeRun::retry(
            &f.pool,
            &VibeRun::find_by_workspace_id(&f.pool, f.workspace.id)
                .await
                .unwrap()
                .unwrap(),
            Some(&confirmed),
        )
        .await
        .unwrap();
        let restored = VibeRun::find_by_workspace_id(&f.pool, f.workspace.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(restored.review_session_id, run.review_session_id);
        assert_eq!(
            restored.pr_bases.as_ref().unwrap().0[0].target_branch,
            "other"
        );
        assert!(
            validate(&f.pool, &f.git, &f.workspace, &restored, false)
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn a_prior_merge_does_not_hide_the_next_merge_destination() {
        let f = Fixture::new().await;
        Merge::create_direct(
            &f.pool,
            f.workspace.id,
            f.repo.id,
            "feature/example",
            "synthetic-prior-tip",
        )
        .await
        .unwrap();
        git(&f.repo.path, &["checkout", "vk/work"]);
        std::fs::write(f.repo.path.join("new-work.txt"), "synthetic new work").unwrap();
        git(&f.repo.path, &["add", "new-work.txt"]);
        git(&f.repo.path, &["commit", "-m", "More synthetic work"]);
        WorkspaceRepo::update_target_branch(&f.pool, f.workspace.id, f.repo.id, "other")
            .await
            .unwrap();
        assert!(
            f.resolve(Some(&f.selection("other")), None, false)
                .await
                .unwrap_err()
                .contains("head and base")
        );
        let bases = f
            .resolve(Some(&f.selection("integration")), None, false)
            .await
            .unwrap();
        assert_eq!(bases[0].target_branch, "other");
        // The standalone route still uses the actual historical result.
        let merges = Merge::find_by_workspace_and_repo_id(&f.pool, f.workspace.id, f.repo.id)
            .await
            .unwrap();
        assert_eq!(
            expected_head(
                &f.git,
                &f.repo.path,
                &merges,
                &f.workspace.branch,
                "other",
                true
            )
            .unwrap(),
            "feature/example"
        );
    }

    #[tokio::test]
    async fn a_follow_up_retry_cannot_publish_a_target_changed_after_the_merge() {
        let f = Fixture::new().await;
        let bases = f
            .resolve(Some(&f.selection("integration")), None, false)
            .await
            .unwrap();
        let run = f.start(bases).await;
        Merge::create_direct(
            &f.pool,
            f.workspace.id,
            f.repo.id,
            "feature/example",
            "synthetic-merge",
        )
        .await
        .unwrap();
        VibeRun::finish_merge(&f.pool, f.workspace.id, run.generation)
            .await
            .unwrap();
        VibeRun::block_follow_up(
            &f.pool,
            f.workspace.id,
            "pushing",
            run.generation,
            "synthetic failure",
        )
        .await
        .unwrap();
        let blocked = VibeRun::find_by_workspace_id(&f.pool, f.workspace.id)
            .await
            .unwrap()
            .unwrap();
        WorkspaceRepo::update_target_branch(&f.pool, f.workspace.id, f.repo.id, "other")
            .await
            .unwrap();
        assert!(
            f.resolve(Some(&f.selection("integration")), None, false)
                .await
                .unwrap_err()
                .contains("Restore the workspace target")
        );
        let error = f
            .resolve(Some(&f.selection("integration")), None, true)
            .await
            .unwrap_err();
        assert!(
            error.contains("Restore the workspace target to 'feature/example'"),
            "{error}"
        );
        assert_eq!(
            VibeRun::find_by_workspace_id(&f.pool, f.workspace.id)
                .await
                .unwrap()
                .unwrap()
                .phase,
            "blocked"
        );
        WorkspaceRepo::update_target_branch(&f.pool, f.workspace.id, f.repo.id, "feature/example")
            .await
            .unwrap();
        let bases = f
            .resolve(Some(&f.selection("integration")), None, true)
            .await
            .unwrap();
        assert!(
            VibeRun::retry(&f.pool, &blocked, Some(&bases))
                .await
                .unwrap()
        );
        let restored = VibeRun::find_by_workspace_id(&f.pool, f.workspace.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(restored.phase, "pushing");
        assert_eq!(restored.review_session_id, run.review_session_id);
        assert_eq!(
            Merge::find_by_workspace_id(&f.pool, f.workspace.id)
                .await
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn a_remote_qualified_base_retains_its_receiving_repository() {
        let f = Fixture::new().await;
        let fork = f.dir.path().join("fork.git");
        let central = f.dir.path().join("central.git");
        for remote in [&fork, &central] {
            git(
                f.dir.path(),
                &[
                    "clone",
                    "--bare",
                    f.repo.path.to_str().unwrap(),
                    remote.to_str().unwrap(),
                ],
            );
        }
        git(
            &f.repo.path,
            &["remote", "set-url", "origin", fork.to_str().unwrap()],
        );
        git(
            &f.repo.path,
            &["remote", "add", "upstream", central.to_str().unwrap()],
        );
        git(&f.repo.path, &["fetch", "upstream"]);
        // The receiving remote's default is not the explicitly chosen base.
        git(
            &central,
            &["symbolic-ref", "HEAD", "refs/heads/feature/example"],
        );
        let bases = f
            .resolve(Some(&f.selection("upstream/integration")), None, false)
            .await
            .unwrap();
        let run = f.start(bases.clone()).await;
        let validated = validate(&f.pool, &f.git, &f.workspace, &run, false)
            .await
            .unwrap();
        assert_eq!(validated, bases);
        let remote = f
            .git
            .get_remote_from_branch_name(&f.repo.path, &validated[0].base_branch)
            .unwrap();
        assert_eq!(remote.name, "upstream");
        assert_eq!(remote.url, central.to_str().unwrap());
        let push_remote = f
            .git
            .resolve_remote_for_branch(&f.repo.path, "feature/example")
            .unwrap();
        let (_, branch) =
            f.git
                .pr_base_remote(&f.repo.path, &validated[0].base_branch, &push_remote);
        assert_eq!(branch, "integration");
        assert!(
            f.resolve(Some(&f.selection("upstream/feature/example")), None, false)
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn a_local_only_base_is_refused_before_any_run_or_merge_is_created() {
        let f = Fixture::new().await;
        let origin = f.dir.path().join("origin.git");
        git(
            f.dir.path(),
            &[
                "clone",
                "--bare",
                "--single-branch",
                "--branch",
                "feature/example",
                f.repo.path.to_str().unwrap(),
                origin.to_str().unwrap(),
            ],
        );
        git(
            &f.repo.path,
            &["remote", "set-url", "origin", origin.to_str().unwrap()],
        );
        assert!(
            f.git
                .check_local_branch_exists(&f.repo.path, "integration")
                .unwrap()
        );
        let error = f
            .resolve(Some(&f.selection("integration")), None, false)
            .await
            .unwrap_err();
        assert!(error.contains("does not exist on remote"), "{error}");
        assert!(
            VibeRun::find_non_terminal(&f.pool)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            Merge::find_by_workspace_id(&f.pool, f.workspace.id)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            Repo::find_by_id(&f.pool, f.repo.id)
                .await
                .unwrap()
                .unwrap()
                .default_target_branch
                .is_none()
        );
    }

    #[tokio::test]
    async fn a_stale_tracking_ref_cannot_hide_a_deleted_remote_base() {
        let f = Fixture::new().await;
        let origin = f.dir.path().join("origin.git");
        git(
            f.dir.path(),
            &[
                "clone",
                "--bare",
                f.repo.path.to_str().unwrap(),
                origin.to_str().unwrap(),
            ],
        );
        git(
            &f.repo.path,
            &["remote", "set-url", "origin", origin.to_str().unwrap()],
        );
        git(&f.repo.path, &["fetch", "origin"]);
        git(&origin, &["update-ref", "-d", "refs/heads/integration"]);
        assert!(
            f.git
                .check_branch_exists(&f.repo.path, "origin/integration")
                .unwrap()
        );
        let error = f
            .resolve(Some(&f.selection("origin/integration")), None, false)
            .await
            .unwrap_err();
        assert!(error.contains("does not exist on remote"), "{error}");
        assert!(
            VibeRun::find_non_terminal(&f.pool)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn confirmed_targets_are_frozen_and_every_repo_is_checked_before_execution() {
        let f = Fixture::new().await;
        let second = Fixture::add_repo(&f.pool, &f.workspace, f.dir.path(), "gadgets").await;
        let mut selections = f.selection("integration");
        selections.push(PrBaseSelection {
            repo_id: second.id,
            base_branch: "integration".into(),
        });
        let bases = f.resolve(Some(&selections), None, false).await.unwrap();
        let repos = confirmed_merge_repos(&f.pool, &f.git, &f.workspace, &bases)
            .await
            .unwrap();
        WorkspaceRepo::update_target_branch(&f.pool, f.workspace.id, second.id, "other")
            .await
            .unwrap();
        assert!(
            repos
                .iter()
                .all(|repo| repo.target_branch == "feature/example")
        );
        let error = confirmed_merge_repos(&f.pool, &f.git, &f.workspace, &bases)
            .await
            .unwrap_err();
        assert!(error.contains("merge target changed"), "{error}");
        assert!(
            VibeRun::find_non_terminal(&f.pool)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            Merge::find_by_workspace_id(&f.pool, f.workspace.id)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn all_repos_are_checked_and_partial_or_duplicate_selections_are_refused() {
        let f = Fixture::new().await;
        let second = Fixture::add_repo(&f.pool, &f.workspace, f.dir.path(), "gadgets").await;
        sqlx::query("UPDATE repos SET default_target_branch = 'integration' WHERE id = ?")
            .bind(f.repo.id)
            .execute(&f.pool)
            .await
            .unwrap();
        assert!(
            f.resolve(None, None, false)
                .await
                .unwrap_err()
                .contains("gadgets")
        );
        assert!(
            f.resolve(Some(&f.selection("integration")), None, false)
                .await
                .unwrap_err()
                .contains("every repository")
        );
        let mut selections = f.selection("integration");
        selections.push(PrBaseSelection {
            repo_id: second.id,
            base_branch: "integration".into(),
        });
        let bases = f.resolve(Some(&selections), None, false).await.unwrap();
        assert_eq!(bases.len(), 2);
        selections.push(selections[0].clone());
        assert!(
            f.resolve(Some(&selections), None, false)
                .await
                .unwrap_err()
                .contains("duplicate")
        );
        assert!(
            VibeRun::find_non_terminal(&f.pool)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            Merge::find_by_workspace_id(&f.pool, f.workspace.id)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn a_legacy_blocked_pr_confirms_its_base_and_resumes_only_the_pr_step() {
        let f = Fixture::new().await;
        Merge::create_direct(
            &f.pool,
            f.workspace.id,
            f.repo.id,
            "feature/example",
            "synthetic-merge",
        )
        .await
        .unwrap();
        let run = f.start(vec![]).await;
        sqlx::query("UPDATE vibe_runs SET phase = 'creating_pr', pr_bases = NULL")
            .execute(&f.pool)
            .await
            .unwrap();
        VibeRun::block_follow_up(
            &f.pool,
            f.workspace.id,
            "creating_pr",
            run.generation,
            "legacy base missing",
        )
        .await
        .unwrap();
        let blocked = VibeRun::find_by_workspace_id(&f.pool, f.workspace.id)
            .await
            .unwrap()
            .unwrap();
        assert!(
            validate(&f.pool, &f.git, &f.workspace, &blocked, true)
                .await
                .unwrap_err()
                .contains("no confirmed PR bases")
        );
        sqlx::query("UPDATE repos SET default_target_branch = 'integration'")
            .execute(&f.pool)
            .await
            .unwrap();
        let bases = f.resolve(None, None, true).await.unwrap();
        assert!(
            VibeRun::retry(&f.pool, &blocked, Some(&bases))
                .await
                .unwrap()
        );
        let resumed = VibeRun::find_by_workspace_id(&f.pool, f.workspace.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(resumed.phase, "creating_pr");
        assert_eq!(resumed.review_session_id, run.review_session_id);
        assert_eq!(
            Merge::find_by_workspace_id(&f.pool, f.workspace.id)
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            validate(&f.pool, &f.git, &f.workspace, &resumed, true)
                .await
                .unwrap()[0]
                .base_branch,
            "integration"
        );
    }
}
