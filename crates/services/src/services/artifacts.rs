//! Execution-owned discovery and immutable snapshots. The sidecar is the source
//! of truth; JsonPatch persistence and a mounted chat/diff view are not required.
use std::{
    collections::{BTreeMap, HashSet},
    fs::OpenOptions,
    io::Read,
    path::{Component, Path, PathBuf},
    time::{Duration, Instant, SystemTime},
};

use anyhow::{Context, Result, bail};
use executors::{
    executors::{SubagentLiveHandle, codex::Codex},
    logs::{
        ActionType, FileChange, NormalizedEntry, NormalizedEntryType, SubagentControlTarget,
        ToolStatus,
        artifacts::{
            ArtifactBundle, ArtifactCandidate, ArtifactList, ArtifactReference, ArtifactResource,
            ArtifactStatus, decode_file_reference, entry_candidates, static_references,
        },
    },
};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{
    file::FileService,
    filesystem_watcher::{ARTIFACT_SKIP_DIRS, WatcherComponents, artifact_watcher},
    subagent_transcript,
};

pub const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_EXECUTION_BYTES: u64 = 128 * 1024 * 1024;
const MAX_ARTIFACTS: usize = 256;
const MAX_SCAN_ENTRIES: usize = 50_000;
// ponytail: serialize rare legacy recovery; use per-execution locks if
// concurrent history recovery becomes a measured bottleneck.
pub static RECOVERY: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct ObservedSubagent {
    target: SubagentControlTarget,
    terminal: bool,
    saved_terminal: bool,
    last_read: Option<Instant>,
    content_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Stamp {
    len: u64,
    modified: Option<SystemTime>,
}

fn stamp(path: &Path) -> Option<Stamp> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    metadata.is_file().then(|| Stamp {
        len: metadata.len(),
        modified: metadata.modified().ok(),
    })
}

pub fn directory(session_id: Uuid, execution_id: Uuid) -> PathBuf {
    utils::execution_logs::process_log_file_path(session_id, execution_id)
        .with_extension("artifacts")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactManifest {
    pub version: u32,
    pub workspace_id: Uuid,
    pub session_id: Uuid,
    pub execution_id: Uuid,
    pub list: ArtifactList,
    pub bundles: BTreeMap<String, ArtifactBundle>,
    /// Child entry bindings survive a missing CLI transcript, including files
    /// also referenced by the parent or another child (one snapshot per file).
    #[serde(default)]
    pub transcripts: BTreeMap<String, BTreeMap<String, u32>>,
}

pub async fn load(session_id: Uuid, execution_id: Uuid) -> Result<Option<ArtifactManifest>> {
    let path = directory(session_id, execution_id).join("manifest.json");
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let manifest: ArtifactManifest = serde_json::from_slice(&bytes)?;
    if manifest.version != 1
        || manifest.session_id != session_id
        || manifest.execution_id != execution_id
    {
        bail!("Invalid artifact manifest scope or version");
    }
    Ok(Some(manifest))
}

/// After a restart, retain only bytes that were actually persisted. A missing
/// finalizer must never turn today's workspace content into yesterday's output.
pub async fn seal_interrupted(manifest: &mut ArtifactManifest) -> Result<()> {
    manifest.list.complete = true;
    manifest.list.warnings.push(
        "Execution ended without a final snapshot; showing the last preserved version".into(),
    );
    for artifact in &mut manifest.list.artifacts {
        if artifact.status == ArtifactStatus::Preparing {
            artifact.status = ArtifactStatus::Error;
            artifact.error = Some("Final content was not preserved".into());
        }
    }
    atomic_write(
        &directory(manifest.session_id, manifest.execution_id).join("manifest.json"),
        &serde_json::to_vec(manifest)?,
    )
    .await
}

fn scan(root: &Path) -> (BTreeMap<PathBuf, Stamp>, bool) {
    let mut files = BTreeMap::new();
    let entries = WalkBuilder::new(root)
        .hidden(false)
        .follow_links(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        .ignore(false)
        .parents(false)
        .filter_entry(|entry| {
            !entry.file_type().is_some_and(|ty| ty.is_dir())
                || !ARTIFACT_SKIP_DIRS.contains(&entry.file_name().to_str().unwrap_or(""))
        })
        .build();
    for (count, entry) in entries.enumerate() {
        if count >= MAX_SCAN_ENTRIES {
            return (files, true);
        }
        if let Ok(entry) = entry
            && let Some(value) = stamp(entry.path())
        {
            files.insert(entry.into_path(), value);
        }
    }
    (files, false)
}

/// Absolute paths are accepted only under this workspace. Every reference is
/// canonicalized, including the session working directory and symlink targets.
pub fn resolve_path(root: &Path, working_dir: &Path, path: &str) -> Result<PathBuf> {
    if path.contains('\0')
        || path.contains('\\')
        || path.contains("://")
        || path.starts_with("data:")
    {
        bail!("Unsupported file reference");
    }
    let path = Path::new(path);
    if path
        .components()
        .any(|part| matches!(part, Component::ParentDir))
    {
        bail!("Parent traversal is not allowed");
    }
    let root = dunce::canonicalize(root)?;
    let working_dir = dunce::canonicalize(working_dir)?;
    if !working_dir.starts_with(&root) {
        bail!("Working directory is outside workspace");
    }
    let path = dunce::canonicalize(working_dir.join(path))?;
    if !path.starts_with(&root) {
        bail!("File is outside workspace");
    }
    if !path.is_file() {
        bail!("Not a regular file");
    }
    Ok(path)
}

pub fn resolve_reference(root: &Path, working_dir: &Path, path: &str) -> Result<PathBuf> {
    if let Ok(path) = resolve_path(root, working_dir, path) {
        return Ok(path);
    }
    if path.contains('\0')
        || path.contains('\\')
        || path.contains("://")
        || path.contains(':') && !Path::new(path).is_absolute()
    {
        bail!("Unsupported file reference");
    }
    let reference = Path::new(path);
    if reference
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        bail!("Parent traversal is not allowed");
    }
    let candidate = working_dir.join(reference);
    if !candidate.starts_with(root) {
        bail!("File is outside workspace");
    }
    // Preserve a missing reference without granting access. Existing symlinks,
    // including dangling ones, must still pass canonical containment.
    let mut ancestor = candidate.as_path();
    while ancestor != root && std::fs::symlink_metadata(ancestor).is_err() {
        ancestor = ancestor.parent().context("Invalid file reference")?;
    }
    if ancestor.exists() || std::fs::symlink_metadata(ancestor).is_ok() {
        let canonical = dunce::canonicalize(ancestor)?;
        let root = dunce::canonicalize(root)?;
        if !canonical.starts_with(root) {
            bail!("File is outside workspace");
        }
    }
    Ok(candidate)
}

fn read_stable(root: &Path, path: &Path) -> Result<Vec<u8>> {
    let canonical = resolve_path(root, root, path.to_str().context("Invalid file name")?)?;
    let before = stamp(&canonical).context("Not a regular file")?;
    if before.len > MAX_FILE_BYTES {
        bail!("File exceeds 20 MiB snapshot limit");
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // A replacement with a symlink/FIFO must neither escape nor block the
        // execution finalizer before the post-open identity checks below.
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(&canonical)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        bail!("Not a regular file");
    }
    let mut data = Vec::new();
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut data)?;
    if data.len() as u64 > MAX_FILE_BYTES {
        bail!("File exceeds 20 MiB snapshot limit");
    }
    // Recheck after reading as writers may replace the file or an ancestor.
    if resolve_path(root, root, path.to_str().unwrap_or_default())? != canonical
        || stamp(&canonical).as_ref() != Some(&before)
        || data.len() as u64 != before.len
    {
        bail!("File is still changing");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let current = std::fs::metadata(&canonical)?;
        if metadata.dev() != current.dev() || metadata.ino() != current.ino() {
            bail!("File changed while reading");
        }
    }
    Ok(data)
}

fn mime(path: &str) -> String {
    match Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "mmd" | "mermaid" => "text/vnd.mermaid".to_string(),
        "md" | "markdown" => "text/markdown".to_string(),
        _ => mime_guess::from_path(path)
            .first_or_octet_stream()
            .to_string(),
    }
}

fn inline_id(execution: Uuid, scope: Option<&str>, index: usize, name: &str) -> String {
    // Preserve IDs already saved by the parent-only manifest format.
    let source = scope.map(|scope| format!("{scope}:")).unwrap_or_default();
    format!(
        "{:x}",
        Sha256::digest(format!("{execution}:inline:{source}{index}:{name}"))
    )
}

/// Map the same preserved bytes onto a transcript without trusting UI entry IDs
/// or adding the child's ordinal to the parent conversation's namespace.
pub fn transcript_references<'a>(
    manifest: &ArtifactManifest,
    root: &Path,
    working: &Path,
    scope: &str,
    entries: impl IntoIterator<Item = (usize, &'a NormalizedEntry)>,
) -> Vec<ArtifactReference> {
    let root = dunce::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let working = dunce::canonicalize(working).unwrap_or_else(|_| working.to_path_buf());
    let mut references = Vec::new();
    let mut seen = HashSet::new();
    for (index, entry) in entries {
        for candidate in entry_candidates(entry) {
            let id = match candidate {
                ArtifactCandidate::File(path) => {
                    let Ok(path) = resolve_reference(&root, &working, &path) else {
                        continue;
                    };
                    let Ok(path) = path.strip_prefix(&root) else {
                        continue;
                    };
                    let relative = path.to_string_lossy().replace('\\', "/");
                    format!(
                        "{:x}",
                        Sha256::digest(format!("{}:file:{relative}", manifest.execution_id))
                    )
                }
                ArtifactCandidate::Inline { name, .. }
                | ArtifactCandidate::PreparingInline { name } => {
                    inline_id(manifest.execution_id, Some(scope), index, &name)
                }
                ArtifactCandidate::Url(url) => {
                    format!(
                        "{:x}",
                        Sha256::digest(format!("{}:url:{url}", manifest.execution_id))
                    )
                }
            };
            if let Some(artifact) = manifest
                .list
                .artifacts
                .iter()
                .find(|artifact| artifact.id == id)
                && seen.insert(id)
            {
                let mut artifact = artifact.clone();
                artifact.source_entry = u32::try_from(index).ok();
                references.push(artifact);
            }
        }
    }
    references
}

pub fn preserved_transcript_references(
    manifest: &ArtifactManifest,
    scope: &str,
) -> Vec<ArtifactReference> {
    manifest
        .list
        .artifacts
        .iter()
        .filter(|artifact| {
            manifest
                .transcripts
                .get(scope)
                .is_some_and(|ids| ids.contains_key(&artifact.id))
                || artifact.source_scope.as_deref() == Some(scope)
        })
        .cloned()
        .collect()
}

pub struct ArtifactObserver {
    root: PathBuf,
    working_dir: PathBuf,
    destination: PathBuf,
    baseline: BTreeMap<PathBuf, Stamp>,
    pending: HashSet<PathBuf>,
    watcher: Option<WatcherComponents>,
    manifest: ArtifactManifest,
    file_service: FileService,
    stored_hashes: HashSet<String>,
    bytes: u64,
    dirty: bool,
    recovery: bool,
    subagents: BTreeMap<String, ObservedSubagent>,
    subagent_handle: Option<SubagentLiveHandle>,
    codex: Option<Codex>,
    agent_session_id: Option<String>,
}

impl ArtifactObserver {
    pub async fn start(
        root: PathBuf,
        working_dir: PathBuf,
        workspace_id: Uuid,
        session_id: Uuid,
        execution_id: Uuid,
        file_service: FileService,
    ) -> Result<Self> {
        let root = dunce::canonicalize(root)?;
        let working_dir = dunce::canonicalize(working_dir)?;
        if !working_dir.starts_with(&root) {
            bail!("Working directory is outside workspace");
        }
        // Install first, then capture the baseline before spawning the agent.
        let watch_root = root.clone();
        let watcher = tokio::task::spawn_blocking(move || artifact_watcher(watch_root)).await?;
        let scan_root = root.clone();
        let (baseline, limited) = tokio::task::spawn_blocking(move || scan(&scan_root)).await?;
        let mut warnings = Vec::new();
        if let Err(error) = &watcher {
            warnings.push(format!("Live discovery unavailable: {error}"));
        }
        if limited {
            warnings.push("Workspace scan reached the 50000 entry limit".into());
        }
        let mut observer = Self {
            root,
            working_dir,
            baseline,
            watcher: watcher.ok(),
            pending: HashSet::new(),
            destination: directory(session_id, execution_id),
            file_service,
            manifest: ArtifactManifest {
                version: 1,
                workspace_id,
                session_id,
                execution_id,
                list: ArtifactList {
                    artifacts: Vec::new(),
                    complete: false,
                    warnings,
                },
                bundles: BTreeMap::new(),
                transcripts: BTreeMap::new(),
            },
            stored_hashes: HashSet::new(),
            bytes: 0,
            dirty: true,
            recovery: false,
            subagents: BTreeMap::new(),
            subagent_handle: None,
            codex: None,
            agent_session_id: None,
        };
        observer.persist().await?;
        Ok(observer)
    }

    #[allow(clippy::too_many_arguments)] // Keep workspace/session/execution ownership explicit.
    pub async fn recover(
        root: PathBuf,
        working_dir: PathBuf,
        workspace_id: Uuid,
        session_id: Uuid,
        execution_id: Uuid,
        file_service: FileService,
        entries: BTreeMap<usize, NormalizedEntry>,
        scope: Option<&str>,
    ) -> Result<ArtifactManifest> {
        let root = dunce::canonicalize(&root).unwrap_or(root);
        let working_dir = dunce::canonicalize(&working_dir).unwrap_or(working_dir);
        let previous = load(session_id, execution_id).await?;
        if let Some(manifest) = &previous {
            if manifest.workspace_id != workspace_id || !manifest.list.complete {
                bail!("Cannot recover into another workspace or an active execution");
            }
            if scope.is_none_or(|scope| manifest.transcripts.contains_key(scope)) {
                return Ok(manifest.clone());
            }
        }
        let mut observer = Self {
            root,
            working_dir,
            baseline: BTreeMap::new(),
            watcher: None,
            pending: HashSet::new(),
            destination: directory(session_id, execution_id),
            file_service,
            manifest: previous.unwrap_or_else(|| ArtifactManifest {
                version: 1,
                workspace_id,
                session_id,
                execution_id,
                list: ArtifactList {
                    artifacts: Vec::new(),
                    complete: false,
                    warnings: Vec::new(),
                },
                bundles: BTreeMap::new(),
                transcripts: BTreeMap::new(),
            }),
            stored_hashes: HashSet::new(),
            bytes: 0,
            dirty: true,
            recovery: true,
            subagents: BTreeMap::new(),
            subagent_handle: None,
            codex: None,
            agent_session_id: None,
        };
        tokio::fs::create_dir_all(&observer.destination).await?;
        // Count all previous versions, including blobs no longer referenced by
        // the latest manifest. Repeated child recovery cannot reset the budget.
        let mut stored = tokio::fs::read_dir(&observer.destination).await?;
        while let Some(file) = stored.next_entry().await? {
            let hash = file.file_name().to_string_lossy().into_owned();
            if hash.len() == 64
                && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
                && file.file_type().await?.is_file()
            {
                observer.bytes += file.metadata().await?.len();
                observer.stored_hashes.insert(hash);
            }
        }
        let preserved: HashSet<_> = observer
            .manifest
            .list
            .artifacts
            .iter()
            .map(|artifact| artifact.id.clone())
            .collect();
        let mut recorded_writes = BTreeMap::new();
        for (index, entry) in entries {
            observer.observe_scoped_entry(index, &entry, scope).await;
            if let NormalizedEntryType::ToolUse {
                action_type: ActionType::FileEdit { path, changes },
                status: ToolStatus::Success,
                ..
            } = &entry.entry_type
                && let Ok(path) = resolve_reference(&observer.root, &observer.working_dir, path)
            {
                recorded_writes.remove(&path);
                if let Some(FileChange::Write { content }) = changes.last() {
                    recorded_writes.insert(path, content.clone());
                }
            }
        }
        for (path, content) in recorded_writes {
            let relative = path
                .strip_prefix(&observer.root)?
                .to_string_lossy()
                .replace('\\', "/");
            let Some(index) = observer
                .manifest
                .list
                .artifacts
                .iter()
                .position(|artifact| artifact.path.as_deref() == Some(&relative))
            else {
                continue;
            };
            if preserved.contains(&observer.manifest.list.artifacts[index].id) {
                continue;
            }
            if let Ok(hash) = observer.store(content.as_bytes(), &relative).await {
                let artifact = &mut observer.manifest.list.artifacts[index];
                artifact.content_hash = Some(hash);
                artifact.size_bytes = content.len() as u32;
                artifact.status = ArtifactStatus::Ready;
                artifact.source = "recovered_log".into();
                artifact.error = None;
                observer.manifest.bundles.insert(
                    artifact.id.clone(),
                    ArtifactBundle {
                        artifact: artifact.clone(),
                        base_path: None,
                        resources: Vec::new(),
                        warnings: vec!["Historical static dependencies were not preserved".into()],
                    },
                );
                observer.pending.remove(&path);
            }
        }
        if let Some(scope) = scope {
            observer
                .manifest
                .transcripts
                .entry(scope.to_string())
                .or_default();
        }
        observer.tick(true).await?;
        Ok(observer.manifest)
    }

    fn add_file(&mut self, path: PathBuf, source_entry: Option<u32>, scope: Option<&str>) {
        let Ok(relative) = path.strip_prefix(&self.root) else {
            return;
        };
        let relative = relative.to_string_lossy().replace('\\', "/");
        let id = format!(
            "{:x}",
            Sha256::digest(format!("{}:file:{relative}", self.manifest.execution_id))
        );
        if let Some(existing) = self.manifest.list.artifacts.iter_mut().find(|a| a.id == id) {
            if self.recovery {
                return;
            }
            if source_entry.is_some()
                && (existing.source_entry.is_none()
                    || scope.is_none() && existing.source_scope.is_some())
            {
                existing.source_entry = source_entry;
                existing.source_scope = scope.map(str::to_string);
                existing.source = "tool_or_message".into();
                self.dirty = true;
            }
        } else if self.manifest.list.artifacts.len() < MAX_ARTIFACTS {
            self.manifest.list.artifacts.push(ArtifactReference {
                id,
                execution_id: self.manifest.execution_id.to_string(),
                name: relative.clone(),
                mime: mime(&relative),
                path: Some(relative),
                url: None,
                source_entry,
                source_scope: scope.map(str::to_string),
                source: if source_entry.is_some() {
                    "tool_or_message"
                } else {
                    "workspace_observation"
                }
                .into(),
                content_hash: None,
                size_bytes: 0,
                status: ArtifactStatus::Preparing,
                error: None,
            });
            self.dirty = true;
        } else {
            self.warn("Execution reached the 256 artifact limit");
            return;
        }
        self.pending.insert(path);
    }

    fn warn(&mut self, message: &str) {
        if !self.manifest.list.warnings.iter().any(|s| s == message) {
            self.manifest.list.warnings.push(message.into());
            self.dirty = true;
        }
    }

    pub async fn observe_entry(&mut self, index: usize, entry: &NormalizedEntry) {
        if let NormalizedEntryType::ToolUse {
            action_type:
                ActionType::TaskCreate {
                    control: Some(control),
                    ..
                },
            ..
        } = &entry.entry_type
            && control.can_open_transcript
            && !self.recovery
        {
            let scope = subagent_transcript::scope(&control.target);
            if let Some(child) = self.subagents.get_mut(&scope) {
                if child.target != control.target || child.terminal == control.can_stop {
                    child.target = control.target.clone();
                    child.terminal = !control.can_stop;
                    child.saved_terminal = false;
                    child.last_read = None;
                }
            } else if self.subagents.len() < 32 {
                self.subagents.insert(
                    scope,
                    ObservedSubagent {
                        target: control.target.clone(),
                        terminal: !control.can_stop,
                        saved_terminal: false,
                        last_read: None,
                        content_hash: None,
                    },
                );
            } else {
                self.warn("Subagent discovery reached the 32 transcript limit");
            }
        }
        self.observe_scoped_entry(index, entry, None).await;
    }

    pub fn set_subagent_runtime(
        &mut self,
        handle: Option<SubagentLiveHandle>,
        codex: Option<Codex>,
    ) {
        self.subagent_handle = handle;
        self.codex = codex;
    }

    pub fn set_agent_session_id(&mut self, id: &str) {
        self.agent_session_id = Some(id.to_string());
    }

    async fn collect_subagents(&mut self, complete: bool) {
        let working = self.working_dir.to_string_lossy();
        let reads = self
            .subagents
            .iter()
            .filter(|(_, child)| {
                !child.saved_terminal
                    && (complete
                        || child
                            .last_read
                            .is_none_or(|at| at.elapsed() >= Duration::from_secs(3)))
            })
            .map(|(scope, child)| {
                let read = subagent_transcript::read(
                    &child.target,
                    self.agent_session_id.as_deref(),
                    &working,
                    self.subagent_handle.as_ref(),
                    self.codex.as_ref(),
                );
                async move {
                    (
                        scope.clone(),
                        tokio::time::timeout(Duration::from_secs(5), read).await,
                    )
                }
            });
        // Reads share one deadline so a disconnected child cannot delay log
        // finalization by one timeout per transcript. No browser subscription.
        let results = futures::future::join_all(reads).await;
        for (scope, result) in results {
            let child = self.subagents.get_mut(&scope).unwrap();
            child.last_read = Some(Instant::now());
            match result {
                Ok(Ok((_, _, true))) => {
                    child.saved_terminal = true;
                    self.warn(
                        "Subagent transcript was truncated; retaining previously preserved results",
                    );
                }
                Ok(Ok((_, entries, false))) => {
                    let bytes = serde_json::to_vec(&entries).unwrap_or_default();
                    if bytes.len() > subagent_transcript::TRANSCRIPT_MAX_BYTES {
                        child.saved_terminal = true;
                        self.warn("Subagent transcript exceeds the 512 KiB preservation limit");
                        continue;
                    }
                    let hash = format!("{:x}", Sha256::digest(&bytes));
                    let changed = child.content_hash.as_ref() != Some(&hash);
                    child.saved_terminal = child.terminal || complete;
                    child.content_hash = Some(hash);
                    if changed {
                        for (index, entry) in entries.iter().enumerate() {
                            self.observe_scoped_entry(index, entry, Some(&scope)).await;
                        }
                    }
                }
                _ if complete => self.warn(
                    "A subagent transcript was unavailable; only preserved results are shown",
                ),
                _ => {}
            }
        }
    }

    async fn observe_scoped_entry(
        &mut self,
        index: usize,
        entry: &NormalizedEntry,
        scope: Option<&str>,
    ) {
        for candidate in entry_candidates(entry).into_iter().take(MAX_ARTIFACTS) {
            match candidate {
                ArtifactCandidate::PreparingInline { name } => {
                    let id = inline_id(self.manifest.execution_id, scope, index, &name);
                    if !self
                        .manifest
                        .list
                        .artifacts
                        .iter()
                        .any(|artifact| artifact.id == id)
                        && self.manifest.list.artifacts.len() < MAX_ARTIFACTS
                    {
                        self.manifest.list.artifacts.push(ArtifactReference {
                            id,
                            execution_id: self.manifest.execution_id.to_string(),
                            mime: mime(&name),
                            name,
                            path: None,
                            url: None,
                            source_entry: u32::try_from(index).ok(),
                            source_scope: scope.map(str::to_string),
                            source: "inline".into(),
                            content_hash: None,
                            size_bytes: 0,
                            status: ArtifactStatus::Preparing,
                            error: None,
                        });
                        self.dirty = true;
                    }
                }
                ArtifactCandidate::File(path) => {
                    if let Ok(path) = resolve_reference(&self.root, &self.working_dir, &path) {
                        self.add_file(path, u32::try_from(index).ok(), scope);
                    }
                }
                ArtifactCandidate::Inline { name, content } => {
                    if content.len() as u64 > MAX_FILE_BYTES {
                        continue;
                    }
                    let id = inline_id(self.manifest.execution_id, scope, index, &name);
                    let hash = format!("{:x}", Sha256::digest(content.as_bytes()));
                    if self.manifest.list.artifacts.iter().any(|a| {
                        a.id == id && (self.recovery || a.content_hash.as_ref() == Some(&hash))
                    }) {
                        continue;
                    }
                    if !self.manifest.list.artifacts.iter().any(|a| a.id == id)
                        && self.manifest.list.artifacts.len() >= MAX_ARTIFACTS
                    {
                        continue;
                    }
                    let stored = self.store(content.as_bytes(), &name).await;
                    let artifact = ArtifactReference {
                        id: id.clone(),
                        execution_id: self.manifest.execution_id.to_string(),
                        name: name.clone(),
                        mime: mime(&name),
                        path: None,
                        url: None,
                        source_entry: u32::try_from(index).ok(),
                        source_scope: scope.map(str::to_string),
                        source: if self.recovery && scope.is_some() { "recovered_transcript" } else { "inline" }.into(),
                        content_hash: stored.as_ref().ok().cloned(),
                        size_bytes: content.len() as u32,
                        status: if stored.is_ok() {
                            ArtifactStatus::Ready
                        } else {
                            ArtifactStatus::Error
                        },
                        error: stored.err().map(|e| e.to_string()).or_else(|| (self.recovery && scope.is_some()).then(|| "Original execution content was not preserved; recovered from the currently available subagent transcript".into())),
                    };
                    self.manifest.list.artifacts.retain(|a| a.id != id);
                    self.manifest.list.artifacts.push(artifact.clone());
                    let bundle = self.bundle_resources(artifact).await;
                    self.manifest.bundles.insert(id, bundle);
                    self.dirty = true;
                }
                ArtifactCandidate::Url(url) => {
                    let Ok(parsed) = url::Url::parse(&url) else {
                        continue;
                    };
                    if !parsed.username().is_empty() || parsed.password().is_some() {
                        continue;
                    }
                    let id = format!(
                        "{:x}",
                        Sha256::digest(format!("{}:url:{url}", self.manifest.execution_id))
                    );
                    if self.manifest.list.artifacts.iter().any(|a| a.id == id)
                        || self.manifest.list.artifacts.len() >= MAX_ARTIFACTS
                    {
                        continue;
                    }
                    self.manifest.list.artifacts.push(ArtifactReference {
                        id,
                        execution_id: self.manifest.execution_id.to_string(),
                        name: parsed.host_str().unwrap_or("Link").into(),
                        mime: "text/uri-list".into(),
                        path: None,
                        url: Some(url),
                        source_entry: u32::try_from(index).ok(),
                        source_scope: scope.map(str::to_string),
                        source: "remote_url".into(),
                        content_hash: None,
                        size_bytes: 0,
                        status: ArtifactStatus::Ready,
                        error: None,
                    });
                    self.dirty = true;
                }
            }
        }
        if let Some(scope) = scope {
            // Reuse the same candidate IDs as API replay, including shared files.
            for artifact in transcript_references(
                &self.manifest,
                &self.root,
                &self.working_dir,
                scope,
                [(index, entry)],
            ) {
                if let Some(index) = artifact.source_entry {
                    self.manifest
                        .transcripts
                        .entry(scope.to_string())
                        .or_default()
                        .insert(artifact.id, index);
                    self.dirty = true;
                }
            }
        }
    }

    /// Uses the existing attachment store/hash/size policy, then gives the
    /// execution its own hard link. Attachment GC cannot delete past results;
    /// session log cleanup removes snapshots together with their manifest.
    async fn store(&mut self, data: &[u8], name: &str) -> Result<String> {
        let hash = format!("{:x}", Sha256::digest(data));
        if self.stored_hashes.contains(&hash) {
            return Ok(hash);
        }
        if self.bytes + data.len() as u64 > MAX_EXECUTION_BYTES {
            bail!("Execution exceeds 128 MiB snapshot limit");
        }
        let cached = self.file_service.store_file(data, name).await?;
        let destination = self.destination.join(&hash);
        let source = self.file_service.get_absolute_path(&cached);
        // A global orphan cleanup may race the attachment write. Atomic copy
        // from the already bounded bytes is the fallback, never the live file.
        if tokio::fs::hard_link(source, &destination).await.is_err() {
            atomic_write(&destination, data).await?;
        }
        self.bytes += data.len() as u64;
        self.stored_hashes.insert(hash.clone());
        Ok(hash)
    }

    async fn snapshot(&mut self, path: &Path) -> Result<(String, u32)> {
        let root = self.root.clone();
        let source = path.to_path_buf();
        let bytes = tokio::task::spawn_blocking(move || read_stable(&root, &source)).await??;
        let hash = self
            .store(
                &bytes,
                path.file_name().and_then(|s| s.to_str()).unwrap_or("file"),
            )
            .await?;
        Ok((hash, bytes.len() as u32))
    }

    async fn bundle_resources(&mut self, artifact: ArtifactReference) -> ArtifactBundle {
        let source_name = artifact.path.clone().unwrap_or_else(|| {
            self.working_dir
                .strip_prefix(&self.root)
                .unwrap_or(Path::new(""))
                .join(&artifact.name)
                .to_string_lossy()
                .replace('\\', "/")
        });
        let mut bundle = ArtifactBundle {
            artifact: artifact.clone(),
            base_path: Some(source_name.clone()),
            resources: Vec::new(),
            warnings: Vec::new(),
        };
        if !matches!(
            artifact.mime.as_str(),
            "text/html" | "image/svg+xml" | "text/css"
        ) {
            return bundle;
        }
        let Some(hash) = artifact.content_hash.as_ref() else {
            return bundle;
        };
        if self.recovery {
            bundle
                .warnings
                .push("Historical static dependencies were not preserved".into());
            return bundle;
        }
        let mut queue = vec![(source_name.clone(), hash.clone(), 0)];
        let mut visited = HashSet::from([source_name]);
        let mut bytes = artifact.size_bytes as u64;
        while let Some((name, hash, depth)) = queue.pop() {
            let Ok(text) = tokio::fs::read_to_string(self.destination.join(hash)).await else {
                continue;
            };
            for reference in static_references(&name, &text) {
                if reference.starts_with('#') || reference.starts_with("data:") {
                    continue;
                }
                if reference.contains(':') || reference.starts_with('/') || reference.contains('\\')
                {
                    bundle
                        .warnings
                        .push("External or absolute dependencies are not loaded".into());
                    continue;
                }
                let Some(reference) =
                    decode_file_reference(reference.split(['?', '#']).next().unwrap_or_default())
                else {
                    continue;
                };
                let path = self
                    .root
                    .join(Path::new(&name).parent().unwrap_or(Path::new("")))
                    .join(&reference);
                let path = match dunce::canonicalize(&path) {
                    Ok(path) if path.starts_with(&self.root) => path,
                    _ => {
                        bundle
                            .warnings
                            .push(format!("Missing or disallowed dependency: {reference}"));
                        continue;
                    }
                };
                let relative = path
                    .strip_prefix(&self.root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                if !visited.insert(relative.clone()) {
                    continue;
                }
                let resource_mime = mime(&relative);
                if !matches!(
                    resource_mime.as_str(),
                    "text/css"
                        | "text/javascript"
                        | "application/javascript"
                        | "image/png"
                        | "image/jpeg"
                        | "image/gif"
                        | "image/webp"
                        | "image/svg+xml"
                        | "image/bmp"
                        | "image/x-icon"
                        | "image/vnd.microsoft.icon"
                ) {
                    bundle
                        .warnings
                        .push(format!("Unsupported static dependency: {relative}"));
                    continue;
                }
                if depth >= 4
                    || bundle.resources.len() >= 32
                    || bytes + stamp(&path).map_or(MAX_FILE_BYTES, |s| s.len) > 40 * 1024 * 1024
                {
                    bundle.warnings.push(
                        "Static dependencies exceed the 32 file, 4 level or 40 MiB limit".into(),
                    );
                    continue;
                }
                match self.snapshot(&path).await {
                    Ok((hash, size)) => {
                        bytes += size as u64;
                        if resource_mime == "text/css" {
                            queue.push((relative.clone(), hash.clone(), depth + 1));
                        }
                        bundle.resources.push(ArtifactResource {
                            path: relative,
                            mime: resource_mime,
                            content_hash: hash,
                        });
                    }
                    Err(_) => bundle
                        .warnings
                        .push(format!("Dependency could not be preserved: {relative}")),
                }
            }
        }
        bundle.warnings.sort();
        bundle.warnings.dedup();
        bundle
    }

    pub async fn tick(&mut self, complete: bool) -> Result<()> {
        self.collect_subagents(complete).await;
        let mut changed = Vec::new();
        if let Some((_, receiver, _)) = &mut self.watcher {
            while let Ok(events) = receiver.try_recv() {
                if let Ok(events) = events {
                    changed.extend(events.into_iter().flat_map(|event| event.paths.clone()));
                }
            }
        }
        let resources_changed = !changed.is_empty();
        for path in changed {
            if !path.exists() {
                let deleted: Vec<_> = self
                    .manifest
                    .list
                    .artifacts
                    .iter()
                    .filter_map(|artifact| artifact.path.as_ref())
                    .map(|relative| self.root.join(relative))
                    .filter(|file| file.starts_with(&path))
                    .collect();
                if !deleted.is_empty() {
                    self.pending.extend(deleted);
                    continue;
                }
            }
            if path.is_dir() {
                let scan_path = path.clone();
                let (files, limited) =
                    tokio::task::spawn_blocking(move || scan(&scan_path)).await?;
                if limited {
                    self.warn("Directory scan reached the 50000 entry limit");
                }
                for (path, value) in files {
                    if self.baseline.get(&path) != Some(&value) {
                        self.add_file(path, None, None);
                    }
                }
            } else if !path
                .strip_prefix(&self.root)
                .unwrap_or(&path)
                .components()
                .any(|part| ARTIFACT_SKIP_DIRS.contains(&part.as_os_str().to_str().unwrap_or("")))
                && (self.baseline.get(&path) != stamp(&path).as_ref()
                    || !self.baseline.contains_key(&path))
            {
                self.add_file(path, None, None);
            }
        }
        if complete && !self.recovery {
            let root = self.root.clone();
            let (end, limited) = tokio::task::spawn_blocking(move || scan(&root)).await?;
            if limited {
                self.warn("Workspace scan reached the 50000 entry limit");
            }
            for (path, value) in &end {
                if self.baseline.get(path) != Some(value) {
                    self.add_file(path.clone(), None, None);
                }
            }
            for artifact in &self.manifest.list.artifacts {
                if let Some(path) = &artifact.path {
                    self.pending.insert(self.root.join(path));
                }
            }
        }
        for path in std::mem::take(&mut self.pending) {
            let relative = path
                .strip_prefix(&self.root)?
                .to_string_lossy()
                .replace('\\', "/");
            let Some(index) = self
                .manifest
                .list
                .artifacts
                .iter()
                .position(|a| a.path.as_ref() == Some(&relative))
            else {
                continue;
            };
            let recent = stamp(&path)
                .and_then(|s| s.modified)
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|elapsed| elapsed < Duration::from_millis(500));
            if recent && !complete {
                self.manifest.list.artifacts[index].status = ArtifactStatus::Preparing;
                self.pending.insert(path);
                self.dirty = true;
                continue;
            }
            match self.snapshot(&path).await {
                Ok((hash, size)) => {
                    let artifact = &mut self.manifest.list.artifacts[index];
                    artifact.content_hash = Some(hash);
                    artifact.size_bytes = size;
                    artifact.status = ArtifactStatus::Ready;
                    artifact.error = None;
                    let artifact = artifact.clone();
                    let bundle = self.bundle_resources(artifact).await;
                    self.manifest
                        .bundles
                        .insert(bundle.artifact.id.clone(), bundle);
                }
                Err(error) => {
                    let artifact = &mut self.manifest.list.artifacts[index];
                    artifact.status = if path.exists() {
                        ArtifactStatus::Error
                    } else {
                        ArtifactStatus::Missing
                    };
                    artifact.error = Some(error.to_string());
                }
            }
            if self.recovery {
                let artifact = &mut self.manifest.list.artifacts[index];
                artifact.source = "recovered_current".into();
                artifact.error = Some(if artifact.content_hash.is_some() { "Original execution content was not preserved; this is the currently available file" } else { "Original content was not preserved and the source file is unavailable" }.into());
                if let Some(bundle) = self.manifest.bundles.get_mut(&artifact.id) {
                    bundle.artifact = artifact.clone();
                }
            }
            self.dirty = true;
        }
        if !self.recovery && (complete || resources_changed) {
            let artifacts = self
                .manifest
                .list
                .artifacts
                .iter()
                .filter(|artifact| artifact.content_hash.is_some())
                .cloned()
                .collect::<Vec<_>>();
            for artifact in artifacts {
                let bundle = self.bundle_resources(artifact).await;
                self.manifest
                    .bundles
                    .insert(bundle.artifact.id.clone(), bundle);
                self.dirty = true;
            }
        }
        if complete {
            for artifact in &mut self.manifest.list.artifacts {
                if artifact.status == ArtifactStatus::Preparing {
                    artifact.status = ArtifactStatus::Error;
                    artifact.error = Some(
                        "Execution ended before a stable complete result was available".into(),
                    );
                }
            }
            self.manifest.list.complete = true;
            self.dirty = true;
            self.watcher.take();
        }
        self.persist().await
    }

    async fn persist(&mut self) -> Result<()> {
        if self.dirty {
            tokio::fs::create_dir_all(&self.destination).await?;
            atomic_write(
                &self.destination.join("manifest.json"),
                &serde_json::to_vec(&self.manifest)?,
            )
            .await?;
            self.dirty = false;
        }
        Ok(())
    }
}

async fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    use tokio::io::AsyncWriteExt;
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .await?;
    let result = async {
        file.write_all(bytes).await?;
        file.sync_all().await?;
        tokio::fs::rename(&temporary, path).await?;
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_includes_ignored_files_and_rejects_escape() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(root.join("reports")).unwrap();
        std::fs::create_dir_all(root.join("target")).unwrap();
        std::fs::write(root.join(".gitignore"), "reports/\n").unwrap();
        std::fs::write(root.join("reports/a.html"), "<html></html>").unwrap();
        std::fs::write(root.join("target/b.html"), "ignored").unwrap();
        let (files, limited) = scan(&root);
        assert!(!limited);
        assert!(files.contains_key(&root.join("reports/a.html")));
        assert!(!files.contains_key(&root.join("target/b.html")));
        assert!(resolve_path(&root, &root.join("reports"), "a.html").is_ok());
        assert!(resolve_path(&root, &root, "../secret").is_err());
        assert!(resolve_path(&root, &root, "file:///etc/passwd").is_err());
        assert!(resolve_path(&root, &root, root.join("reports/a.html").to_str().unwrap()).is_ok());
        assert!(resolve_path(&root, &root, "target/b.html").is_ok()); // explicit references are allowed
        let oversized = root.join("large.pdf");
        std::fs::File::create(&oversized)
            .unwrap()
            .set_len(MAX_FILE_BYTES + 1)
            .unwrap();
        assert!(read_stable(&root, &oversized).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc/passwd", root.join("escape.html")).unwrap();
            assert!(resolve_path(&root, &root, "escape.html").is_err());
            assert!(resolve_reference(&root, &root, "escape.html").is_err());
        }
    }

    #[tokio::test]
    async fn execution_discovers_ignored_shell_output_and_keeps_completed_bytes() {
        use executors::logs::{ActionType, NormalizedEntryType, ToolStatus};
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        std::fs::write(root.join(".gitignore"), "out/\n").unwrap();
        std::fs::create_dir(root.join("out")).unwrap();
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
        let files = FileService::new(pool).unwrap();
        let session = Uuid::new_v4();
        let execution = Uuid::new_v4();
        let mut observer = ArtifactObserver::start(
            root.clone(),
            root.clone(),
            Uuid::new_v4(),
            session,
            execution,
            files.clone(),
        )
        .await
        .unwrap();
        let html = b"<html><head><link rel=\"stylesheet\" href=\"style.css\"></head><body>saved</body></html>";
        std::fs::write(root.join("out/report.html"), html).unwrap();
        std::fs::write(root.join("out/style.css"), "body{color:blue}").unwrap();
        // No tool entry and no Changes/chat subscriber exists during discovery.
        tokio::time::sleep(Duration::from_millis(900)).await;
        observer.tick(false).await.unwrap();
        let live = load(session, execution).await.unwrap().unwrap();
        assert!(
            live.list
                .artifacts
                .iter()
                .any(|a| a.name == "out/report.html" && a.source == "workspace_observation")
        );
        let entry = NormalizedEntry {
            timestamp: None,
            entry_type: NormalizedEntryType::ToolUse {
                tool_name: "Write".into(),
                action_type: ActionType::FileRead {
                    path: "out/report.html".into(),
                },
                status: ToolStatus::Success,
            },
            content: String::new(),
            metadata: None,
        };
        observer.observe_entry(7, &entry).await;
        observer.tick(true).await.unwrap();
        drop(observer);
        let completed = load(session, execution).await.unwrap().unwrap();
        assert!(completed.list.complete);
        let outputs = completed
            .list
            .artifacts
            .iter()
            .filter(|a| a.name == "out/report.html")
            .collect::<Vec<_>>();
        assert_eq!(outputs.len(), 1);
        let artifact = outputs[0];
        assert_eq!(artifact.source_entry, Some(7));
        assert_eq!(artifact.status, ArtifactStatus::Ready);
        assert_eq!(completed.bundles[&artifact.id].resources.len(), 1);
        std::fs::write(root.join("out/report.html"), "changed after exit").unwrap();
        std::fs::remove_file(root.join("out/report.html")).unwrap();
        files.delete_orphaned_files().await.unwrap();
        let snapshot = directory(session, execution).join(artifact.content_hash.as_ref().unwrap());
        assert_eq!(std::fs::read(snapshot).unwrap(), html);
        tokio::fs::remove_dir_all(utils::execution_logs::process_logs_session_dir(session))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn legacy_replay_preserves_logged_write_and_reports_missing_current_content() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(root.join("repo/reports")).unwrap();
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
        let session = Uuid::new_v4();
        let execution = Uuid::new_v4();
        let original = "<html><body>original from Write log</body></html>";
        let write = NormalizedEntry {
            timestamp: None,
            metadata: None,
            content: String::new(),
            entry_type: NormalizedEntryType::ToolUse {
                tool_name: "Write".into(),
                status: ToolStatus::Success,
                action_type: ActionType::FileEdit {
                    path: "reports/deleted.html".into(),
                    changes: vec![FileChange::Write {
                        content: original.into(),
                    }],
                },
            },
        };
        let markdown = NormalizedEntry { timestamp: None, metadata: None, content: "[missing](reports/missing.pdf)\n```mermaid\ngraph TD\nA-->B\n```\n```html\n<html>unfinished".into(), entry_type: NormalizedEntryType::AssistantMessage };
        let workspace = Uuid::new_v4();
        let files = FileService::new(pool).unwrap();
        ArtifactObserver::recover(
            root.clone(),
            root.join("repo"),
            workspace,
            session,
            execution,
            files.clone(),
            BTreeMap::from([(1, write), (2, markdown)]),
            None,
        )
        .await
        .unwrap();
        let manifest = load(session, execution).await.unwrap().unwrap();
        assert!(manifest.list.complete);
        let logged = manifest
            .list
            .artifacts
            .iter()
            .find(|artifact| artifact.name.ends_with("deleted.html"))
            .unwrap();
        assert_eq!(logged.source, "recovered_log");
        assert_eq!(
            std::fs::read_to_string(
                directory(session, execution).join(logged.content_hash.as_ref().unwrap())
            )
            .unwrap(),
            original
        );
        let missing = manifest
            .list
            .artifacts
            .iter()
            .find(|artifact| artifact.name.ends_with("missing.pdf"))
            .unwrap();
        assert_eq!(missing.status, ArtifactStatus::Missing);
        assert!(missing.content_hash.is_none());
        assert!(
            manifest
                .list
                .artifacts
                .iter()
                .any(|artifact| artifact.mime == "text/vnd.mermaid"
                    && artifact.status == ArtifactStatus::Ready)
        );
        assert!(
            manifest
                .list
                .artifacts
                .iter()
                .any(|artifact| artifact.name == "block-1.html"
                    && artifact.status == ArtifactStatus::Error)
        );
        std::fs::write(root.join("repo/reports/deleted.html"), "changed today").unwrap();
        std::fs::write(root.join("repo/reports/missing.pdf"), "new file today").unwrap();
        let child = NormalizedEntry { timestamp: None, metadata: None, entry_type: NormalizedEntryType::AssistantMessage,
            content: "[existing](reports/deleted.html) [missing](reports/missing.pdf)\n```html\n<html><script src=\"today.js\"></script>child</html>\n```".into() };
        let recovered = ArtifactObserver::recover(
            root.clone(),
            root.join("repo"),
            workspace,
            session,
            execution,
            files.clone(),
            BTreeMap::from([(1, child.clone())]),
            Some("codex:legacy-child"),
        )
        .await
        .unwrap();
        for artifact in &manifest.list.artifacts {
            let after = recovered
                .list
                .artifacts
                .iter()
                .find(|saved| saved.id == artifact.id)
                .unwrap();
            assert_eq!(
                serde_json::to_value(after).unwrap(),
                serde_json::to_value(artifact).unwrap()
            );
        }
        let refs = preserved_transcript_references(&recovered, "codex:legacy-child");
        assert_eq!(refs.len(), 3);
        let inline = refs
            .iter()
            .find(|artifact| artifact.path.is_none())
            .unwrap();
        assert_eq!(inline.source, "recovered_transcript");
        assert!(
            inline
                .error
                .as_deref()
                .unwrap()
                .contains("currently available")
        );
        assert!(recovered.bundles[&inline.id].resources.is_empty());
        // Old versions still consume the execution budget on later recovery.
        std::fs::File::create(directory(session, execution).join("0".repeat(64)))
            .unwrap()
            .set_len(MAX_EXECUTION_BYTES)
            .unwrap();
        let limited = ArtifactObserver::recover(
            root.clone(),
            root.join("repo"),
            workspace,
            session,
            execution,
            files,
            BTreeMap::from([(
                1,
                NormalizedEntry {
                    content: "```mermaid\ngraph TD\nA-->new\n```".into(),
                    ..child
                },
            )]),
            Some("claude:other-child"),
        )
        .await
        .unwrap();
        let refs = preserved_transcript_references(&limited, "claude:other-child");
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].status, ArtifactStatus::Error);
        assert!(refs[0].error.as_deref().unwrap().contains("128 MiB"));
        tokio::fs::remove_dir_all(utils::execution_logs::process_logs_session_dir(session))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn scoped_inline_dependencies_and_concurrent_rename_survive_finalization() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let working = root.join("repo-a/nested");
        std::fs::create_dir_all(&working).unwrap();
        std::fs::create_dir_all(root.join("repo-b/out")).unwrap();
        std::fs::create_dir_all(root.join("target")).unwrap();
        std::fs::write(root.join("repo-b/.gitignore"), "out/\n").unwrap();
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
        let files = FileService::new(pool).unwrap();
        let workspace = Uuid::new_v4();
        let session = Uuid::new_v4();
        let execution = Uuid::new_v4();
        let other_session = Uuid::new_v4();
        let other_execution = Uuid::new_v4();
        let mut observer = ArtifactObserver::start(
            root.clone(),
            working.clone(),
            workspace,
            session,
            execution,
            files.clone(),
        )
        .await
        .unwrap();
        let mut concurrent = ArtifactObserver::start(
            root.clone(),
            root.clone(),
            workspace,
            other_session,
            other_execution,
            files.clone(),
        )
        .await
        .unwrap();
        let inline = NormalizedEntry { timestamp: None, metadata: None, entry_type: NormalizedEntryType::AssistantMessage,
            content: "```html\n<html><head><link rel=\"stylesheet\" href=\"style.css\"></head><body><script src=\"app.js\"></script>inline</body></html>\n```".into() };
        observer.observe_entry(3, &inline).await;
        observer
            .observe_scoped_entry(3, &inline, Some("codex:child-a"))
            .await;
        observer
            .observe_scoped_entry(3, &inline, Some("claude:child-b"))
            .await;
        // Dependencies may be created after a complete streamed code block.
        std::fs::write(
            working.join("style.css"),
            "@import 'cycle.css';body{color:blue}",
        )
        .unwrap();
        std::fs::write(working.join("cycle.css"), "@import 'style.css';").unwrap();
        std::fs::write(working.join("app.js"), "document.body.dataset.ready='true'").unwrap();
        std::fs::write(root.join("repo-b/out/old.html"), "<html>version one</html>").unwrap();
        observer.tick(false).await.unwrap();
        // A successful tool explicitly names a rename into an otherwise excluded directory.
        std::fs::rename(
            root.join("repo-b/out/old.html"),
            root.join("target/new.html"),
        )
        .unwrap();
        let rename = NormalizedEntry {
            timestamp: None,
            metadata: None,
            content: String::new(),
            entry_type: NormalizedEntryType::ToolUse {
                tool_name: "apply_patch".into(),
                status: ToolStatus::Success,
                action_type: ActionType::FileEdit {
                    path: root
                        .join("repo-b/out/old.html")
                        .to_string_lossy()
                        .into_owned(),
                    changes: vec![FileChange::Rename {
                        new_path: root.join("target/new.html").to_string_lossy().into_owned(),
                    }],
                },
            },
        };
        observer.observe_entry(9, &rename).await;
        std::fs::write(root.join("repo-b/out/shared.svg"), "<svg></svg>").unwrap();
        // Cancellation uses the same finalizer without needing any mounted UI.
        observer.tick(true).await.unwrap();
        concurrent.tick(true).await.unwrap();
        assert!(observer.watcher.is_none());
        let saved = load(session, execution).await.unwrap().unwrap();
        let inline_results = saved
            .list
            .artifacts
            .iter()
            .filter(|artifact| artifact.name == "block-0.html")
            .collect::<Vec<_>>();
        assert_eq!(inline_results.len(), 3);
        assert_eq!(
            inline_results
                .iter()
                .map(|artifact| &artifact.id)
                .collect::<HashSet<_>>()
                .len(),
            3
        );
        for artifact in inline_results {
            let bundle = &saved.bundles[&artifact.id];
            assert_eq!(
                bundle.base_path.as_deref(),
                Some("repo-a/nested/block-0.html")
            );
            assert_eq!(bundle.resources.len(), 3);
            assert!(
                bundle
                    .resources
                    .iter()
                    .all(|resource| resource.path.starts_with("repo-a/nested/"))
            );
        }
        let mapped =
            transcript_references(&saved, &root, &working, "codex:child-a", [(3, &inline)]);
        assert_eq!(mapped.len(), 1);
        assert_eq!(mapped[0].source_entry, Some(3));
        assert_eq!(mapped[0].source_scope.as_deref(), Some("codex:child-a"));
        assert!(
            saved
                .list
                .artifacts
                .iter()
                .any(
                    |artifact| artifact.path.as_deref() == Some("target/new.html")
                        && artifact.source_entry == Some(9)
                        && artifact.status == ArtifactStatus::Ready
                )
        );
        assert!(
            saved
                .list
                .artifacts
                .iter()
                .any(
                    |artifact| artifact.path.as_deref() == Some("repo-b/out/old.html")
                        && artifact.status == ArtifactStatus::Missing
                )
        );
        let other = load(other_session, other_execution).await.unwrap().unwrap();
        let observed = other
            .list
            .artifacts
            .iter()
            .find(|artifact| artifact.name == "repo-b/out/shared.svg")
            .unwrap();
        assert_eq!(observed.source, "workspace_observation");
        assert!(observed.source_entry.is_none());
        assert!(
            !other
                .list
                .artifacts
                .iter()
                .any(|artifact| artifact.name == "target/new.html")
        );
        let first = saved
            .list
            .artifacts
            .iter()
            .find(|artifact| artifact.name == observed.name)
            .unwrap();
        assert_ne!(first.id, observed.id);
        assert_eq!(first.content_hash, observed.content_hash);
        std::fs::remove_dir_all(&working).unwrap();
        files.delete_orphaned_files().await.unwrap();
        for bundle in saved.bundles.values() {
            for resource in &bundle.resources {
                assert!(
                    directory(session, execution)
                        .join(&resource.content_hash)
                        .is_file()
                );
            }
        }
        tokio::fs::remove_dir_all(utils::execution_logs::process_logs_session_dir(session))
            .await
            .unwrap();
        tokio::fs::remove_dir_all(utils::execution_logs::process_logs_session_dir(
            other_session,
        ))
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn child_collection_survives_missing_transcript_and_old_manifest_fields() {
        use executors::logs::SubagentControl;
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let transcript = tempfile::tempdir().unwrap();
        let task_file = transcript
            .path()
            .join("agent-session/subagents/agent-child.jsonl");
        std::fs::create_dir_all(task_file.parent().unwrap()).unwrap();
        std::fs::write(
            &task_file,
            include_str!(
                "../../../executors/tests/fixtures/artifacts/claude-2.1.258-subagent.jsonl"
            ),
        )
        .unwrap();
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
        let session = Uuid::new_v4();
        let execution = Uuid::new_v4();
        let mut observer = ArtifactObserver::start(
            root.clone(),
            root,
            Uuid::new_v4(),
            session,
            execution,
            FileService::new(pool).unwrap(),
        )
        .await
        .unwrap();
        observer.set_agent_session_id("agent-session");
        observer
            .observe_entry(
                2,
                &NormalizedEntry {
                    timestamp: None,
                    metadata: None,
                    content: String::new(),
                    entry_type: NormalizedEntryType::ToolUse {
                        tool_name: "Agent".into(),
                        status: ToolStatus::Success,
                        action_type: ActionType::TaskCreate {
                            description: "Counter example".into(),
                            subagent_type: None,
                            result: None,
                            last_activity: None,
                            duration_ms: None,
                            control: Some(SubagentControl {
                                can_open_transcript: true,
                                can_stop: false,
                                target: SubagentControlTarget::ClaudeCode {
                                    task_id: "child".into(),
                                    output_file: Some(task_file.to_string_lossy().into_owned()),
                                },
                            }),
                        },
                    },
                },
            )
            .await;
        observer.tick(true).await.unwrap();
        // A growing transcript eventually loses stable entry ordinals. Keep
        // captured results and stop repeatedly polling its oversized tail.
        std::fs::write(
            &task_file,
            " ".repeat(subagent_transcript::TRANSCRIPT_MAX_BYTES + 1),
        )
        .unwrap();
        observer
            .subagents
            .get_mut("claude:child")
            .unwrap()
            .saved_terminal = false;
        observer.tick(true).await.unwrap();
        assert!(observer.subagents["claude:child"].saved_terminal);
        std::fs::remove_file(&task_file).unwrap();
        let saved = load(session, execution).await.unwrap().unwrap();
        let refs = preserved_transcript_references(&saved, "claude:child");
        assert_eq!(refs.len(), 2);
        assert!(
            refs.iter()
                .all(|artifact| artifact.status == ArtifactStatus::Ready)
        );
        assert!(preserved_transcript_references(&saved, "claude:another-child").is_empty());
        assert!(saved.list.complete);
        // Optional additions must not prevent replaying the initial sidecar format.
        let mut old = serde_json::to_value(&saved).unwrap();
        old.as_object_mut().unwrap().remove("transcripts");
        for artifact in old["list"]["artifacts"].as_array_mut().unwrap() {
            artifact.as_object_mut().unwrap().remove("source_scope");
        }
        for bundle in old["bundles"].as_object_mut().unwrap().values_mut() {
            bundle.as_object_mut().unwrap().remove("base_path");
        }
        let legacy: ArtifactManifest = serde_json::from_value(old).unwrap();
        assert_eq!(legacy.list.artifacts.len(), 2);
        assert!(legacy.transcripts.is_empty());
        tokio::fs::remove_dir_all(utils::execution_logs::process_logs_session_dir(session))
            .await
            .unwrap();
    }
}
