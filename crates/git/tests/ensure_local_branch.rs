//! Tests for `ensure_local_branch_for_remote`, which backs merging into a
//! remote-only target branch by materializing a local branch from it.

use std::{fs, io::Write, path::Path};

use git::GitService;
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

fn push_ref(repo: &Repository, refspec_local: &str, refspec_remote: &str) {
    let mut remote = repo.find_remote("origin").unwrap();
    let mut opts = PushOptions::new();
    let spec = format!("+{refspec_local}:{refspec_remote}");
    remote.push(&[spec.as_str()], Some(&mut opts)).unwrap();
}

/// Seed a bare `origin` with `main` plus an extra branch `feature_ref`, then
/// clone it. The clone gets local `main` only; `feature_ref` stays remote-only.
/// Returns the local checkout path.
fn setup_with_remote_branch(temp: &TempDir, feature_ref: &str) -> std::path::PathBuf {
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
    seed.remote("origin", &remote_url).unwrap();
    push_ref(&seed, "refs/heads/main", "refs/heads/main");

    // Create the feature branch off main with its own commit and push it.
    let head = seed.head().unwrap().peel_to_commit().unwrap();
    seed.branch(feature_ref, &head, false).unwrap();
    checkout_branch(&seed, feature_ref);
    write_file(&seed_path, "feature.txt", "feat\n");
    commit_all(&seed, "feature commit");
    push_ref(
        &seed,
        &format!("refs/heads/{feature_ref}"),
        &format!("refs/heads/{feature_ref}"),
    );

    let local_path = temp.path().join("local");
    let local = Repository::clone(&remote_url, &local_path).unwrap();
    configure_user(&local);
    let main_commit = local
        .find_reference("refs/remotes/origin/main")
        .unwrap()
        .peel_to_commit()
        .unwrap();
    local.branch("main", &main_commit, false).unwrap();
    checkout_branch(&local, "main");
    local_path
}

#[test]
fn creates_local_branch_tracking_remote() {
    let temp = TempDir::new().unwrap();
    let local_path = setup_with_remote_branch(&temp, "feature");
    let service = GitService::new();

    // Precondition: no local `feature`, but a remote-tracking one exists.
    assert!(
        !service
            .check_local_branch_exists(&local_path, "feature")
            .unwrap()
    );
    assert!(
        service
            .is_remote_branch(&local_path, "origin/feature")
            .unwrap()
    );

    let local_name = service
        .ensure_local_branch_for_remote(&local_path, "origin/feature")
        .unwrap();
    assert_eq!(local_name, "feature");

    let repo = Repository::open(&local_path).unwrap();
    let local = repo
        .find_branch("feature", git2::BranchType::Local)
        .unwrap();
    // Points at the remote tip.
    let remote = repo
        .find_branch("origin/feature", git2::BranchType::Remote)
        .unwrap();
    assert_eq!(
        local.get().peel_to_commit().unwrap().id(),
        remote.get().peel_to_commit().unwrap().id()
    );
    // Tracks the remote branch.
    assert_eq!(
        local.upstream().unwrap().name().unwrap(),
        Some("origin/feature")
    );
}

#[test]
fn is_idempotent_when_local_branch_exists() {
    let temp = TempDir::new().unwrap();
    let local_path = setup_with_remote_branch(&temp, "feature");
    let service = GitService::new();

    let first = service
        .ensure_local_branch_for_remote(&local_path, "origin/feature")
        .unwrap();
    let second = service
        .ensure_local_branch_for_remote(&local_path, "origin/feature")
        .unwrap();
    assert_eq!(first, "feature");
    assert_eq!(second, "feature");
}

#[test]
fn strips_only_the_remote_prefix_for_slashed_branch_names() {
    let temp = TempDir::new().unwrap();
    let local_path = setup_with_remote_branch(&temp, "feature/x");
    let service = GitService::new();

    let local_name = service
        .ensure_local_branch_for_remote(&local_path, "origin/feature/x")
        .unwrap();
    assert_eq!(local_name, "feature/x");
    assert!(
        service
            .check_local_branch_exists(&local_path, "feature/x")
            .unwrap()
    );
}
