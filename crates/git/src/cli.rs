//! Why we prefer the Git CLI here
//!
//! - Safer working-tree semantics: the `git` CLI refuses to clobber uncommitted
//!   tracked changes and untracked files during checkout/merge/rebase unless you
//!   explicitly force it. libgit2 does not enforce those protections by default,
//!   which means callers must re‑implement a lot of safety checks to avoid data loss.
//! - Sparse‑checkout correctness: the CLI natively respects sparse‑checkout.
//!   libgit2 does not yet support sparse‑checkout semantics the same way, which
//!   led to incorrect diffs and staging in our workflows.
//! - Cross‑platform stability: we observed libgit2 corrupt repositories shared
//!   between WSL and Windows in scenarios where the `git` CLI did not. Delegating
//!   working‑tree mutations to the CLI has proven more reliable in practice.
//!
//! Given these reasons, this module centralizes destructive or working‑tree‑
//! touching operations (rebase, merge, checkout, add/commit, etc.) through the
//! `git` CLI, while keeping libgit2 for read‑only graph queries and credentialed
//! network operations when useful.
use std::{
    collections::{HashMap, HashSet},
    ffi::{OsStr, OsString},
    io::{Read as _, Write as _},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        LazyLock, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::SystemTime,
};

use thiserror::Error;
use utils::{path::ALWAYS_SKIP_DIRS, shell::resolve_executable_path_blocking};

use super::Commit;

#[derive(Debug, Error)]
pub enum GitCliError {
    #[error("git executable not found or not runnable")]
    NotAvailable,
    #[error("git command failed: {0}")]
    CommandFailed(String),
    #[error("authentication failed: {0}")]
    AuthFailed(String),
    #[error("push rejected: {0}")]
    PushRejected(String),
    #[error("rebase in progress in this worktree")]
    RebaseInProgress,
}

/// Reject a remote URL that git would parse as a command-line option rather than
/// a repository (argument injection). Remote URLs are read from a repo's own git
/// config, so a crafted `remote.url` such as `--upload-pack=...` must never reach
/// `git fetch`/`push`/`ls-remote` as a bare positional argument.
fn ensure_safe_remote_url(remote_url: &str) -> Result<(), GitCliError> {
    if remote_url.starts_with('-') {
        return Err(GitCliError::CommandFailed(format!(
            "refusing remote URL that resembles a command-line option: {remote_url}"
        )));
    }
    Ok(())
}

#[derive(Clone, Default)]
pub struct GitCli;

/// Parsed change type from `git diff --name-status` output
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChangeType {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Unmerged,
    Unknown(String),
}

/// One entry from a status diff (name-status + paths)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusDiffEntry {
    pub change: ChangeType,
    pub path: String,
    pub old_path: Option<String>,
}

/// One entry from `git diff --numstat`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NumstatDiffEntry {
    pub additions: Option<usize>,
    pub deletions: Option<usize>,
    pub path: String,
}

/// Parsed worktree entry from `git worktree list --porcelain`
#[derive(Debug, Clone)]
pub struct WorktreeEntry {
    pub path: String,
    pub branch: Option<String>,
}

/// Total size of untracked files above which they are no longer hashed as
/// rename candidates.
const UNTRACKED_RENAME_BUDGET_BYTES: u64 = 16 * 1024 * 1024;

/// Added-line counts of untracked files, reused while a file's size and mtime
/// are unchanged so a poll only rereads the files that changed.
///
/// ponytail: entries of a removed worktree stay until restart; prune by
/// worktree removal if memory ever matters.
static UNTRACKED_LINE_COUNTS: LazyLock<Mutex<LineCounts>> = LazyLock::new(Default::default);

/// Path to the stat it was counted at and its added lines.
type LineCounts = HashMap<PathBuf, (StatKey, Option<usize>)>;

/// Size, mtime and (on Unix) ctime in nanoseconds. Ctime also moves on a
/// same-size edit within one mtime tick and on copies that keep the mtime.
type StatKey = (u64, SystemTime, i64);

/// Repository paths as raw bytes.
type RawPaths = Vec<Vec<u8>>;

/// See [`GitCli::temp_worktree_index`]. The index lives as long as this value.
struct TempWorktreeIndex {
    _dir: tempfile::TempDir,
    envs: Vec<(OsString, OsString)>,
    /// Untracked files left out of the index; callers report them as added.
    untracked: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct StatusDiffOptions {
    pub path_filter: Option<Vec<String>>, // pathspecs to limit diff
}

impl GitCli {
    pub fn new() -> Self {
        Self {}
    }
    /// Run `git -C <repo> worktree add <path> <branch>` (optionally creating the branch with -b)
    pub fn worktree_add(
        &self,
        repo_path: &Path,
        worktree_path: &Path,
        branch: &str,
        create_branch: bool,
    ) -> Result<(), GitCliError> {
        self.ensure_available()?;

        let mut args: Vec<OsString> = vec!["worktree".into(), "add".into()];
        if create_branch {
            args.push("-b".into());
            args.push(OsString::from(branch));
        }
        args.push(worktree_path.as_os_str().into());
        args.push(OsString::from(branch));
        self.git(repo_path, args)?;

        // Good practice: reapply sparse-checkout in the new worktree to ensure materialization matches
        // Non-fatal if it fails or not configured.
        let _ = self.git(worktree_path, ["sparse-checkout", "reapply"]);

        Ok(())
    }

    /// Run `git -C <repo> worktree remove <path>`
    pub fn worktree_remove(
        &self,
        repo_path: &Path,
        worktree_path: &Path,
        force: bool,
    ) -> Result<(), GitCliError> {
        self.ensure_available()?;
        let mut args: Vec<OsString> = vec!["worktree".into(), "remove".into()];
        if force {
            args.push("--force".into());
        }
        args.push(worktree_path.as_os_str().into());
        self.git(repo_path, args)?;
        Ok(())
    }

    /// Run `git -C <repo> worktree move <old_path> <new_path>`
    pub fn worktree_move(
        &self,
        repo_path: &Path,
        old_path: &Path,
        new_path: &Path,
    ) -> Result<(), GitCliError> {
        self.ensure_available()?;
        self.git(
            repo_path,
            [
                "worktree",
                "move",
                old_path.to_str().ok_or_else(|| {
                    GitCliError::CommandFailed("Invalid old worktree path".to_string())
                })?,
                new_path.to_str().ok_or_else(|| {
                    GitCliError::CommandFailed("Invalid new worktree path".to_string())
                })?,
            ],
        )?;
        Ok(())
    }

    /// Prune stale worktree metadata
    pub fn worktree_prune(&self, repo_path: &Path) -> Result<(), GitCliError> {
        self.git(repo_path, ["worktree", "prune"])?;
        Ok(())
    }

    /// Return true if there are any changes in the working tree (staged or unstaged).
    pub fn has_changes(&self, worktree_path: &Path) -> Result<bool, GitCliError> {
        let out = self.git(
            worktree_path,
            ["--no-optional-locks", "status", "--porcelain"],
        )?;
        Ok(!out.is_empty())
    }

    /// Every uncommitted change as `XY path`, with untracked files listed
    /// individually. A rename also lists its original path as a deletion so a
    /// caller settling the changes can restore both halves of the rename.
    /// Parse NUL records so spaces and rename arrows in names are never
    /// mistaken for porcelain quoting or separators.
    pub fn status_porcelain(&self, worktree_path: &Path) -> Result<Vec<String>, GitCliError> {
        let out = self.git_impl(
            worktree_path,
            [
                "--no-optional-locks",
                "status",
                "--porcelain",
                "-z",
                "--untracked-files=all",
            ],
            None,
            None,
        )?;
        let mut records = out.split(|byte| *byte == 0);
        let mut lines = Vec::new();
        while let Some(entry) = records.next() {
            if entry.len() < 4 {
                continue;
            }
            lines.push(String::from_utf8_lossy(entry).into_owned());
            if matches!(entry[0], b'R' | b'C') || matches!(entry[1], b'R' | b'C') {
                // The original path follows a rename/copy entry. A copy keeps
                // its source, while a rename removes it from the old location.
                if let Some(original) = records.next()
                    && !original.is_empty()
                    && (entry[0] == b'R' || entry[1] == b'R')
                {
                    let status = if entry[0] == b'R' { "D " } else { " D" };
                    lines.push(format!("{status} {}", String::from_utf8_lossy(original)));
                }
            }
        }
        Ok(lines)
    }

    /// The working-tree path named by a normalized `status_porcelain` entry.
    pub fn porcelain_path(line: &str) -> &str {
        line.get(3..).unwrap_or("")
    }

    /// Diff status vs a base branch using a temporary index (always includes untracked).
    /// Path filter limits the reported paths.
    pub fn diff_status(
        &self,
        worktree_path: &Path,
        base_commit: &Commit,
        opts: StatusDiffOptions,
    ) -> Result<Vec<StatusDiffEntry>, GitCliError> {
        let index =
            self.temp_worktree_index(worktree_path, base_commit, opts.path_filter.as_ref())?;
        let args: Vec<OsString> = vec![
            "-c".into(),
            "core.quotepath=false".into(),
            "diff".into(),
            "--cached".into(),
            "-M".into(),
            "--name-status".into(),
            OsString::from(base_commit.to_string()),
        ];
        let args = Self::apply_pathspec_filter(args, opts.path_filter.as_ref());
        let out = self.git_with_env(worktree_path, args, &index.envs)?;
        let mut entries = Self::parse_name_status(&out);
        entries.extend(index.untracked.into_iter().map(|path| StatusDiffEntry {
            change: ChangeType::Added,
            path,
            old_path: None,
        }));
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(entries)
    }

    /// Diff line stats vs a base commit using a temporary index.
    /// This mirrors `diff_status` semantics, but avoids loading file contents.
    pub fn diff_numstat(
        &self,
        worktree_path: &Path,
        base_commit: &Commit,
        opts: StatusDiffOptions,
    ) -> Result<Vec<NumstatDiffEntry>, GitCliError> {
        let index =
            self.temp_worktree_index(worktree_path, base_commit, opts.path_filter.as_ref())?;
        let args: Vec<OsString> = vec![
            "-c".into(),
            "core.quotepath=false".into(),
            "diff".into(),
            "--cached".into(),
            "-M".into(),
            "--numstat".into(),
            OsString::from(base_commit.to_string()),
        ];
        let args = Self::apply_pathspec_filter(args, opts.path_filter.as_ref());
        let out = self.git_with_env(worktree_path, args, &index.envs)?;
        let mut entries = Self::parse_numstat(&out);
        let paths: Vec<PathBuf> = index
            .untracked
            .iter()
            .map(|path| worktree_path.join(path))
            .collect();
        if opts.path_filter.is_none() {
            let live: HashSet<&PathBuf> = paths.iter().collect();
            UNTRACKED_LINE_COUNTS
                .lock()
                .unwrap()
                .retain(|path, _| !path.starts_with(worktree_path) || live.contains(path));
        }
        let counts = Self::added_lines_for(&paths);
        entries.extend(
            index
                .untracked
                .into_iter()
                .zip(counts)
                .map(|(path, additions)| NumstatDiffEntry {
                    additions,
                    deletions: additions.map(|_| 0),
                    path,
                }),
        );
        Ok(entries)
    }

    /// Temp index of HEAD plus the worktree's changes, for `diff --cached`.
    /// Staging hashes a file and writes its blob to the object DB, so untracked
    /// files (a scratch folder can hold gigabytes) are left out and returned
    /// instead. They are staged only when a deletion vs base could pair with
    /// them as a rename, or when they reappear at a path the base had.
    fn temp_worktree_index(
        &self,
        worktree_path: &Path,
        base_commit: &Commit,
        path_filter: Option<&Vec<String>>,
    ) -> Result<TempWorktreeIndex, GitCliError> {
        let dir = tempfile::TempDir::new()
            .map_err(|e| GitCliError::CommandFailed(format!("temp dir create failed: {e}")))?;
        let envs = vec![(
            OsString::from("GIT_INDEX_FILE"),
            dir.path().join("index").into_os_string(),
        )];
        // Use a temp index from HEAD to accurately track renames
        self.git_with_env(worktree_path, ["read-tree", "HEAD"], &envs)?;

        // A path filter limits the diff to the same paths, so staging only
        // those yields the same result.
        let (tracked, mut untracked) = self.changed_paths(worktree_path, path_filter)?;
        self.add_to_index(worktree_path, &envs, tracked)?;

        if !untracked.is_empty() {
            let args: Vec<OsString> = vec![
                "diff".into(),
                "--cached".into(),
                "--name-only".into(),
                "-z".into(),
                "--diff-filter=D".into(),
                OsString::from(base_commit.to_string()),
            ];
            let args = Self::apply_pathspec_filter(args, path_filter);
            let out = self.git_impl(worktree_path, args, Some(&envs), None)?;
            let deleted: HashSet<&[u8]> =
                out.split(|b| *b == 0).filter(|p| !p.is_empty()).collect();
            if !deleted.is_empty() {
                // Judge the budget on the whole worktree so a filtered rediff
                // pairs renames exactly like the full diff does.
                let all = match path_filter {
                    None => Self::untracked_within_rename_budget(worktree_path, &untracked),
                    Some(_) => Self::untracked_within_rename_budget(
                        worktree_path,
                        &self.changed_paths(worktree_path, None)?.1,
                    ),
                };
                let (staged, rest) = untracked.into_iter().partition(|p| {
                    (all || deleted.contains(p.as_slice()))
                        // An untracked nested repository without commits
                        // can't be staged, and fails the whole `git add`.
                        && !std::fs::symlink_metadata(
                            worktree_path.join(&*String::from_utf8_lossy(p)),
                        )
                        .is_ok_and(|m| m.is_dir())
                });
                self.add_to_index(worktree_path, &envs, staged)?;
                untracked = rest;
            }
        }

        Ok(TempWorktreeIndex {
            _dir: dir,
            envs,
            untracked: untracked
                .into_iter()
                .map(|p| String::from_utf8_lossy(&p).into_owned())
                .collect(),
        })
    }

    /// Tracked changes (with rename sources) and untracked files from `git
    /// status`, as raw paths.
    fn changed_paths(
        &self,
        worktree_path: &Path,
        path_filter: Option<&Vec<String>>,
    ) -> Result<(RawPaths, RawPaths), GitCliError> {
        let status = self.worktree_status(worktree_path, "--untracked-files=all", path_filter)?;
        let (untracked, tracked): (Vec<_>, Vec<_>) =
            status.entries.into_iter().partition(|e| e.is_untracked);
        let tracked: Vec<Vec<u8>> = tracked
            .into_iter()
            .flat_map(|e| std::iter::once(e.path).chain(e.orig_path))
            .collect();
        // `git rm --cached` leaves a path both staged-deleted and untracked,
        // and a tracked file replaced by a directory stages the files under
        // it; staging the tracked path already covers those.
        let tracked_set: HashSet<&[u8]> = tracked.iter().map(Vec::as_slice).collect();
        let untracked = untracked
            .into_iter()
            // An untracked nested repository is listed as `dir/`, but diffs
            // as the gitlink `dir`.
            .map(|e| {
                e.path
                    .strip_suffix(b"/")
                    .map(<[u8]>::to_vec)
                    .unwrap_or(e.path)
            })
            .filter(|p| {
                !(0..=p.len())
                    .filter(|&i| i == p.len() || p[i] == b'/')
                    .any(|i| tracked_set.contains(&p[..i]))
            })
            .collect();
        Ok((tracked, untracked))
    }

    /// Stage paths into the temp index named by `envs`. Explicit paths are
    /// faster than `git add -A` for large repos, and raw paths avoid lossy
    /// UTF-8 conversions for odd filenames. They are literal, so a name like
    /// `[id]` doesn't glob-match (and stage) untracked files.
    fn add_to_index(
        &self,
        worktree_path: &Path,
        envs: &[(OsString, OsString)],
        paths: Vec<Vec<u8>>,
    ) -> Result<(), GitCliError> {
        if paths.is_empty() {
            return Ok(());
        }
        let mut input = Vec::new();
        for p in paths {
            input.extend_from_slice(b":(literal)");
            input.extend_from_slice(&p);
            input.push(0);
        }
        for p in Self::get_default_pathspec_excludes() {
            input.extend_from_slice(p.as_encoded_bytes());
            input.push(0);
        }
        let args = ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"];
        self.git_with_stdin(worktree_path, args, Some(envs), &input)?;
        Ok(())
    }

    /// Whether the untracked files are small enough in total to hash as rename
    /// candidates on every poll.
    ///
    /// ponytail: above the budget a file moved into an untracked path shows as
    /// a deletion plus an addition until it is staged or committed; pick
    /// candidates by size against the deleted blobs if that starts to matter.
    fn untracked_within_rename_budget(worktree_path: &Path, paths: &[Vec<u8>]) -> bool {
        let mut total = 0u64;
        paths.iter().all(|p| {
            total += std::fs::symlink_metadata(worktree_path.join(&*String::from_utf8_lossy(p)))
                .map(|m| m.len())
                .unwrap_or(0);
            total <= UNTRACKED_RENAME_BUDGET_BYTES
        })
    }

    /// [`Self::cached_added_lines`] for many files. Reads are latency bound
    /// (endpoint scanners add to every open), so a few threads cut the first
    /// pass over a large scratch folder about threefold.
    fn added_lines_for(paths: &[PathBuf]) -> Vec<Option<usize>> {
        const BATCH: usize = 64;
        let threads = std::thread::available_parallelism()
            .map_or(1, |n| n.get().min(8))
            .min(paths.len().div_ceil(BATCH));
        if threads <= 1 {
            return paths.iter().map(|p| Self::cached_added_lines(p)).collect();
        }
        let next = AtomicUsize::new(0);
        let mut counts = vec![None; paths.len()];
        std::thread::scope(|scope| {
            let workers: Vec<_> = (0..threads)
                .map(|_| {
                    scope.spawn(|| {
                        let mut done = Vec::new();
                        loop {
                            let start = next.fetch_add(BATCH, Ordering::Relaxed);
                            if start >= paths.len() {
                                break done;
                            }
                            let end = (start + BATCH).min(paths.len());
                            done.extend(paths[start..end].iter().enumerate().map(
                                |(offset, path)| (start + offset, Self::cached_added_lines(path)),
                            ));
                        }
                    })
                })
                .collect();
            for worker in workers {
                for (i, lines) in worker.join().unwrap() {
                    counts[i] = lines;
                }
            }
        });
        counts
    }

    /// [`Self::count_added_lines`] through [`UNTRACKED_LINE_COUNTS`].
    fn cached_added_lines(path: &Path) -> Option<usize> {
        let meta = std::fs::symlink_metadata(path).ok()?;
        let Some(key) = Self::stat_key(&meta) else {
            return Self::count_added_lines(path, &meta);
        };
        if let Some(&(cached, lines)) = UNTRACKED_LINE_COUNTS.lock().unwrap().get(path)
            && cached == key
        {
            return lines;
        }
        let lines = Self::count_added_lines(path, &meta);
        UNTRACKED_LINE_COUNTS
            .lock()
            .unwrap()
            .insert(path.to_path_buf(), (key, lines));
        lines
    }

    fn stat_key(meta: &std::fs::Metadata) -> Option<StatKey> {
        #[cfg(unix)]
        let ctime = {
            use std::os::unix::fs::MetadataExt as _;
            meta.ctime() * 1_000_000_000 + meta.ctime_nsec()
        };
        #[cfg(not(unix))]
        let ctime = 0;
        Some((meta.len(), meta.modified().ok()?, ctime))
    }

    /// Added-line count for an untracked file as `git diff --numstat` would
    /// report it, or `None` (git's `-`) for binary, oversized or unreadable files.
    fn count_added_lines(path: &Path, meta: &std::fs::Metadata) -> Option<usize> {
        if meta.is_symlink() || meta.is_dir() {
            // Git diffs a link target, or a nested repository's commit, as a
            // single line.
            return Some(1);
        }
        let max = crate::MAX_INLINE_DIFF_BYTES as u64;
        if !meta.is_file() || meta.len() > max {
            return None;
        }
        let mut file = std::fs::File::open(path).ok()?;
        let mut buf = Vec::new();
        // Like git, a NUL in the first 8000 bytes marks the file binary.
        (&mut file).take(8000).read_to_end(&mut buf).ok()?;
        if buf.contains(&0) {
            return None;
        }
        // The file may have grown since `meta`; never read past the cap.
        file.take(max + 1 - buf.len() as u64)
            .read_to_end(&mut buf)
            .ok()?;
        if buf.len() as u64 > max {
            return None;
        }
        let newlines = buf.iter().filter(|b| **b == b'\n').count();
        Some(newlines + usize::from(buf.last().is_some_and(|b| *b != b'\n')))
    }

    /// Return `git status --porcelain` parsed into a structured summary
    pub fn get_worktree_status(&self, worktree_path: &Path) -> Result<WorktreeStatus, GitCliError> {
        self.worktree_status(worktree_path, "--untracked-files=normal", None)
    }

    fn worktree_status(
        &self,
        worktree_path: &Path,
        untracked_files: &str,
        path_filter: Option<&Vec<String>>,
    ) -> Result<WorktreeStatus, GitCliError> {
        // Using -z for NUL-separated output which correctly handles paths with special chars.
        // Format: XY<space>PATH<NUL>[ORIGPATH<NUL>] where ORIGPATH only present for R/C.
        let args = Self::apply_pathspec_filter(
            [
                "--no-optional-locks",
                "status",
                "--porcelain",
                "-z",
                untracked_files,
            ],
            path_filter,
        );
        let out = self.git_impl(worktree_path, args, None, None)?;
        let mut entries = Vec::new();
        let mut uncommitted_tracked = 0usize;
        let mut untracked = 0usize;
        let mut parts = out.split(|b| *b == 0);
        while let Some(part) = parts.next() {
            if part.is_empty() || part.len() < 4 {
                continue;
            }
            let staged = part[0] as char;
            let unstaged = part[1] as char;
            let path = part[3..].to_vec();

            let mut orig_path = None;
            if (staged == 'R' || unstaged == 'R' || staged == 'C' || unstaged == 'C')
                && let Some(old_path) = parts.next()
                && !old_path.is_empty()
            {
                orig_path = Some(old_path.to_vec());
            }
            if staged == '?' && unstaged == '?' {
                untracked += 1;
                entries.push(StatusEntry {
                    staged,
                    unstaged,
                    path,
                    orig_path,
                    is_untracked: true,
                });
            } else {
                if staged != ' ' || unstaged != ' ' {
                    uncommitted_tracked += 1;
                }
                entries.push(StatusEntry {
                    staged,
                    unstaged,
                    path,
                    orig_path,
                    is_untracked: false,
                });
            }
        }
        Ok(WorktreeStatus {
            uncommitted_tracked,
            untracked,
            entries,
        })
    }

    /// Stage all changes in the working tree (respects sparse-checkout semantics).
    pub fn add_all(&self, worktree_path: &Path) -> Result<(), GitCliError> {
        self.git(
            worktree_path,
            Self::apply_default_excludes(vec!["add", "-A"]),
        )?;
        Ok(())
    }

    pub fn list_worktrees(&self, repo_path: &Path) -> Result<Vec<WorktreeEntry>, GitCliError> {
        let out = self.git(repo_path, ["worktree", "list", "--porcelain"])?;
        let mut entries = Vec::new();
        let mut current_path: Option<String> = None;
        let mut current_head: Option<String> = None;
        let mut current_branch: Option<String> = None;

        for line in out.lines() {
            let line = line.trim();

            if line.is_empty() {
                // End of current worktree entry, save it if we have required data
                if let (Some(path), Some(_head)) = (current_path.take(), current_head.take()) {
                    entries.push(WorktreeEntry {
                        path,
                        branch: current_branch.take(),
                    });
                }
            } else if let Some(path) = line.strip_prefix("worktree ") {
                current_path = Some(path.to_string());
            } else if let Some(head) = line.strip_prefix("HEAD ") {
                current_head = Some(head.to_string());
            } else if let Some(branch_ref) = line.strip_prefix("branch ") {
                // Extract branch name from refs/heads/branch-name
                current_branch = branch_ref
                    .strip_prefix("refs/heads/")
                    .map(|name| name.to_string());
            }
        }

        // Handle the last entry if no trailing empty line
        if let (Some(path), Some(_head)) = (current_path, current_head) {
            entries.push(WorktreeEntry {
                path,
                branch: current_branch,
            });
        }

        Ok(entries)
    }

    /// Commit staged changes with the given message.
    pub fn commit(&self, worktree_path: &Path, message: &str) -> Result<(), GitCliError> {
        self.git(worktree_path, ["commit", "-m", message])?;
        Ok(())
    }
    /// Fetch a branch to the given remote using native git authentication.
    pub fn fetch_with_refspec(
        &self,
        repo_path: &Path,
        remote_url: &str,
        refspec: &str,
    ) -> Result<(), GitCliError> {
        ensure_safe_remote_url(remote_url)?;
        let envs = vec![(OsString::from("GIT_TERMINAL_PROMPT"), OsString::from("0"))];

        let args = [
            OsString::from("fetch"),
            OsString::from(remote_url),
            OsString::from(refspec),
        ];

        match self.git_with_env(repo_path, args, &envs) {
            Ok(_) => Ok(()),
            Err(GitCliError::CommandFailed(msg)) => Err(self.classify_cli_error(msg)),
            Err(err) => Err(err),
        }
    }

    /// Push a branch to the given remote using native git authentication.
    ///
    /// When `no_verify` is set, `--no-verify` is passed so the local pre-push
    /// hook is skipped (mirrors `git push --no-verify`).
    pub fn push(
        &self,
        repo_path: &Path,
        remote_url: &str,
        branch: &str,
        force: bool,
        no_verify: bool,
    ) -> Result<(), GitCliError> {
        let refspec = if force {
            format!("+refs/heads/{branch}:refs/heads/{branch}")
        } else {
            format!("refs/heads/{branch}:refs/heads/{branch}")
        };
        ensure_safe_remote_url(remote_url)?;
        let envs = vec![(OsString::from("GIT_TERMINAL_PROMPT"), OsString::from("0"))];

        let mut args = vec![OsString::from("push")];
        if no_verify {
            args.push(OsString::from("--no-verify"));
        }
        args.push(OsString::from(remote_url));
        args.push(OsString::from(refspec));

        match self.git_with_env(repo_path, args, &envs) {
            Ok(_) => Ok(()),
            Err(GitCliError::CommandFailed(msg)) => Err(self.classify_cli_error(msg)),
            Err(err) => Err(err),
        }
    }

    /// This directly queries the remote without fetching.
    pub fn check_remote_branch_exists(
        &self,
        repo_path: &Path,
        remote_url: &str,
        branch_name: &str,
    ) -> Result<bool, GitCliError> {
        ensure_safe_remote_url(remote_url)?;
        let envs = vec![(OsString::from("GIT_TERMINAL_PROMPT"), OsString::from("0"))];

        let args = [
            OsString::from("ls-remote"),
            OsString::from("--heads"),
            OsString::from(remote_url),
            OsString::from(format!("refs/heads/{branch_name}")),
        ];

        match self.git_with_env(repo_path, args, &envs) {
            Ok(output) => Ok(!output.trim().is_empty()),
            Err(GitCliError::CommandFailed(msg)) => Err(self.classify_cli_error(msg)),
            Err(err) => Err(err),
        }
    }

    /// Delete a local branch from the repository (force delete).
    pub fn delete_branch(&self, repo_path: &Path, branch_name: &str) -> Result<(), GitCliError> {
        self.ensure_available()?;
        self.git(repo_path, ["branch", "-D", branch_name])?;
        Ok(())
    }

    pub fn get_remote_url(
        &self,
        repo_path: &Path,
        remote_name: &str,
    ) -> Result<String, GitCliError> {
        let output = self.git(repo_path, ["remote", "get-url", remote_name])?;
        Ok(output.trim().to_string())
    }

    /// List each remote's fetch URL without `remote -v` display annotations.
    pub fn list_remotes(&self, repo_path: &Path) -> Result<Vec<(String, String)>, GitCliError> {
        self.git(repo_path, ["remote"])?
            .lines()
            .map(|name| {
                self.get_remote_url(repo_path, name)
                    .map(|url| (name.to_string(), url))
            })
            .collect()
    }

    // Parse `git diff --name-status` output into structured entries.
    // Handles rename/copy scores like `R100` by matching the first letter.
    fn parse_name_status(output: &str) -> Vec<StatusDiffEntry> {
        let mut out = Vec::new();
        for line in output.lines() {
            let line = line.trim_end();
            if line.is_empty() {
                continue;
            }
            let mut parts = line.split('\t');
            let code = parts.next().unwrap_or("");
            let change = match code.chars().next().unwrap_or('?') {
                'A' => ChangeType::Added,
                'M' => ChangeType::Modified,
                'D' => ChangeType::Deleted,
                'R' => ChangeType::Renamed,
                'C' => ChangeType::Copied,
                'T' => ChangeType::TypeChanged,
                'U' => ChangeType::Unmerged,
                other => ChangeType::Unknown(other.to_string()),
            };

            match change {
                ChangeType::Renamed | ChangeType::Copied => {
                    if let (Some(old), Some(newp)) = (parts.next(), parts.next()) {
                        out.push(StatusDiffEntry {
                            change,
                            path: newp.to_string(),
                            old_path: Some(old.to_string()),
                        });
                    }
                }
                _ => {
                    if let Some(p) = parts.next() {
                        out.push(StatusDiffEntry {
                            change,
                            path: p.to_string(),
                            old_path: None,
                        });
                    }
                }
            }
        }
        out
    }

    fn parse_numstat(output: &str) -> Vec<NumstatDiffEntry> {
        let mut out = Vec::new();
        for line in output.lines() {
            let line = line.trim_end();
            if line.is_empty() {
                continue;
            }

            let mut parts = line.split('\t');
            let additions = parts.next().and_then(|s| s.parse::<usize>().ok());
            let deletions = parts.next().and_then(|s| s.parse::<usize>().ok());
            if let Some(path) = parts.next() {
                out.push(NumstatDiffEntry {
                    additions,
                    deletions,
                    path: path.to_string(),
                });
            }
        }
        out
    }

    /// Return the merge base commit sha of two refs in the given worktree.
    /// If `git merge-base --fork-point` fails, falls back to regular `merge-base`.
    pub fn merge_base(
        &self,
        worktree_path: &Path,
        a: &str,
        b: &str,
    ) -> Result<String, GitCliError> {
        let out = self
            .git(worktree_path, ["merge-base", "--fork-point", a, b])
            .unwrap_or(self.git(worktree_path, ["merge-base", a, b])?);
        Ok(out.trim().to_string())
    }

    /// Perform `git rebase --onto <new_base> <old_base>` on <task_branch> in `worktree_path`.
    pub fn rebase_onto(
        &self,
        worktree_path: &Path,
        new_base: &str,
        old_base: &str,
        task_branch: &str,
    ) -> Result<(), GitCliError> {
        // If a rebase is in progress, refuse to proceed. The caller can
        // choose to abort or continue; we avoid destructive actions here.
        if self.is_rebase_in_progress(worktree_path).unwrap_or(false) {
            return Err(GitCliError::RebaseInProgress);
        }
        // compute the merge base of task_branch from old_base
        let merge_base = self
            .merge_base(worktree_path, old_base, task_branch)
            .unwrap_or(old_base.to_string());

        self.git(
            worktree_path,
            ["rebase", "--onto", new_base, &merge_base, task_branch],
        )?;
        Ok(())
    }

    /// Return true if there is a rebase in progress in this worktree.
    /// We treat this as true when either of Git's rebase state directories exists:
    /// - rebase-merge (interactive rebase)
    /// - rebase-apply (am-based rebase)
    pub fn is_rebase_in_progress(&self, worktree_path: &Path) -> Result<bool, GitCliError> {
        let rebase_merge = self.git(worktree_path, ["rev-parse", "--git-path", "rebase-merge"])?;
        let rebase_apply = self.git(worktree_path, ["rev-parse", "--git-path", "rebase-apply"])?;
        let rm_exists = std::path::Path::new(rebase_merge.trim()).exists();
        let ra_exists = std::path::Path::new(rebase_apply.trim()).exists();
        Ok(rm_exists || ra_exists)
    }

    /// Return true if a merge is in progress (MERGE_HEAD exists).
    pub fn is_merge_in_progress(&self, worktree_path: &Path) -> Result<bool, GitCliError> {
        match self.git(worktree_path, ["rev-parse", "--verify", "MERGE_HEAD"]) {
            Ok(_) => Ok(true),
            Err(GitCliError::CommandFailed(_)) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Return true if a cherry-pick is in progress (CHERRY_PICK_HEAD exists).
    pub fn is_cherry_pick_in_progress(&self, worktree_path: &Path) -> Result<bool, GitCliError> {
        match self.git(worktree_path, ["rev-parse", "--verify", "CHERRY_PICK_HEAD"]) {
            Ok(_) => Ok(true),
            Err(GitCliError::CommandFailed(_)) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Return true if a revert is in progress (REVERT_HEAD exists).
    pub fn is_revert_in_progress(&self, worktree_path: &Path) -> Result<bool, GitCliError> {
        match self.git(worktree_path, ["rev-parse", "--verify", "REVERT_HEAD"]) {
            Ok(_) => Ok(true),
            Err(GitCliError::CommandFailed(_)) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Abort an in-progress rebase in this worktree. If no rebase is in progress,
    /// this is a no-op and returns Ok(()).
    pub fn abort_rebase(&self, worktree_path: &Path) -> Result<(), GitCliError> {
        // If nothing to abort, return success
        if !self.is_rebase_in_progress(worktree_path)? {
            return Ok(());
        }
        // Best-effort: if `git rebase --abort` fails, surface the error message
        self.git(worktree_path, ["rebase", "--abort"]).map(|_| ())
    }

    /// Quit an in-progress rebase (cleanup metadata without modifying commits).
    /// If no rebase is in progress, it's a no-op.
    pub fn quit_rebase(&self, worktree_path: &Path) -> Result<(), GitCliError> {
        if !self.is_rebase_in_progress(worktree_path)? {
            return Ok(());
        }
        self.git(worktree_path, ["rebase", "--quit"]).map(|_| ())
    }

    /// Continue an in-progress rebase. Returns error if no rebase is in progress
    /// or if there are unresolved conflicts.
    pub fn continue_rebase(&self, worktree_path: &Path) -> Result<(), GitCliError> {
        if !self.is_rebase_in_progress(worktree_path)? {
            return Err(GitCliError::CommandFailed(
                "No rebase in progress".to_string(),
            ));
        }
        self.git(worktree_path, ["rebase", "--continue"])
            .map(|_| ())
    }

    /// Return true if there are staged changes (index differs from HEAD)
    pub fn has_staged_changes(&self, repo_path: &Path) -> Result<bool, GitCliError> {
        use utils::command_ext::NoWindowExt;
        // `git diff --cached --quiet` returns exit code 1 if there are differences
        let out =
            Command::new(resolve_executable_path_blocking("git").ok_or(GitCliError::NotAvailable)?)
                .arg("-C")
                .arg(repo_path)
                .arg("diff")
                .arg("--cached")
                .arg("--quiet")
                .no_window()
                .output()
                .map_err(|e| GitCliError::CommandFailed(e.to_string()))?;
        match out.status.code() {
            Some(0) => Ok(false),
            Some(1) => Ok(true),
            _ => Err(GitCliError::CommandFailed(
                String::from_utf8_lossy(&out.stderr).trim().to_string(),
            )),
        }
    }

    /// Checkout base branch and fast-forward it to from_branch. Returns new HEAD sha.
    pub fn merge_ff_only(
        &self,
        repo_path: &Path,
        base_branch: &str,
        from_branch: &str,
    ) -> Result<String, GitCliError> {
        self.git(repo_path, ["checkout", base_branch]).map(|_| ())?;
        self.git(repo_path, ["merge", "--ff-only", from_branch])
            .map(|_| ())?;
        let sha = self
            .git(repo_path, ["rev-parse", "HEAD"])?
            .trim()
            .to_string();
        Ok(sha)
    }

    /// Fast-forward the branch currently checked out in `worktree_path` to
    /// `target` (a ref name or sha). Unlike [`merge_ff_only`], this does not
    /// switch branches — it advances the current HEAD in place, which is what a
    /// `git pull --ff-only` does. Fails if a fast-forward is not possible.
    /// Returns the new HEAD sha.
    pub fn merge_ff_only_current(
        &self,
        worktree_path: &Path,
        target: &str,
    ) -> Result<String, GitCliError> {
        self.git(worktree_path, ["merge", "--ff-only", target])
            .map(|_| ())?;
        let sha = self
            .git(worktree_path, ["rev-parse", "HEAD"])?
            .trim()
            .to_string();
        Ok(sha)
    }

    /// Merge `from_ref` into the branch currently checked out in
    /// `worktree_path`, creating a merge commit when the histories have
    /// diverged (or fast-forwarding when possible). Used to bring base-branch
    /// changes into a work branch without rewriting history. On conflicts git
    /// leaves the worktree in a merge-conflict state and this returns
    /// `CommandFailed` with the conflict output.
    pub fn merge_branch_into_current(
        &self,
        worktree_path: &Path,
        from_ref: &str,
        message: &str,
    ) -> Result<String, GitCliError> {
        self.git(
            worktree_path,
            ["merge", "--no-edit", "-m", message, from_ref],
        )
        .map(|_| ())?;
        let sha = self
            .git(worktree_path, ["rev-parse", "HEAD"])?
            .trim()
            .to_string();
        Ok(sha)
    }

    /// Update a ref to a specific sha in the repo.
    pub fn update_ref(
        &self,
        repo_path: &Path,
        refname: &str,
        sha: &str,
    ) -> Result<(), GitCliError> {
        self.git(repo_path, ["update-ref", refname, sha])
            .map(|_| ())
    }

    pub fn abort_merge(&self, worktree_path: &Path) -> Result<(), GitCliError> {
        if !self.is_merge_in_progress(worktree_path)? {
            return Ok(());
        }
        self.git(worktree_path, ["merge", "--abort"]).map(|_| ())
    }

    pub fn abort_cherry_pick(&self, worktree_path: &Path) -> Result<(), GitCliError> {
        if !self.is_cherry_pick_in_progress(worktree_path)? {
            return Ok(());
        }
        self.git(worktree_path, ["cherry-pick", "--abort"])
            .map(|_| ())
    }

    pub fn abort_revert(&self, worktree_path: &Path) -> Result<(), GitCliError> {
        if !self.is_revert_in_progress(worktree_path)? {
            return Ok(());
        }
        self.git(worktree_path, ["revert", "--abort"]).map(|_| ())
    }

    /// List files currently in a conflicted (unmerged) state in the worktree.
    pub fn get_conflicted_files(&self, worktree_path: &Path) -> Result<Vec<String>, GitCliError> {
        // `--diff-filter=U` lists paths with unresolved conflicts
        let out = self.git(worktree_path, ["diff", "--name-only", "--diff-filter=U"])?;
        let mut files = Vec::new();
        for line in out.lines() {
            let p = line.trim();
            if !p.is_empty() {
                files.push(p.to_string());
            }
        }
        Ok(files)
    }
}

// Private methods
impl GitCli {
    fn classify_cli_error(&self, msg: String) -> GitCliError {
        let lower = msg.to_ascii_lowercase();
        if lower.contains("authentication failed")
            || lower.contains("could not read username")
            || lower.contains("invalid username or password")
        {
            GitCliError::AuthFailed(msg)
        } else if lower.contains("non-fast-forward")
            || lower.contains("fetch first")
            || lower.contains("updates were rejected because the tip")
        {
            // Only genuine non-fast-forward rejections become PushRejected — the
            // one case where the caller offers a force push. We deliberately do
            // NOT match the generic "failed to push some refs" summary line: git
            // prints it for EVERY failed push (rejected pre-push hooks,
            // protected-branch / permission denials, ...), none of which a force
            // push can fix. Those fall through to CommandFailed so the full git
            // output reaches the user instead of a misleading "branch diverged,
            // force push?" prompt.
            GitCliError::PushRejected(msg)
        } else {
            GitCliError::CommandFailed(msg)
        }
    }

    /// Ensure `git` is available on PATH
    fn ensure_available(&self) -> Result<(), GitCliError> {
        use utils::command_ext::NoWindowExt;
        let git = resolve_executable_path_blocking("git").ok_or(GitCliError::NotAvailable)?;
        let out = Command::new(&git)
            .arg("--version")
            .no_window()
            .output()
            .map_err(|_| GitCliError::NotAvailable)?;
        if out.status.success() {
            Ok(())
        } else {
            Err(GitCliError::NotAvailable)
        }
    }

    /// Run `git -C <repo_path> <args...>` and return stdout bytes on success.
    /// Prefer adding specific helpers (e.g. `get_worktree_status`, `diff_status`)
    /// instead of calling this directly, so all parsing and command choices are
    /// centralized here. This makes it easier to change the underlying commands
    /// without adjusting callers. Use this low-level method directly only in
    /// tests or when no dedicated helper exists yet.
    ///
    /// About `OsStr`/`OsString` usage:
    /// - `Command` and `Path` operate on `OsStr` to support non‑UTF‑8 paths and
    ///   arguments across platforms. Using `String` would force lossy conversion
    ///   or partial failures. This API accepts anything that implements
    ///   `AsRef<OsStr>` so typical call sites can still pass `&str` literals or
    ///   owned `String`s without friction.
    fn git_impl<I, S>(
        &self,
        repo_path: &Path,
        args: I,
        envs: Option<&[(OsString, OsString)]>,
        stdin: Option<&[u8]>,
    ) -> Result<Vec<u8>, GitCliError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.ensure_available()?;
        let git = resolve_executable_path_blocking("git").ok_or(GitCliError::NotAvailable)?;
        let mut cmd = Command::new(&git);
        // Disable the `ext::` transport for every git invocation. A remote URL is
        // read from a repo's own git config; `ext::<cmd>` makes git run an
        // arbitrary command as its "transport helper", so a booby-trapped
        // `remote.url` would be RCE on the host. We never use ext:: ourselves.
        cmd.arg("-c").arg("protocol.ext.allow=never");
        cmd.arg("-C").arg(repo_path);

        if let Some(envs) = envs {
            for (k, v) in envs {
                cmd.env(k, v);
            }
        }

        for a in args {
            cmd.arg(a);
        }

        if stdin.is_some() {
            cmd.stdin(Stdio::piped());
        } else {
            cmd.stdin(Stdio::null());
        }

        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        tracing::trace!(
            stdin = ?stdin.as_ref().map(|s| String::from_utf8_lossy(s)),
            repo = ?repo_path,
            "Running git command: {:?}",
            cmd
        );

        use utils::command_ext::NoWindowExt;
        let mut child = cmd
            .no_window()
            .spawn()
            .map_err(|e| GitCliError::CommandFailed(e.to_string()))?;

        let stdin_write_result = if let Some(input) = stdin
            && let Some(mut child_stdin) = child.stdin.take()
        {
            Some(child_stdin.write_all(input))
        } else {
            None
        };

        let out = child
            .wait_with_output()
            .map_err(|e| GitCliError::CommandFailed(e.to_string()))?;

        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let combined = match (stdout.is_empty(), stderr.is_empty()) {
                (true, true) => "Command failed with no output".to_string(),
                (false, false) => format!("--- stderr\n{stderr}\n--- stdout\n{stdout}"),
                (false, true) => format!("--- stderr\n{stdout}"),
                (true, false) => format!("--- stdout\n{stderr}"),
            };
            return Err(GitCliError::CommandFailed(combined));
        }
        if let Some(Err(e)) = stdin_write_result {
            return Err(GitCliError::CommandFailed(format!(
                "failed to write to git stdin: {e}"
            )));
        }
        Ok(out.stdout)
    }

    pub fn git<I, S>(&self, repo_path: &Path, args: I) -> Result<String, GitCliError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let out = self.git_impl(repo_path, args, None, None)?;
        Ok(String::from_utf8_lossy(&out).to_string())
    }

    fn git_with_env<I, S>(
        &self,
        repo_path: &Path,
        args: I,
        envs: &[(OsString, OsString)],
    ) -> Result<String, GitCliError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let out = self.git_impl(repo_path, args, Some(envs), None)?;
        Ok(String::from_utf8_lossy(&out).to_string())
    }

    fn git_with_stdin<I, S>(
        &self,
        repo_path: &Path,
        args: I,
        envs: Option<&[(OsString, OsString)]>,
        stdin: &[u8],
    ) -> Result<String, GitCliError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let out = self.git_impl(repo_path, args, envs, Some(stdin))?;
        Ok(String::from_utf8_lossy(&out).to_string())
    }

    fn apply_default_excludes<I, S>(args: I) -> Vec<OsString>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        Self::apply_pathspec_filter(args, None)
    }

    fn apply_pathspec_filter<I, S>(args: I, pathspecs: Option<&Vec<String>>) -> Vec<OsString>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let filters = Self::build_pathspec_filter(pathspecs);
        let mut args = args
            .into_iter()
            .map(|s| s.as_ref().to_os_string())
            .collect::<Vec<_>>();
        if !filters.is_empty() {
            args.push("--".into());
            args.extend(filters);
        }
        args
    }

    fn build_pathspec_filter(pathspecs: Option<&Vec<String>>) -> Vec<OsString> {
        let mut filters = Vec::new();
        filters.extend(Self::get_default_pathspec_excludes());
        if let Some(pathspecs) = pathspecs {
            for p in pathspecs {
                if p.trim().is_empty() {
                    continue;
                }
                filters.push(OsString::from(p));
            }
        }
        filters
    }

    fn get_default_pathspec_excludes() -> Vec<OsString> {
        ALWAYS_SKIP_DIRS
            .iter()
            .map(|d| OsString::from(format!(":(glob,exclude)**/{d}/")))
            .collect()
    }
}
/// Parsed entry from `git status --porcelain`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusEntry {
    /// Single-letter staged status (column X) or '?' for untracked
    pub staged: char,
    /// Single-letter unstaged status (column Y) or '?' for untracked
    pub unstaged: char,
    /// Current path (raw bytes to avoid lossy UTF-8 conversion)
    pub path: Vec<u8>,
    /// Original path (for renames), raw bytes
    pub orig_path: Option<Vec<u8>>,
    /// True if this entry is untracked ("??")
    pub is_untracked: bool,
}

/// Summary + entries for a working tree status
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeStatus {
    pub uncommitted_tracked: usize,
    pub untracked: usize,
    pub entries: Vec<StatusEntry>,
}

#[cfg(test)]
mod tests {
    use super::{GitCli, GitCliError, NumstatDiffEntry};

    #[test]
    fn classify_cli_error_only_flags_true_non_fast_forward_as_push_rejected() {
        let git = GitCli;

        // Genuine non-fast-forward rejections stay PushRejected so the caller can
        // offer a force push.
        for msg in [
            "! [rejected]        main -> main (non-fast-forward)\n\
             error: failed to push some refs to 'https://github.com/x/y.git'\n\
             hint: Updates were rejected because the tip of your current branch is behind",
            "! [rejected]        main -> main (fetch first)\n\
             error: failed to push some refs to 'https://github.com/x/y.git'",
        ] {
            assert!(
                matches!(
                    git.classify_cli_error(msg.to_string()),
                    GitCliError::PushRejected(_)
                ),
                "expected PushRejected for: {msg}"
            );
        }

        // A failing pre-push hook or a protected-branch rejection is NOT a
        // divergence — a force push cannot fix it — so it must surface as
        // CommandFailed (full output shown to the user), never a force-push prompt.
        for msg in [
            "ruff format check....................Failed\n\
             - hook id: ruff-format\n\
             error: failed to push some refs to 'https://github.com/x/y.git'",
            "remote: error: GH006: Protected branch update failed for refs/heads/main.\n\
             ! [remote rejected] main -> main (protected branch hook declined)\n\
             error: failed to push some refs to 'https://github.com/x/y.git'",
        ] {
            assert!(
                matches!(
                    git.classify_cli_error(msg.to_string()),
                    GitCliError::CommandFailed(_)
                ),
                "expected CommandFailed for: {msg}"
            );
        }

        // Auth failures keep their dedicated classification.
        assert!(matches!(
            git.classify_cli_error(
                "fatal: Authentication failed for 'https://github.com/x/y.git'".to_string()
            ),
            GitCliError::AuthFailed(_)
        ));
    }

    #[test]
    fn parses_numstat_text_and_binary_entries() {
        let output = "12\t3\tsrc/main.rs\n-\t-\tassets/logo.png\n";

        assert_eq!(
            GitCli::parse_numstat(output),
            vec![
                NumstatDiffEntry {
                    additions: Some(12),
                    deletions: Some(3),
                    path: "src/main.rs".to_string(),
                },
                NumstatDiffEntry {
                    additions: None,
                    deletions: None,
                    path: "assets/logo.png".to_string(),
                },
            ]
        );
    }
}
