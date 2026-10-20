use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, mpsc},
    time::Duration,
};

use futures::{
    SinkExt, StreamExt,
    channel::mpsc::{Receiver, channel},
};
use ignore::{
    WalkBuilder,
    gitignore::{Gitignore, GitignoreBuilder},
};
use notify::{
    EventHandler, RecommendedWatcher, RecursiveMode, Watcher,
    event::{EventKind, ModifyKind, RenameMode},
};
use notify_debouncer_full::{
    DebounceEventResult, DebouncedEvent, Debouncer, NoCache, new_debouncer_opt,
};
use thiserror::Error;
use utils::path::ALWAYS_SKIP_DIRS;

pub type WatcherComponents = (WatcherGuard, Receiver<DebounceEventResult>, PathBuf);

/// Keeps a watcher running; dropping it releases the watcher off the caller's
/// thread. Stopping a macOS FSEvents stream spins until its run loop idles,
/// which a burst of events can postpone indefinitely, so an async worker must
/// never do it.
pub struct WatcherGuard<W: Send + 'static = Arc<Mutex<DebouncedWatcher>>>(pub(crate) Option<W>);

impl<W: Send + 'static> Drop for WatcherGuard<W> {
    fn drop(&mut self) {
        if let Some(debouncer) = self.0.take() {
            release_off_thread(debouncer);
        }
    }
}

/// A debouncer fed by a watcher we own. `Debouncer` keeps its watcher to
/// itself, and every FSEvents `watch` restarts the stream with all paths so
/// far, so registering a large checkout one directory at a time took seconds;
/// owning the watcher lets `paths_mut` apply them in one restart. Without a
/// file-id cache the debouncer never reads its own root list.
pub struct DebouncedWatcher {
    watcher: RecommendedWatcher,
    _debouncer: Debouncer<EventTap, NoCache>,
}

thread_local! {
    static TAPPED_FEED: RefCell<Option<Box<dyn EventHandler>>> = const { RefCell::new(None) };
}

/// Stands in for the debouncer's watcher and hands over its event feed.
struct EventTap;

impl Watcher for EventTap {
    fn new<F: EventHandler>(feed: F, _: notify::Config) -> notify::Result<Self> {
        TAPPED_FEED.set(Some(Box::new(feed)));
        Ok(Self)
    }

    fn watch(&mut self, _: &Path, _: RecursiveMode) -> notify::Result<()> {
        Ok(())
    }

    fn unwatch(&mut self, _: &Path) -> notify::Result<()> {
        Ok(())
    }

    fn kind() -> notify::WatcherKind {
        notify::WatcherKind::NullWatcher
    }
}

/// Drop `value` on the shared release thread without waiting for it.
// ponytail: one thread for every release, so stuck stops can't pile up
// threads; a stop stuck behind an endless burst delays later releases (never
// their callers). Per-release threads if that delay ever matters.
fn release_off_thread<T: Send + 'static>(value: T) {
    static RELEASER: OnceLock<mpsc::Sender<Box<dyn Send>>> = OnceLock::new();
    let releaser = RELEASER.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<Box<dyn Send>>();
        std::thread::Builder::new()
            .name("watcher-release".into())
            .spawn(move || rx.into_iter().for_each(drop))
            .expect("failed to spawn the watcher release thread");
        tx
    });
    // Fails only if a drop panicked the thread; the value then drops here.
    let _ = releaser.send(Box::new(value));
}

#[derive(Debug, Error)]
pub enum FilesystemWatcherError {
    #[error(transparent)]
    Notify(#[from] notify::Error),
    #[error(transparent)]
    Ignore(#[from] ignore::Error),
    #[error(transparent)]
    IoError(#[from] std::io::Error),
    #[error("Failed to build gitignore: {0}")]
    GitignoreBuilder(String),
    #[error("Invalid path: {0}")]
    InvalidPath(String),
}

fn canonicalize_lossy(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn should_skip_dir(name: &str) -> bool {
    ALWAYS_SKIP_DIRS.contains(&name)
}

/// Check if the platform supports efficient native recursive watching.
/// macOS (FSEvents) and Windows (ReadDirectoryChangesW) support recursive watching natively.
/// Linux (inotify) does not - it requires a watch descriptor per directory.
fn platform_supports_native_recursive() -> bool {
    cfg!(target_os = "macos") || cfg!(target_os = "windows")
}

fn build_gitignore_set(root: &Path) -> Result<Gitignore, FilesystemWatcherError> {
    let mut builder = GitignoreBuilder::new(root);
    let mut gitignore_files = Vec::new();

    // Walk once to collect all .gitignore files under root
    // Use git_ignore(true) to avoid walking into gitignored directories
    WalkBuilder::new(root)
        .follow_links(false)
        .hidden(false) // we *want* to see .gitignore
        .git_ignore(true) // Respect gitignore to skip heavy directories
        .filter_entry(|entry| {
            let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);

            // Skip .git directory
            if is_dir
                && let Some(name) = entry.file_name().to_str()
                && should_skip_dir(name)
            {
                return false;
            }

            // only recurse into directories and .gitignore files
            is_dir
                || entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name == ".gitignore")
        })
        .build()
        .try_for_each(|result| {
            // everything that is not a directory and is named .gitignore
            match result {
                Ok(dir_entry) => {
                    if !dir_entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                        gitignore_files.push(dir_entry.into_path());
                    }
                    Ok(())
                }
                Err(err)
                    if err.io_error().is_some_and(|io_err| {
                        io_err.kind() == std::io::ErrorKind::PermissionDenied
                    }) =>
                {
                    // Skip entries we don't have permission to read
                    tracing::warn!("Permission denied reading path: {}", err);
                    Ok(())
                }
                Err(e) => Err(FilesystemWatcherError::Ignore(e)),
            }
        })?;

    // Parents first: the last matching glob wins, so deeper files override.
    gitignore_files.sort_by_key(|path| path.components().count());
    for file in gitignore_files {
        add_scoped_gitignore(&mut builder, root, &file);
    }

    // Optionally include repo-local excludes
    let info_exclude = root.join(".git/info/exclude");
    if info_exclude.exists() {
        builder.add(info_exclude);
    }

    Ok(builder.build()?)
}

/// `GitignoreBuilder` matches every glob against the builder root, so a
/// nested `.gitignore` holding `*` would ignore the whole tree. Rewrite its
/// patterns relative to the root, as git scopes them to their directory.
fn add_scoped_gitignore(builder: &mut GitignoreBuilder, root: &Path, file: &Path) {
    let dir = file
        .parent()
        .and_then(|dir| dir.strip_prefix(root).ok())
        .map(|dir| dir.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    if dir.is_empty() {
        builder.add(file);
        return;
    }
    let Ok(content) = std::fs::read_to_string(file) else {
        return;
    };
    for line in content.lines() {
        let line = line.trim_start_matches('\u{feff}').trim_end();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (negation, pattern) = match line.strip_prefix('!') {
            Some(pattern) => ("!", pattern),
            None => ("", line),
        };
        // A slash before the end anchors to this directory; otherwise the
        // pattern matches at any depth below it.
        let scoped = if pattern.trim_end_matches('/').contains('/') {
            format!("{negation}{dir}/{}", pattern.trim_start_matches('/'))
        } else {
            format!("{negation}{dir}/**/{pattern}")
        };
        let _ = builder.add_line(Some(file.to_path_buf()), &scoped);
    }
}

fn path_allowed(path: &Path, gi: &Gitignore, canonical_root: &Path) -> bool {
    let canonical_path = canonicalize_lossy(path);

    // Convert absolute path to relative path from the gitignore root
    let relative_path = match canonical_path.strip_prefix(canonical_root) {
        Ok(rel_path) => rel_path,
        Err(_) => {
            // Path is outside the watched root, don't ignore it
            return true;
        }
    };

    // Check if path is inside any of the always-skip directories
    if let Some(parent) = relative_path.parent() {
        for component in parent.components() {
            if let std::path::Component::Normal(name) = component
                && let Some(name_str) = name.to_str()
                && should_skip_dir(name_str)
            {
                return false;
            }
        }
    }

    let is_dir = if let Ok(metadata) = std::fs::metadata(&canonical_path) {
        metadata.is_dir()
    } else {
        // File may already be gone (e.g., remove event). Fall back to the
        // old extension heuristic so directory-only rules still match.
        // FIXME: capture file-type information earlier (e.g., when we add
        // watches) so we don't have to guess after the fact.
        relative_path.extension().is_none()
    };
    let matched = gi.matched_path_or_any_parents(relative_path, is_dir);

    !matched.is_ignore()
}

fn debounced_should_forward(event: &DebouncedEvent, gi: &Gitignore, canonical_root: &Path) -> bool {
    // DebouncedEvent is a struct that wraps the underlying notify::Event
    if event.kind.is_access() {
        // Ignore access events
        return false;
    }
    // A rename names both ends; it matters if either side is not ignored
    // (an ignored temp file renamed over a tracked one, or the reverse).
    // Rescans (inotify queue overflow) carry no paths but mean events were lost.
    event.need_rescan()
        || event
            .paths
            .iter()
            .any(|path| path_allowed(path, gi, canonical_root))
}

/// Represents a directory to watch with its recursive mode.
#[derive(Debug, Clone)]
struct WatchTarget {
    path: PathBuf,
    recursive: RecursiveMode,
}

#[derive(Default)]
struct WatchedDirs {
    all: HashSet<PathBuf>,
    recursive: HashSet<PathBuf>,
}

impl WatchedDirs {
    fn contains(&self, path: &Path) -> bool {
        self.all.contains(path)
    }

    fn has_recursive_cover(&self, path: &Path) -> bool {
        self.recursive
            .iter()
            .any(|ancestor| ancestor != path && path.starts_with(ancestor))
    }

    fn insert(&mut self, path: PathBuf, mode: RecursiveMode) {
        if matches!(mode, RecursiveMode::Recursive) {
            self.recursive.insert(path.clone());
        } else {
            self.recursive.remove(&path);
        }
        self.all.insert(path);
    }

    fn remove_dir_and_children<F>(&mut self, prefix: &Path, f: F)
    where
        F: FnMut(&Path),
    {
        self.remove_with_prefix(prefix, true, f);
    }

    fn remove_children_only<F>(&mut self, prefix: &Path, f: F)
    where
        F: FnMut(&Path),
    {
        self.remove_with_prefix(prefix, false, f);
    }

    fn remove_with_prefix<F>(&mut self, prefix: &Path, include_prefix: bool, mut f: F)
    where
        F: FnMut(&Path),
    {
        let to_remove: Vec<PathBuf> = self
            .all
            .iter()
            .filter(|path| path.starts_with(prefix) && (include_prefix || *path != prefix))
            .cloned()
            .collect();

        for path in to_remove {
            self.all.remove(&path);
            self.recursive.remove(&path);
            f(&path);
        }
    }
}

/// Check if a directory or any of its descendants has gitignored directories.
/// Used on macOS/Windows to determine if we can watch recursively.
///
/// This checks recursively to ensure we don't use Recursive mode on a directory
/// that has gitignored descendants (e.g., packages/app1/node_modules).
fn has_ignored_descendants(
    dir: &Path,
    gi: &Gitignore,
    canonical_root: &Path,
    allowed_dirs: &std::collections::HashSet<PathBuf>,
    cache: &mut HashMap<PathBuf, bool>,
) -> bool {
    let key = dir.to_path_buf();
    if let Some(&cached) = cache.get(&key) {
        return cached;
    }

    // Read immediate children
    let result = (|| {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return false;
        };

        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };

            if !file_type.is_dir() {
                continue;
            }

            let path = entry.path();

            // Check if this subdirectory should be skipped
            if let Some(name) = path.file_name().and_then(|n| n.to_str())
                && should_skip_dir(name)
            {
                return true;
            }

            // If it's not in allowed_dirs, it means WalkBuilder skipped it (gitignored)
            if !allowed_dirs.contains(&path) && !path_allowed(&path, gi, canonical_root) {
                return true;
            }

            if has_ignored_descendants(&path, gi, canonical_root, allowed_dirs, cache) {
                return true;
            }
        }
        false
    })();

    cache.insert(key, result);
    result
}

/// Collect directories to watch, respecting gitignore and excluding .git.
/// On macOS/Windows, use recursive mode for directories without ignored subdirectories.
/// On Linux, use non-recursive mode for all directories.
fn collect_watch_directories(
    root: &Path,
    gi: &Gitignore,
    respect_gitignore: bool,
) -> Vec<WatchTarget> {
    let use_recursive = platform_supports_native_recursive();
    let filter_root = root.to_path_buf();
    let filter_ignore = gi.clone();

    let mut allowed_dirs: Vec<PathBuf> = WalkBuilder::new(root)
        .follow_links(false)
        .hidden(false)
        .git_ignore(respect_gitignore)
        .git_global(respect_gitignore)
        .git_exclude(respect_gitignore)
        .ignore(respect_gitignore)
        .parents(respect_gitignore)
        .filter_entry(move |entry| {
            let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
            if !is_dir {
                return false;
            }

            if let Some(name) = entry.file_name().to_str()
                && should_skip_dir(name)
            {
                return false;
            }

            path_allowed(entry.path(), &filter_ignore, &filter_root)
        })
        .build()
        .take(if respect_gitignore {
            usize::MAX
        } else {
            50_000
        })
        .filter_map(|result| result.ok())
        .filter(|entry| entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false))
        .map(|entry| entry.into_path())
        .collect();

    allowed_dirs.sort();

    let allowed_dirs_set: HashSet<PathBuf> = allowed_dirs.iter().cloned().collect();
    let mut ignored_cache = HashMap::new();
    let mut ancestor_stack: Vec<(PathBuf, bool)> = Vec::new();

    allowed_dirs
        .into_iter()
        .filter_map(|path| {
            while ancestor_stack
                .last()
                .is_some_and(|(ancestor, _)| !path.starts_with(ancestor))
            {
                ancestor_stack.pop();
            }

            if ancestor_stack
                .last()
                .is_some_and(|(_, is_recursive)| *is_recursive)
            {
                return None;
            }

            let recursive_mode = if use_recursive {
                if has_ignored_descendants(&path, gi, root, &allowed_dirs_set, &mut ignored_cache) {
                    RecursiveMode::NonRecursive
                } else {
                    RecursiveMode::Recursive
                }
            } else {
                RecursiveMode::NonRecursive
            };

            let is_recursive = matches!(recursive_mode, RecursiveMode::Recursive);
            ancestor_stack.push((path.clone(), is_recursive));

            Some(WatchTarget {
                path,
                recursive: recursive_mode,
            })
        })
        .collect()
}

/// Helper to determine watch mode for a directory (used for dynamically added directories).
/// This does a simple check of immediate children only, since we don't have the full
/// allowed_dirs set at runtime.
fn determine_watch_mode(path: &Path, gi: &Gitignore, canonical_root: &Path) -> RecursiveMode {
    if !platform_supports_native_recursive() {
        return RecursiveMode::NonRecursive;
    }

    let Ok(entries) = std::fs::read_dir(path) else {
        return RecursiveMode::Recursive;
    };

    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };

        if !file_type.is_dir() {
            continue;
        }

        let child_path = entry.path();

        if let Some(name) = child_path.file_name().and_then(|n| n.to_str())
            && should_skip_dir(name)
        {
            return RecursiveMode::NonRecursive;
        }

        if !path_allowed(&child_path, gi, canonical_root) {
            return RecursiveMode::NonRecursive;
        }
    }

    RecursiveMode::Recursive
}

/// Pending watch updates: `Some(mode)` watches a path, `None` unwatches it.
type WatchChanges = Vec<(PathBuf, Option<RecursiveMode>)>;

/// Apply every update with one stream restart; a path that could not be
/// watched is forgotten.
fn apply_watch_changes(
    watcher: &mut dyn Watcher,
    watched_dirs: &mut WatchedDirs,
    changes: WatchChanges,
) {
    if changes.is_empty() {
        return;
    }
    let mut paths = watcher.paths_mut();
    for (path, mode) in changes {
        let result = match mode {
            Some(mode) => paths.add(&path, mode),
            None => paths.remove(&path),
        };
        if let Err(e) = result {
            tracing::warn!("Could not update the watch on {:?}: {}", path, e);
            if mode.is_some() {
                watched_dirs.all.remove(&path);
                watched_dirs.recursive.remove(&path);
            }
        }
    }
    if let Err(e) = paths.commit() {
        tracing::warn!("Could not apply watch updates: {}", e);
    }
}

/// Add a watch for a newly created directory
fn add_directory_watch(
    changes: &mut WatchChanges,
    watched_dirs: &mut WatchedDirs,
    dir_path: &Path,
    gi: &Gitignore,
    canonical_root: &Path,
) {
    let canonical_dir = canonicalize_lossy(dir_path);

    if !path_allowed(&canonical_dir, gi, canonical_root) {
        return;
    }

    if watched_dirs.contains(&canonical_dir) || watched_dirs.has_recursive_cover(&canonical_dir) {
        return;
    }

    let mode = determine_watch_mode(&canonical_dir, gi, canonical_root);

    changes.push((canonical_dir.clone(), Some(mode)));
    if matches!(mode, RecursiveMode::Recursive) {
        watched_dirs.remove_children_only(&canonical_dir, |child| {
            changes.push((child.to_path_buf(), None));
        });
    }
    watched_dirs.insert(canonical_dir, mode);
}

/// Remove a watch for a deleted directory
fn remove_directory_watch(
    changes: &mut WatchChanges,
    watched_dirs: &mut WatchedDirs,
    dir_path: &Path,
) {
    let canonical_dir = canonicalize_lossy(dir_path);

    watched_dirs.remove_dir_and_children(&canonical_dir, |path| {
        changes.push((path.to_path_buf(), None));
    });
}

pub fn async_watcher(root: PathBuf) -> Result<WatcherComponents, FilesystemWatcherError> {
    let canonical_root = canonicalize_lossy(&root);
    let gi_set = build_gitignore_set(&canonical_root)?;
    async_watcher_with_policy(canonical_root, gi_set, true, Arc::default())
}

/// Artifact discovery includes ignored output, but never installs watches in
/// dependency/cache trees. The diff watcher continues to respect Git ignores.
pub const ARTIFACT_SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    ".venv",
    "venv",
    "__pycache__",
    ".cache",
    ".next",
    ".nuxt",
    ".turbo",
    ".pnpm-store",
    ".mypy_cache",
    ".pytest_cache",
];

/// The flag is set when a burst drops events, which then name no paths.
pub fn artifact_watcher(
    root: PathBuf,
) -> Result<(WatcherComponents, Arc<std::sync::atomic::AtomicBool>), FilesystemWatcherError> {
    let root = dunce::canonicalize(root)?;
    let mut builder = GitignoreBuilder::new(&root);
    for name in ARTIFACT_SKIP_DIRS {
        builder.add_line(None, &format!("{name}/"))?;
    }
    let dropped = Arc::default();
    async_watcher_with_policy(root, builder.build()?, false, Arc::clone(&dropped))
        .map(|watcher| (watcher, dropped))
}

fn async_watcher_with_policy(
    canonical_root: PathBuf,
    gi_set: Gitignore,
    respect_gitignore: bool,
    dropped: Arc<std::sync::atomic::AtomicBool>,
) -> Result<WatcherComponents, FilesystemWatcherError> {
    let gi_set = Arc::new(gi_set);
    // NOTE: changes to .gitignore aren’t picked up until the watcher is rebuilt.
    // Recomputing on every change would require rebuilding the full watcher fleet.

    let (mut raw_tx, mut raw_rx) = channel::<DebounceEventResult>(64);
    let (mut filtered_tx, filtered_rx) = channel::<DebounceEventResult>(64);

    let gi_clone = gi_set.clone();
    let root_for_task = canonical_root.clone();

    // No file-id cache (Linux already runs without one): on macOS it stitches
    // a rename into its destination alone, so `a.txt` renamed to an ignored
    // `a.tmp` never reported `a.txt` leaving. It also walked every watched
    // file on setup.
    let debouncer = new_debouncer_opt::<_, EventTap, NoCache>(
        Duration::from_millis(200),
        None,
        move |res: DebounceEventResult| {
            if respect_gitignore {
                futures::executor::block_on(async {
                    raw_tx.send(res).await.ok();
                });
            } else if let Err(error) = raw_tx.try_send(res) {
                // Artifact observers refresh every output after a drop. Never
                // let a burst block the native watcher thread (and its
                // Drop/join) while a cancelled execution releases its receiver.
                if error.is_full() {
                    dropped.store(true, std::sync::atomic::Ordering::Relaxed);
                    tracing::warn!(
                        "Artifact watcher burst exceeded the live event buffer; next tick refreshes every artifact"
                    );
                }
            }
        },
        NoCache::new(),
        notify::Config::default(),
    )?;
    let mut feed = TAPPED_FEED
        .take()
        .expect("EventTap::new stores the debouncer's feed");
    let mut watcher = DebouncedWatcher {
        watcher: RecommendedWatcher::new(
            move |event| feed.handle_event(event),
            notify::Config::default(),
        )?,
        _debouncer: debouncer,
    };

    let mut watched = WatchedDirs::default();
    let changes = collect_watch_directories(&canonical_root, &gi_set, respect_gitignore)
        .into_iter()
        .map(|target| {
            watched.insert(target.path.clone(), target.recursive);
            (target.path, Some(target.recursive))
        })
        .collect();
    apply_watch_changes(&mut watcher.watcher, &mut watched, changes);

    let debouncer = Arc::new(Mutex::new(watcher));
    let debouncer_for_task = Arc::downgrade(&debouncer);

    std::thread::spawn(move || {
        while let Some(result) = futures::executor::block_on(async { raw_rx.next().await }) {
            let Some(debouncer_arc) = debouncer_for_task.upgrade() else {
                break;
            };

            match result {
                Ok(events) => {
                    let mut changes = WatchChanges::new();

                    for event in &events {
                        if event.kind.is_create() {
                            for path in &event.paths {
                                if path.is_dir() {
                                    add_directory_watch(
                                        &mut changes,
                                        &mut watched,
                                        path,
                                        &gi_clone,
                                        &root_for_task,
                                    );
                                }
                            }
                        } else if event.kind.is_remove() {
                            for path in &event.paths {
                                remove_directory_watch(&mut changes, &mut watched, path);
                            }
                        } else if let EventKind::Modify(ModifyKind::Name(mode)) = &event.kind {
                            match mode {
                                RenameMode::From => {
                                    for path in &event.paths {
                                        remove_directory_watch(&mut changes, &mut watched, path);
                                    }
                                }
                                RenameMode::To => {
                                    for path in &event.paths {
                                        if path.is_dir() {
                                            add_directory_watch(
                                                &mut changes,
                                                &mut watched,
                                                path,
                                                &gi_clone,
                                                &root_for_task,
                                            );
                                        }
                                    }
                                }
                                RenameMode::Both => {
                                    if let Some((from, rest)) = event.paths.split_first() {
                                        remove_directory_watch(&mut changes, &mut watched, from);

                                        if let Some(to) = rest.last()
                                            && to.is_dir()
                                        {
                                            add_directory_watch(
                                                &mut changes,
                                                &mut watched,
                                                to,
                                                &gi_clone,
                                                &root_for_task,
                                            );
                                        }
                                    }
                                }
                                RenameMode::Any | RenameMode::Other => {
                                    for path in &event.paths {
                                        remove_directory_watch(&mut changes, &mut watched, path);
                                    }

                                    for path in &event.paths {
                                        if path.is_dir() {
                                            add_directory_watch(
                                                &mut changes,
                                                &mut watched,
                                                path,
                                                &gi_clone,
                                                &root_for_task,
                                            );
                                        }
                                    }
                                }
                            }
                        }
                        // A moved/populated directory can arrive in one event.
                        // inotify needs descriptors for its descendants as well.
                        if !respect_gitignore
                            && !platform_supports_native_recursive()
                            && (event.kind.is_create()
                                || matches!(event.kind, EventKind::Modify(ModifyKind::Name(_))))
                        {
                            for directory in event.paths.iter().filter(|path| path.is_dir()) {
                                for target in collect_watch_directories(directory, &gi_clone, false)
                                {
                                    if !watched.contains(&target.path) {
                                        add_directory_watch(
                                            &mut changes,
                                            &mut watched,
                                            &target.path,
                                            &gi_clone,
                                            &root_for_task,
                                        );
                                    }
                                }
                            }
                        }
                    }

                    apply_watch_changes(
                        &mut debouncer_arc.lock().unwrap().watcher,
                        &mut watched,
                        changes,
                    );

                    let filtered_events: Vec<DebouncedEvent> = events
                        .into_iter()
                        .filter(|ev| debounced_should_forward(ev, &gi_set, &root_for_task))
                        .collect();

                    if !filtered_events.is_empty() {
                        futures::executor::block_on(async {
                            filtered_tx.send(Ok(filtered_events)).await.ok();
                        });
                    }
                }
                Err(errors) => {
                    futures::executor::block_on(async {
                        filtered_tx.send(Err(errors)).await.ok();
                    });
                }
            }
        }
    });

    Ok((WatcherGuard(Some(debouncer)), filtered_rx, canonical_root))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_gitignore_patterns_stay_in_their_directory() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        for dir in ["sub", "other/deep"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        std::fs::write(root.join(".gitignore"), "*.log\n").unwrap();
        std::fs::write(root.join("sub/.gitignore"), "# output\n*\n!keep.txt\n").unwrap();
        std::fs::write(root.join("other/.gitignore"), "/only-here\nbuild/\n").unwrap();

        let gi = build_gitignore_set(root).unwrap();
        let ignored = |path: &str| gi.matched_path_or_any_parents(path, false).is_ignore();

        assert!(!ignored("a.txt"));
        assert!(ignored("a.log"));
        assert!(ignored("sub/x.txt"));
        assert!(!ignored("sub/keep.txt"));
        assert!(ignored("other/only-here"));
        assert!(!ignored("only-here"));
        assert!(!ignored("other/deep/only-here"));
        assert!(ignored("other/deep/build/out.js"));
        assert!(!ignored("build/out.js"));
    }

    #[test]
    fn pathless_rescans_are_forwarded() {
        let tmp = tempfile::TempDir::new().unwrap();
        let gi = build_gitignore_set(tmp.path()).unwrap();
        let rescan = DebouncedEvent::new(
            notify::Event::new(EventKind::Other).set_flag(notify::event::Flag::Rescan),
            std::time::Instant::now(),
        );
        assert!(debounced_should_forward(&rescan, &gi, tmp.path()));
    }

    #[test]
    fn batched_watches_report_every_directory_including_new_ones() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        // `node_modules` keeps the root non-recursive, so `a` and `b` are
        // separate watches registered in one batch.
        for dir in ["node_modules", "a", "b"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        let ((_guard, mut events, _), _) = artifact_watcher(root.clone()).unwrap();
        let mut reported = |path: PathBuf| {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while std::time::Instant::now() < deadline {
                match events.try_recv() {
                    Ok(Ok(batch)) if batch.iter().any(|event| event.paths.contains(&path)) => {
                        return;
                    }
                    Ok(_) => {}
                    Err(_) => std::thread::sleep(Duration::from_millis(20)),
                }
            }
            panic!("no event for {path:?}");
        };
        std::fs::write(root.join("a/x.txt"), "x").unwrap();
        reported(root.join("a/x.txt"));
        std::fs::write(root.join("b/y.txt"), "y").unwrap();
        reported(root.join("b/y.txt"));
        // A new directory is watched before its creation is forwarded.
        std::fs::create_dir(root.join("c")).unwrap();
        reported(root.join("c"));
        std::fs::write(root.join("c/z.txt"), "z").unwrap();
        reported(root.join("c/z.txt"));
    }

    #[test]
    fn watch_changes_apply_in_one_commit_and_forget_failed_adds() {
        use notify::PathsMut;

        // FSEvents restarts its stream on every `watch`/`unwatch` call and
        // once per `paths_mut` commit.
        #[derive(Default)]
        struct Calls(Vec<&'static str>);
        impl Watcher for Calls {
            fn new<F: EventHandler>(_: F, _: notify::Config) -> notify::Result<Self> {
                Ok(Self::default())
            }
            fn watch(&mut self, _: &Path, _: RecursiveMode) -> notify::Result<()> {
                self.0.push("watch");
                Ok(())
            }
            fn unwatch(&mut self, _: &Path) -> notify::Result<()> {
                self.0.push("unwatch");
                Ok(())
            }
            fn paths_mut<'me>(&'me mut self) -> Box<dyn PathsMut + 'me> {
                Box::new(Batch(self))
            }
            fn kind() -> notify::WatcherKind {
                notify::WatcherKind::NullWatcher
            }
        }
        struct Batch<'a>(&'a mut Calls);
        impl PathsMut for Batch<'_> {
            fn add(&mut self, path: &Path, _: RecursiveMode) -> notify::Result<()> {
                self.0.0.push("add");
                if path.ends_with("gone") {
                    return Err(notify::Error::path_not_found());
                }
                Ok(())
            }
            fn remove(&mut self, _: &Path) -> notify::Result<()> {
                self.0.0.push("remove");
                Ok(())
            }
            fn commit(self: Box<Self>) -> notify::Result<()> {
                self.0.0.push("commit");
                Ok(())
            }
        }

        let mut watcher = Calls::default();
        let mut watched = WatchedDirs::default();
        let mut changes: WatchChanges = (0..968)
            .map(|i| {
                (
                    PathBuf::from(format!("/r/{i}")),
                    Some(RecursiveMode::NonRecursive),
                )
            })
            .collect();
        changes.push(("/r/gone".into(), Some(RecursiveMode::Recursive)));
        changes.push(("/r/old".into(), None));
        for (path, mode) in &changes {
            if let Some(mode) = mode {
                watched.insert(path.clone(), *mode);
            }
        }
        apply_watch_changes(&mut watcher, &mut watched, changes);
        let count = |name| watcher.0.iter().filter(|call| **call == name).count();
        assert_eq!(
            (count("add"), count("remove"), count("commit")),
            (969, 1, 1)
        );
        assert_eq!(count("watch") + count("unwatch"), 0);
        assert_eq!(watcher.0.last(), Some(&"commit"));
        assert!(watched.contains(Path::new("/r/0")) && watched.contains(Path::new("/r/967")));
        assert!(!watched.contains(Path::new("/r/gone")));
        // Nothing to change restarts nothing.
        apply_watch_changes(&mut watcher, &mut watched, Vec::new());
        assert_eq!(watcher.0.len(), 971);
    }

    #[test]
    fn release_never_waits_for_a_stuck_stop() {
        struct Stuck(mpsc::Receiver<()>, mpsc::Sender<()>);
        impl Drop for Stuck {
            fn drop(&mut self) {
                let _ = self.0.recv();
                let _ = self.1.send(());
            }
        }
        struct Released(mpsc::Sender<()>);
        impl Drop for Released {
            fn drop(&mut self) {
                let _ = self.0.send(());
            }
        }
        let (unblock, blocked) = mpsc::channel();
        let (dropped_tx, dropped) = mpsc::channel();
        let started = std::time::Instant::now();
        release_off_thread(Stuck(blocked, dropped_tx.clone()));
        release_off_thread(Released(dropped_tx));
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(dropped.recv_timeout(Duration::from_millis(100)).is_err());
        unblock.send(()).unwrap();
        // Releases queued behind the stuck stop run once it ends.
        for _ in 0..2 {
            dropped.recv_timeout(Duration::from_secs(5)).unwrap();
        }
    }
}
