//! Execution-owned discovery and immutable snapshots. The sidecar is the source
//! of truth; JsonPatch persistence and a mounted chat/diff view are not required.
use std::{
    collections::{BTreeMap, HashSet},
    fs::OpenOptions,
    io::Read,
    path::{Component, Path, PathBuf},
    time::{Duration, SystemTime},
};

use anyhow::{Context, Result, bail};
use executors::logs::{
    ActionType, FileChange, NormalizedEntry, NormalizedEntryType, ToolStatus,
    artifacts::{
        ArtifactBundle, ArtifactCandidate, ArtifactList, ArtifactReference, ArtifactResource,
        ArtifactStatus, decode_file_reference, entry_candidates, static_references,
    },
};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{
    file::FileService,
    filesystem_watcher::{ARTIFACT_SKIP_DIRS, WatcherComponents, artifact_watcher},
};

pub const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_EXECUTION_BYTES: u64 = 128 * 1024 * 1024;
const MAX_ARTIFACTS: usize = 256;
const MAX_SCAN_ENTRIES: usize = 50_000;

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
            },
            stored_hashes: HashSet::new(),
            bytes: 0,
            dirty: true,
            recovery: false,
        };
        observer.persist().await?;
        Ok(observer)
    }

    pub async fn recover(
        root: PathBuf,
        working_dir: PathBuf,
        workspace_id: Uuid,
        session_id: Uuid,
        execution_id: Uuid,
        file_service: FileService,
        entries: BTreeMap<usize, NormalizedEntry>,
    ) -> Result<()> {
        let root = dunce::canonicalize(&root).unwrap_or(root);
        let working_dir = dunce::canonicalize(&working_dir).unwrap_or(working_dir);
        let mut observer = Self {
            root,
            working_dir,
            baseline: BTreeMap::new(),
            watcher: None,
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
                    warnings: Vec::new(),
                },
                bundles: BTreeMap::new(),
            },
            stored_hashes: HashSet::new(),
            bytes: 0,
            dirty: true,
            recovery: true,
        };
        tokio::fs::create_dir_all(&observer.destination).await?;
        let mut recorded_writes = BTreeMap::new();
        for (index, entry) in entries {
            observer.observe_entry(index, &entry).await;
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
                        resources: Vec::new(),
                        warnings: vec!["Historical static dependencies were not preserved".into()],
                    },
                );
                observer.pending.remove(&path);
            }
        }
        observer.tick(true).await
    }

    fn add_file(&mut self, path: PathBuf, source_entry: Option<u32>) {
        let Ok(relative) = path.strip_prefix(&self.root) else {
            return;
        };
        let relative = relative.to_string_lossy().replace('\\', "/");
        let id = format!(
            "{:x}",
            Sha256::digest(format!("{}:file:{relative}", self.manifest.execution_id))
        );
        if let Some(existing) = self.manifest.list.artifacts.iter_mut().find(|a| a.id == id) {
            if source_entry.is_some() && existing.source_entry.is_none() {
                existing.source_entry = source_entry;
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
        for candidate in entry_candidates(entry).into_iter().take(MAX_ARTIFACTS) {
            match candidate {
                ArtifactCandidate::PreparingInline { name } => {
                    let id = format!(
                        "{:x}",
                        Sha256::digest(format!(
                            "{}:inline:{index}:{name}",
                            self.manifest.execution_id
                        ))
                    );
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
                        self.add_file(path, u32::try_from(index).ok());
                    }
                }
                ArtifactCandidate::Inline { name, content } => {
                    if content.len() as u64 > MAX_FILE_BYTES {
                        continue;
                    }
                    let id = format!(
                        "{:x}",
                        Sha256::digest(format!(
                            "{}:inline:{index}:{name}",
                            self.manifest.execution_id
                        ))
                    );
                    let hash = format!("{:x}", Sha256::digest(content.as_bytes()));
                    if self
                        .manifest
                        .list
                        .artifacts
                        .iter()
                        .any(|a| a.id == id && a.content_hash.as_ref() == Some(&hash))
                    {
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
                        source: "inline".into(),
                        content_hash: stored.as_ref().ok().cloned(),
                        size_bytes: content.len() as u32,
                        status: if stored.is_ok() {
                            ArtifactStatus::Ready
                        } else {
                            ArtifactStatus::Error
                        },
                        error: stored.err().map(|e| e.to_string()),
                    };
                    self.manifest.list.artifacts.retain(|a| a.id != id);
                    self.manifest.list.artifacts.push(artifact.clone());
                    self.manifest.bundles.insert(
                        id,
                        ArtifactBundle {
                            artifact,
                            resources: Vec::new(),
                            warnings: Vec::new(),
                        },
                    );
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
        let mut bundle = ArtifactBundle {
            artifact: artifact.clone(),
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
        let source_name = artifact.path.as_deref().unwrap_or(&artifact.name);
        let mut queue = vec![(source_name.to_string(), hash.clone(), 0)];
        let mut visited = HashSet::from([source_name.to_string()]);
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
        let mut changed = Vec::new();
        if let Some((_, receiver, _)) = &mut self.watcher {
            while let Ok(events) = receiver.try_recv() {
                if let Ok(events) = events {
                    changed.extend(events.into_iter().flat_map(|event| event.paths.clone()));
                }
            }
        }
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
                        self.add_file(path, None);
                    }
                }
            } else if !path
                .components()
                .any(|part| ARTIFACT_SKIP_DIRS.contains(&part.as_os_str().to_str().unwrap_or("")))
            {
                self.add_file(path, None);
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
                    self.add_file(path.clone(), None);
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
            self.dirty = true;
        }
        if self.recovery {
            for artifact in &mut self.manifest.list.artifacts {
                if artifact.path.is_some() && artifact.source != "recovered_log" {
                    artifact.source = "recovered_current".into();
                    artifact.error = Some(if artifact.content_hash.is_some() { "Original execution content was not preserved; this is the currently available file" } else { "Original content was not preserved and the source file is unavailable" }.into());
                }
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
        ArtifactObserver::recover(
            root.clone(),
            root.join("repo"),
            Uuid::new_v4(),
            session,
            execution,
            FileService::new(pool).unwrap(),
            BTreeMap::from([(1, write), (2, markdown)]),
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
        tokio::fs::remove_dir_all(utils::execution_logs::process_logs_session_dir(session))
            .await
            .unwrap();
    }
}
