//! Tests for the repo-level remote helpers backing the repo settings
//! push/fetch buttons: `get_remote_tracking_status`, `fetch_remote`, and
//! `push_branch_to_named_remote`.

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

/// Create a bare `origin` seeded with `main`, then clone it into a local
/// checkout on `main`. Returns the local checkout path.
fn setup_remote_and_local(temp: &TempDir) -> std::path::PathBuf {
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

    let local_path = temp.path().join("local");
    let local = Repository::clone(&remote_url, &local_path).unwrap();
    configure_user(&local);
    // The bare remote's HEAD defaults to `master`, so the clone leaves `main`
    // only as a remote-tracking ref. Create and check out a local `main` that
    // tracks `origin/main`.
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
fn tracking_status_reports_ahead_after_local_commit() {
    let temp = TempDir::new().unwrap();
    let local_path = setup_remote_and_local(&temp);
    let service = GitService::new();

    // Freshly cloned: in sync with origin/main.
    let (exists, ahead, behind) = service
        .get_remote_tracking_status(&local_path, "main", "origin")
        .unwrap();
    assert!(exists);
    assert_eq!((ahead, behind), (0, 0));

    // A local commit makes the branch one commit ahead.
    let local = Repository::open(&local_path).unwrap();
    write_file(&local_path, "local.txt", "v1\n");
    commit_all(&local, "local change");

    let (exists, ahead, behind) = service
        .get_remote_tracking_status(&local_path, "main", "origin")
        .unwrap();
    assert!(exists);
    assert_eq!((ahead, behind), (1, 0));
}

#[test]
fn tracking_status_reports_missing_remote_branch() {
    let temp = TempDir::new().unwrap();
    let local_path = setup_remote_and_local(&temp);
    let service = GitService::new();

    // A branch that was never pushed has no remote-tracking ref.
    let local = Repository::open(&local_path).unwrap();
    let head = local.head().unwrap().peel_to_commit().unwrap();
    local.branch("feature", &head, false).unwrap();
    checkout_branch(&local, "feature");

    let (exists, ahead, behind) = service
        .get_remote_tracking_status(&local_path, "feature", "origin")
        .unwrap();
    assert!(!exists);
    assert_eq!((ahead, behind), (0, 0));
}

#[test]
fn push_to_named_remote_clears_ahead() {
    let temp = TempDir::new().unwrap();
    let local_path = setup_remote_and_local(&temp);
    let service = GitService::new();

    let local = Repository::open(&local_path).unwrap();
    write_file(&local_path, "local.txt", "v1\n");
    commit_all(&local, "local change");

    let (_, ahead, _) = service
        .get_remote_tracking_status(&local_path, "main", "origin")
        .unwrap();
    assert_eq!(ahead, 1);

    service
        .push_branch_to_named_remote(&local_path, "main", "origin", false)
        .unwrap();

    // After pushing, the local remote-tracking ref advances and the branch is
    // no longer ahead.
    let (exists, ahead, behind) = service
        .get_remote_tracking_status(&local_path, "main", "origin")
        .unwrap();
    assert!(exists);
    assert_eq!((ahead, behind), (0, 0));
}
