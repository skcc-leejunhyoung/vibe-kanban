use std::{
    collections::{HashMap, HashSet},
    io,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::anyhow;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use command_group::AsyncGroupChild;
use db::{
    DBService,
    models::{
        coding_agent_turn::CodingAgentTurn,
        execution_process::{
            ExecutionContext, ExecutionProcess, ExecutionProcessRunReason, ExecutionProcessStatus,
        },
        execution_process_logs::ExecutionProcessLogs,
        execution_process_repo_state::ExecutionProcessRepoState,
        merge::{Merge, MergeStatus},
        pending_rate_limit_resume::PendingRateLimitResume,
        repo::Repo,
        scratch::{Scratch, ScratchType},
        session::{CreateSession, Session},
        session_message_index::SessionMessageIndex,
        vibe_run::VibeRun,
        workspace::Workspace,
        workspace_repo::WorkspaceRepo,
    },
};
use deployment::DeploymentError;
use executors::{
    actions::{
        Executable, ExecutorAction, ExecutorActionType,
        coding_agent_follow_up::CodingAgentFollowUpRequest,
        coding_agent_initial::CodingAgentInitialRequest,
    },
    approvals::{ExecutorApprovalService, NoopExecutorApprovalService},
    env::{ExecutionEnv, RepoContext},
    executors::{
        BaseCodingAgent, CancellationToken, ExecutorExitResult, ExecutorExitSignal,
        SubagentLiveHandle,
    },
    logs::{NormalizedEntryType, utils::patch::extract_normalized_entry_from_patch},
    profile::ExecutorConfig,
};
use futures::{FutureExt, TryStreamExt, stream::select};
use git::{GitService, GitServiceError};
use services::services::{
    approvals::{Approvals, executor_approvals::ExecutorApprovalBridge},
    config::{Config, DEFAULT_COMMIT_REMINDER_PROMPT},
    container::{ContainerError, ContainerLocks, ContainerRef, ContainerService},
    diff_stream::{self, DiffStreamHandle},
    events::EventService,
    file::FileService,
    notification::NotificationService,
    queued_message::{DrainHold, QueuedMessageService},
    remote_client::RemoteClient,
    remote_sync, session_message_indexer, vibe_orchestrator,
    vibe_orchestrator::{
        FinalizeInput, MergeOutcome, PostMergeAction, VibeAction, VibeBounds, VibePhase,
        VibeResult, decide_after_merge, decide_finalize_action, parse_vibe_result,
    },
    vibe_tags,
};
use tokio::{
    sync::{Notify, RwLock},
    task::JoinHandle,
};
use tokio_util::io::ReaderStream;
use utils::{
    log_msg::LogMsg,
    msg_store::MsgStore,
    text::{Utf8Decoder, git_branch_id, short_uuid, truncate_to_char_boundary},
};
use uuid::Uuid;
use workspace_manager::{RepoWorkspaceInput, WorkspaceError, WorkspaceManager};

use crate::{command, copy};

const WORKSPACE_TOUCH_DEBOUNCE: Duration = Duration::from_mins(2);
const GIB: u64 = 1024 * 1024 * 1024;
const DEFAULT_EXTRA_CARGO_CACHE_MAX_GIB: u64 = 60;
const DEFAULT_MIN_FREE_DISK_GIB: u64 = 40;

#[derive(Debug, Default, Clone, Copy)]
struct CargoCachePruneStats {
    removed_targets: usize,
    busy_targets: usize,
    removed_bytes: u64,
}

impl CargoCachePruneStats {
    fn merge(&mut self, other: Self) {
        self.removed_targets += other.removed_targets;
        self.busy_targets += other.busy_targets;
        self.removed_bytes = self.removed_bytes.saturating_add(other.removed_bytes);
    }
}

#[derive(Debug, Default)]
struct ExtraCargoCachePruneReport {
    configured_targets: usize,
    measured_targets: usize,
    total_bytes_before: u64,
    available_bytes_before: u64,
    pressure_triggered: bool,
    stats: CargoCachePruneStats,
}

#[derive(Debug, Default)]
struct DockerCachePruneReport {
    configured: bool,
    active_build: bool,
    succeeded: bool,
    summary: Option<String>,
}

/// A child's byte stream as log messages.
///
/// `ReaderStream` cuts on read boundaries, which land mid-character for
/// non-ASCII output. Decoding each chunk with `String::from_utf8_lossy` would
/// burn the straddling character into U+FFFD before anything downstream could
/// reassemble it, so carry the incomplete tail across chunks instead. A chunk
/// that is nothing but a held-back tail decodes to "" and is dropped rather
/// than pushed as an empty log message.
fn decoded_log_stream<R>(
    reader: R,
    wrap: fn(String) -> LogMsg,
) -> impl futures::Stream<Item = Result<LogMsg, io::Error>>
where
    R: tokio::io::AsyncRead,
{
    let mut decoder = Utf8Decoder::new();
    ReaderStream::new(reader)
        .map_ok(move |chunk| decoder.push(&chunk))
        .try_filter(|text| std::future::ready(!text.is_empty()))
        .map_ok(wrap)
}

fn path_size(path: &Path) -> io::Result<u64> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Ok(0);
    }
    if metadata.is_file() {
        return Ok(metadata.len());
    }
    if !metadata.is_dir() {
        return Ok(0);
    }

    let mut total = 0u64;
    let mut pending = vec![path.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            if file_type.is_dir() && !file_type.is_symlink() {
                pending.push(entry.path());
            } else if file_type.is_file() {
                total = total.saturating_add(entry.metadata()?.len());
            }
        }
    }
    Ok(total)
}

fn cargo_debug_size(target_dir: &Path) -> io::Result<Option<u64>> {
    match std::fs::symlink_metadata(target_dir) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => return Ok(None),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    }

    let debug_dir = target_dir.join("debug");
    match std::fs::symlink_metadata(&debug_dir) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => return Ok(None),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    }

    match std::fs::symlink_metadata(debug_dir.join(".cargo-lock")) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {}
        Ok(_) => return Ok(None),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    }

    let mut bytes = 0u64;
    for entry in std::fs::read_dir(debug_dir)? {
        let entry = entry?;
        if entry.file_name() != ".cargo-lock" {
            bytes = bytes.saturating_add(path_size(&entry.path())?);
        }
    }
    Ok(Some(bytes))
}

fn prune_cargo_debug_dir(target_dir: &Path) -> io::Result<CargoCachePruneStats> {
    let debug_dir = target_dir.join("debug");
    match std::fs::symlink_metadata(&debug_dir) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => return Ok(CargoCachePruneStats::default()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(CargoCachePruneStats::default());
        }
        Err(error) => return Err(error),
    };

    let lock_path = debug_dir.join(".cargo-lock");
    match std::fs::symlink_metadata(&lock_path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {}
        Ok(_) => return Ok(CargoCachePruneStats::default()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(CargoCachePruneStats::default());
        }
        Err(error) => return Err(error),
    };

    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&lock_path)?;
    match lock.try_lock() {
        Ok(()) => {}
        Err(std::fs::TryLockError::WouldBlock) => {
            return Ok(CargoCachePruneStats {
                busy_targets: 1,
                ..CargoCachePruneStats::default()
            });
        }
        Err(std::fs::TryLockError::Error(error)) => return Err(error),
    }

    let mut stats = CargoCachePruneStats::default();
    for entry in std::fs::read_dir(&debug_dir)? {
        let entry = entry?;
        if entry.file_name() == ".cargo-lock" {
            continue;
        }
        let path = entry.path();
        stats.removed_bytes = stats.removed_bytes.saturating_add(path_size(&path)?);
        let file_type = entry.file_type()?;
        let result = if file_type.is_dir() && !file_type.is_symlink() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        if let Err(error) = result
            && error.kind() != io::ErrorKind::NotFound
        {
            return Err(error);
        }
        stats.removed_targets = 1;
    }
    Ok(stats)
}

fn prune_stale_cargo_debug_caches(workspace_dir: &Path) -> io::Result<CargoCachePruneStats> {
    let mut pending = vec![workspace_dir.to_path_buf()];
    let mut stats = CargoCachePruneStats::default();
    while let Some(dir) = pending.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        for entry in entries {
            let entry = entry?;
            let file_type = entry.file_type()?;
            if !file_type.is_dir() || file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            match entry.file_name().to_str() {
                Some("target") => {
                    stats.merge(prune_cargo_debug_dir(&path)?);
                }
                Some(".git") | Some("node_modules") => {}
                _ => pending.push(path),
            }
        }
    }
    Ok(stats)
}

fn prune_extra_cargo_targets(
    target_dirs: Vec<PathBuf>,
    available_bytes: u64,
    max_total_bytes: u64,
    min_free_bytes: u64,
) -> io::Result<ExtraCargoCachePruneReport> {
    let mut report = ExtraCargoCachePruneReport {
        configured_targets: target_dirs.len(),
        available_bytes_before: available_bytes,
        ..ExtraCargoCachePruneReport::default()
    };
    let mut measured = Vec::new();
    for target_dir in target_dirs {
        if let Some(bytes) = cargo_debug_size(&target_dir)? {
            report.measured_targets += 1;
            report.total_bytes_before = report.total_bytes_before.saturating_add(bytes);
            measured.push((bytes, target_dir));
        }
    }

    let mut remaining_bytes = report.total_bytes_before;
    let mut estimated_available = available_bytes;
    report.pressure_triggered =
        remaining_bytes > max_total_bytes || estimated_available < min_free_bytes;
    if !report.pressure_triggered {
        return Ok(report);
    }

    measured.sort_unstable_by(|left, right| right.0.cmp(&left.0));
    for (_, target_dir) in measured {
        if remaining_bytes <= max_total_bytes && estimated_available >= min_free_bytes {
            break;
        }
        let stats = prune_cargo_debug_dir(&target_dir)?;
        remaining_bytes = remaining_bytes.saturating_sub(stats.removed_bytes);
        estimated_available = estimated_available.saturating_add(stats.removed_bytes);
        report.stats.merge(stats);
    }
    Ok(report)
}

fn checkout_cargo_target_dirs(current_dir: &Path, home_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut target_dirs = Vec::new();
    if let Some(root) = current_dir.ancestors().find(|candidate| {
        candidate
            .join("crates/local-deployment/Cargo.toml")
            .is_file()
            && candidate.join("npx-cli").is_dir()
    }) {
        target_dirs.extend([
            root.join("target"),
            root.join("crates/remote/target"),
            root.join("crates/relay-tunnel/target"),
        ]);
    }
    if let Some(home_dir) = home_dir {
        target_dirs.push(home_dir.join(".cache/vk-agents-target"));
    }
    target_dirs
}

fn configured_extra_cargo_target_dirs() -> Vec<PathBuf> {
    let current_dir = std::env::current_dir().unwrap_or_default();
    let home_dir = std::env::var_os("HOME").map(PathBuf::from);
    let mut target_dirs = checkout_cargo_target_dirs(&current_dir, home_dir.as_deref());
    if let Some(cargo_target_dir) = std::env::var_os("CARGO_TARGET_DIR").map(PathBuf::from) {
        target_dirs.push(cargo_target_dir);
    }
    if let Some(raw) = std::env::var_os("VIBE_KANBAN_EXTRA_CARGO_TARGET_DIRS") {
        target_dirs.extend(std::env::split_paths(&raw));
    }

    let mut seen = HashSet::new();
    target_dirs
        .into_iter()
        .filter(|path| {
            if !path.is_absolute() {
                tracing::warn!(path = %path.display(), "Ignoring relative Cargo cache target");
                return false;
            }
            seen.insert(path.clone())
        })
        .collect()
}

#[cfg(unix)]
fn docker_build_active() -> bool {
    std::process::Command::new("ps")
        .args(["-Ao", "command="])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .is_some_and(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .any(is_docker_build_command)
        })
}

#[cfg(not(unix))]
fn docker_build_active() -> bool {
    false
}

fn is_docker_build_command(command: &str) -> bool {
    let tokens: Vec<_> = command.split_whitespace().collect();
    tokens.iter().enumerate().any(|(index, token)| {
        let executable = Path::new(token)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(token);
        let args = &tokens[index + 1..];
        match executable {
            "docker" | "docker-compose" => args.iter().any(|arg| matches!(*arg, "build" | "bake")),
            "buildctl" => args.contains(&"build"),
            _ => false,
        }
    })
}

fn final_output_line(bytes: &[u8]) -> Option<String> {
    String::from_utf8_lossy(bytes)
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.chars().take(256).collect())
}

fn prune_docker_build_cache() -> DockerCachePruneReport {
    let Some(max_storage) =
        std::env::var_os("VIBE_KANBAN_DOCKER_CACHE_MAX_STORAGE").filter(|value| !value.is_empty())
    else {
        return DockerCachePruneReport::default();
    };
    if docker_build_active() {
        return DockerCachePruneReport {
            configured: true,
            active_build: true,
            ..DockerCachePruneReport::default()
        };
    }

    match std::process::Command::new("docker")
        .args(["buildx", "prune", "--force", "--max-used-space"])
        .arg(max_storage)
        .output()
    {
        Ok(output) => DockerCachePruneReport {
            configured: true,
            succeeded: output.status.success(),
            summary: final_output_line(if output.status.success() {
                &output.stdout
            } else {
                &output.stderr
            }),
            ..DockerCachePruneReport::default()
        },
        Err(error) => DockerCachePruneReport {
            configured: true,
            summary: Some(error.to_string()),
            ..DockerCachePruneReport::default()
        },
    }
}

fn gib_limit_from_env(name: &str, default_gib: u64) -> u64 {
    match std::env::var(name) {
        Ok(raw) => match raw.parse::<u64>().ok().and_then(|gib| gib.checked_mul(GIB)) {
            Some(bytes) => bytes,
            None => {
                tracing::warn!(name, value = raw, default_gib, "Ignoring invalid GiB limit");
                default_gib * GIB
            }
        },
        Err(_) => default_gib * GIB,
    }
}

#[cfg(unix)]
fn available_space(path: &Path) -> io::Result<u64> {
    let stats = nix::sys::statvfs::statvfs(path).map_err(io::Error::other)?;
    Ok(u64::from(stats.blocks_available()).saturating_mul(stats.fragment_size()))
}

#[cfg(not(unix))]
fn available_space(_path: &Path) -> io::Result<u64> {
    Ok(u64::MAX)
}

fn minimum_available_space(target_dirs: &[PathBuf]) -> u64 {
    // ponytail: configured targets normally share one local volume; use the
    // minimum observed free space until cross-volume cache policies are needed.
    target_dirs
        .iter()
        .filter(|path| path.exists())
        .filter_map(|path| available_space(path).ok())
        .min()
        .unwrap_or(u64::MAX)
}

/// Budget for the agent-image cache: content-addressed display copies of images
/// the agent viewed from outside a workspace. Nothing but chat rendering
/// references them and they no longer die with their worktree, so the cache
/// needs its own ceiling. An evicted image degrades its chat entry back to a
/// plain tool row.
const AGENT_IMAGE_CACHE_BUDGET_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Default, Clone, Copy)]
struct AgentImageCachePruneStats {
    removed_files: usize,
    removed_bytes: u64,
    retained_bytes: u64,
}

/// Drop the oldest cached agent images until the directory fits `budget_bytes`.
/// Only the `agent-` names the log normalizer writes are considered, so a file
/// that ended up here by other means is never deleted.
fn prune_agent_image_cache(dir: &Path, budget_bytes: u64) -> io::Result<AgentImageCachePruneStats> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        // Nothing cached yet is the common case, not a failure.
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(AgentImageCachePruneStats::default());
        }
        Err(error) => return Err(error),
    };

    let mut files = Vec::new();
    let mut total_bytes = 0u64;
    for entry in entries {
        let entry = entry?;
        if !entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with("agent-"))
        {
            continue;
        }
        let metadata = entry.metadata()?;
        if !metadata.is_file() {
            continue;
        }
        total_bytes = total_bytes.saturating_add(metadata.len());
        files.push((
            metadata.modified().unwrap_or(std::time::UNIX_EPOCH),
            metadata.len(),
            entry.path(),
        ));
    }

    let mut stats = AgentImageCachePruneStats {
        retained_bytes: total_bytes,
        ..AgentImageCachePruneStats::default()
    };
    if total_bytes <= budget_bytes {
        return Ok(stats);
    }

    // ponytail: content-hash names are written once and never rewritten, so
    // mtime orders by first sighting rather than last view. Good enough while
    // eviction is a rare ceiling; touch on serve if it starts evicting live
    // conversations.
    files.sort_by_key(|(modified, _, _)| *modified);
    for (_, len, path) in files {
        if stats.retained_bytes <= budget_bytes {
            break;
        }
        if std::fs::remove_file(&path).is_err() {
            continue;
        }
        stats.removed_files += 1;
        stats.removed_bytes = stats.removed_bytes.saturating_add(len);
        stats.retained_bytes = stats.retained_bytes.saturating_sub(len);
    }
    Ok(stats)
}

// Safety net for draining the stdout/stderr forwarder: normally the pipes EOF
// promptly once the child (and its process group) exit, but an orphaned child
// that inherited the pipe (e.g. an MCP server) can hold it open. Since the
// orphan SIGKILL only runs after this drain, cap the wait so a stuck pipe can
// never deadlock session finalization (and every follow-up gated behind it).
const FORWARDER_DRAIN_TIMEOUT: Duration = Duration::from_secs(60);

// Defensive upper bound on how long a follow-up will wait for the previous
// execution's session finalization to drain. The barrier normally opens within
// the drain window, but a narrow stop/exit-monitor interleaving could leave an
// execution registered without a matching ready. Cap the wait so a leaked
// registration degrades to a slightly stale follow-up instead of a permanent
// per-session hang.
const SESSION_READY_WAIT_TIMEOUT: Duration = Duration::from_secs(120);

// How long a stop lets the executor wind the agent down itself (Claude:
// interrupt → final result → exit) before the process group is signalled.
const GRACEFUL_STOP_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Default)]
struct SessionFinalizationBarrier {
    active: RwLock<HashMap<Uuid, HashSet<Uuid>>>,
    changed: Notify,
}

#[derive(Default)]
struct OutputPipelineBarrier {
    ready: RwLock<HashSet<Uuid>>,
    changed: Notify,
}

impl OutputPipelineBarrier {
    async fn mark_ready(&self, execution_id: Uuid) {
        self.ready.write().await.insert(execution_id);
        self.changed.notify_waiters();
    }

    async fn wait_until_ready(&self, execution_id: Uuid) {
        loop {
            let changed = self.changed.notified();
            if self.ready.read().await.contains(&execution_id) {
                return;
            }
            changed.await;
        }
    }

    async fn remove(&self, execution_id: Uuid) {
        self.ready.write().await.remove(&execution_id);
    }
}

impl SessionFinalizationBarrier {
    async fn mark_active(&self, session_id: Uuid, execution_id: Uuid) {
        self.active
            .write()
            .await
            .entry(session_id)
            .or_default()
            .insert(execution_id);
    }

    async fn mark_ready(&self, session_id: Uuid, execution_id: Uuid) {
        let mut active = self.active.write().await;
        if let Some(executions) = active.get_mut(&session_id) {
            executions.remove(&execution_id);
            if executions.is_empty() {
                active.remove(&session_id);
            }
        }
        drop(active);
        self.changed.notify_waiters();
    }

    async fn wait_until_ready(&self, session_id: Uuid) {
        loop {
            // Register before checking the map so a transition between the
            // check and await cannot be missed.
            let changed = self.changed.notified();
            if !self.active.read().await.contains_key(&session_id) {
                return;
            }
            changed.await;
        }
    }
}

#[derive(Clone)]
pub struct LocalContainerService {
    db: DBService,
    events: EventService,
    workspace_manager: WorkspaceManager,
    child_store: Arc<RwLock<HashMap<Uuid, Arc<RwLock<AsyncGroupChild>>>>>,
    cancellation_tokens: Arc<RwLock<HashMap<Uuid, CancellationToken>>>,
    /// Live per-process clients for individual subagent control; removed
    /// alongside the child handle so stops are rejected once the process died.
    subagent_handles: Arc<RwLock<HashMap<Uuid, SubagentLiveHandle>>>,
    msg_stores: Arc<RwLock<HashMap<Uuid, Arc<MsgStore>>>>,
    /// Tracks background tasks that stream logs to the database.
    /// When stopping execution, we await these to ensure logs are fully persisted.
    db_stream_handles: Arc<RwLock<HashMap<Uuid, JoinHandle<()>>>>,
    /// Tracks the fire-and-forget task forwarding child stdout/stderr into the
    /// MsgStore. Awaited at exit so post-completion log reads see all output.
    forwarder_handles: Arc<RwLock<HashMap<Uuid, JoinHandle<()>>>>,
    normalizer_handles: Arc<RwLock<HashMap<Uuid, Vec<JoinHandle<()>>>>>,
    exit_monitor_handles: Arc<RwLock<HashMap<Uuid, JoinHandle<()>>>>,
    output_pipeline: Arc<OutputPipelineBarrier>,
    session_finalization: Arc<SessionFinalizationBarrier>,
    deferred_finalizations: Arc<RwLock<HashMap<Uuid, DeferredFinalization>>>,
    workspace_touch_times: Arc<RwLock<HashMap<Uuid, Instant>>>,
    container_locks: ContainerLocks,
    session_start_locks: ContainerLocks,
    config: Arc<RwLock<Config>>,
    git: GitService,
    file_service: FileService,
    approvals: Approvals,
    queued_message_service: QueuedMessageService,
    notification_service: NotificationService,
    remote_client: Option<RemoteClient>,
}

/// Pure plan describing how `handle_execution_post_completion` should wrap up a
/// finished execution, separated from the DB/IO side effects so the terminal-turn
/// branching can be unit-tested. See [`LocalContainerService::plan_post_completion`].
#[derive(Debug, PartialEq)]
struct PostCompletionPlan {
    /// Run the chained next action (e.g. cleanup script / next coding step).
    start_next: bool,
    /// Emit the "skipping cleanup script - no changes" log (no-changes turn).
    log_skip_cleanup: bool,
    /// `Some(has_chained_follow_up)` => finalize via `finalize_with_queued_followup`,
    /// draining any queued follow-up. `None` => leave finalization to a later
    /// execution in the chain.
    finalize_with_queue: Option<bool>,
}

#[derive(Clone, Copy)]
struct DeferredFinalization {
    execution_process_id: Uuid,
    has_chained_follow_up: bool,
    keep_queue: bool,
}

impl LocalContainerService {
    #[allow(clippy::too_many_arguments)]
    pub async fn new(
        db: DBService,
        events: EventService,
        workspace_manager: WorkspaceManager,
        msg_stores: Arc<RwLock<HashMap<Uuid, Arc<MsgStore>>>>,
        config: Arc<RwLock<Config>>,
        git: GitService,
        file_service: FileService,
        approvals: Approvals,
        queued_message_service: QueuedMessageService,
        remote_client: Option<RemoteClient>,
    ) -> Self {
        let child_store = Arc::new(RwLock::new(HashMap::new()));
        let cancellation_tokens = Arc::new(RwLock::new(HashMap::new()));
        let subagent_handles = Arc::new(RwLock::new(HashMap::new()));
        let db_stream_handles = Arc::new(RwLock::new(HashMap::new()));
        let forwarder_handles = Arc::new(RwLock::new(HashMap::new()));
        let normalizer_handles = Arc::new(RwLock::new(HashMap::new()));
        let exit_monitor_handles = Arc::new(RwLock::new(HashMap::new()));
        let output_pipeline = Arc::new(OutputPipelineBarrier::default());
        let session_finalization = Arc::new(SessionFinalizationBarrier::default());
        let workspace_touch_times = Arc::new(RwLock::new(HashMap::new()));
        let container_locks = Arc::new(RwLock::new(HashMap::new()));
        let session_start_locks = Arc::new(RwLock::new(HashMap::new()));
        let notification_service =
            NotificationService::new(config.clone(), db.pool.clone(), remote_client.clone());

        let container = LocalContainerService {
            db,
            events,
            workspace_manager,
            child_store,
            cancellation_tokens,
            subagent_handles,
            msg_stores,
            db_stream_handles,
            forwarder_handles,
            normalizer_handles,
            exit_monitor_handles,
            output_pipeline,
            session_finalization,
            deferred_finalizations: Default::default(),
            workspace_touch_times,
            container_locks,
            session_start_locks,
            config,
            git,
            file_service,
            approvals,
            queued_message_service,
            notification_service,
            remote_client,
        };

        container.spawn_workspace_cleanup();

        container
    }

    fn map_workspace_manager_error(err: WorkspaceError) -> ContainerError {
        match err {
            WorkspaceError::Database(err) => ContainerError::Sqlx(err),
            WorkspaceError::Worktree(err) => ContainerError::Worktree(err),
            WorkspaceError::GitService(err) => ContainerError::GitServiceError(err),
            WorkspaceError::Io(err) => ContainerError::Io(err),
            WorkspaceError::NoRepositories => {
                ContainerError::Other(anyhow!("No repositories provided"))
            }
            WorkspaceError::Repo(err) => ContainerError::Other(anyhow!(err)),
            WorkspaceError::WorkspaceNotFound => {
                ContainerError::Other(anyhow!("Workspace not found"))
            }
            WorkspaceError::RepoAlreadyAttached => {
                ContainerError::Other(anyhow!("Repository already attached to workspace"))
            }
            WorkspaceError::BranchNotFound { repo_name, branch } => ContainerError::Other(anyhow!(
                "Branch '{}' does not exist in repository '{}'",
                branch,
                repo_name
            )),
            WorkspaceError::PartialCreation(msg) => ContainerError::Other(anyhow!(msg)),
        }
    }

    async fn workspace_repo_inputs(
        &self,
        workspace_id: Uuid,
    ) -> Result<(Vec<Repo>, Vec<RepoWorkspaceInput>), ContainerError> {
        let workspace_repos =
            WorkspaceRepo::find_by_workspace_id(&self.db.pool, workspace_id).await?;
        if workspace_repos.is_empty() {
            return Err(ContainerError::Other(anyhow!(
                "Workspace has no repositories configured"
            )));
        }

        let repositories =
            WorkspaceRepo::find_repos_for_workspace(&self.db.pool, workspace_id).await?;
        let target_branches: HashMap<_, _> = workspace_repos
            .iter()
            .map(|wr| (wr.repo_id, wr.target_branch.clone()))
            .collect();

        let workspace_inputs: Vec<RepoWorkspaceInput> = repositories
            .iter()
            .map(|repo| {
                let target_branch = target_branches.get(&repo.id).cloned().ok_or_else(|| {
                    ContainerError::Other(anyhow!(
                        "Missing target branch mapping for repo {} in workspace {}",
                        repo.id,
                        workspace_id
                    ))
                })?;
                Ok(RepoWorkspaceInput::new(repo.clone(), target_branch))
            })
            .collect::<Result<_, ContainerError>>()?;

        Ok((repositories, workspace_inputs))
    }

    async fn get_child_from_store(&self, id: &Uuid) -> Option<Arc<RwLock<AsyncGroupChild>>> {
        let map = self.child_store.read().await;
        map.get(id).cloned()
    }

    async fn add_child_to_store(&self, id: Uuid, exec: AsyncGroupChild) {
        let mut map = self.child_store.write().await;
        map.insert(id, Arc::new(RwLock::new(exec)));
    }

    async fn remove_child_from_store(&self, id: &Uuid) {
        let mut map = self.child_store.write().await;
        map.remove(id);
    }

    async fn add_cancellation_token(&self, id: Uuid, token: CancellationToken) {
        let mut map = self.cancellation_tokens.write().await;
        map.insert(id, token);
    }

    async fn add_subagent_handle(&self, id: Uuid, handle: SubagentLiveHandle) {
        let mut map = self.subagent_handles.write().await;
        map.insert(id, handle);
    }

    async fn remove_subagent_handle(&self, id: &Uuid) {
        let mut map = self.subagent_handles.write().await;
        map.remove(id);
    }

    async fn take_cancellation_token(&self, id: &Uuid) -> Option<CancellationToken> {
        let mut map = self.cancellation_tokens.write().await;
        map.remove(id)
    }

    async fn add_db_stream_handle(&self, id: Uuid, handle: JoinHandle<()>) {
        let mut map = self.db_stream_handles.write().await;
        map.insert(id, handle);
    }

    async fn take_db_stream_handle(&self, id: &Uuid) -> Option<JoinHandle<()>> {
        let mut map = self.db_stream_handles.write().await;
        map.remove(id)
    }

    async fn add_forwarder_handle(&self, id: Uuid, handle: JoinHandle<()>) {
        let mut map = self.forwarder_handles.write().await;
        map.insert(id, handle);
    }

    async fn take_forwarder_handle(&self, id: &Uuid) -> Option<JoinHandle<()>> {
        let mut map = self.forwarder_handles.write().await;
        map.remove(id)
    }

    async fn add_exit_monitor_handle(&self, id: Uuid, handle: JoinHandle<()>) {
        let mut map = self.exit_monitor_handles.write().await;
        map.insert(id, handle);
    }

    async fn take_exit_monitor_handle(&self, id: &Uuid) -> Option<JoinHandle<()>> {
        let mut map = self.exit_monitor_handles.write().await;
        map.remove(id)
    }

    /// Quarantine a workspace the automatic cleanup cannot safely evaluate.
    /// Returning `Ok` (rather than `Err`) is the point: the expiry query skips
    /// blocked workspaces, so this replaces a warning that repeated on every
    /// 30-minute pass with a single recorded reason the user can act on.
    async fn block_cleanup(
        &self,
        workspace: &Workspace,
        reason: &str,
    ) -> Result<(), ContainerError> {
        if Workspace::mark_cleanup_blocked(&self.db.pool, workspace.id, reason).await? {
            tracing::warn!(
                workspace_id = %workspace.id,
                reason,
                "Cannot verify uncommitted changes; excluding workspace from automatic cleanup. Delete it explicitly to reclaim the directory."
            );
        }
        Ok(())
    }

    async fn cleanup_workspace(
        &self,
        workspace: &Workspace,
        preserve_uncommitted: bool,
    ) -> Result<(), ContainerError> {
        // SAFETY: in-place ("quick chat") workspaces point `container_ref` at the
        // user's REAL checkout. Removing that directory or its branch here would
        // delete the user's repository, so cleanup is a strict no-op for them.
        // (They are also excluded from `find_expired_for_cleanup` up front.)
        if workspace.in_place {
            tracing::debug!(
                "Skipping cleanup for in-place workspace {} (real checkout at {:?})",
                workspace.id,
                workspace.container_ref
            );
            return Ok(());
        }

        let Some(container_ref) = &workspace.container_ref else {
            return Ok(());
        };
        let workspace_dir = PathBuf::from(container_ref);

        let repositories =
            WorkspaceRepo::find_repos_for_workspace(&self.db.pool, workspace.id).await?;

        if preserve_uncommitted {
            if repositories.is_empty() && workspace_dir.try_exists()? {
                return self
                    .block_cleanup(workspace, "repository metadata is missing")
                    .await;
            }
            for repo in &repositories {
                let path = workspace_dir.join(&repo.name);
                // A previous partial cleanup may already have removed this repo.
                if !path.try_exists()? {
                    continue;
                }
                // Git status includes both tracked changes and untracked files.
                // A failure here means the directory survived but is no longer a
                // usable worktree (pruned admin dir, moved main repo, partial
                // cleanup). We cannot tell whether work would be lost, so we
                // neither delete nor retry forever — we quarantine it.
                let status = match self.git().get_worktree_status(&path) {
                    Ok(status) => status,
                    Err(error) => {
                        return self
                            .block_cleanup(
                                workspace,
                                &format!("{} is not a readable git worktree: {error}", repo.name),
                            )
                            .await;
                    }
                };
                if !status.entries.is_empty() {
                    tracing::info!(workspace_id = %workspace.id, "Preserving workspace with uncommitted changes");
                    return Ok(());
                }
            }
        }

        if repositories.is_empty() {
            tracing::warn!(
                "No repositories found for workspace {}, cleaning up workspace directory only",
                workspace.id
            );
            if let Err(e) = tokio::fs::remove_dir_all(&workspace_dir).await
                && e.kind() != io::ErrorKind::NotFound
            {
                return Err(e.into());
            }
        } else {
            WorkspaceManager::cleanup_workspace(&workspace_dir, &repositories)
                .await
                .map_err(Self::map_workspace_manager_error)?;
        }

        Workspace::mark_worktree_deleted(&self.db.pool, workspace.id).await?;
        Ok(())
    }

    async fn cleanup_expired_workspaces(&self) -> Result<(), DeploymentError> {
        if std::env::var("DISABLE_WORKTREE_CLEANUP").is_ok() {
            tracing::info!(
                "Expired workspace cleanup is disabled via DISABLE_WORKTREE_CLEANUP environment variable"
            );
            return Ok(());
        }

        let build_cache_summary = Workspace::build_cache_cleanup_summary(&self.db.pool).await?;
        let expired_workspaces = Workspace::find_expired_for_cleanup(&self.db.pool, None).await?;
        let mut worktree_cleanup_failures = 0usize;
        let mut worktree_recheck_skips = 0usize;
        if expired_workspaces.is_empty() {
            tracing::debug!("No expired workspaces found");
        } else {
            tracing::info!(
                "Found {} expired workspaces to clean up",
                expired_workspaces.len()
            );
            for workspace in &expired_workspaces {
                // Earlier deletions may take time. Recheck activity and archive/pin
                // state immediately before touching this workspace's filesystem.
                let Some(current) =
                    Workspace::find_expired_for_cleanup(&self.db.pool, Some(workspace.id))
                        .await?
                        .pop()
                else {
                    worktree_recheck_skips += 1;
                    continue;
                };
                if let Err(error) = self.cleanup_workspace(&current, true).await {
                    worktree_cleanup_failures += 1;
                    tracing::warn!(
                        workspace_id = %current.id,
                        %error,
                        "Workspace cleanup failed; will retry on the next cleanup pass"
                    );
                }
            }
        }

        let stale_build_caches =
            Workspace::find_expired_for_build_cache_cleanup(&self.db.pool, None).await?;
        let mut workspace_cache_stats = CargoCachePruneStats::default();
        for workspace in &stale_build_caches {
            let Some(current) =
                Workspace::find_expired_for_build_cache_cleanup(&self.db.pool, Some(workspace.id))
                    .await?
                    .pop()
            else {
                continue;
            };
            let workspace_id = current.id;
            let Some(workspace_dir) = current.container_ref.map(PathBuf::from) else {
                continue;
            };
            match tokio::task::spawn_blocking(move || {
                prune_stale_cargo_debug_caches(&workspace_dir)
            })
            .await
            {
                Ok(Ok(stats)) => {
                    if stats.removed_targets > 0 || stats.busy_targets > 0 {
                        tracing::info!(
                            %workspace_id,
                            removed_debug_directories = stats.removed_targets,
                            busy_debug_directories = stats.busy_targets,
                            removed_bytes = stats.removed_bytes,
                            "Processed stale Cargo debug outputs"
                        );
                    }
                    workspace_cache_stats.merge(stats);
                }
                Ok(Err(error)) => tracing::warn!(
                    %workspace_id,
                    %error,
                    "Failed to remove stale Cargo debug outputs; will retry"
                ),
                Err(error) => tracing::warn!(
                    %workspace_id,
                    %error,
                    "Cargo debug cleanup task failed; will retry"
                ),
            }
        }

        let extra_target_dirs = configured_extra_cargo_target_dirs();
        let extra_target_count = extra_target_dirs.len();
        let available_bytes = minimum_available_space(&extra_target_dirs);
        let max_total_bytes = gib_limit_from_env(
            "VIBE_KANBAN_EXTRA_CARGO_CACHE_MAX_GIB",
            DEFAULT_EXTRA_CARGO_CACHE_MAX_GIB,
        );
        let min_free_bytes =
            gib_limit_from_env("VIBE_KANBAN_MIN_FREE_DISK_GIB", DEFAULT_MIN_FREE_DISK_GIB);
        let extra_report = if extra_target_dirs.is_empty() {
            ExtraCargoCachePruneReport::default()
        } else {
            match tokio::task::spawn_blocking(move || {
                prune_extra_cargo_targets(
                    extra_target_dirs,
                    available_bytes,
                    max_total_bytes,
                    min_free_bytes,
                )
            })
            .await
            {
                Ok(Ok(report)) => report,
                Ok(Err(error)) => {
                    tracing::warn!(%error, "Failed to process configured Cargo caches; will retry");
                    ExtraCargoCachePruneReport {
                        configured_targets: extra_target_count,
                        ..ExtraCargoCachePruneReport::default()
                    }
                }
                Err(error) => {
                    tracing::warn!(%error, "Configured Cargo cache cleanup task failed; will retry");
                    ExtraCargoCachePruneReport {
                        configured_targets: extra_target_count,
                        ..ExtraCargoCachePruneReport::default()
                    }
                }
            }
        };

        let docker_report = match tokio::task::spawn_blocking(prune_docker_build_cache).await {
            Ok(report) => report,
            Err(error) => {
                tracing::warn!(%error, "Docker build-cache cleanup task failed; will retry");
                DockerCachePruneReport::default()
            }
        };
        if docker_report.configured && !docker_report.active_build && !docker_report.succeeded {
            tracing::warn!(
                summary = ?docker_report.summary,
                "Docker build-cache cleanup failed; will retry"
            );
        }

        let agent_image_stats = match tokio::task::spawn_blocking(|| {
            prune_agent_image_cache(
                &utils::path::agent_image_cache_dir(),
                AGENT_IMAGE_CACHE_BUDGET_BYTES,
            )
        })
        .await
        {
            Ok(Ok(stats)) => stats,
            Ok(Err(error)) => {
                tracing::warn!(%error, "Agent image cache cleanup failed; will retry");
                AgentImageCachePruneStats::default()
            }
            Err(error) => {
                tracing::warn!(%error, "Agent image cache cleanup task failed; will retry");
                AgentImageCachePruneStats::default()
            }
        };

        tracing::info!(
            worktree_candidates = expired_workspaces.len(),
            worktree_recheck_skips,
            worktree_cleanup_failures,
            build_cache_total = build_cache_summary.total,
            build_cache_candidates = build_cache_summary.eligible,
            excluded_unmanaged = build_cache_summary.unmanaged,
            excluded_running = build_cache_summary.running,
            excluded_pinned = build_cache_summary.pinned,
            excluded_in_place = build_cache_summary.in_place,
            excluded_deleted = build_cache_summary.worktree_deleted,
            excluded_never_completed = build_cache_summary.never_completed,
            excluded_too_recent = build_cache_summary.too_recent,
            stale_cache_candidates = stale_build_caches.len(),
            extra_configured_targets = extra_report.configured_targets,
            extra_measured_targets = extra_report.measured_targets,
            extra_cache_bytes_before = extra_report.total_bytes_before,
            available_bytes_before = extra_report.available_bytes_before,
            extra_pressure_triggered = extra_report.pressure_triggered,
            docker_cache_configured = docker_report.configured,
            docker_build_active = docker_report.active_build,
            docker_cache_prune_succeeded = docker_report.succeeded,
            docker_cache_prune_summary = ?docker_report.summary,
            removed_debug_directories = workspace_cache_stats.removed_targets
                + extra_report.stats.removed_targets,
            busy_debug_directories = workspace_cache_stats.busy_targets
                + extra_report.stats.busy_targets,
            removed_bytes = workspace_cache_stats
                .removed_bytes
                .saturating_add(extra_report.stats.removed_bytes),
            agent_images_removed = agent_image_stats.removed_files,
            agent_image_bytes_removed = agent_image_stats.removed_bytes,
            agent_image_bytes_retained = agent_image_stats.retained_bytes,
            "Periodic workspace cleanup completed"
        );
        Ok(())
    }

    /// Delete any leftover ephemeral (spec-intake) workspaces from a prior run
    /// that crashed mid-generation. Keyed on the durable `ephemeral` flag, not a
    /// name, so it can never touch a real user workspace.
    async fn reap_ephemeral_workspaces(&self) {
        let ephemeral = match Workspace::find_ephemeral(&self.db.pool).await {
            Ok(ws) => ws,
            Err(e) => {
                tracing::warn!("Failed to query ephemeral workspaces for reaping: {}", e);
                return;
            }
        };
        for workspace in ephemeral {
            let workspace_id = workspace.id;
            match self
                .workspace_manager
                .load_managed_workspace(workspace)
                .await
            {
                Ok(managed) => match managed.prepare_deletion_context().await {
                    Ok(ctx) => {
                        if let Err(e) = managed.delete_record().await {
                            tracing::warn!(
                                "Failed to delete leftover ephemeral workspace {}: {}",
                                workspace_id,
                                e
                            );
                        }
                        WorkspaceManager::spawn_workspace_deletion_cleanup(ctx, true);
                        tracing::info!("Reaped leftover ephemeral workspace {}", workspace_id);
                    }
                    Err(e) => tracing::warn!(
                        "Failed to prepare deletion for ephemeral workspace {}: {}",
                        workspace_id,
                        e
                    ),
                },
                Err(e) => tracing::warn!(
                    "Failed to load ephemeral workspace {} for reaping: {}",
                    workspace_id,
                    e
                ),
            }
        }
    }

    fn spawn_workspace_cleanup(&self) {
        let container = self.clone();
        tokio::spawn(async move {
            // Reap leftover ephemeral workspaces first (after the orphan-execution
            // reconciliation that runs during server startup).
            container.reap_ephemeral_workspaces().await;

            container
                .workspace_manager
                .cleanup_orphan_workspaces()
                .await;

            let mut cleanup_interval =
                tokio::time::interval(tokio::time::Duration::from_secs(1800)); // 30 minutes
            loop {
                cleanup_interval.tick().await;
                tracing::info!("Starting periodic workspace cleanup...");
                container
                    .cleanup_expired_workspaces()
                    .await
                    .unwrap_or_else(|e| {
                        tracing::error!("Failed to clean up expired workspaces: {}", e)
                    });
            }
        });
    }

    /// Record the current HEAD commit for each repository as the "after" state.
    /// Errors are silently ignored since this runs after the main execution completes
    /// and failure should not block process finalization.
    async fn update_after_head_commits(&self, exec_id: Uuid) {
        if let Ok(ctx) = ExecutionProcess::load_context(&self.db.pool, exec_id).await {
            let workspace_root = self.workspace_to_current_dir(&ctx.workspace);
            for repo in &ctx.repos {
                let repo_path = workspace_root.join(&repo.name);
                if let Ok(head) = self.git().get_head_info(&repo_path) {
                    let _ = ExecutionProcessRepoState::update_after_head_commit(
                        &self.db.pool,
                        exec_id,
                        repo.id,
                        &head.oid,
                    )
                    .await;
                }
            }
        }
    }

    /// Get the commit message based on the execution run reason.
    async fn get_commit_message(&self, ctx: &ExecutionContext) -> String {
        match ctx.execution_process.run_reason {
            ExecutionProcessRunReason::CodingAgent => {
                // Try to retrieve the task summary from the coding agent turn
                // otherwise fallback to default message
                match CodingAgentTurn::find_by_execution_process_id(
                    &self.db().pool,
                    ctx.execution_process.id,
                )
                .await
                {
                    Ok(Some(turn)) if turn.summary.is_some() => {
                        // The summary is the agent's final message verbatim, which
                        // in a vibe run ends with the `VIBE_RESULT:` sentinel. Strip
                        // it so orchestration noise never lands in the commit; fall
                        // back to the default if nothing meaningful remains.
                        let cleaned =
                            vibe_orchestrator::strip_result_sentinel(&turn.summary.unwrap());
                        if cleaned.is_empty() {
                            format!(
                                "Commit changes from coding agent for workspace {}",
                                ctx.workspace.id
                            )
                        } else {
                            cleaned
                        }
                    }
                    Ok(_) => {
                        tracing::debug!(
                            "No summary found for execution process {}, using default message",
                            ctx.execution_process.id
                        );
                        format!(
                            "Commit changes from coding agent for workspace {}",
                            ctx.workspace.id
                        )
                    }
                    Err(e) => {
                        tracing::debug!(
                            "Failed to retrieve summary for execution process {}: {}",
                            ctx.execution_process.id,
                            e
                        );
                        format!(
                            "Commit changes from coding agent for workspace {}",
                            ctx.workspace.id
                        )
                    }
                }
            }
            ExecutionProcessRunReason::CleanupScript => {
                format!("Cleanup script changes for workspace {}", ctx.workspace.id)
            }
            _ => format!(
                "Changes from execution process {}",
                ctx.execution_process.id
            ),
        }
    }

    /// Check which repos have uncommitted changes. Fails if any repo is inaccessible.
    fn check_repos_for_changes(
        &self,
        workspace_root: &Path,
        repos: &[Repo],
    ) -> Result<Vec<(Repo, PathBuf)>, ContainerError> {
        let git = GitService::new();
        let mut repos_with_changes = Vec::new();

        for repo in repos {
            let worktree_path = workspace_root.join(&repo.name);

            match git.get_worktree_status(&worktree_path) {
                Ok(ws) if !ws.entries.is_empty() => {
                    repos_with_changes.push((repo.clone(), worktree_path));
                }
                Ok(_) => {
                    tracing::debug!("No changes in repo '{}'", repo.name);
                }
                Err(e) => {
                    return Err(ContainerError::Other(anyhow!(
                        "Pre-flight check failed for repo '{}': {}",
                        repo.name,
                        e
                    )));
                }
            }
        }

        Ok(repos_with_changes)
    }

    async fn has_commits_from_execution(
        &self,
        ctx: &ExecutionContext,
    ) -> Result<bool, ContainerError> {
        let workspace_root = self.workspace_to_current_dir(&ctx.workspace);

        let repo_states = ExecutionProcessRepoState::find_by_execution_process_id(
            &self.db.pool,
            ctx.execution_process.id,
        )
        .await?;

        for repo in &ctx.repos {
            let repo_path = workspace_root.join(&repo.name);
            let current_head = self.git().get_head_info(&repo_path).ok().map(|h| h.oid);

            let before_head = repo_states
                .iter()
                .find(|s| s.repo_id == repo.id)
                .and_then(|s| s.before_head_commit.clone());

            if current_head != before_head {
                return Ok(true);
            }
        }

        Ok(false)
    }

    /// Commit changes to each repo. Logs failures but continues with other repos.
    fn commit_repos(&self, repos_with_changes: Vec<(Repo, PathBuf)>, message: &str) -> bool {
        let mut any_committed = false;

        for (repo, worktree_path) in repos_with_changes {
            tracing::debug!(
                "Committing changes for repo '{}' at {:?}",
                repo.name,
                &worktree_path
            );

            match self.git().commit(&worktree_path, message) {
                Ok(true) => {
                    any_committed = true;
                    tracing::info!("Committed changes in repo '{}'", repo.name);
                }
                Ok(false) => {
                    tracing::warn!("No changes committed in repo '{}' (unexpected)", repo.name);
                }
                Err(e) => {
                    tracing::warn!("Failed to commit in repo '{}': {}", repo.name, e);
                }
            }
        }

        any_committed
    }

    /// Spawn a background task that polls the child process for completion and
    /// cleans up the execution entry when it exits. `drain_hold` is released
    /// once this process's completion handling is done, and the queue is then
    /// rechecked.
    fn spawn_exit_monitor(
        &self,
        exec_id: &Uuid,
        session_id: Uuid,
        exit_signal: Option<ExecutorExitSignal>,
        drain_hold: Option<DrainHold>,
    ) -> JoinHandle<()> {
        let exec_id = *exec_id;
        let child_store = self.child_store.clone();
        let msg_stores = self.msg_stores.clone();
        let db = self.db.clone();
        let container = self.clone();

        let mut process_exit_rx = self.spawn_os_exit_watcher(exec_id);

        tokio::spawn(async move {
            let mut exit_signal_future = exit_signal
                .map(|rx| rx.boxed()) // wait for result
                .unwrap_or_else(|| std::future::pending().boxed()); // no signal, stall forever

            let status_result: std::io::Result<std::process::ExitStatus>;
            let should_kill_process_group;

            // Wait for process to exit, or exit signal from executor
            tokio::select! {
                // Exit signal with result.
                // Some coding agent processes do not automatically exit after processing the user request; instead the executor
                // signals when processing has finished to gracefully kill the process.
                exit_result = &mut exit_signal_future => {
                    // Map the exit result to appropriate exit status
                    status_result = match exit_result {
                        Ok(ExecutorExitResult::Success) => Ok(success_exit_status()),
                        Ok(ExecutorExitResult::Failure) => Ok(failure_exit_status()),
                        Err(_) => Ok(success_exit_status()), // Channel closed, assume success
                    };
                    should_kill_process_group = true;
                }
                // Process exit
                exit_status_result = &mut process_exit_rx => {
                    status_result = exit_status_result.unwrap_or_else(|e| Err(std::io::Error::other(e)));
                    should_kill_process_group = false;
                }
            }

            let (exit_code, status) = match status_result {
                Ok(exit_status) => {
                    let code = exit_status.code().unwrap_or(-1) as i64;
                    let status = if exit_status.success() {
                        ExecutionProcessStatus::Completed
                    } else {
                        ExecutionProcessStatus::Failed
                    };
                    (Some(code), status)
                }
                Err(_) => (None, ExecutionProcessStatus::Failed),
            };

            // Terminal status is the UI boundary; session finalization is the
            // follow-up readiness boundary. Publish completion first so process
            // shutdown and final log draining do not keep the visible turn live.
            container
                .session_finalization
                .mark_active(session_id, exec_id)
                .await;
            let completion: Result<_, ContainerError> = async {
                if !ExecutionProcess::update_completion_if_running(
                    &db.pool, exec_id, status, exit_code,
                )
                .await?
                {
                    return Ok(None);
                }
                ExecutionProcess::find_by_id(&db.pool, exec_id)
                    .await?
                    .ok_or_else(|| {
                        ContainerError::Other(anyhow!(
                            "Execution process {exec_id} disappeared after completion"
                        ))
                    })
                    .map(Some)
            }
            .await;
            match completion {
                Ok(Some(process)) => {
                    if let Err(e) = container
                        .events
                        .publish_execution_process_update(&process)
                        .await
                    {
                        tracing::error!("Failed to publish execution process completion: {}", e);
                    }
                }
                Ok(None) => {}
                Err(e) => {
                    tracing::error!("Failed to update execution process completion: {}", e);
                }
            }

            if should_kill_process_group
                && let Some(child_lock) = child_store.read().await.get(&exec_id).cloned()
            {
                let mut child = child_lock.write().await;
                if let Err(err) = command::kill_process_group(&mut child).await {
                    tracing::error!(
                        "Failed to kill process group after exit signal: {} {}",
                        exec_id,
                        err
                    );
                }
            }

            // Drain the (otherwise detached) stdout/stderr forwarder into the
            // MsgStore before any post-completion step reads this process's logs
            // (turn summary, rate-limit detection, vibe cleanup-failure log).
            container.output_pipeline.wait_until_ready(exec_id).await;
            if let Some(forwarder) = container.take_forwarder_handle(&exec_id).await {
                let _ = tokio::time::timeout(FORWARDER_DRAIN_TIMEOUT, forwarder).await;
            }
            if let Some(msg_store) = msg_stores.read().await.get(&exec_id).cloned() {
                msg_store.push_finished();
            }
            for handle in container.take_normalizer_handles(&exec_id).await {
                let _ = handle.await;
            }

            // All derived metadata is now in MsgStore. Terminate and join the
            // independent storage consumer before opening the follow-up barrier.
            let db_stream_handle = container.take_db_stream_handle(&exec_id).await;
            if let Some(msg_store) = msg_stores.read().await.get(&exec_id).cloned() {
                msg_store.push(LogMsg::StorageFinished);
            }
            if let Some(handle) = db_stream_handle {
                let _ = handle.await;
            }
            container.output_pipeline.remove(exec_id).await;
            container
                .session_finalization
                .mark_ready(session_id, exec_id)
                .await;

            // Ephemeral workspaces (spec-intake) are throwaway: skip ALL normal
            // finalize side effects — session summary, rate-limit auto-resume,
            // commit, next-action, queued follow-ups, task finalize, vibe
            // orchestration, analytics, and remote sync. Completion status was
            // already persisted above, and the MsgStore/stream teardown below
            // still runs regardless (the spec-intake route reads the agent's
            // final message from the MsgStore before it is dropped).
            if let Ok(ctx) = ExecutionProcess::load_context(&db.pool, exec_id).await
                && !ctx.workspace.ephemeral
            {
                // Update executor session summary if available
                if let Err(e) = container.update_executor_session_summary(&exec_id).await {
                    tracing::warn!("Failed to update executor session summary: {}", e);
                }

                // Index this turn's conversation for MCP session search. The
                // normalizer handles were joined above, so the MsgStore
                // history is final at this point.
                if matches!(
                    ctx.execution_process.run_reason,
                    ExecutionProcessRunReason::CodingAgent
                ) {
                    let action = ctx.execution_process.executor_action().ok().cloned();
                    let store = msg_stores.read().await.get(&exec_id).cloned();
                    if let Some(store) = store {
                        let patches = store
                            .get_history()
                            .into_iter()
                            .filter_map(|msg| match msg {
                                LogMsg::JsonPatch(patch) => Some(patch),
                                _ => None,
                            })
                            .collect();
                        let rows =
                            session_message_indexer::index_rows_blocking(action, patches).await;
                        if let Err(e) = SessionMessageIndex::rebuild_for_execution(
                            &db.pool,
                            session_id,
                            exec_id,
                            ctx.execution_process.created_at,
                            &rows,
                        )
                        .await
                        {
                            tracing::warn!(
                                "Failed to index session messages for {}: {}",
                                exec_id,
                                e
                            );
                        }
                    }
                }

                // If this execution stopped because a usage rate limit was
                // reached and the session opted into auto-resume, schedule a
                // deferred "continue" follow-up for once the limit resets.
                let rate_limit_resume_scheduled =
                    match container.maybe_schedule_rate_limit_resume(&ctx).await {
                        Ok(scheduled) => scheduled,
                        Err(e) => {
                            tracing::warn!("Failed to schedule rate-limit auto-resume: {}", e);
                            false
                        }
                    };

                if !rate_limit_resume_scheduled
                    && let Err(e) = container
                        .handle_execution_post_completion(&ctx, exit_code)
                        .await
                {
                    tracing::error!("Failed to run post-completion handling: {}", e);
                }

                if rate_limit_resume_scheduled {
                    tracing::info!(
                        "Skipping finalization for execution {} while rate-limit auto-resume is pending",
                        ctx.execution_process.id
                    );
                }

                // Sync workspace to remote after CodingAgent execution. This
                // also backfills the cloud row if the one-shot link at creation
                // never succeeded, so issue-linked workspaces self-heal instead
                // of staying invisible on the issue board.
                if matches!(
                    &ctx.execution_process.run_reason,
                    ExecutionProcessRunReason::CodingAgent
                ) && let Some(client) = &container.remote_client
                {
                    let client = client.clone();
                    let pool = container.db.pool.clone();
                    let git = container.git.clone();
                    let workspace_id = ctx.workspace.id;
                    tokio::spawn(async move {
                        // Re-read for the current name/archived/task_id.
                        let workspace = match Workspace::find_by_id(&pool, workspace_id).await {
                            Ok(Some(workspace)) => workspace,
                            Ok(None) => return,
                            Err(e) => {
                                tracing::error!(
                                    "Failed to load workspace {} for remote sync: {}",
                                    workspace_id,
                                    e
                                );
                                return;
                            }
                        };
                        remote_sync::sync_or_create_linked_workspace(
                            &client, &pool, &git, &workspace,
                        )
                        .await;
                    });
                }

                // This process's own drain (finalize, steer, rate-limit
                // deferral) is done. A message queued after it looked at the
                // queue — or one a parallel setup script was blocking — has
                // nobody else to start it.
                if let Some(hold) = drain_hold {
                    drop(hold);
                    if let Err(e) = container.resume_deferred_finalization(session_id).await {
                        tracing::error!("Failed to resume deferred finalization: {e}");
                    }
                    if let Err(e) = container
                        .drain_queue_if_idle(&ctx.session, &ctx.workspace)
                        .await
                    {
                        tracing::error!("Failed to start queued follow-up: {}", e);
                    }
                }
            }

            // Now that commit/next-action/finalization steps for this process are complete,
            // capture the HEAD OID as the definitive "after" state (best-effort).
            container.update_after_head_commits(exec_id).await;

            if let Some(msg_arc) = msg_stores.write().await.remove(&exec_id) {
                msg_arc.push_finished();
            }

            // SIGKILL any orphaned children (e.g. MCP servers) still in the
            // process group. The executor itself is already done — either it
            // exited naturally or was killed in the exit-signal branch above.
            if let Some(child_lock) = child_store.read().await.get(&exec_id).cloned() {
                let mut child = child_lock.write().await;
                let _ = child.start_kill();
            }
            child_store.write().await.remove(&exec_id);
            container.remove_subagent_handle(&exec_id).await;
        })
    }

    fn spawn_os_exit_watcher(
        &self,
        exec_id: Uuid,
    ) -> tokio::sync::oneshot::Receiver<std::io::Result<std::process::ExitStatus>> {
        let (tx, rx) = tokio::sync::oneshot::channel::<std::io::Result<std::process::ExitStatus>>();
        let child_store = self.child_store.clone();
        tokio::spawn(async move {
            loop {
                let child_lock = {
                    let map = child_store.read().await;
                    map.get(&exec_id).cloned()
                };
                if let Some(child_lock) = child_lock {
                    let mut child_handler = child_lock.write().await;
                    match child_handler.try_wait() {
                        Ok(Some(status)) => {
                            let _ = tx.send(Ok(status));
                            break;
                        }
                        Ok(None) => {}
                        Err(e) => {
                            let _ = tx.send(Err(e));
                            break;
                        }
                    }
                } else {
                    let _ = tx.send(Err(io::Error::other(format!(
                        "Child handle missing for {exec_id}"
                    ))));
                    break;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        });
        rx
    }

    fn dir_name_from_workspace(workspace_id: &Uuid, task_title: &str) -> String {
        let task_title_id = git_branch_id(task_title);
        format!("{}-{}", short_uuid(workspace_id), task_title_id)
    }

    async fn track_child_msgs_in_store(
        &self,
        id: Uuid,
        child: &mut AsyncGroupChild,
    ) -> Result<(), ContainerError> {
        let store = self
            .get_msg_store_by_id(&id)
            .await
            .ok_or_else(|| ContainerError::Other(anyhow!("MsgStore not found for execution")))?;
        let out = child.inner().stdout.take().expect("no stdout");
        let err = child.inner().stderr.take().expect("no stderr");

        let out = decoded_log_stream(out, LogMsg::Stdout);
        let err = decoded_log_stream(err, LogMsg::Stderr);

        // If you have a JSON Patch source, map it to LogMsg::JsonPatch too, then select all three.

        // Merge and forward into the store
        let merged = select(out, err); // Stream<Item = Result<LogMsg, io::Error>>
        let handle = store.clone().spawn_forwarder(merged);
        self.add_forwarder_handle(id, handle).await;
        Ok(())
    }

    /// Create a live diff log stream for ongoing attempts for WebSocket
    /// Returns a stream that owns the filesystem watcher - when dropped, watcher is cleaned up
    async fn create_live_diff_stream(
        &self,
        args: diff_stream::DiffStreamArgs,
    ) -> Result<DiffStreamHandle, ContainerError> {
        diff_stream::create(args)
            .await
            .map_err(|e| ContainerError::Other(anyhow!("{e}")))
    }

    /// Extract the last assistant message from the MsgStore history
    fn extract_last_assistant_message(&self, exec_id: &Uuid) -> Option<String> {
        // Get the MsgStore for this execution
        let msg_stores = self.msg_stores.try_read().ok()?;
        let msg_store = msg_stores.get(exec_id)?;

        // Get the history and scan in reverse for the last assistant message
        let history = msg_store.get_history();

        const MAX_SUMMARY_LENGTH: usize = 4096;
        let cap = |content: &str| {
            if content.len() > MAX_SUMMARY_LENGTH {
                let truncated = truncate_to_char_boundary(content, MAX_SUMMARY_LENGTH);
                format!("{truncated}...")
            } else {
                content.to_string()
            }
        };
        // History keeps every streamed snapshot of an entry; only the latest
        // counts, or a half-streamed fence would pass for prose.
        let mut seen = HashSet::new();
        for msg in history.iter().rev() {
            if let LogMsg::JsonPatch(patch) = msg
                && let Some((index, entry)) = extract_normalized_entry_from_patch(patch)
                && seen.insert(index)
                && matches!(entry.entry_type, NormalizedEntryType::AssistantMessage)
            {
                // The live summary block is workspace state, not prose.
                let content = executors::logs::status_note::strip_blocks(&entry.content);
                if !vibe_orchestrator::strip_result_sentinel(&content)
                    .trim()
                    .is_empty()
                {
                    return Some(cap(&content));
                }
                // A final message holding only the summary (and perhaps the
                // result sentinel): the summary itself describes the turn.
                if let Some(block) =
                    executors::logs::status_note::extract_last_block(&entry.content)
                {
                    return Some(cap(&block.text));
                }
            }
        }

        None
    }

    /// Like [`extract_last_assistant_message`] but returns the full, untruncated
    /// content. Used for `VIBE_RESULT:` sentinel parsing, where a trailing line
    /// must not be dropped by the 4096-char summary cap.
    fn extract_last_assistant_message_full(&self, exec_id: &Uuid) -> Option<String> {
        let msg_stores = self.msg_stores.try_read().ok()?;
        let msg_store = msg_stores.get(exec_id)?;
        Self::last_assistant_message_full_from_msgs(&msg_store.get_history())
    }

    /// The newest assistant message without its summary blocks. A message
    /// holding only a block is still the last one: a sentinel it lacks must not
    /// be taken from an earlier message of the turn.
    fn last_assistant_message_full_from_msgs(msgs: &[LogMsg]) -> Option<String> {
        // Only an entry's latest streamed snapshot counts.
        let mut seen = HashSet::new();
        for msg in msgs.iter().rev() {
            if let LogMsg::JsonPatch(patch) = msg
                && let Some((index, entry)) = extract_normalized_entry_from_patch(patch)
                && seen.insert(index)
                && matches!(entry.entry_type, NormalizedEntryType::AssistantMessage)
                && !entry.content.trim().is_empty()
            {
                return Some(executors::logs::status_note::strip_blocks(&entry.content));
            }
        }
        None
    }

    /// Update the coding agent turn summary with the final assistant message
    async fn update_executor_session_summary(&self, exec_id: &Uuid) -> Result<(), anyhow::Error> {
        // Check if there's a coding agent turn for this execution process
        let turn = CodingAgentTurn::find_by_execution_process_id(&self.db.pool, *exec_id).await?;

        if let Some(turn) = turn {
            // Only update if summary is not already set
            if turn.summary.is_none() {
                if let Some(summary) = self.extract_last_assistant_message(exec_id) {
                    CodingAgentTurn::update_summary(&self.db.pool, *exec_id, &summary).await?;
                } else {
                    tracing::debug!("No assistant message found for execution {}", exec_id);
                }
            }
        }

        Ok(())
    }

    /// Copy project files and workspace attachments to the workspace.
    /// Skips files that already exist (fast no-op if all exist).
    async fn copy_files_and_images(
        &self,
        workspace_dir: &Path,
        workspace: &Workspace,
    ) -> Result<(), ContainerError> {
        let repos = WorkspaceRepo::find_repos_with_copy_files(&self.db.pool, workspace.id).await?;

        for repo in &repos {
            if let Some(copy_files) = &repo.copy_files
                && !copy_files.trim().is_empty()
            {
                let worktree_path = workspace_dir.join(&repo.name);
                self.copy_project_files(&repo.path, &worktree_path, copy_files)
                    .await
                    .unwrap_or_else(|e| {
                        tracing::warn!(
                            "Failed to copy project files for repo '{}': {}",
                            repo.name,
                            e
                        );
                    });
            }
        }

        self.copy_workspace_attachments(workspace_dir, workspace)
            .await
    }

    /// Copy this workspace's attachments into `<dir>/.vibe-attachments/`, which
    /// carries its own `.gitignore` (`*`) so it stays invisible to git — the same
    /// place agent-produced images are written.
    async fn copy_workspace_attachments(
        &self,
        workspace_dir: &Path,
        workspace: &Workspace,
    ) -> Result<(), ContainerError> {
        let agent_working_dir = Session::find_latest_by_workspace_id(&self.db.pool, workspace.id)
            .await?
            .and_then(|session| session.agent_working_dir);

        if let Err(e) = self
            .file_service
            .copy_files_by_workspace_to_worktree(
                workspace_dir,
                workspace.id,
                agent_working_dir.as_deref(),
            )
            .await
        {
            tracing::warn!("Failed to copy workspace files to workspace: {}", e);
        }

        Ok(())
    }

    /// Create workspace-level CLAUDE.md and AGENTS.md files that import from each repo.
    /// Uses the @import syntax to reference each repo's config files.
    /// Skips creating files if they already exist or if no repos have the source file.
    async fn create_workspace_config_files(
        workspace_dir: &Path,
        repos: &[Repo],
    ) -> Result<(), ContainerError> {
        const CONFIG_FILES: [&str; 2] = ["CLAUDE.md", "AGENTS.md"];

        for config_file in CONFIG_FILES {
            let workspace_config_path = workspace_dir.join(config_file);

            if workspace_config_path.exists() {
                tracing::trace!(
                    "Workspace config file {} already exists, skipping",
                    config_file
                );
                continue;
            }

            let mut import_lines = Vec::new();
            for repo in repos {
                let repo_config_path = workspace_dir.join(&repo.name).join(config_file);
                if repo_config_path.exists() {
                    import_lines.push(format!("@{}/{}", repo.name, config_file));
                }
            }

            if import_lines.is_empty() {
                tracing::trace!(
                    "No repos have {}, skipping workspace config creation",
                    config_file
                );
                continue;
            }

            let content = import_lines.join("\n") + "\n";
            if let Err(e) = tokio::fs::write(&workspace_config_path, &content).await {
                tracing::warn!(
                    "Failed to create workspace config file {}: {}",
                    config_file,
                    e
                );
                continue;
            }

            tracing::info!(
                "Created workspace {} with {} import(s)",
                config_file,
                import_lines.len()
            );
        }

        Ok(())
    }

    /// Conservative wait before auto-resuming a rate-limited session when the
    /// agent does not report an exact reset time. Sized to the common 5-hour
    /// usage window plus a small margin; if the limit is still active on resume,
    /// a new schedule is created and we wait again.
    const RATE_LIMIT_RESUME_DELAY_SECS: i64 = 5 * 60 * 60 + 5 * 60;
    /// Follow-up sent by the rate-limit watcher for both resume kinds. Also the
    /// marker [`Self::recent_capacity_retries`] counts, so the scheduled row and
    /// the bound must keep using the same word.
    const RESUME_PROMPT: &'static str = "continue";
    /// Provider capacity errors clear in seconds-to-minutes, unlike a usage
    /// limit which resets hours out.
    const CAPACITY_RETRY_DELAY_SECS: i64 = 60;
    /// Auto-resume retries already started for this session within
    /// [`Self::CAPACITY_RETRY_WINDOW_MINS`] that stop further capacity retries.
    const CAPACITY_MAX_RETRIES: usize = 2;
    const CAPACITY_RETRY_WINDOW_MINS: i64 = 30;

    /// If this execution stopped because a usage rate limit was reached, or
    /// because the provider reported the model at capacity, and the session has
    /// auto-resume enabled, schedule an automatic "continue" follow-up. A usage
    /// limit uses the agent-reported reset time when present and in the future,
    /// otherwise a conservative estimate; a capacity error retries shortly.
    async fn maybe_schedule_rate_limit_resume(
        &self,
        ctx: &ExecutionContext,
    ) -> Result<bool, ContainerError> {
        if !matches!(
            ctx.execution_process.run_reason,
            ExecutionProcessRunReason::CodingAgent
        ) {
            return Ok(false);
        }
        if !ctx.session.auto_resume_enabled {
            return Ok(false);
        }

        // Look for a rate-limit entry emitted by the executor when a usage
        // limit was reached during this execution. Prefer the in-memory
        // MsgStore because the exit monitor runs before DB log streaming is
        // flushed; falling back to DB logs keeps this usable for unusual paths
        // where the store has already gone away.
        let msgs = if let Some(store) = self.get_msg_store_by_id(&ctx.execution_process.id).await {
            store.get_history()
        } else {
            let records =
                ExecutionProcessLogs::find_by_execution_id(&self.db.pool, ctx.execution_process.id)
                    .await?;
            match ExecutionProcessLogs::parse_logs(&records) {
                Ok(m) => m,
                Err(e) => {
                    tracing::warn!("Failed to parse logs for rate-limit detection: {}", e);
                    return Ok(false);
                }
            }
        };

        let resume_at = match Self::rate_limit_reset_hint_from_msgs(&msgs) {
            Some(reset_hint) => Self::resume_at_from_hint(reset_hint.as_deref(), Utc::now()),
            // Not a usage limit: retry shortly if the provider reported the
            // model at capacity, which is transient. The process status is no
            // help here — codex reports the capacity failure as a failed *turn*
            // while its app-server still exits 0, so the run lands as
            // `Completed` and the logged error is the only signal.
            None => {
                if !Self::capacity_error_in_msgs(&msgs)
                    || self.recent_capacity_retries(ctx.session.id).await?
                        >= Self::CAPACITY_MAX_RETRIES
                {
                    return Ok(false);
                }
                Utc::now() + chrono::Duration::seconds(Self::CAPACITY_RETRY_DELAY_SECS)
            }
        };

        PendingRateLimitResume::upsert(
            &self.db.pool,
            ctx.session.id,
            ctx.execution_process.id,
            resume_at,
            Self::RESUME_PROMPT,
        )
        .await
        .map_err(|e| ContainerError::Other(e.into()))?;

        tracing::info!(
            "Scheduled rate-limit auto-resume for session {} (execution {}) at {}",
            ctx.session.id,
            ctx.execution_process.id,
            resume_at
        );
        Ok(true)
    }

    /// Pick the resume time: the agent-reported reset (as RFC3339) plus a 60s
    /// margin when present and still in the future, otherwise a conservative
    /// fallback. `now` is a parameter so the choice is unit-testable.
    fn resume_at_from_hint(
        reset_hint: Option<&str>,
        now: chrono::DateTime<Utc>,
    ) -> chrono::DateTime<Utc> {
        reset_hint
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.with_timezone(&Utc) + chrono::Duration::seconds(60))
            .filter(|dt| *dt > now)
            .unwrap_or_else(|| now + chrono::Duration::seconds(Self::RATE_LIMIT_RESUME_DELAY_SECS))
    }

    fn rate_limit_reset_hint_from_msgs(msgs: &[LogMsg]) -> Option<Option<String>> {
        let mut limit_reached = false;
        let mut reset_hint: Option<String> = None;

        for msg in msgs {
            if let LogMsg::JsonPatch(patch) = msg
                && let Some((_, entry)) = extract_normalized_entry_from_patch(patch)
                && let NormalizedEntryType::RateLimitInfo(info) = &entry.entry_type
                && info.limit_reached
            {
                limit_reached = true;
                if info.resets_at.is_some() {
                    reset_hint = info.resets_at.clone();
                }
            }
        }

        limit_reached.then_some(reset_hint)
    }

    /// True when the run logged the provider's transient capacity error (e.g.
    /// codex's `Error: Selected model is at capacity`). Only error entries
    /// count, so an agent merely quoting the phrase can't trigger a retry.
    fn capacity_error_in_msgs(msgs: &[LogMsg]) -> bool {
        msgs.iter().any(|msg| {
            let LogMsg::JsonPatch(patch) = msg else {
                return false;
            };
            extract_normalized_entry_from_patch(patch).is_some_and(|(_, entry)| {
                matches!(entry.entry_type, NormalizedEntryType::ErrorMessage { .. })
                    && entry.content.to_lowercase().contains("is at capacity")
            })
        })
    }

    /// Auto-resume retries already started for this session. The watcher starts
    /// each one as a coding-agent follow-up carrying [`Self::RESUME_PROMPT`], so
    /// counting those bounds capacity retries without a schema change. A user
    /// typing the same word only makes the bound stricter.
    async fn recent_capacity_retries(&self, session_id: Uuid) -> Result<usize, ContainerError> {
        let since = Utc::now() - chrono::Duration::minutes(Self::CAPACITY_RETRY_WINDOW_MINS);
        Ok(
            ExecutionProcess::find_by_session_id(&self.db.pool, session_id, false)
                .await?
                .iter()
                .filter(|p| {
                    p.created_at >= since
                        && matches!(p.run_reason, ExecutionProcessRunReason::CodingAgent)
                        && matches!(
                            p.executor_action().map(ExecutorAction::typ),
                            Ok(ExecutorActionType::CodingAgentFollowUpRequest(r))
                                if r.prompt == Self::RESUME_PROMPT
                        )
                })
                .count(),
        )
    }

    /// Decide how to wrap up a finished execution. Pure so the terminal-turn
    /// branching — notably that a "no changes made" turn must still drain its
    /// queued follow-up rather than only finalizing — can be unit-tested without
    /// DB/IO.
    ///
    /// - `success_or_cleanup`: coding agent completed ok, or a cleanup script
    ///   finished — i.e. we're in the commit/next-action block.
    /// - `should_start_next`: a next action should run (changes were made, or a
    ///   non-coding-agent run). Only meaningful when `success_or_cleanup`.
    /// - `should_finalize`: [`Self::should_finalize`] verdict for this ctx.
    /// - `has_chained_follow_up`: a chained `next_action` exists.
    fn plan_post_completion(
        success_or_cleanup: bool,
        should_start_next: bool,
        should_finalize: bool,
        has_chained_follow_up: bool,
    ) -> PostCompletionPlan {
        // Finalizing here (a failed or stopped cleanup with more cleanups
        // chained) ends the chain: the rest would finalize it again on exit.
        let start_next = success_or_cleanup && should_start_next && !should_finalize;
        // "No changes made" early-finalize: we bypass the normal flow (no next
        // action runs), so this is the terminal turn and MUST drain the queue.
        // It wins over `should_finalize` (mirrors the old `already_finalized`).
        let no_changes_finalize = success_or_cleanup && !should_start_next;
        let finalize_with_queue = if no_changes_finalize {
            // Terminal turn with no chained follow-up by construction.
            Some(false)
        } else if should_finalize {
            Some(has_chained_follow_up)
        } else {
            None
        };
        PostCompletionPlan {
            start_next,
            log_skip_cleanup: no_changes_finalize,
            finalize_with_queue,
        }
    }

    async fn handle_execution_post_completion(
        &self,
        ctx: &ExecutionContext,
        exit_code: Option<i64>,
    ) -> Result<(), ContainerError> {
        // "Send now" / steer: this coding-agent turn was interrupted by a steer
        // request (the steer route killed it after pushing the steering message to
        // the front of the queue). Skip the normal commit / next-action / finalize
        // flow and immediately drain that front message as a follow-up so the
        // session continues from where it was. Any uncommitted partial work stays
        // on disk for the follow-up turn to build on and commit at its own
        // completion. Only coding-agent turns can be steered; the one-shot
        // `take_steering` flag distinguishes a steer-kill from a plain user stop
        // (which discards the queue). On a drain failure the message is back at
        // the front of the queue and we fall through to normal completion
        // handling so the turn still finalizes — keeping the queue, since this
        // kill was not a stop.
        let mut steer_start_failed = false;
        if matches!(
            ctx.execution_process.run_reason,
            ExecutionProcessRunReason::CodingAgent
        ) && let Some(steered_id) = self.queued_message_service.take_steering(ctx.session.id)
            && let Some(queued_msg) = self
                .queued_message_service
                .take_steered_or_front(ctx.session.id, steered_id)
        {
            tracing::info!(
                "Steer: starting interrupting follow-up for session {}",
                ctx.session.id
            );
            if let Err(e) =
                Scratch::delete(&self.db.pool, ctx.session.id, &ScratchType::DraftFollowUp).await
            {
                tracing::warn!("Failed to delete scratch after consuming steered message: {e}");
            }
            match self
                .start_queued_followup(&ctx.session, &ctx.workspace, queued_msg)
                .await
            {
                Ok(Some(_)) => return Ok(()),
                Ok(None) => {
                    self.defer_finalization(ctx, false, true).await;
                    return Ok(());
                }
                Err(e) => {
                    tracing::error!(
                        "Failed to start steered follow-up for session {}: {}; falling back to normal completion handling",
                        ctx.session.id,
                        e
                    );
                    steer_start_failed = true;
                }
            }
        }

        // vibe: capture the agent's `VIBE_RESULT:` self-report from the FULL
        // in-memory final message now — while the coding process's MsgStore is
        // still alive and before the truncated turn-summary path could drop a
        // trailing sentinel on a long wrap-up. Persisted for the finalize below
        // (or for the later cleanup-script finalize) to consume.
        self.vibe_capture_result(ctx).await;

        let success = matches!(
            ctx.execution_process.status,
            ExecutionProcessStatus::Completed
        ) && exit_code == Some(0);

        let cleanup_done = matches!(
            ctx.execution_process.run_reason,
            ExecutionProcessRunReason::CleanupScript
        ) && !matches!(
            ctx.execution_process.status,
            ExecutionProcessStatus::Running
        );

        let success_or_cleanup = success || cleanup_done;

        // Whether a chained next action should run. Committing changes is a side
        // effect, so it stays in the shell; only the resulting boolean feeds the
        // pure planner below.
        let should_start_next = if success_or_cleanup {
            // Commit changes (if any) and get feedback about whether changes were made
            let changes_committed = match self.try_commit_changes(ctx).await {
                Ok(committed) => committed,
                Err(e) => {
                    tracing::error!("Failed to commit changes after execution: {}", e);
                    // Treat commit failures as if changes were made to be safe
                    true
                }
            };

            if matches!(
                ctx.execution_process.run_reason,
                ExecutionProcessRunReason::CodingAgent
            ) {
                // Check if agent made commits OR if we just committed uncommitted changes
                changes_committed || self.has_commits_from_execution(ctx).await.unwrap_or(false)
            } else {
                true
            }
        } else {
            false
        };

        let has_chained_follow_up = ctx
            .execution_process
            .executor_action()
            .ok()
            .and_then(|action| action.next_action())
            .is_some();

        let plan = Self::plan_post_completion(
            success_or_cleanup,
            should_start_next,
            self.should_finalize(ctx),
            has_chained_follow_up,
        );

        if plan.start_next {
            // If the process exited successfully, start the next action
            if let Err(e) = self.try_start_next_action(ctx).await {
                tracing::error!("Failed to start next action after completion: {}", e);
                // The chain was left to the next action's exit, which may now
                // never come (`start_next` never comes with a finalize here).
                self.finalize_unstarted_next_action(ctx, &e).await;
            }
        }

        if plan.log_skip_cleanup {
            tracing::info!(
                "Skipping cleanup script for workspace {} - no changes made by coding agent",
                ctx.workspace.id
            );
        }

        // Drain any queued follow-up here for BOTH the no-changes early-finalize
        // path and the normal should_finalize path, so a queued message is never
        // left stuck in the in-memory queue when the cleanup script is skipped.
        if let Some(has_chained) = plan.finalize_with_queue {
            self.finalize_with_queued_followup(ctx, has_chained, steer_start_failed)
                .await;
        }

        Ok(())
    }

    /// Whether a session's queued follow-up should be executed (rather than
    /// discarded) given the terminal status of the just-finished execution.
    ///
    /// A successfully completed turn — including a "no changes made" turn that
    /// finalizes early without running the cleanup script — must still drain its
    /// queue; only failed or killed turns discard it (a failed cleanup holds it
    /// instead). Shared decision for both finalize paths in
    /// [`Self::finalize_with_queued_followup`].
    fn should_execute_queued_message(status: &ExecutionProcessStatus) -> bool {
        !matches!(
            status,
            ExecutionProcessStatus::Failed | ExecutionProcessStatus::Killed
        )
    }

    async fn defer_finalization(
        &self,
        ctx: &ExecutionContext,
        has_chained_follow_up: bool,
        keep_queue: bool,
    ) {
        self.deferred_finalizations.write().await.insert(
            ctx.session.id,
            DeferredFinalization {
                execution_process_id: ctx.execution_process.id,
                has_chained_follow_up,
                keep_queue,
            },
        );
    }

    async fn resume_deferred_finalization(&self, session_id: Uuid) -> Result<(), ContainerError> {
        if !self
            .deferred_finalizations
            .read()
            .await
            .contains_key(&session_id)
        {
            return Ok(());
        }
        let starting = self.lock_session_start(session_id).await;
        if self.queued_message_service.is_drain_held(session_id)
            || ExecutionProcess::has_running_non_dev_server_processes_for_session(
                &self.db.pool,
                session_id,
            )
            .await?
        {
            return Ok(());
        }
        let Some(pending) = self
            .deferred_finalizations
            .read()
            .await
            .get(&session_id)
            .copied()
        else {
            return Ok(());
        };
        // A newer coding turn owns completion, even if it already ended.
        if ExecutionProcess::has_newer_coding_agent_process(
            &self.db.pool,
            pending.execution_process_id,
        )
        .await?
        {
            self.deferred_finalizations
                .write()
                .await
                .remove(&session_id);
            return Ok(());
        }
        let ctx =
            ExecutionProcess::load_context(&self.db.pool, pending.execution_process_id).await?;
        self.deferred_finalizations
            .write()
            .await
            .remove(&session_id);
        let hold = self.queued_message_service.hold_drain(session_id);
        drop(starting);
        self.finalize_with_queued_followup(&ctx, pending.has_chained_follow_up, pending.keep_queue)
            .await;
        drop(hold);
        Ok(())
    }

    /// Terminal handling for a completed execution: consume the session's
    /// queued follow-up message if one is present (and the execution wasn't
    /// failed/killed), otherwise finalize the task. Also re-marks the coding
    /// agent turn unseen when this is the terminal turn (no chained or queued
    /// follow-up will run).
    ///
    /// Shared by the normal `should_finalize` path and the "no changes made"
    /// early-finalize path, so that a queued message is never left stuck in the
    /// in-memory queue when the cleanup script is skipped.
    ///
    /// `keep_queue`: a steer killed this turn but its message failed to start;
    /// the queue (with that message back in front) survives the kill.
    async fn finalize_with_queued_followup(
        &self,
        ctx: &ExecutionContext,
        has_chained_follow_up: bool,
        keep_queue: bool,
    ) {
        let mut started_queued_follow_up = false;

        // Only execute queued messages if the execution succeeded.
        // If it failed or was killed, discard the queue and finalize.
        let should_execute_queued =
            Self::should_execute_queued_message(&ctx.execution_process.status);

        // The coding turn's work stands; only its cleanup failed. Hold the
        // queue for the user rather than run it on top of the failure or drop
        // it: the drain below then finds nothing ready.
        let cleanup_failed =
            matches!(
                ctx.execution_process.run_reason,
                ExecutionProcessRunReason::CleanupScript
            ) && matches!(ctx.execution_process.status, ExecutionProcessStatus::Failed);
        if cleanup_failed {
            self.queued_message_service
                .hold_front(ctx.session.id, "Cleanup script failed".to_string());
        }

        if !should_execute_queued && !keep_queue && !cleanup_failed {
            // Execution failed or was killed - discard the ENTIRE queue (not just
            // the front of a multi-message queue) so no follow-ups are left
            // stranded to resurface on a later turn, then finalize.
            let discarded = self.queued_message_service.clear_queue(ctx.session.id);
            if !discarded.is_empty() {
                tracing::info!(
                    "Discarding {} queued message(s) for session {} due to execution status {:?}",
                    discarded.len(),
                    ctx.session.id,
                    ctx.execution_process.status
                );
            }
            self.finalize_task(ctx).await;
            self.vibe_on_finalize(ctx).await;
        } else if let Some(queued_msg) = self.queued_message_service.take_next(ctx.session.id) {
            tracing::info!(
                "Found queued message for session {}, starting follow-up execution",
                ctx.session.id
            );

            // Delete the scratch since we're consuming the queued message.
            // Only meaningful for the last message; further drained messages
            // have no scratch backing, so the delete is a harmless no-op.
            if let Err(e) =
                Scratch::delete(&self.db.pool, ctx.session.id, &ScratchType::DraftFollowUp).await
            {
                tracing::warn!("Failed to delete scratch after consuming queued message: {e}");
            }

            // Execute the queued follow-up
            match self
                .start_queued_followup(&ctx.session, &ctx.workspace, queued_msg)
                .await
            {
                Ok(Some(_)) => started_queued_follow_up = true,
                Ok(None) => {
                    self.defer_finalization(ctx, has_chained_follow_up, keep_queue)
                        .await;
                    return;
                }
                Err(e) => {
                    tracing::error!("Failed to start queued follow-up: {}", e);
                    // The message is back in the queue, waiting for the user;
                    // finalize this turn.
                    self.finalize_task(ctx).await;
                    self.vibe_on_finalize(ctx).await;
                }
            }
        } else {
            self.finalize_task(ctx).await;
            self.vibe_on_finalize(ctx).await;
        }

        let should_mark_turn_unseen = matches!(
            ctx.execution_process.run_reason,
            ExecutionProcessRunReason::CodingAgent
        ) && !has_chained_follow_up
            && !started_queued_follow_up;

        if should_mark_turn_unseen
            && let Err(e) = CodingAgentTurn::mark_unseen_by_execution_process_id(
                &self.db.pool,
                ctx.execution_process.id,
            )
            .await
        {
            tracing::warn!(
                "Failed to mark coding agent turn unseen for execution {}: {}",
                ctx.execution_process.id,
                e
            );
        }
    }

    /// `ctx`'s next action failed to start. If no process of it got far enough
    /// to exit, nothing else will ever finalize this chain, so finalize it here
    /// as a failure — through the row the failed start left (its log holds the
    /// error; vibe reads it like a cleanup that ran and failed), or as `ctx`
    /// itself when not even that row was written. The queue is held: nothing
    /// runs on top of the failure, and its front waits for the user.
    async fn finalize_unstarted_next_action(&self, ctx: &ExecutionContext, error: &ContainerError) {
        let pool = &self.db.pool;
        // A process that did spawn finalizes the chain from its exit monitor.
        if ExecutionProcess::has_running_non_dev_server_processes_for_session(pool, ctx.session.id)
            .await
            .unwrap_or(true)
        {
            return;
        }
        self.queued_message_service.hold_front(
            ctx.session.id,
            format!("Previous step could not start: {error}"),
        );

        let failed_row = ExecutionProcess::find_by_session_id(pool, ctx.session.id, false)
            .await
            .unwrap_or_default()
            .into_iter()
            .rev()
            .find(|p| {
                p.id != ctx.execution_process.id
                    && p.created_at >= ctx.execution_process.created_at
                    && p.status == ExecutionProcessStatus::Failed
                    && p.run_reason != ExecutionProcessRunReason::DevServer
            });
        let failed_id = failed_row.map_or(ctx.execution_process.id, |p| p.id);
        let mut failed = match ExecutionProcess::load_context(pool, failed_id).await {
            Ok(failed) => failed,
            Err(e) => {
                tracing::error!("Failed to load context to finalize {}: {}", failed_id, e);
                return;
            }
        };
        failed.execution_process.status = ExecutionProcessStatus::Failed;
        self.finalize_task(&failed).await;
        self.vibe_on_finalize(&failed).await;
    }

    /// Entry point for the automated `vibe` workflow, called at every terminal
    /// finalize (replacing the old immediate auto-merge). Reads the persisted
    /// per-workspace [`VibeRun`] state and the agent's `VIBE_RESULT:` self-report,
    /// asks the functional core ([`decide_finalize_action`]) what to do, and
    /// performs it. Non-vibe issues are a no-op.
    /// Capture the agent's `VIBE_RESULT:` self-report at coding completion from
    /// the full in-memory message and persist it on the run for the finalize to
    /// consume. Runs only for coding-agent completions; skips before any remote
    /// call unless an actual sentinel is present (non-vibe agents never emit
    /// one, since they don't receive the preamble).
    async fn vibe_capture_result(&self, ctx: &ExecutionContext) {
        if !matches!(
            ctx.execution_process.run_reason,
            ExecutionProcessRunReason::CodingAgent
        ) {
            return;
        }
        let Some(task_id) = ctx.workspace.task_id else {
            return;
        };
        let Some(message) = self.extract_last_assistant_message_full(&ctx.execution_process.id)
        else {
            return;
        };
        let Some(token) = parse_vibe_result(&message).as_token() else {
            return; // no sentinel → nothing to record (and no remote call)
        };
        let workspace_id = ctx.workspace.id;

        // Create the run (after a one-time remote vibe-check) only if it doesn't
        // exist yet; thereafter just update the token.
        match VibeRun::find_by_workspace_id(&self.db.pool, workspace_id).await {
            Ok(Some(run)) => {
                // During review/merging, only the dedicated review session's
                // sentinel is authoritative. A late or duplicate completion from
                // the original coding session (also run_reason CodingAgent) must
                // NOT overwrite the review verdict — otherwise a stale coding
                // `done` could mask the review session's `approve` and stall the
                // merge. Mirrors `session_is_review` in `vibe_on_finalize`.
                let phase = VibePhase::from_db_str(&run.phase).unwrap_or(VibePhase::Coding);
                if matches!(phase, VibePhase::Review | VibePhase::Merging)
                    && run.review_session_id != Some(ctx.session.id)
                {
                    return;
                }
            }
            Ok(None) => {
                let Some(client) = self.remote_client.clone() else {
                    return;
                };
                if !matches!(client.auto_merge_check(workspace_id).await, Ok(true)) {
                    return;
                }
                if let Err(e) = VibeRun::get_or_create(&self.db.pool, workspace_id, task_id).await {
                    tracing::error!(
                        "vibe: get_or_create (capture) failed for {}: {}",
                        workspace_id,
                        e
                    );
                    return;
                }
            }
            Err(e) => {
                tracing::error!(
                    "vibe: find_by_workspace_id (capture) failed for {}: {}",
                    workspace_id,
                    e
                );
                return;
            }
        }
        if let Err(e) = VibeRun::set_last_result(&self.db.pool, workspace_id, Some(token)).await {
            tracing::warn!("vibe: set_last_result failed for {}: {}", workspace_id, e);
        }
    }

    pub async fn vibe_on_finalize(&self, ctx: &ExecutionContext) {
        // Dev-server / archive completions never participate.
        if matches!(
            ctx.execution_process.run_reason,
            ExecutionProcessRunReason::DevServer | ExecutionProcessRunReason::ArchiveScript
        ) {
            return;
        }
        let Some(task_id) = ctx.workspace.task_id else {
            return;
        };
        let Some(client) = self.remote_client.clone() else {
            return;
        };
        let workspace_id = ctx.workspace.id;

        // A run row exists only for vibe issues, so its presence is the cheap
        // local gate; only the first time we see this workspace do we pay a
        // remote vibe-check before creating it.
        let vibe_run = match VibeRun::find_by_workspace_id(&self.db.pool, workspace_id).await {
            Ok(Some(r)) => r,
            Ok(None) => {
                match client.auto_merge_check(workspace_id).await {
                    Ok(true) => {}
                    Ok(false) => return,
                    Err(e) => {
                        tracing::warn!("vibe: auto_merge_check failed for {}: {}", workspace_id, e);
                        return;
                    }
                }
                match VibeRun::get_or_create(&self.db.pool, workspace_id, task_id).await {
                    Ok(r) => r,
                    Err(e) => {
                        tracing::error!("vibe: get_or_create failed for {}: {}", workspace_id, e);
                        return;
                    }
                }
            }
            Err(e) => {
                tracing::error!(
                    "vibe: find_by_workspace_id failed for {}: {}",
                    workspace_id,
                    e
                );
                return;
            }
        };
        let phase = VibePhase::from_db_str(&vibe_run.phase).unwrap_or(VibePhase::Coding);
        let session_is_review = vibe_run.review_session_id == Some(ctx.session.id);

        // Read the sentinel captured (untruncated) at coding completion to drive
        // the decision. It is consumed (cleared) only AFTER the action succeeds
        // (below), so a failed action leaves the token in place for the next
        // finalize to retry — rather than silently losing a `done`/`approve`
        // self-report and falling back to the wrong default on the next turn.
        let result = vibe_run
            .last_result
            .as_deref()
            .map(VibeResult::from_token)
            .unwrap_or(VibeResult::None);

        let input = FinalizeInput {
            run_reason: ctx.execution_process.run_reason.clone(),
            status: ctx.execution_process.status.clone(),
            phase,
            session_is_review,
            result,
            coding_turns: vibe_run.coding_turns as u32,
            review_turns: vibe_run.review_turns as u32,
            merge_retries: vibe_run.merge_retries as u32,
            bounds: VibeBounds::default(),
        };
        let action = decide_finalize_action(&input);
        tracing::info!(
            "vibe: workspace {} phase={} result={:?} -> {:?}",
            workspace_id,
            phase.as_str(),
            result,
            action
        );

        match self
            .vibe_execute(ctx, &client, &vibe_run, phase, action)
            .await
        {
            // Action performed — now consume the sentinel so the next turn (with
            // no fresh sentinel) falls back to the default instead of re-reading
            // this one.
            Ok(()) => {
                if vibe_run.last_result.is_some() {
                    let _ = VibeRun::set_last_result(&self.db.pool, workspace_id, None).await;
                }
            }
            Err(e) => {
                tracing::error!("vibe: failed to execute action for {}: {}", workspace_id, e);
            }
        }
    }

    /// Perform the decided [`VibeAction`] (the side-effecting half of the shell).
    async fn vibe_execute(
        &self,
        ctx: &ExecutionContext,
        client: &RemoteClient,
        vibe_run: &VibeRun,
        phase: VibePhase,
        action: VibeAction,
    ) -> Result<(), ContainerError> {
        let pool = &self.db.pool;
        let workspace_id = ctx.workspace.id;
        let task_id = vibe_run.task_id;

        match action {
            VibeAction::Nothing => {}

            VibeAction::CleanupFix => {
                let log = self
                    .vibe_cleanup_failure_log(ctx.execution_process.id)
                    .await;
                let body = vibe_orchestrator::cleanup_fix_prompt(&log);
                let in_review = matches!(phase, VibePhase::Review | VibePhase::Merging);
                let prompt = if in_review {
                    let _ =
                        VibeRun::set_review_turns(pool, workspace_id, vibe_run.review_turns + 1)
                            .await;
                    vibe_orchestrator::with_review_preamble(&body)
                } else {
                    let _ =
                        VibeRun::set_coding_turns(pool, workspace_id, vibe_run.coding_turns + 1)
                            .await;
                    vibe_orchestrator::with_coding_preamble(&body)
                };
                self.vibe_send_followup(ctx, &prompt).await?;
            }

            VibeAction::ContinueCoding { turn } => {
                let _ = VibeRun::set_coding_turns(pool, workspace_id, turn as i64).await;
                let prompt =
                    vibe_orchestrator::with_coding_preamble(vibe_orchestrator::PROMPT_CONTINUE);
                self.vibe_send_followup(ctx, &prompt).await?;
            }

            VibeAction::StartReview => {
                self.vibe_tag(client, task_id, vibe_orchestrator::TAG_DONE)
                    .await;
                let prompt =
                    vibe_orchestrator::with_review_preamble(vibe_orchestrator::PROMPT_REVIEW_A);
                self.vibe_start_review_session(&ctx.workspace, &ctx.session, &prompt, None)
                    .await?;
            }

            VibeAction::ReviewFollowup { turn } => {
                let _ = VibeRun::set_review_turns(pool, workspace_id, turn as i64).await;
                let prompt =
                    vibe_orchestrator::with_review_preamble(vibe_orchestrator::PROMPT_REVIEW_B);
                self.vibe_send_followup(ctx, &prompt).await?;
            }

            VibeAction::Block { reason } => {
                let _ = VibeRun::set_phase(pool, workspace_id, VibePhase::Blocked.as_str()).await;
                self.vibe_tag(client, task_id, vibe_orchestrator::TAG_BLOCK)
                    .await;
                tracing::warn!("vibe: workspace {} blocked ({:?})", workspace_id, reason);
            }

            VibeAction::AttemptMerge { retry } => {
                let _ = VibeRun::set_phase(pool, workspace_id, VibePhase::Merging.as_str()).await;
                self.vibe_tag(client, task_id, vibe_orchestrator::TAG_APPROVE)
                    .await;

                // Git refuses blocking local edits. Never ask an agent to
                // settle another checkout's WIP or send its file list to it.
                let (outcome, detail) = self.vibe_perform_merge(ctx).await;
                match decide_after_merge(outcome, retry, &VibeBounds::default()) {
                    PostMergeAction::MarkInReview => {
                        if let Err(e) = client.mark_workspace_issue_for_review(workspace_id).await {
                            tracing::warn!(
                                "vibe: mark_for_review failed for {}: {}",
                                workspace_id,
                                e
                            );
                        }
                        // Push the local merge status to the remote so cloud clients
                        // reflect the merge — parity with the manual merge path
                        // (workspaces/git.rs). Best-effort: handles auth/404 itself.
                        remote_sync::sync_local_workspace_merge_to_remote(client, workspace_id)
                            .await;
                        let _ =
                            VibeRun::set_phase(pool, workspace_id, VibePhase::Done.as_str()).await;
                        tracing::info!("vibe: workspace {} merged → In review", workspace_id);
                        self.vibe_notify_ready_for_review(ctx).await;
                    }
                    PostMergeAction::ResolveConflict { retry } => {
                        let _ = VibeRun::set_merge_retries(pool, workspace_id, retry as i64).await;
                        let prompt = vibe_orchestrator::with_review_preamble(
                            vibe_orchestrator::PROMPT_CONFLICT,
                        );
                        self.vibe_send_followup(ctx, &prompt).await?;
                    }
                    PostMergeAction::Escalate => {
                        if let Err(e) = client.mark_workspace_issue_for_review(workspace_id).await {
                            tracing::warn!(
                                "vibe: mark_for_review failed for {}: {}",
                                workspace_id,
                                e
                            );
                        }
                        let _ = VibeRun::set_phase(pool, workspace_id, VibePhase::Blocked.as_str())
                            .await;
                        self.vibe_tag(client, task_id, vibe_orchestrator::TAG_BLOCK)
                            .await;
                        tracing::warn!(
                            "vibe: workspace {} auto-merge gave up (retry {}): {}",
                            workspace_id,
                            retry,
                            detail
                        );
                        self.vibe_notify_merge_failed(ctx, &detail).await;
                    }
                }
            }
        }
        Ok(())
    }

    /// Notify this host's LOCAL push subscriptions that the workspace's issue
    /// moved to "In review". The remote already pushes an
    /// `issue_review_requested` notification to the user's remote subscriptions
    /// (phone), so this covers only the disjoint local subscriptions (e.g. a
    /// desktop browser paired via the local server) the remote push never
    /// reaches. Best-effort, local delivery only to avoid double-notifying.
    async fn vibe_notify_ready_for_review(&self, ctx: &ExecutionContext) {
        let name = ctx
            .workspace
            .name
            .as_deref()
            .unwrap_or(&ctx.workspace.branch);
        self.notification_service
            .notify_local_only(
                "Ready for review",
                &format!("'{name}' is ready for review"),
                Some(ctx.workspace.id),
            )
            .await;
    }

    /// Local-only push saying the auto-merge gave up and why. The issue still
    /// moves to "In review" for a human, but reusing the "ready for review"
    /// notice here hid the failure (e.g. a dirty base checkout) entirely.
    async fn vibe_notify_merge_failed(&self, ctx: &ExecutionContext, detail: &str) {
        let name = ctx
            .workspace
            .name
            .as_deref()
            .unwrap_or(&ctx.workspace.branch);
        // Git stderr dumps are multi-line and long; flatten and cap for a push body.
        let mut detail: String = detail.split_whitespace().collect::<Vec<_>>().join(" ");
        if detail.is_empty() {
            detail = "see server log".to_string();
        } else if detail.chars().count() > 300 {
            detail = format!("{}…", detail.chars().take(300).collect::<String>());
        }
        self.notification_service
            .notify_local_only(
                "Auto-merge failed",
                &format!("'{name}': {detail}"),
                Some(ctx.workspace.id),
            )
            .await;
    }

    /// Best-effort attach of a `vibe-*` tag (for human visibility only).
    async fn vibe_tag(&self, client: &RemoteClient, issue_id: Uuid, name: &str) {
        if let Err(e) = vibe_tags::add_issue_tag_by_name(client, issue_id, name).await {
            tracing::warn!(
                "vibe: failed to add tag '{}' to issue {}: {}",
                name,
                issue_id,
                e
            );
        }
    }

    /// Collect a failed cleanup script's stdout/stderr (tail-capped) for pasting
    /// into the fix prompt.
    async fn vibe_cleanup_failure_log(&self, exec_id: Uuid) -> String {
        // Logs stream to files (and the in-memory MsgStore), NOT the
        // execution_process_logs DB table, so a DB read returns nothing right
        // after completion — which made this always paste "(로그가 비어 있음)".
        // Prefer the still-alive MsgStore, mirroring the rate-limit detection
        // path above; once it is gone (a cleanup that failed to start), read
        // the log file its start failure was written to.
        let msgs = if let Some(store) = self.get_msg_store_by_id(&exec_id).await {
            store.get_history()
        } else {
            services::services::execution_process::load_raw_log_messages(&self.db.pool, exec_id)
                .await
                .unwrap_or_default()
        };
        vibe_orchestrator::cleanup_failure_log_text(&msgs, 4000)
    }

    /// Reuse the user's complete executor config for backend-driven turns,
    /// including sandbox and permission policies. Unset overrides must stay
    /// unset so the selected profile remains authoritative.
    async fn vibe_executor_config(&self, session_id: Uuid) -> Option<ExecutorConfig> {
        ExecutionProcess::latest_executor_config_for_session(&self.db.pool, session_id)
            .await
            .ok()
            .flatten()
    }

    /// Send a backend-driven follow-up prompt into `ctx.session` (continue,
    /// cleanup-fix, review B, conflict-resolve), chaining cleanup as usual.
    async fn vibe_send_followup(
        &self,
        ctx: &ExecutionContext,
        prompt: &str,
    ) -> Result<(), ContainerError> {
        // No profile means we cannot spawn anything; surface it as an error so
        // the finalize keeps `last_result` intact (rather than consuming it on a
        // false success) and the orphan watcher can later escalate this run.
        let Some(executor_config) = self.vibe_executor_config(ctx.session.id).await else {
            return Err(ContainerError::Other(anyhow!(
                "vibe: no executor profile for session {}, cannot send follow-up",
                ctx.session.id
            )));
        };
        let latest_session_info =
            CodingAgentTurn::find_latest_session_info(&self.db.pool, ctx.session.id).await?;
        let repos =
            WorkspaceRepo::find_repos_for_workspace(&self.db.pool, ctx.workspace.id).await?;
        let cleanup_action = self.cleanup_actions_for_repos(&repos);
        let working_dir = ctx
            .session
            .agent_working_dir
            .as_ref()
            .filter(|dir| !dir.is_empty())
            .cloned();

        let action_type = if let Some(info) = latest_session_info {
            ExecutorActionType::CodingAgentFollowUpRequest(CodingAgentFollowUpRequest {
                prompt: prompt.to_string(),
                session_id: info.session_id,
                reset_to_message_id: None,
                executor_config,
                working_dir,
            })
        } else {
            ExecutorActionType::CodingAgentInitialRequest(CodingAgentInitialRequest {
                prompt: prompt.to_string(),
                executor_config,
                working_dir,
                handoff_from: None,
                handoff_session_id: None,
                handoff_user_prompt: None,
            })
        };
        let action = ExecutorAction::new(action_type, cleanup_action.map(Box::new));
        self.start_execution(
            &ctx.workspace,
            &ctx.session,
            &action,
            &ExecutionProcessRunReason::CodingAgent,
        )
        .await?;
        Ok(())
    }

    /// Rule 4: open a fresh review session in the same workspace and send the
    /// review prompt. Records the review session on the run only after the
    /// execution actually starts, so a spawn failure doesn't strand the run in
    /// the `review` phase pointing at a session that never ran.
    async fn vibe_start_review_session(
        &self,
        workspace: &Workspace,
        session: &Session,
        prompt: &str,
        executor_config: Option<ExecutorConfig>,
    ) -> Result<Session, ContainerError> {
        let (review_session, executor_config) = self
            .vibe_create_review_session(workspace, session, executor_config)
            .await?;
        self.vibe_spawn_review_agent(workspace, &review_session, prompt, executor_config)
            .await?;

        // Record the review session only AFTER the execution actually started:
        // the `?` above propagates a spawn failure before any phase change, so
        // the run stays in its prior `coding` phase and the next finalize retries
        // StartReview — instead of being stranded in `review` pointing at a
        // session that never ran (previously recoverable only by the 15-minute
        // orphan watcher).
        VibeRun::begin_review(&self.db.pool, workspace.id, review_session.id)
            .await
            .map_err(|e| ContainerError::Other(anyhow!("vibe begin_review failed: {e}")))?;
        Ok(review_session)
    }

    /// First half of [`Self::vibe_start_review_session`]: resolve the executor
    /// config and create the (empty) review session.
    async fn vibe_create_review_session(
        &self,
        workspace: &Workspace,
        session: &Session,
        executor_config: Option<ExecutorConfig>,
    ) -> Result<(Session, ExecutorConfig), ContainerError> {
        // See `vibe_send_followup`: a missing profile must error, not no-op, so
        // the run is not silently abandoned in a non-terminal phase. A manual
        // review uses the chat selector config; automated reviews inherit the
        // source session's executor config.
        let executor_config = match executor_config {
            Some(executor_config) => executor_config,
            None => self.vibe_executor_config(session.id).await.ok_or_else(|| {
                ContainerError::Other(anyhow!(
                    "vibe: no executor profile for session {}, cannot start review",
                    session.id
                ))
            })?,
        };

        let session_id = Uuid::new_v4();
        let create = CreateSession {
            executor: Some(executor_config.executor.to_string()),
            variant: executor_config.variant.clone(),
            name: Some("vibe-review".to_string()),
        };
        let review_session =
            Session::create(&self.db.pool, &create, session_id, workspace.id).await?;
        Ok((review_session, executor_config))
    }

    /// Second half of [`Self::vibe_start_review_session`]: spawn the review
    /// agent. Moving the run to the review phase is up to the caller.
    async fn vibe_spawn_review_agent(
        &self,
        workspace: &Workspace,
        review_session: &Session,
        prompt: &str,
        executor_config: ExecutorConfig,
    ) -> Result<(), ContainerError> {
        let working_dir = review_session
            .agent_working_dir
            .as_ref()
            .filter(|dir| !dir.is_empty())
            .cloned();
        let repos = WorkspaceRepo::find_repos_for_workspace(&self.db.pool, workspace.id).await?;
        let cleanup_action = self.cleanup_actions_for_repos(&repos);
        let action = ExecutorAction::new(
            ExecutorActionType::CodingAgentInitialRequest(CodingAgentInitialRequest {
                prompt: prompt.to_string(),
                executor_config,
                working_dir,
                handoff_from: None,
                handoff_session_id: None,
                handoff_user_prompt: None,
            }),
            cleanup_action.map(Box::new),
        );
        self.start_execution(
            workspace,
            review_session,
            &action,
            &ExecutionProcessRunReason::CodingAgent,
        )
        .await?;
        Ok(())
    }

    /// Rule 5: fast-forward merge each qualifying repo into its target branch,
    /// classifying the outcome for [`decide_after_merge`]. Remote-only targets
    /// are first materialized as local tracking branches, matching manual Merge.
    /// Skips repos with an open PR or an already-recorded direct merge.
    /// Returns the outcome plus a short human-readable detail of what went
    /// wrong (empty on success) for the escalation notification / log — the
    /// outcome alone hid *why* an auto-merge gave up.
    async fn vibe_perform_merge(&self, ctx: &ExecutionContext) -> (MergeOutcome, String) {
        let workspace = ctx.workspace.clone();
        let workspace_id = workspace.id;

        let workspace_repos =
            match WorkspaceRepo::find_by_workspace_id(&self.db.pool, workspace_id).await {
                Ok(v) if !v.is_empty() => v,
                Ok(_) => {
                    return (
                        MergeOutcome::OtherFailure,
                        "workspace has no repos to merge".to_string(),
                    );
                }
                Err(e) => {
                    tracing::error!("vibe merge: load workspace_repos failed: {}", e);
                    return (
                        MergeOutcome::OtherFailure,
                        format!("load workspace repos failed: {e}"),
                    );
                }
            };

        let container_ref = match self.ensure_container_exists(&workspace).await {
            Ok(r) => r,
            Err(e) => {
                tracing::error!("vibe merge: ensure container failed: {}", e);
                return (
                    MergeOutcome::OtherFailure,
                    format!("ensure container failed: {e}"),
                );
            }
        };
        let workspace_path = Path::new(&container_ref);

        let mut any_conflict = false;
        let mut any_dirty_base = false;
        let mut any_other_failure = false;
        let mut failures: Vec<String> = Vec::new();
        // Whether at least one repo reached a review-ready state: freshly merged,
        // already merged, or carrying an open PR. Without this, a run where every
        // repo is skipped would fall through to `Success` and mark the issue In
        // review / Done even though nothing actually merged.
        let mut any_review_ready = false;

        for workspace_repo in &workspace_repos {
            let repo = match Repo::find_by_id(&self.db.pool, workspace_repo.repo_id).await {
                Ok(Some(r)) => r,
                Ok(None) => {
                    tracing::warn!("vibe merge: repo {} not found", workspace_repo.repo_id);
                    failures.push(format!("repo {} not found", workspace_repo.repo_id));
                    any_other_failure = true;
                    continue;
                }
                Err(e) => {
                    tracing::error!("vibe merge: load repo failed: {}", e);
                    failures.push(format!("load repo failed: {e}"));
                    any_other_failure = true;
                    continue;
                }
            };

            let merges =
                match Merge::find_by_workspace_and_repo_id(&self.db.pool, workspace_id, repo.id)
                    .await
                {
                    Ok(merges) => merges,
                    Err(e) => {
                        failures.push(format!("{}: load merges failed: {e}", repo.name));
                        any_other_failure = true;
                        continue;
                    }
                };
            if merges.iter().any(
                |m| matches!(m, Merge::Pr(pr) if matches!(pr.pr_info.status, MergeStatus::Open)),
            ) {
                // Open PR is the review artifact → legitimately In review.
                any_review_ready = true;
                continue;
            }
            // Idempotency: a direct merge was already recorded for this
            // workspace — but that alone does NOT mean the branch is fully
            // merged *now*. If the workspace was merged once and then gained
            // more commits (e.g. a manual merge, more work, then a review →
            // approve), those new commits are still unmerged and must land.
            // Only skip when the branch has not advanced past its target
            // (`ahead == 0`); otherwise fall through to the merge below.
            // Skipping unconditionally stranded post-merge commits, leaving an
            // approved review marked "merged → In review" without merging them.
            if merges.iter().any(|m| matches!(m, Merge::Direct(_))) {
                match self.git.get_branch_status(
                    &repo.path,
                    &workspace.branch,
                    &workspace_repo.target_branch,
                ) {
                    // No commits ahead of target → everything already merged.
                    Ok((0, _)) => {
                        any_review_ready = true;
                        continue;
                    }
                    // Commits added since the recorded merge → merge them below.
                    Ok(_) => {}
                    Err(e) => {
                        tracing::error!(
                            "vibe merge: branch status failed for {}: {}",
                            repo.name,
                            e
                        );
                        failures.push(format!("{}: branch status failed: {e}", repo.name));
                        any_other_failure = true;
                        continue;
                    }
                }
            }

            let is_target_remote = match self
                .git
                .is_remote_branch(&repo.path, &workspace_repo.target_branch)
            {
                Ok(is_remote) => is_remote,
                Err(e) => {
                    tracing::error!(
                        "vibe merge: is_remote_branch failed for {}: {}",
                        repo.name,
                        e
                    );
                    failures.push(format!("{}: is_remote_branch failed: {e}", repo.name));
                    any_other_failure = true;
                    continue;
                }
            };
            // Match the manual Merge action: a remote-only target such as
            // `origin/feature` is materialized as a local tracking branch
            // (`feature`) before merging. Persist the local target only after
            // the merge succeeds, so a failed attempt does not silently rewrite
            // the workspace configuration.
            let target_branch = if is_target_remote {
                match self
                    .git
                    .ensure_local_branch_for_remote(&repo.path, &workspace_repo.target_branch)
                {
                    Ok(branch) => branch,
                    Err(e) => {
                        tracing::error!(
                            "vibe merge: materialize remote target failed for {}: {}",
                            repo.name,
                            e
                        );
                        failures.push(format!(
                            "{}: materialize remote target failed: {e}",
                            repo.name
                        ));
                        any_other_failure = true;
                        continue;
                    }
                }
            } else {
                workspace_repo.target_branch.clone()
            };

            let worktree_path = workspace_path.join(&repo.name);
            let mut merge_result = self.git.merge_changes(
                &repo.path,
                &worktree_path,
                &workspace.branch,
                &target_branch,
            );

            // The base moved forward since the workspace branched, so a
            // fast-forward merge is impossible. Rather than immediately handing
            // this to the agent as a "conflict", try an automatic rebase onto
            // the latest target first — most diverged bases rebase cleanly.
            // Only a rebase that itself reports conflicts is a real conflict the
            // agent must resolve; the error type (MergeConflicts) routes it to
            // the conflict-resolution turn via the classifier below.
            if matches!(merge_result, Err(GitServiceError::BranchesDiverged(_))) {
                tracing::info!(
                    "vibe merge: base diverged for {}, attempting auto-rebase",
                    repo.name
                );
                match self.git.rebase_branch(
                    &repo.path,
                    &worktree_path,
                    &target_branch,
                    &target_branch,
                    &workspace.branch,
                ) {
                    Ok(_) => {
                        // Rebase landed cleanly — the workspace branch is now
                        // strictly ahead of target, so re-attempt the merge.
                        tracing::info!(
                            "vibe merge: auto-rebase succeeded for {}, retrying merge",
                            repo.name
                        );
                        merge_result = self.git.merge_changes(
                            &repo.path,
                            &worktree_path,
                            &workspace.branch,
                            &target_branch,
                        );
                    }
                    // Rebase failed. A conflict becomes the agent's job; any
                    // other error is an other-failure. Both are classified by
                    // matching on the error type in the block below.
                    Err(e) => {
                        merge_result = Err(e);
                    }
                }
            }

            match merge_result {
                Ok(merge_commit_id) => {
                    if is_target_remote
                        && let Err(e) = WorkspaceRepo::update_target_branch(
                            &self.db.pool,
                            workspace_id,
                            repo.id,
                            &target_branch,
                        )
                        .await
                    {
                        tracing::error!(
                            "vibe merge: persist materialized target failed for {}: {}",
                            repo.name,
                            e
                        );
                        failures.push(format!(
                            "{}: persist materialized target failed: {e}",
                            repo.name
                        ));
                        any_other_failure = true;
                        continue;
                    }
                    if let Err(e) = Merge::create_direct(
                        &self.db.pool,
                        workspace_id,
                        repo.id,
                        &target_branch,
                        &merge_commit_id,
                    )
                    .await
                    {
                        tracing::error!("vibe merge: record merge failed for {}: {}", repo.name, e);
                        failures.push(format!("{}: record merge failed: {e}", repo.name));
                        any_other_failure = true;
                    } else {
                        any_review_ready = true;
                    }
                }
                Err(GitServiceError::MergeConflicts { .. })
                | Err(GitServiceError::BranchesDiverged(_)) => {
                    tracing::warn!("vibe merge: conflict merging {}", repo.name);
                    failures.push(format!("{}: merge conflict", repo.name));
                    any_conflict = true;
                }
                Err(GitServiceError::WorktreeDirty(branch, files)) if branch == target_branch => {
                    tracing::warn!(
                        "vibe merge: '{}' checkout has uncommitted changes blocking {}: {}",
                        branch,
                        repo.name,
                        files
                    );
                    failures.push(format!(
                        "{}: '{branch}' checkout has uncommitted changes: {files}",
                        repo.name
                    ));
                    any_dirty_base = true;
                }
                Err(e) => {
                    tracing::warn!("vibe merge: merge_changes failed for {}: {}", repo.name, e);
                    failures.push(format!("{}: {e}", repo.name));
                    any_other_failure = true;
                }
            }
        }

        let outcome = if any_conflict {
            MergeOutcome::Conflict
        } else if any_dirty_base {
            MergeOutcome::DirtyBase
        } else if any_other_failure {
            MergeOutcome::OtherFailure
        } else if any_review_ready {
            MergeOutcome::Success
        } else {
            // Nothing merged and no review artifact. Escalate to a human instead
            // of silently marking the issue as merged.
            failures.push("nothing merged and no open PR".to_string());
            MergeOutcome::OtherFailure
        };
        (outcome, failures.join("; "))
    }
}

fn failure_exit_status() -> std::process::ExitStatus {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        ExitStatusExt::from_raw(256) // Exit code 1 (shifted by 8 bits)
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::ExitStatusExt;
        ExitStatusExt::from_raw(1)
    }
}

#[async_trait]
impl ContainerService for LocalContainerService {
    fn msg_stores(&self) -> &Arc<RwLock<HashMap<Uuid, Arc<MsgStore>>>> {
        &self.msg_stores
    }

    fn container_locks(&self) -> &ContainerLocks {
        &self.container_locks
    }

    fn session_start_locks(&self) -> &ContainerLocks {
        &self.session_start_locks
    }

    async fn has_live_child(&self, execution_process_id: Uuid) -> bool {
        self.child_store
            .read()
            .await
            .contains_key(&execution_process_id)
    }

    async fn subagent_handle(&self, id: &Uuid) -> Option<SubagentLiveHandle> {
        let map = self.subagent_handles.read().await;
        map.get(id).cloned()
    }

    fn db(&self) -> &DBService {
        &self.db
    }

    fn events(&self) -> &EventService {
        &self.events
    }

    fn git(&self) -> &GitService {
        &self.git
    }

    fn notification_service(&self) -> &NotificationService {
        &self.notification_service
    }

    fn queued_message_service(&self) -> &QueuedMessageService {
        &self.queued_message_service
    }

    async fn wait_for_session_ready(&self, session_id: Uuid) {
        if tokio::time::timeout(
            SESSION_READY_WAIT_TIMEOUT,
            self.session_finalization.wait_until_ready(session_id),
        )
        .await
        .is_err()
        {
            tracing::warn!(
                session_id = %session_id,
                "Timed out waiting for session finalization; proceeding with possibly stale metadata"
            );
        }
    }

    async fn touch(&self, workspace: &Workspace) -> Result<(), ContainerError> {
        let now = Instant::now();

        // We debounce touches to avoid excessive database writes, which in SQLites causes DB locks
        let should_debounce = |last_touch: &Instant| -> bool {
            now.duration_since(*last_touch) < WORKSPACE_TOUCH_DEBOUNCE
        };

        // Quick check with read lock
        if self
            .workspace_touch_times
            .read()
            .await
            .get(&workspace.id)
            .is_some_and(should_debounce)
        {
            return Ok(());
        }

        let mut map = self.workspace_touch_times.write().await;
        // Clean up stale entries older than the debounce window, reduce memory usage over time
        map.retain(|_, time| should_debounce(time));
        // check in case another thread has touched already
        if map.get(&workspace.id).is_some_and(should_debounce) {
            return Ok(());
        }
        map.insert(workspace.id, now);
        drop(map);

        Workspace::touch(&self.db.pool, workspace.id).await?;
        Ok(())
    }

    async fn store_db_stream_handle(&self, id: Uuid, handle: JoinHandle<()>) {
        self.add_db_stream_handle(id, handle).await;
    }

    async fn take_db_stream_handle(&self, id: &Uuid) -> Option<JoinHandle<()>> {
        LocalContainerService::take_db_stream_handle(self, id).await
    }

    async fn store_normalizer_handles(&self, id: Uuid, handles: Vec<JoinHandle<()>>) {
        self.normalizer_handles.write().await.insert(id, handles);
    }

    async fn take_normalizer_handles(&self, id: &Uuid) -> Vec<JoinHandle<()>> {
        self.normalizer_handles
            .write()
            .await
            .remove(id)
            .unwrap_or_default()
    }

    async fn mark_output_pipeline_ready(&self, id: Uuid) {
        self.output_pipeline.mark_ready(id).await;
    }

    async fn finalize_cancelled_rate_limit_resume(
        &self,
        execution_process_id: Uuid,
    ) -> Result<(), ContainerError> {
        let ctx = ExecutionProcess::load_context(&self.db.pool, execution_process_id).await?;

        if ExecutionProcess::has_running_non_dev_server_processes_for_session(
            &self.db.pool,
            ctx.session.id,
        )
        .await?
        {
            tracing::info!(
                "Skipping cancelled rate-limit finalization for execution {} because session {} has a running process",
                execution_process_id,
                ctx.session.id
            );
            return Ok(());
        }

        let drain_hold = self.queued_message_service.hold_drain(ctx.session.id);
        let finalized = self
            .handle_execution_post_completion(&ctx, ctx.execution_process.exit_code)
            .await;
        drop(drain_hold);
        self.resume_deferred_finalization(ctx.session.id).await?;
        if let Err(e) = self.drain_queue_if_idle(&ctx.session, &ctx.workspace).await {
            tracing::error!("Failed to start queued follow-up: {}", e);
        }
        finalized
    }

    async fn git_branch_prefix(&self) -> String {
        self.config.read().await.git_branch_prefix.clone()
    }

    fn workspace_to_current_dir(&self, workspace: &Workspace) -> PathBuf {
        PathBuf::from(workspace.container_ref.clone().unwrap_or_default())
    }

    async fn create(&self, workspace: &Workspace) -> Result<ContainerRef, ContainerError> {
        if workspace.in_place {
            // In-place ("quick chat") workspaces never materialize a worktree;
            // `container_ref` already points at the user's existing checkout.
            return Ok(workspace.container_ref.clone().unwrap_or_default());
        }
        let label = workspace.name.as_deref().unwrap_or("workspace");
        let workspace_dir_name =
            LocalContainerService::dir_name_from_workspace(&workspace.id, label);
        let workspace_dir = WorkspaceManager::get_workspace_base_dir().join(&workspace_dir_name);

        let (repositories, workspace_inputs) = self.workspace_repo_inputs(workspace.id).await?;

        let created_workspace = WorkspaceManager::create_workspace(
            &workspace_dir,
            &workspace_inputs,
            &workspace.branch,
        )
        .await
        .map_err(Self::map_workspace_manager_error)?;

        // Worktrees now exist on disk but `container_ref` is not yet persisted.
        // If the post-worktree steps fail here, the normal deletion path (which
        // reads `container_ref` from the DB) can't find this directory, leaving
        // an orphaned worktree. Clean it up directly on failure to close that
        // window (matters especially for ephemeral spec-intake workspaces).
        let post_worktree: Result<(), ContainerError> = async {
            // Copy project files and images to workspace
            self.copy_files_and_images(&created_workspace.workspace_dir, workspace)
                .await?;
            Self::create_workspace_config_files(&created_workspace.workspace_dir, &repositories)
                .await?;
            Ok(())
        }
        .await;

        if let Err(e) = post_worktree {
            tracing::error!(
                "Workspace {} setup failed after worktree creation; cleaning up {}: {}",
                workspace.id,
                created_workspace.workspace_dir.display(),
                e
            );
            if let Err(cleanup_err) =
                WorkspaceManager::cleanup_workspace(&created_workspace.workspace_dir, &repositories)
                    .await
            {
                tracing::warn!(
                    "Failed to clean up partially-created workspace {}: {}",
                    workspace.id,
                    cleanup_err
                );
            }
            return Err(e);
        }

        Workspace::update_container_ref(
            &self.db.pool,
            workspace.id,
            &created_workspace.workspace_dir.to_string_lossy(),
        )
        .await?;

        Ok(created_workspace
            .workspace_dir
            .to_string_lossy()
            .to_string())
    }

    async fn delete(&self, workspace: &Workspace) -> Result<(), ContainerError> {
        self.try_stop(workspace, true, None).await?;
        self.cleanup_workspace(workspace, false).await
    }

    async fn ensure_container_exists_unlocked(
        &self,
        workspace: &Workspace,
    ) -> Result<ContainerRef, ContainerError> {
        self.touch(workspace).await?;
        let (repositories, workspace_inputs) = self.workspace_repo_inputs(workspace.id).await?;

        let workspace_dir = if let Some(container_ref) = &workspace.container_ref {
            PathBuf::from(container_ref)
        } else {
            let label = workspace.name.as_deref().unwrap_or("workspace");
            let workspace_dir_name =
                LocalContainerService::dir_name_from_workspace(&workspace.id, label);
            WorkspaceManager::get_workspace_base_dir().join(&workspace_dir_name)
        };

        // In-place ("quick chat"): the agent runs directly in the user's existing
        // checkout. There is no worktree to materialize, and we must NOT copy
        // project files or write CLAUDE.md/AGENTS.md config shims — that would
        // mutate the real repo. `container_ref` is already set, so just return it.
        // Attachments are the exception: they go to the self-ignoring
        // `.vibe-attachments/` dir, so the agent can actually open the files the
        // user attached to the prompt.
        if workspace.in_place {
            self.copy_workspace_attachments(&workspace_dir, workspace)
                .await?;
            return Ok(workspace_dir.to_string_lossy().to_string());
        }

        WorkspaceManager::ensure_workspace_exists(
            &workspace_dir,
            &workspace_inputs,
            &workspace.branch,
        )
        .await
        .map_err(Self::map_workspace_manager_error)?;

        if workspace.container_ref.is_none() {
            Workspace::update_container_ref(
                &self.db.pool,
                workspace.id,
                &workspace_dir.to_string_lossy(),
            )
            .await?;
        }

        if workspace.worktree_deleted {
            Workspace::clear_worktree_deleted(&self.db.pool, workspace.id).await?;
        }

        // Copy project files and images (fast no-op if already exist)
        self.copy_files_and_images(&workspace_dir, workspace)
            .await?;

        Self::create_workspace_config_files(&workspace_dir, &repositories).await?;

        Ok(workspace_dir.to_string_lossy().to_string())
    }

    async fn is_container_clean(&self, workspace: &Workspace) -> Result<bool, ContainerError> {
        let Some(container_ref) = &workspace.container_ref else {
            return Ok(true);
        };

        let workspace_dir = PathBuf::from(container_ref);
        if !workspace_dir.exists() {
            return Ok(true);
        }

        let repositories =
            WorkspaceRepo::find_repos_for_workspace(&self.db.pool, workspace.id).await?;

        for repo in &repositories {
            let worktree_path = workspace_dir.join(&repo.name);
            if worktree_path.exists() {
                let (uncommitted, untracked) =
                    self.git().get_worktree_change_counts(&worktree_path)?;
                if uncommitted > 0 || untracked > 0 {
                    return Ok(false);
                }
            }
        }

        Ok(true)
    }

    async fn start_execution_inner(
        &self,
        workspace: &Workspace,
        execution_process: &ExecutionProcess,
        executor_action: &ExecutorAction,
    ) -> Result<(), ContainerError> {
        // Get the worktree path
        let container_ref = workspace
            .container_ref
            .as_ref()
            .ok_or(ContainerError::Other(anyhow!(
                "Container ref not found for workspace"
            )))?;
        let current_dir = PathBuf::from(container_ref);

        let approvals_service: Arc<dyn ExecutorApprovalService> =
            match executor_action.base_executor() {
                Some(
                    BaseCodingAgent::Codex
                    | BaseCodingAgent::ClaudeCode
                    | BaseCodingAgent::Gemini
                    | BaseCodingAgent::QwenCode
                    | BaseCodingAgent::Opencode,
                ) => ExecutorApprovalBridge::new(
                    self.approvals.clone(),
                    self.db.clone(),
                    self.notification_service.clone(),
                    execution_process.id,
                ),
                _ => Arc::new(NoopExecutorApprovalService {}),
            };

        let repos = WorkspaceRepo::find_repos_for_workspace(&self.db.pool, workspace.id).await?;
        let repo_names: Vec<String> = repos.iter().map(|r| r.name.clone()).collect();
        let repo_context = RepoContext::new(current_dir.clone(), repo_names);

        let config = self.config.read().await;
        let commit_reminder_enabled = config.commit_reminder_enabled;
        let commit_reminder_prompt = config
            .commit_reminder_prompt
            .clone()
            .unwrap_or_else(|| DEFAULT_COMMIT_REMINDER_PROMPT.to_string());
        drop(config);
        let mut env = ExecutionEnv::new(
            repo_context,
            commit_reminder_enabled,
            commit_reminder_prompt,
        );

        // Always inject workspace/session context
        env.insert("VK_WORKSPACE_ID", workspace.id.to_string());
        env.insert("VK_WORKSPACE_BRANCH", &workspace.branch);

        // Create the child and stream, add to execution tracker with timeout
        let mut spawned = tokio::time::timeout(
            Duration::from_secs(30),
            executor_action.spawn(&current_dir, approvals_service, &env),
        )
        .await
        .map_err(|_| {
            ContainerError::Other(anyhow!(
                "Timeout: process took more than 30 seconds to start"
            ))
        })??;

        if let Err(e) = self
            .track_child_msgs_in_store(execution_process.id, &mut spawned.child)
            .await
        {
            let _ = command::kill_process_group(&mut spawned.child).await;
            return Err(e);
        }

        self.add_child_to_store(execution_process.id, spawned.child)
            .await;

        // Store cancellation token for graceful shutdown
        if let Some(cancel) = spawned.cancel {
            self.add_cancellation_token(execution_process.id, cancel)
                .await;
        }

        // Store the live client handle for individual subagent control
        if let Some(handle) = spawned.subagent_handle {
            self.add_subagent_handle(execution_process.id, handle).await;
        }

        // Spawn unified exit monitor: watches OS exit and optional executor signal.
        // Its completion handling drains the queue, so an enqueue meanwhile
        // leaves the message to it; dev servers never drain.
        let drain_hold = (execution_process.run_reason != ExecutionProcessRunReason::DevServer)
            .then(|| {
                self.queued_message_service
                    .hold_drain(execution_process.session_id)
            });
        let hn = self.spawn_exit_monitor(
            &execution_process.id,
            execution_process.session_id,
            spawned.exit_signal,
            drain_hold,
        );
        self.add_exit_monitor_handle(execution_process.id, hn).await;

        Ok(())
    }

    async fn stop_execution(
        &self,
        execution_process: &ExecutionProcess,
        status: ExecutionProcessStatus,
    ) -> Result<(), ContainerError> {
        // If the watcher already claimed it, fall through to the normal stop
        // path, including its late-child registration guard.
        if self
            .complete_pending_execution(
                execution_process.id,
                execution_process.session_id,
                status.clone(),
            )
            .await?
        {
            return Ok(());
        }

        let child = match self.get_child_from_store(&execution_process.id).await {
            Some(child) => child,
            None => {
                // The row is created before the child is registered. A cancelled
                // start request can leave it running forever with no child to
                // kill, so mark it stopped; `finish_execution_spawn` re-reads the
                // row after registering and kills a child that started anyway.
                let marked = ExecutionProcess::update_completion_if_running(
                    &self.db.pool,
                    execution_process.id,
                    status.clone(),
                    None,
                )
                .await?;
                // The child can also be registered between the lookup above and
                // the mark, after that re-read still saw the row running — then
                // nobody would kill it. Look again now the row is marked.
                match self.get_child_from_store(&execution_process.id).await {
                    Some(child) => child,
                    None => {
                        if marked {
                            let completed_process =
                                ExecutionProcess::find_by_id(&self.db.pool, execution_process.id)
                                    .await?
                                    .ok_or_else(|| {
                                        ContainerError::Other(anyhow!(
                                            "Execution process disappeared after stop"
                                        ))
                                    })?;
                            if let Err(error) = self
                                .events
                                .publish_execution_process_update(&completed_process)
                                .await
                            {
                                tracing::error!(
                                    execution_process_id = %execution_process.id,
                                    %error,
                                    "Failed to publish execution stop"
                                );
                            }
                            if status == ExecutionProcessStatus::Killed {
                                self.discard_queue_for_unstarted_turn(execution_process);
                            }
                        }
                        if let Some(msg) =
                            self.msg_stores.write().await.remove(&execution_process.id)
                        {
                            msg.push_finished();
                            msg.push(LogMsg::StorageFinished);
                        }
                        return Ok(());
                    }
                }
            }
        };
        let exit_code = if status == ExecutionProcessStatus::Completed {
            Some(0)
        } else {
            None
        };

        // Serialize this check with mark_ready so a late stop cannot reopen
        // a metadata barrier the monitor has already finished.
        {
            let mut active = self.session_finalization.active.write().await;
            if ExecutionProcess::find_by_id(&self.db.pool, execution_process.id)
                .await?
                .is_some_and(|process| process.status == ExecutionProcessStatus::Running)
            {
                active
                    .entry(execution_process.session_id)
                    .or_default()
                    .insert(execution_process.id);
            }
        }
        let completed_process = ExecutionProcess::update_completion(
            &self.db.pool,
            execution_process.id,
            status,
            exit_code,
        )
        .await?;
        if let Err(error) = self
            .events
            .publish_execution_process_update(&completed_process)
            .await
        {
            tracing::error!(
                execution_process_id = %execution_process.id,
                %error,
                "Failed to publish execution stop"
            );
        }

        // Try graceful cancellation first, then force kill
        if let Some(cancel) = self.take_cancellation_token(&execution_process.id).await {
            cancel.cancel();
            // The exit monitor keeps running detached; drop its handle.
            self.take_exit_monitor_handle(&execution_process.id).await;

            // The monitor also drains logs and finalizes the turn; only wait
            // for process exit here so that work cannot delay the stop response.
            let exited = async {
                while matches!(child.write().await.try_wait(), Ok(None)) {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            };
            match tokio::time::timeout(GRACEFUL_STOP_TIMEOUT, exited).await {
                Ok(()) => {
                    tracing::debug!("Process {} exited gracefully", execution_process.id);
                }
                Err(_) => {
                    tracing::debug!(
                        "Graceful shutdown timed out for process {}, force killing",
                        execution_process.id
                    );
                }
            }
        }

        {
            let mut child_guard = child.write().await;
            if let Err(e) = command::kill_process_group(&mut child_guard).await {
                tracing::error!(
                    "Failed to stop execution process {}: {}",
                    execution_process.id,
                    e
                );
                return Err(e);
            }
        }
        self.remove_child_from_store(&execution_process.id).await;
        self.remove_subagent_handle(&execution_process.id).await;

        // The exit monitor owns output drain, normalizer shutdown, storage
        // shutdown, and MsgStore removal. Do not race that pipeline here:
        // terminating storage early can discard normalized metadata produced
        // after a slow forwarder finishes.

        tracing::debug!(
            "Execution process {} stopped successfully",
            execution_process.id
        );

        // Record after-head commit OID (best-effort)
        self.update_after_head_commits(execution_process.id).await;

        Ok(())
    }

    async fn stream_diff(
        &self,
        workspace: &Workspace,
        stats_only: bool,
    ) -> Result<futures::stream::BoxStream<'static, Result<LogMsg, std::io::Error>>, ContainerError>
    {
        let workspace_repos =
            WorkspaceRepo::find_by_workspace_id(&self.db.pool, workspace.id).await?;
        let target_branches: HashMap<_, _> = workspace_repos
            .iter()
            .map(|wr| (wr.repo_id, wr.target_branch.clone()))
            .collect();

        let repositories =
            WorkspaceRepo::find_repos_for_workspace(&self.db.pool, workspace.id).await?;

        let mut streams = Vec::new();

        // A worktree-deleted workspace (archived / cleaned up) has no live
        // checkout to diff. Recreating it here is undesirable (it's archived)
        // and can fail indefinitely when its branch is now held by another
        // worktree — which spun a fail-retry loop in the diff WS. Show an empty
        // diff instead. In-place workspaces never have a deletable worktree.
        if workspace.worktree_deleted && !workspace.in_place {
            return Ok(Box::pin(futures::stream::empty()));
        }

        let container_ref = self.ensure_container_exists(workspace).await?;
        let workspace_root = PathBuf::from(container_ref);

        for repo in repositories {
            // In-place ("quick chat") workspaces run in the repo root itself, so
            // the worktree path IS `container_ref` (not a per-repo subdir). The
            // workspace branch equals the repo's current branch, so the diff base
            // resolves to HEAD and the Changes view shows uncommitted edits.
            let worktree_path = if workspace.in_place {
                workspace_root.clone()
            } else {
                workspace_root.join(&repo.name)
            };
            let branch = &workspace.branch;

            let Some(target_branch) = target_branches.get(&repo.id) else {
                tracing::warn!(
                    "Skipping diff stream for repo {}: no target branch configured",
                    repo.name
                );
                continue;
            };

            let base_commit = match self
                .git()
                .get_base_commit(&repo.path, branch, target_branch)
            {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!(
                        "Skipping diff stream for repo {}: failed to get base commit: {}",
                        repo.name,
                        e
                    );
                    continue;
                }
            };

            let stream = self
                .create_live_diff_stream(diff_stream::DiffStreamArgs {
                    git_service: self.git().clone(),
                    db: self.db().clone(),
                    workspace_id: workspace.id,
                    repo_id: repo.id,
                    repo_path: repo.path.clone(),
                    worktree_path: worktree_path.clone(),
                    branch: branch.to_string(),
                    target_branch: target_branch.clone(),
                    base_commit: base_commit.clone(),
                    stats_only,
                    path_prefix: Some(repo.name.clone()),
                })
                .await?;

            streams.push(Box::pin(stream));
        }

        if streams.is_empty() {
            return Ok(Box::pin(futures::stream::empty()));
        }

        // Merge all streams into one
        Ok(Box::pin(futures::stream::select_all(streams)))
    }

    async fn try_commit_changes(&self, ctx: &ExecutionContext) -> Result<bool, ContainerError> {
        // In-place ("quick chat") runs leave the agent's edits uncommitted in the
        // user's working tree for them to review and commit with their own git.
        if ctx.workspace.in_place {
            return Ok(false);
        }

        if !matches!(
            ctx.execution_process.run_reason,
            ExecutionProcessRunReason::CodingAgent | ExecutionProcessRunReason::CleanupScript,
        ) {
            return Ok(false);
        }

        let message = self.get_commit_message(ctx).await;

        let container_ref = ctx
            .workspace
            .container_ref
            .as_ref()
            .ok_or_else(|| ContainerError::Other(anyhow!("Container reference not found")))?;
        let workspace_root = PathBuf::from(container_ref);

        let repos_with_changes = self.check_repos_for_changes(&workspace_root, &ctx.repos)?;
        if repos_with_changes.is_empty() {
            tracing::debug!("No changes to commit in any repository");
            return Ok(false);
        }

        Ok(self.commit_repos(repos_with_changes, &message))
    }

    /// Copy files from the original project directory to the worktree.
    /// Skips files that already exist at target with same size.
    async fn copy_project_files(
        &self,
        source_dir: &Path,
        target_dir: &Path,
        copy_files: &str,
    ) -> Result<(), ContainerError> {
        let source_dir = source_dir.to_path_buf();
        let target_dir = target_dir.to_path_buf();
        let copy_files = copy_files.to_string();

        tokio::time::timeout(
            std::time::Duration::from_secs(30),
            tokio::task::spawn_blocking(move || {
                copy::copy_project_files_impl(&source_dir, &target_dir, &copy_files)
            }),
        )
        .await
        .map_err(|_| ContainerError::Other(anyhow!("Copy project files timed out after 30s")))?
        .map_err(|e| ContainerError::Other(anyhow!("Copy files task failed: {e}")))?
    }

    async fn kill_all_running_processes(&self) -> Result<(), ContainerError> {
        tracing::info!("Killing all running processes");
        let running_processes = ExecutionProcess::find_running(&self.db.pool).await?;

        tracing::info!(
            "Found {} running processes to kill",
            running_processes.len()
        );

        for process in running_processes {
            tracing::info!(
                "Killing process: id={}, run_reason={:?}",
                process.id,
                process.run_reason
            );
            if let Err(error) = self
                .stop_execution(&process, ExecutionProcessStatus::Killed)
                .await
            {
                tracing::error!(
                    "Failed to cleanly kill running execution process {:?}: {:?}",
                    process,
                    error
                );
            } else {
                tracing::info!("Successfully killed process: id={}", process.id);
            }
        }

        Ok(())
    }

    /// Manually drive a workspace into the automated `vibe` review phase, as if
    /// its coding agent had just emitted `VIBE_RESULT: done`. Used by the "review"
    /// button next to send: it materializes the run row (so the review verdict →
    /// merge half of the workflow takes over), mirrors the `vibe`/`vibe-done`
    /// issue tags, and spawns the dedicated review session.
    async fn vibe_manual_start_review(
        &self,
        workspace: &Workspace,
        session: &Session,
        executor_config: Option<ExecutorConfig>,
    ) -> Result<Session, ContainerError> {
        let Some(task_id) = workspace.task_id else {
            return Err(ContainerError::Other(anyhow!(
                "vibe: cannot start review for a workspace with no linked issue"
            )));
        };
        let Some(client) = self.remote_client.clone() else {
            return Err(ContainerError::Other(anyhow!(
                "vibe: remote client unavailable, cannot start review"
            )));
        };

        // Materialize the run row so the rest of the automated workflow (review
        // verdict → merge) takes over from here, exactly as it would after an
        // organic `VIBE_RESULT: done`.
        VibeRun::get_or_create(&self.db.pool, workspace.id, task_id)
            .await
            .map_err(|e| ContainerError::Other(anyhow!("vibe get_or_create failed: {e}")))?;

        // Best-effort issue tags mirroring the organic coding→review transition:
        // `vibe` opts the issue into the workflow, `vibe-done` marks coding done.
        // Two cloud round trips the review session doesn't depend on, so they
        // run off the request path.
        {
            let this = self.clone();
            let client = client.clone();
            tokio::spawn(async move {
                this.vibe_tag(&client, task_id, vibe_orchestrator::TAG_VIBE)
                    .await;
                this.vibe_tag(&client, task_id, vibe_orchestrator::TAG_DONE)
                    .await;
            });
        }

        // Answer with the review session as soon as it exists so the UI can
        // switch to it; the agent spawn follows in the background. A start that
        // fails there blocks the run (as the workflow's Block does), so anything
        // waiting on the review — "review and create PR" — stops instead of
        // polling until its timeout.
        let prompt = vibe_orchestrator::with_review_preamble(vibe_orchestrator::PROMPT_REVIEW_A);
        let (review_session, executor_config) = self
            .vibe_create_review_session(workspace, session, executor_config)
            .await?;
        // The phase moves now, not after the spawn: the caller polls it right
        // away and would otherwise read a previous run's `blocked` / `done`.
        VibeRun::begin_review(&self.db.pool, workspace.id, review_session.id)
            .await
            .map_err(|e| ContainerError::Other(anyhow!("vibe begin_review failed: {e}")))?;
        {
            let this = self.clone();
            let workspace = workspace.clone();
            let review = review_session.clone();
            tokio::spawn(async move {
                if let Err(e) = this
                    .vibe_spawn_review_agent(&workspace, &review, &prompt, executor_config)
                    .await
                {
                    tracing::error!(
                        "vibe: manual review for workspace {} failed to start: {}",
                        workspace.id,
                        e
                    );
                    let _ = VibeRun::set_phase(
                        &this.db.pool,
                        workspace.id,
                        VibePhase::Blocked.as_str(),
                    )
                    .await;
                    this.vibe_tag(&client, task_id, vibe_orchestrator::TAG_BLOCK)
                        .await;
                }
            });
        }
        Ok(review_session)
    }
}
fn success_exit_status() -> std::process::ExitStatus {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        ExitStatusExt::from_raw(0)
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::ExitStatusExt;
        ExitStatusExt::from_raw(0)
    }
}

#[cfg(test)]
mod tests {
    use db::models::scratch::DraftFollowUpData;
    use executors::logs::{
        NormalizedEntry, NormalizedEntryError, RateLimitInfo, utils::patch::ConversationPatch,
    };

    use super::*;

    fn rate_limit_msg(resets_at: Option<&str>) -> LogMsg {
        LogMsg::JsonPatch(ConversationPatch::add_normalized_entry(
            0,
            NormalizedEntry {
                timestamp: None,
                entry_type: NormalizedEntryType::RateLimitInfo(RateLimitInfo {
                    limit_reached: true,
                    resets_at: resets_at.map(str::to_string),
                    scope: Some("5h".to_string()),
                }),
                content: "Usage rate limit reached".to_string(),
                metadata: None,
            },
        ))
    }

    #[test]
    fn result_sentinel_is_read_from_the_last_message_only() {
        let message = |index, content: &str| {
            LogMsg::JsonPatch(ConversationPatch::add_normalized_entry(
                index,
                NormalizedEntry {
                    timestamp: None,
                    entry_type: NormalizedEntryType::AssistantMessage,
                    content: content.to_string(),
                    metadata: None,
                },
            ))
        };
        // The final message is only a summary: no sentinel, even though an
        // earlier message of the turn mentioned one.
        let msgs = vec![
            message(0, "I will end with VIBE_RESULT: approve"),
            message(1, "```vibe-status\nDone.\n```"),
        ];
        assert_eq!(
            LocalContainerService::last_assistant_message_full_from_msgs(&msgs).as_deref(),
            Some("")
        );
        let msgs = vec![
            message(0, "earlier"),
            message(1, "```vibe-status\nDone.\n```\nVIBE_RESULT: approve"),
        ];
        assert_eq!(
            LocalContainerService::last_assistant_message_full_from_msgs(&msgs).as_deref(),
            Some("VIBE_RESULT: approve")
        );
    }

    #[test]
    fn rate_limit_reset_hint_detects_in_memory_patch() {
        let reset_at = "2026-06-18T12:00:00+00:00";
        let msgs = vec![rate_limit_msg(Some(reset_at))];

        assert_eq!(
            LocalContainerService::rate_limit_reset_hint_from_msgs(&msgs),
            Some(Some(reset_at.to_string()))
        );
    }

    #[test]
    fn rate_limit_reset_hint_requires_limit_reached_entry() {
        let msgs = vec![LogMsg::Stdout("not a rate-limit patch".to_string())];

        assert_eq!(
            LocalContainerService::rate_limit_reset_hint_from_msgs(&msgs),
            None
        );
    }

    #[test]
    fn capacity_error_only_counts_error_entries() {
        let entry = |entry_type, content: &str| {
            LogMsg::JsonPatch(ConversationPatch::add_normalized_entry(
                0,
                NormalizedEntry {
                    timestamp: None,
                    entry_type,
                    content: content.to_string(),
                    metadata: None,
                },
            ))
        };
        // Codex stderr form, and the app-server `ServerNotification::Error`
        // form — the one real capacity failures actually take.
        let capacity = "Error: Selected model is at capacity\n";
        let capacity_app_server =
            "Error: Selected model is at capacity. Please try a different model.";

        for content in [capacity, capacity_app_server] {
            assert!(LocalContainerService::capacity_error_in_msgs(&[entry(
                NormalizedEntryType::ErrorMessage {
                    error_type: NormalizedEntryError::Other,
                },
                content,
            )]));
        }
        // An agent quoting the phrase is not a failed turn.
        assert!(!LocalContainerService::capacity_error_in_msgs(&[entry(
            NormalizedEntryType::AssistantMessage,
            capacity,
        )]));
        assert!(!LocalContainerService::capacity_error_in_msgs(&[entry(
            NormalizedEntryType::ErrorMessage {
                error_type: NormalizedEntryError::Other,
            },
            "Error: something else\n",
        )]));
    }

    #[test]
    fn resume_at_uses_reported_reset_plus_margin() {
        // The exact epoch from the live failure: resetsAt 1785751800.
        let reset = "2026-08-03T10:10:00+00:00";
        let now = chrono::DateTime::parse_from_rfc3339("2026-08-03T09:21:00+00:00")
            .unwrap()
            .with_timezone(&Utc);
        let resume_at = LocalContainerService::resume_at_from_hint(Some(reset), now);
        // reset + 60s margin, precisely — not the 5h fallback.
        assert_eq!(resume_at.to_rfc3339(), "2026-08-03T10:11:00+00:00");
    }

    #[test]
    fn resume_at_falls_back_when_reset_is_past_or_missing() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-08-03T12:00:00+00:00")
            .unwrap()
            .with_timezone(&Utc);
        let fallback =
            now + chrono::Duration::seconds(LocalContainerService::RATE_LIMIT_RESUME_DELAY_SECS);
        // A reset already in the past is ignored in favor of the conservative
        // window, so a stale hint can never schedule a resume in the past.
        assert_eq!(
            LocalContainerService::resume_at_from_hint(Some("2026-08-03T10:10:00+00:00"), now),
            fallback
        );
        // No hint at all -> same conservative window.
        assert_eq!(
            LocalContainerService::resume_at_from_hint(None, now),
            fallback
        );
    }

    #[tokio::test]
    async fn session_finalization_barrier_waits_for_every_active_process() {
        let barrier = SessionFinalizationBarrier::default();
        let session_id = Uuid::new_v4();
        let first_execution_id = Uuid::new_v4();
        let second_execution_id = Uuid::new_v4();

        barrier.mark_active(session_id, first_execution_id).await;
        barrier.mark_active(session_id, second_execution_id).await;
        assert!(
            tokio::time::timeout(
                Duration::from_millis(10),
                barrier.wait_until_ready(session_id)
            )
            .await
            .is_err()
        );

        barrier.mark_ready(session_id, first_execution_id).await;
        assert!(
            tokio::time::timeout(
                Duration::from_millis(10),
                barrier.wait_until_ready(session_id)
            )
            .await
            .is_err()
        );

        barrier.mark_ready(session_id, second_execution_id).await;
        tokio::time::timeout(
            Duration::from_millis(10),
            barrier.wait_until_ready(session_id),
        )
        .await
        .expect("barrier should open after every process is ready");
    }

    #[tokio::test]
    async fn session_finalization_barrier_registers_an_execution_idempotently() {
        let barrier = SessionFinalizationBarrier::default();
        let session_id = Uuid::new_v4();
        let execution_id = Uuid::new_v4();

        barrier.mark_active(session_id, execution_id).await;
        barrier.mark_active(session_id, execution_id).await;
        barrier.mark_ready(session_id, execution_id).await;

        tokio::time::timeout(
            Duration::from_millis(10),
            barrier.wait_until_ready(session_id),
        )
        .await
        .expect("one ready transition should clear duplicate registrations");
    }

    #[tokio::test]
    async fn output_pipeline_barrier_handles_ready_before_and_after_wait() {
        let barrier = Arc::new(OutputPipelineBarrier::default());
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();

        barrier.mark_ready(first).await;
        tokio::time::timeout(Duration::from_millis(10), barrier.wait_until_ready(first))
            .await
            .expect("an already-ready pipeline should not block");

        let waiting = tokio::spawn({
            let barrier = barrier.clone();
            async move { barrier.wait_until_ready(second).await }
        });
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        barrier.mark_ready(second).await;
        tokio::time::timeout(Duration::from_millis(10), waiting)
            .await
            .expect("pipeline waiter should be notified")
            .expect("pipeline waiter should not panic");
    }

    /// Codex's app server stays up after `turn/completed`, so the exit monitor
    /// kills it and drains stdout before it reaches the queue. The live subagent
    /// handle stays registered until the monitor ends; if it kept the stdout
    /// writer open, every queued follow-up would wait out the drain timeout.
    #[cfg(unix)]
    #[tokio::test]
    async fn codex_turn_completion_reaches_the_queue_without_the_drain_timeout() {
        use db::models::{
            execution_process::CreateExecutionProcess, scratch::DraftFollowUpData,
            workspace::CreateWorkspace,
        };
        use executors::{
            executors::{CodingAgent, StandardCodingAgentExecutor},
            profile::{ExecutorConfigs, ExecutorProfileId},
        };

        // Answers one turn with a tool output, a subagent event and a final
        // message, then idles like the real one.
        const FAKE_APP_SERVER: &str = r#"
while IFS= read -r line; do
  id=$(printf '%s\n' "$line" | sed -n 's/^{"method":"[^"]*","id":\([0-9]*\).*/\1/p')
  case "$line" in
    '{"method":"initialize"'*)
      echo "{\"id\":$id,\"result\":{\"userAgent\":\"fake\",\"codexHome\":\"/tmp\",\"platformFamily\":\"unix\",\"platformOs\":\"test\"}}" ;;
    '{"method":"account/read"'*)
      echo "{\"id\":$id,\"result\":{\"requiresOpenaiAuth\":false}}" ;;
    '{"method":"thread/start"'*)
      echo "{\"id\":$id,\"result\":{\"thread\":{\"id\":\"t\",\"sessionId\":\"t\",\"preview\":\"\",\"ephemeral\":false,\"modelProvider\":\"fake\",\"createdAt\":0,\"updatedAt\":0,\"status\":{\"type\":\"idle\"},\"cwd\":\"/tmp\",\"cliVersion\":\"0\",\"source\":\"appServer\",\"turns\":[]},\"model\":\"fake\",\"modelProvider\":\"fake\",\"cwd\":\"/tmp\",\"approvalPolicy\":\"never\",\"approvalsReviewer\":\"user\",\"sandbox\":{\"type\":\"dangerFullAccess\"}}}" ;;
    '{"method":"turn/start"'*)
      echo "{\"id\":$id,\"result\":{\"turn\":{\"id\":\"u\",\"items\":[],\"status\":\"inProgress\"}}}"
      echo '{"method":"item/completed","params":{"threadId":"t","turnId":"u","completedAtMs":0,"item":{"type":"commandExecution","id":"c","command":"true","cwd":"/tmp","status":"completed","commandActions":[],"aggregatedOutput":"TOOL_OUTPUT","exitCode":0}}}'
      echo '{"method":"item/completed","params":{"threadId":"child","turnId":"x","completedAtMs":0,"item":{"type":"agentMessage","id":"s","text":"SUBAGENT_NOTE"}}}'
      echo '{"method":"item/completed","params":{"threadId":"t","turnId":"u","completedAtMs":0,"item":{"type":"agentMessage","id":"m","text":"FINAL_ANSWER"}}}'
      echo '{"method":"turn/completed","params":{"threadId":"t","turn":{"id":"u","items":[],"status":"completed"}}}' ;;
  esac
done
"#;

        let dir = tempfile::tempdir().unwrap();
        let server = dir.path().join("app-server.sh");
        std::fs::write(&server, FAKE_APP_SERVER).unwrap();
        let Some(CodingAgent::Codex(mut codex)) = ExecutorConfigs::from_defaults()
            .get_coding_agent(&ExecutorProfileId::new(BaseCodingAgent::Codex))
        else {
            panic!("default Codex profile");
        };
        codex.cmd.base_command_override = Some(format!("sh {}", server.display()));

        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
        let workspace = Workspace::create(
            &pool,
            &CreateWorkspace {
                branch: "vk/codex-queue".into(),
                name: None,
            },
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        let session = Session::create(
            &pool,
            &CreateSession {
                executor: Some(BaseCodingAgent::Codex.to_string()),
                variant: None,
                name: None,
            },
            Uuid::new_v4(),
            workspace.id,
        )
        .await
        .unwrap();
        let process = ExecutionProcess::create(
            &pool,
            &CreateExecutionProcess {
                session_id: session.id,
                executor_action: ExecutorAction::new(
                    ExecutorActionType::CodingAgentInitialRequest(CodingAgentInitialRequest {
                        prompt: "hi".into(),
                        executor_config: ExecutorConfig::new(BaseCodingAgent::Codex),
                        working_dir: None,
                        handoff_from: None,
                        handoff_session_id: None,
                        handoff_user_prompt: None,
                    }),
                    None,
                ),
                run_reason: ExecutionProcessRunReason::CodingAgent,
            },
            Uuid::new_v4(),
            &[],
        )
        .await
        .unwrap();

        let container = container_on(pool.clone());

        // Same wiring as `start_execution`.
        let store = Arc::new(MsgStore::new());
        container
            .msg_stores
            .write()
            .await
            .insert(process.id, store.clone());
        let env = ExecutionEnv::new(Default::default(), false, String::new());
        let mut spawned = codex.spawn(dir.path(), "hi", &env).await.unwrap();
        container
            .track_child_msgs_in_store(process.id, &mut spawned.child)
            .await
            .unwrap();
        container
            .store_normalizer_handles(process.id, codex.normalize_logs(store.clone(), dir.path()))
            .await;
        container
            .add_child_to_store(process.id, spawned.child)
            .await;
        container
            .add_subagent_handle(process.id, spawned.subagent_handle.unwrap())
            .await;
        container.mark_output_pipeline_ready(process.id).await;
        // Another executor fails to start before creating a process row.
        container.queued_message_service.enqueue(
            session.id,
            DraftFollowUpData {
                message: "next".into(),
                executor_config: ExecutorConfig::new(BaseCodingAgent::ClaudeCode),
            },
        );

        // The monitor attempts the queued follow-up last; ~4s of it is the kill.
        tokio::time::timeout(
            Duration::from_secs(20),
            container.spawn_exit_monitor(
                &process.id,
                session.id,
                spawned.exit_signal,
                Some(container.queued_message_service.hold_drain(session.id)),
            ),
        )
        .await
        .expect("the queued follow-up waited for the stdout drain timeout")
        .unwrap();

        // A failed follow-up is restored for an explicit retry. Its error proves
        // the monitor reached the queue without waiting for the drain timeout.
        let queued = container.queued_message_service.get_queued(session.id);
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].data.message, "next");
        assert!(queued[0].start_error.is_some());
        assert!(
            container
                .queued_message_service
                .take_next(session.id)
                .is_none()
        );
        let process = ExecutionProcess::find_by_id(&pool, process.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(process.status, ExecutionProcessStatus::Completed);
        let history = store.get_history();
        let stdout: String = history
            .iter()
            .filter_map(|msg| match msg {
                LogMsg::Stdout(chunk) => Some(chunk.as_str()),
                _ => None,
            })
            .collect();
        for line in [
            "TOOL_OUTPUT",
            "SUBAGENT_NOTE",
            "FINAL_ANSWER",
            "turn/completed",
        ] {
            assert!(stdout.contains(line), "{line} missing from the saved logs");
        }
        assert!(history.iter().any(|msg| {
            matches!(msg, LogMsg::JsonPatch(patch)
            if extract_normalized_entry_from_patch(patch).is_some_and(|(_, entry)| {
                matches!(entry.entry_type, NormalizedEntryType::AssistantMessage)
                    && entry.content == "FINAL_ANSWER"
            }))
        }));
    }

    /// Regression for the "no changes made" early-finalize path (scenario A).
    ///
    /// A coding agent that completes successfully *without* making changes is
    /// still a terminal turn whose queued follow-up must be executed, not left
    /// stuck in the in-memory queue forever. Both the normal `should_finalize`
    /// path and the no-changes early-finalize path now run through
    /// `finalize_with_queued_followup`, which consumes the queue iff this
    /// predicate holds — so a `Completed` status (the no-changes success case)
    /// must execute the queue; only `Failed`/`Killed` discard it.
    #[test]
    fn completed_turn_executes_queued_followup_even_without_changes() {
        assert!(LocalContainerService::should_execute_queued_message(
            &ExecutionProcessStatus::Completed
        ));
        assert!(!LocalContainerService::should_execute_queued_message(
            &ExecutionProcessStatus::Failed
        ));
        assert!(!LocalContainerService::should_execute_queued_message(
            &ExecutionProcessStatus::Killed
        ));
    }

    #[test]
    fn agent_image_cache_prune_evicts_oldest_and_leaves_foreign_files() {
        use std::time::{Duration, SystemTime};

        let dir = tempfile::tempdir().unwrap();
        let write = |name: &str, len: usize, age_secs: u64| {
            let path = dir.path().join(name);
            std::fs::write(&path, vec![b'x'; len]).unwrap();
            std::fs::File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000 - age_secs))
                .unwrap();
        };
        write("agent-oldest.png", 100, 300);
        write("agent-middle.png", 100, 200);
        write("agent-newest.png", 100, 100);
        write("not-ours.png", 100, 400);

        // Under budget: nothing is touched.
        let stats = prune_agent_image_cache(dir.path(), 1_000).unwrap();
        assert_eq!(stats.removed_files, 0);
        assert_eq!(stats.retained_bytes, 300, "foreign files are not counted");

        // Over budget: oldest go first, and only ours are eligible.
        let stats = prune_agent_image_cache(dir.path(), 150).unwrap();
        assert_eq!(stats.removed_files, 2);
        assert_eq!(stats.removed_bytes, 200);
        assert_eq!(stats.retained_bytes, 100);
        assert!(!dir.path().join("agent-oldest.png").exists());
        assert!(!dir.path().join("agent-middle.png").exists());
        assert!(dir.path().join("agent-newest.png").exists());
        assert!(dir.path().join("not-ours.png").exists());

        // A cache that was never created is not an error.
        let missing = dir.path().join("nope");
        assert_eq!(
            prune_agent_image_cache(&missing, 0).unwrap().removed_files,
            0
        );
    }

    #[test]
    fn stale_cargo_cleanup_keeps_source_release_and_busy_targets() {
        let root = tempfile::tempdir().unwrap();
        let root_debug = root.path().join("target/debug");
        let nested_debug = root.path().join("crates/remote/target/debug");
        let busy_debug = root.path().join("other/target/debug");
        for debug in [&root_debug, &nested_debug, &busy_debug] {
            std::fs::create_dir_all(debug.join("incremental")).unwrap();
            std::fs::write(debug.join(".cargo-lock"), []).unwrap();
            std::fs::write(debug.join("incremental/artifact"), b"cache").unwrap();
        }
        std::fs::create_dir_all(root.path().join("target/release")).unwrap();
        std::fs::write(root.path().join("target/release/keep"), b"release").unwrap();
        std::fs::write(root.path().join("source.rs"), b"source").unwrap();

        let busy_lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(busy_debug.join(".cargo-lock"))
            .unwrap();
        busy_lock.try_lock().unwrap();

        let first = prune_stale_cargo_debug_caches(root.path()).unwrap();
        assert_eq!(first.removed_targets, 2);
        assert_eq!(first.busy_targets, 1);
        assert!(first.removed_bytes > 0);
        assert!(!root_debug.join("incremental/artifact").exists());
        assert!(!nested_debug.join("incremental/artifact").exists());
        assert!(root_debug.join(".cargo-lock").exists());
        assert!(nested_debug.join(".cargo-lock").exists());
        assert!(busy_debug.join("incremental/artifact").exists());
        drop(busy_lock);
        let second = prune_stale_cargo_debug_caches(root.path()).unwrap();
        assert_eq!(second.removed_targets, 1);
        assert_eq!(second.busy_targets, 0);
        assert!(!busy_debug.join("incremental/artifact").exists());
        assert_eq!(
            std::fs::read(root.path().join("target/release/keep")).unwrap(),
            b"release"
        );
        assert_eq!(
            std::fs::read(root.path().join("source.rs")).unwrap(),
            b"source"
        );
    }

    #[test]
    fn extra_cargo_cache_cleanup_enforces_size_and_free_space_limits() {
        fn target(root: &Path, name: &str, bytes: usize) -> PathBuf {
            let target = root.join(name);
            let debug = target.join("debug");
            std::fs::create_dir_all(&debug).unwrap();
            std::fs::write(debug.join(".cargo-lock"), []).unwrap();
            std::fs::write(debug.join("cache"), vec![0; bytes]).unwrap();
            target
        }

        let size_root = tempfile::tempdir().unwrap();
        let large = target(size_root.path(), "large", 30);
        let medium = target(size_root.path(), "medium", 20);
        let small = target(size_root.path(), "small", 10);
        let report = prune_extra_cargo_targets(
            vec![small.clone(), medium.clone(), large.clone()],
            100,
            25,
            0,
        )
        .unwrap();
        assert_eq!(report.total_bytes_before, 60);
        assert_eq!(report.stats.removed_targets, 2);
        assert_eq!(report.stats.removed_bytes, 50);
        assert!(!large.join("debug/cache").exists());
        assert!(!medium.join("debug/cache").exists());
        assert!(small.join("debug/cache").exists());

        let free_root = tempfile::tempdir().unwrap();
        let larger = target(free_root.path(), "larger", 10);
        let smaller = target(free_root.path(), "smaller", 8);
        let report =
            prune_extra_cargo_targets(vec![smaller.clone(), larger.clone()], 2, 100, 11).unwrap();
        assert_eq!(report.stats.removed_targets, 1);
        assert_eq!(report.stats.removed_bytes, 10);
        assert!(!larger.join("debug/cache").exists());
        assert!(smaller.join("debug/cache").exists());
    }

    #[test]
    fn cargo_cache_discovery_includes_checkout_and_shared_target() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("crates/local-deployment")).unwrap();
        std::fs::create_dir_all(root.path().join("npx-cli/dist")).unwrap();
        std::fs::write(
            root.path().join("crates/local-deployment/Cargo.toml"),
            b"[package]",
        )
        .unwrap();
        let home = root.path().join("home");

        assert_eq!(
            checkout_cargo_target_dirs(&root.path().join("npx-cli/dist"), Some(&home)),
            vec![
                root.path().join("target"),
                root.path().join("crates/remote/target"),
                root.path().join("crates/relay-tunnel/target"),
                home.join(".cache/vk-agents-target"),
            ]
        );
    }

    #[test]
    fn docker_build_detection_ignores_non_build_commands() {
        assert!(is_docker_build_command(
            "/usr/local/bin/docker buildx build --load ."
        ));
        assert!(is_docker_build_command("docker compose -f dev.yml build"));
        assert!(is_docker_build_command("buildctl --addr local build"));
        assert!(!is_docker_build_command("docker builder prune --force"));
        assert!(!is_docker_build_command("docker ps"));
    }

    /// Decision table for [`LocalContainerService::plan_post_completion`].
    ///
    /// The scenario-A regression lives in the first case: a turn that completes
    /// successfully *without* changes (`success_or_cleanup = true`,
    /// `should_start_next = false`) must take the queue-draining finalize path
    /// (`finalize_with_queue = Some(false)`), never start a next action, and must
    /// NOT depend on `should_finalize`/`has_chained` (early-finalize wins). The
    /// original bug skipped queue consumption entirely on this path.
    #[test]
    fn plan_post_completion_decision_table() {
        // Scenario A: success, no changes -> drain queue via early finalize.
        // should_finalize/has_chained set true to prove they don't matter here.
        assert_eq!(
            LocalContainerService::plan_post_completion(true, false, true, true),
            PostCompletionPlan {
                start_next: false,
                log_skip_cleanup: true,
                finalize_with_queue: Some(false),
            }
        );

        // Success with changes, not the last action -> start next, no finalize yet.
        assert_eq!(
            LocalContainerService::plan_post_completion(true, true, false, false),
            PostCompletionPlan {
                start_next: true,
                log_skip_cleanup: false,
                finalize_with_queue: None,
            }
        );

        // A failed/stopped cleanup with more chained -> finalize once, carrying
        // has_chained, without starting the rest (they'd finalize again).
        assert_eq!(
            LocalContainerService::plan_post_completion(true, true, true, true),
            PostCompletionPlan {
                start_next: false,
                log_skip_cleanup: false,
                finalize_with_queue: Some(true),
            }
        );

        // Not in success block (e.g. failed/killed) but should_finalize -> finalize only.
        assert_eq!(
            LocalContainerService::plan_post_completion(false, false, true, false),
            PostCompletionPlan {
                start_next: false,
                log_skip_cleanup: false,
                finalize_with_queue: Some(false),
            }
        );

        // Nothing to do (not success, not finalizing) -> no side effects.
        assert_eq!(
            LocalContainerService::plan_post_completion(false, false, false, false),
            PostCompletionPlan {
                start_next: false,
                log_skip_cleanup: false,
                finalize_with_queue: None,
            }
        );
    }

    /// Container over an in-memory DB. Built by hand rather than with `new()`
    /// so the background workspace cleanup never runs against real worktrees.
    async fn queue_test_container() -> (LocalContainerService, Session, Workspace) {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
        let workspace = Workspace::create(
            &pool,
            &db::models::workspace::CreateWorkspace {
                branch: "vk/queue".into(),
                name: None,
            },
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        let session = Session::create(
            &pool,
            &CreateSession {
                executor: Some(BaseCodingAgent::ClaudeCode.to_string()),
                variant: None,
                name: None,
            },
            Uuid::new_v4(),
            workspace.id,
        )
        .await
        .unwrap();
        (container_on(pool), session, workspace)
    }

    /// The container over `pool`, built by hand rather than with `new()` so
    /// the background workspace cleanup never runs against real worktrees.
    /// Notifications are off.
    pub(super) fn container_on(pool: sqlx::SqlitePool) -> LocalContainerService {
        let db = DBService { pool: pool.clone() };
        let mut config = Config::default();
        config.notifications.sound_enabled = false;
        config.notifications.push_enabled = false;
        let config = Arc::new(RwLock::new(config));
        LocalContainerService {
            events: EventService::new(db.clone(), Arc::new(MsgStore::new()), Default::default()),
            workspace_manager: WorkspaceManager::new(db.clone()),
            db,
            child_store: Default::default(),
            cancellation_tokens: Default::default(),
            subagent_handles: Default::default(),
            msg_stores: Default::default(),
            db_stream_handles: Default::default(),
            forwarder_handles: Default::default(),
            normalizer_handles: Default::default(),
            exit_monitor_handles: Default::default(),
            output_pipeline: Default::default(),
            session_finalization: Default::default(),
            deferred_finalizations: Default::default(),
            workspace_touch_times: Default::default(),
            container_locks: Default::default(),
            session_start_locks: Default::default(),
            notification_service: NotificationService::new(config.clone(), pool.clone(), None),
            config,
            git: GitService::new(),
            file_service: FileService::new(pool).unwrap(),
            approvals: Approvals::new(),
            queued_message_service: QueuedMessageService::new(),
            remote_client: None,
        }
    }

    /// A follow-up for `agent`; anything but Claude Code fails to start in the
    /// Claude Code test session (executor mismatch, before any process row).
    fn follow_up(message: &str, agent: BaseCodingAgent) -> DraftFollowUpData {
        DraftFollowUpData {
            message: message.into(),
            executor_config: ExecutorConfig::new(agent),
        }
    }

    fn finished_turn(
        session: &Session,
        workspace: &Workspace,
        status: ExecutionProcessStatus,
    ) -> ExecutionContext {
        let action = ExecutorAction::new(
            ExecutorActionType::CodingAgentInitialRequest(CodingAgentInitialRequest {
                prompt: "turn".into(),
                executor_config: ExecutorConfig::new(BaseCodingAgent::ClaudeCode),
                working_dir: None,
                handoff_from: None,
                handoff_session_id: None,
                handoff_user_prompt: None,
            }),
            None,
        );
        let now = Utc::now();
        ExecutionContext {
            execution_process: ExecutionProcess {
                id: Uuid::new_v4(),
                session_id: session.id,
                run_reason: ExecutionProcessRunReason::CodingAgent,
                executor_action: sqlx::types::Json(
                    db::models::execution_process::ExecutorActionField::ExecutorAction(action),
                ),
                status,
                exit_code: None,
                dropped: false,
                started_at: now,
                completed_at: Some(now),
                created_at: now,
                updated_at: now,
            },
            session: session.clone(),
            workspace: workspace.clone(),
            repos: vec![],
        }
    }

    #[tokio::test]
    async fn send_now_during_script_finalization_waits_for_the_original_chain() {
        use executors::actions::script::{ScriptContext, ScriptRequest, ScriptRequestLanguage};

        let (container, session, workspace) = queue_test_container().await;
        add_test_repo(&container, &workspace).await;
        let _logs = SessionLogDir(session.id);
        let next = finished_turn(&session, &workspace, ExecutionProcessStatus::Completed)
            .execution_process
            .executor_action()
            .unwrap()
            .clone();
        let script = ExecutorAction::new(
            ExecutorActionType::ScriptRequest(ScriptRequest {
                script: "true".into(),
                language: ScriptRequestLanguage::Bash,
                context: ScriptContext::SetupScript,
                working_dir: None,
            }),
            Some(Box::new(next.clone())),
        );
        let record = container
            .create_execution_record(
                &workspace,
                &session,
                &script,
                &ExecutionProcessRunReason::SetupScript,
            )
            .await
            .unwrap();
        // The metadata barrier is ready, but the script's finalizer still
        // owns the chain until it has registered the original coding request.
        let finishing = container.queued_message_service.hold_drain(session.id);
        ExecutionProcess::update_completion(
            &container.db.pool,
            record.id,
            ExecutionProcessStatus::Completed,
            Some(0),
        )
        .await
        .unwrap();
        assert!(
            !ExecutionProcess::has_running_non_dev_server_processes_for_session(
                &container.db.pool,
                session.id,
            )
            .await
            .unwrap()
        );
        let message = container.queued_message_service.enqueue_front(
            session.id,
            follow_up("send now", BaseCodingAgent::ClaudeCode),
        );
        assert!(
            container
                .drain_queue_if_idle(&session, &workspace)
                .await
                .unwrap()
                .is_none()
        );
        // The queued-message route must also wait without removing its target.
        assert!(
            container
                .queued_message_service
                .promote_to_front(session.id, message.id)
        );
        assert!(
            container
                .drain_queue_if_idle(&session, &workspace)
                .await
                .unwrap()
                .is_none()
        );
        assert!(turn_prompts(&container, session.id).await.is_empty());

        let initial = container
            .create_execution_record(
                &workspace,
                &session,
                &next,
                &ExecutionProcessRunReason::CodingAgent,
            )
            .await
            .unwrap();
        drop(finishing);
        assert!(
            container
                .drain_queue_if_idle(&session, &workspace)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(turn_prompts(&container, session.id).await, ["turn"]);
        ExecutionProcess::update_completion(
            &container.db.pool,
            initial.id,
            ExecutionProcessStatus::Completed,
            Some(0),
        )
        .await
        .unwrap();
        PendingRateLimitResume::upsert(
            &container.db.pool,
            session.id,
            initial.id,
            Utc::now() + chrono::Duration::minutes(5),
            "automatic resume",
        )
        .await
        .unwrap();
        assert!(
            container
                .drain_queue_if_idle(&session, &workspace)
                .await
                .unwrap()
                .is_none()
        );
        // Explicit send-now can supersede a scheduled automatic resume.
        assert!(
            container
                .queued_message_service
                .promote_to_front(session.id, message.id)
        );
        PendingRateLimitResume::delete_by_session_id(&container.db.pool, session.id)
            .await
            .unwrap();
        // No real agent is launched: the fixture has no worktree. A failed
        // queued start still records which prompt was attempted, and keeps it.
        assert!(
            container
                .drain_queue_if_idle(&session, &workspace)
                .await
                .is_err()
        );
        assert_eq!(
            turn_prompts(&container, session.id).await,
            ["turn", "send now"]
        );
        let queued = container.queued_message_service.get_queued(session.id);
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].id, message.id);
        assert!(queued[0].start_error.is_some());
    }

    const MISMATCH: &str = "Executor mismatch";

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_after_metadata_finalization_does_not_reopen_the_followup_barrier() {
        use command_group::AsyncCommandGroup;
        use executors::actions::script::{ScriptContext, ScriptRequest, ScriptRequestLanguage};
        use tokio::process::Command;

        let (container, session, workspace) = queue_test_container().await;
        add_test_repo(&container, &workspace).await;
        let _logs = SessionLogDir(session.id);
        let action = ExecutorAction::new(
            ExecutorActionType::ScriptRequest(ScriptRequest {
                script: "true".into(),
                language: ScriptRequestLanguage::Bash,
                context: ScriptContext::SetupScript,
                working_dir: None,
            }),
            None,
        );
        let record = container
            .create_execution_record(
                &workspace,
                &session,
                &action,
                &ExecutionProcessRunReason::SetupScript,
            )
            .await
            .unwrap();
        let mut child = Command::new("sh")
            .args(["-c", "sleep 60"])
            .group_spawn()
            .unwrap();
        command::kill_process_group(&mut child).await.unwrap();
        container.add_child_to_store(record.id, child).await;
        container
            .session_finalization
            .mark_active(session.id, record.id)
            .await;
        ExecutionProcess::update_completion(
            &container.db.pool,
            record.id,
            ExecutionProcessStatus::Completed,
            Some(0),
        )
        .await
        .unwrap();
        container
            .session_finalization
            .mark_ready(session.id, record.id)
            .await;

        // A stop captured the running row before completion. The monitor has
        // drained metadata, but still retains the child during its tail work.
        container
            .stop_execution(&record, ExecutionProcessStatus::Killed)
            .await
            .unwrap();
        tokio::time::timeout(
            Duration::from_secs(1),
            container.session_finalization.wait_until_ready(session.id),
        )
        .await
        .expect("a late stop reopened the already-finished metadata barrier");
        assert!(!container.has_live_child(record.id).await);
    }

    #[tokio::test]
    async fn stop_wins_over_an_exit_monitor_that_has_already_started() {
        use executors::actions::script::{ScriptContext, ScriptRequest, ScriptRequestLanguage};

        let (container, session, workspace) = queue_test_container().await;
        add_test_repo(&container, &workspace).await;
        let _logs = SessionLogDir(session.id);
        let action = ExecutorAction::new(
            ExecutorActionType::ScriptRequest(ScriptRequest {
                script: "true".into(),
                language: ScriptRequestLanguage::Bash,
                context: ScriptContext::SetupScript,
                working_dir: None,
            }),
            None,
        );
        let record = container
            .create_execution_record(
                &workspace,
                &session,
                &action,
                &ExecutionProcessRunReason::SetupScript,
            )
            .await
            .unwrap();
        container.mark_output_pipeline_ready(record.id).await;

        // The single-connection pool queues the monitor first, then the stop.
        // A separate status read would release the connection before writing,
        // allowing the stop to win and then be overwritten by that stale read.
        let connection = container.db.pool.acquire().await.unwrap();
        let (exit, exited) = tokio::sync::oneshot::channel();
        exit.send(ExecutorExitResult::Success).unwrap();
        let monitor = container.spawn_exit_monitor(&record.id, session.id, Some(exited), None);
        tokio::time::timeout(Duration::from_secs(5), async {
            while !container
                .session_finalization
                .active
                .read()
                .await
                .contains_key(&session.id)
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        tokio::task::yield_now().await;
        let pool = container.db.pool.clone();
        let (queued, waiting) = tokio::sync::oneshot::channel();
        let stop = tokio::spawn(async move {
            queued.send(()).unwrap();
            ExecutionProcess::update_completion(
                &pool,
                record.id,
                ExecutionProcessStatus::Killed,
                None,
            )
            .await
            .unwrap()
        });
        waiting.await.unwrap();
        drop(connection);
        assert_eq!(stop.await.unwrap().status, ExecutionProcessStatus::Killed);
        tokio::time::timeout(Duration::from_secs(10), monitor)
            .await
            .unwrap()
            .unwrap();
        let actual = ExecutionProcess::find_by_id(&container.db.pool, record.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(actual.status, ExecutionProcessStatus::Killed);
        assert_eq!(actual.exit_code, None);
    }

    /// The failed message is back in front under its own id with the reason,
    /// the rest of the queue follows in order, and nothing was started.
    async fn assert_kept_in_front(
        container: &LocalContainerService,
        session: &Session,
        failed: Uuid,
        rest: Uuid,
        reason: &str,
    ) {
        let queued = container.queued_message_service.get_queued(session.id);
        assert_eq!(
            queued.iter().map(|m| m.id).collect::<Vec<_>>(),
            [failed, rest]
        );
        assert!(
            queued[0]
                .start_error
                .as_deref()
                .is_some_and(|e| e.contains(reason)),
            "{:?}",
            queued[0].start_error
        );
        assert!(queued[1].start_error.is_none());
        assert!(
            ExecutionProcess::find_by_session_id(&container.db.pool, session.id, true)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn deferred_followup_finalizes_after_parallel_setup_unless_a_new_turn_owns_completion() {
        use executors::actions::script::{ScriptContext, ScriptRequest, ScriptRequestLanguage};
        use services::services::notification::{PushNotifier, set_global_push_notifier};

        struct Notifications(Arc<std::sync::Mutex<Vec<Uuid>>>);
        #[async_trait]
        impl PushNotifier for Notifications {
            async fn send(&self, _: &str, _: &str, workspace_id: Option<Uuid>) {
                if let Some(id) = workspace_id {
                    self.0.lock().unwrap().push(id);
                }
            }
        }
        let notifications = Arc::new(std::sync::Mutex::new(Vec::new()));
        set_global_push_notifier(Arc::new(Notifications(notifications.clone())));

        for scenario in ["cancelled", "held after start failure", "superseded"] {
            let (container, session, workspace) = queue_test_container().await;
            container.config.write().await.notifications.push_enabled = true;
            add_test_repo(&container, &workspace).await;
            let _logs = SessionLogDir(session.id);
            let turn = finished_turn(&session, &workspace, ExecutionProcessStatus::Completed);
            let action = turn.execution_process.executor_action().unwrap().clone();
            let script = ExecutorAction::new(
                ExecutorActionType::ScriptRequest(ScriptRequest {
                    script: "true".into(),
                    language: ScriptRequestLanguage::Bash,
                    context: ScriptContext::SetupScript,
                    working_dir: None,
                }),
                None,
            );
            let setup = container
                .create_execution_record(
                    &workspace,
                    &session,
                    &script,
                    &ExecutionProcessRunReason::SetupScript,
                )
                .await
                .unwrap();
            let record = container
                .create_execution_record(
                    &workspace,
                    &session,
                    &action,
                    &ExecutionProcessRunReason::CodingAgent,
                )
                .await
                .unwrap();
            ExecutionProcess::update_completion(
                &container.db.pool,
                record.id,
                ExecutionProcessStatus::Completed,
                Some(0),
            )
            .await
            .unwrap();
            let ctx = ExecutionProcess::load_context(&container.db.pool, record.id)
                .await
                .unwrap();
            CodingAgentTurn::mark_seen_by_workspace_id(&container.db.pool, workspace.id)
                .await
                .unwrap();
            let queue = &container.queued_message_service;
            let queued = queue.enqueue(session.id, follow_up("next", BaseCodingAgent::Codex));
            container
                .finalize_with_queued_followup(&ctx, false, false)
                .await;
            assert!(
                container
                    .deferred_finalizations
                    .read()
                    .await
                    .contains_key(&session.id)
            );
            container
                .resume_deferred_finalization(session.id)
                .await
                .unwrap();
            assert!(
                !notifications.lock().unwrap().contains(&workspace.id),
                "{scenario}: finalized before setup ended"
            );
            if scenario != "held after start failure" {
                queue.cancel_message(session.id, queued.id).unwrap();
            }
            if scenario == "superseded" {
                let newer = container
                    .create_execution_record(
                        &workspace,
                        &session,
                        &action,
                        &ExecutionProcessRunReason::CodingAgent,
                    )
                    .await
                    .unwrap();
                ExecutionProcess::update_completion(
                    &container.db.pool,
                    newer.id,
                    ExecutionProcessStatus::Completed,
                    Some(0),
                )
                .await
                .unwrap();
            }
            container.output_pipeline.mark_ready(setup.id).await;
            let (exit, exited) = tokio::sync::oneshot::channel();
            let monitor = container.spawn_exit_monitor(
                &setup.id,
                session.id,
                Some(exited),
                Some(queue.hold_drain(session.id)),
            );
            exit.send(ExecutorExitResult::Success).unwrap();
            tokio::time::timeout(Duration::from_secs(15), monitor)
                .await
                .unwrap()
                .unwrap();
            container
                .resume_deferred_finalization(session.id)
                .await
                .unwrap();
            assert!(
                !container
                    .deferred_finalizations
                    .read()
                    .await
                    .contains_key(&session.id)
            );
            assert_eq!(
                notifications
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|id| **id == workspace.id)
                    .count(),
                usize::from(scenario != "superseded"),
                "{scenario}: completion must be delivered exactly once"
            );
            let turn = CodingAgentTurn::find_by_execution_process_id(&container.db.pool, record.id)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                turn.seen,
                scenario == "superseded",
                "{scenario}: terminal turn becomes unread"
            );
            if scenario == "held after start failure" {
                let remaining = queue.get_queued(session.id);
                assert_eq!(remaining[0].id, queued.id);
                assert!(
                    remaining[0]
                        .start_error
                        .as_deref()
                        .unwrap()
                        .contains(MISMATCH)
                );
            }
        }
    }

    #[tokio::test]
    async fn queue_drain_start_failure_keeps_the_message_and_the_queue() {
        let (container, session, workspace) = queue_test_container().await;
        let queue = &container.queued_message_service;
        let a = queue.enqueue(session.id, follow_up("a", BaseCodingAgent::Codex));
        let b = queue.enqueue(session.id, follow_up("b", BaseCodingAgent::ClaudeCode));
        let turn = finished_turn(&session, &workspace, ExecutionProcessStatus::Completed);

        container
            .finalize_with_queued_followup(&turn, false, false)
            .await;
        assert_kept_in_front(&container, &session, a.id, b.id, MISMATCH).await;

        // The next finished turn doesn't retry it, or run `b` ahead of it.
        container
            .finalize_with_queued_followup(&turn, false, false)
            .await;
        assert_kept_in_front(&container, &session, a.id, b.id, MISMATCH).await;
    }

    #[tokio::test]
    async fn steer_exit_start_failure_keeps_the_queue_through_the_kill() {
        let (container, session, workspace) = queue_test_container().await;
        let queue = &container.queued_message_service;
        let b = queue.enqueue(session.id, follow_up("b", BaseCodingAgent::ClaudeCode));
        let a = queue.enqueue_front(session.id, follow_up("a", BaseCodingAgent::Codex));
        assert!(queue.mark_steering(session.id, a.id));
        let killed = finished_turn(&session, &workspace, ExecutionProcessStatus::Killed);

        container
            .handle_execution_post_completion(&killed, None)
            .await
            .unwrap();
        assert!(!queue.is_steering(session.id));
        assert_kept_in_front(&container, &session, a.id, b.id, MISMATCH).await;

        // A plain stop still discards the queue.
        container
            .handle_execution_post_completion(&killed, None)
            .await
            .unwrap();
        assert!(!queue.has_queued(session.id));
    }

    /// The steer route's fallback (kill found no child) fails either preparing
    /// the workspace or starting the turn; an idle "send now" on the message
    /// that came back fails again. Each time it stays in front, `b` behind it.
    #[tokio::test]
    async fn steer_fallback_and_send_now_start_failure_keep_the_message() {
        let (container, session, workspace) = queue_test_container().await;
        let queue = &container.queued_message_service;
        let b = queue.enqueue(session.id, follow_up("b", BaseCodingAgent::ClaudeCode));
        let a = queue.enqueue_front(session.id, follow_up("a", BaseCodingAgent::Codex));

        // No repo: the workspace can't be prepared.
        assert!(queue.mark_steering(session.id, a.id));
        container
            .run_steered_message(&session, workspace.clone())
            .await;
        assert!(!queue.is_steering(session.id));
        assert_kept_in_front(&container, &session, a.id, b.id, "no repositories").await;

        // An in-place workspace with a repo prepares fine; the start fails.
        let dir = tempfile::tempdir().unwrap();
        let repo = Repo::find_or_create(&container.db.pool, dir.path(), "repo")
            .await
            .unwrap();
        WorkspaceRepo::create_many(
            &container.db.pool,
            workspace.id,
            &[db::models::workspace_repo::CreateWorkspaceRepo {
                repo_id: repo.id,
                target_branch: "main".into(),
            }],
        )
        .await
        .unwrap();
        sqlx::query("UPDATE workspaces SET in_place = 1, container_ref = ? WHERE id = ?")
            .bind(dir.path().to_string_lossy().to_string())
            .bind(workspace.id)
            .execute(&container.db.pool)
            .await
            .unwrap();
        assert!(queue.mark_steering(session.id, a.id));
        container
            .run_steered_message(&session, workspace.clone())
            .await;
        assert_kept_in_front(&container, &session, a.id, b.id, MISMATCH).await;

        let msg = queue.cancel_message(session.id, a.id).unwrap();
        assert!(
            container
                .start_queued_followup(&session, &workspace, msg)
                .await
                .is_err()
        );
        assert_kept_in_front(&container, &session, a.id, b.id, MISMATCH).await;
    }

    /// The capture path reads a child's stdout in arbitrary-sized chunks, so a
    /// multi-byte character lands across a boundary as soon as the output is
    /// long enough. The reassembled log must carry the text exactly, with no
    /// U+FFFD — decoding each chunk on its own is what corrupted Korean output
    /// in the persisted logs.
    #[tokio::test]
    async fn decoded_log_stream_survives_chunk_boundaries_in_multibyte_text() {
        use futures::TryStreamExt;

        // Long enough that tokio's reads split it in several places.
        let text = "검증했습니다 ".repeat(4000) + "🎉 끝";
        let reader = std::io::Cursor::new(text.clone().into_bytes());
        let msgs: Vec<LogMsg> = decoded_log_stream(reader, LogMsg::Stdout)
            .try_collect()
            .await
            .unwrap();

        assert!(
            msgs.len() > 1,
            "expected a chunked read, got {}",
            msgs.len()
        );
        let joined: String = msgs
            .iter()
            .map(|m| match m {
                LogMsg::Stdout(s) => s.as_str(),
                other => panic!("unexpected {other:?}"),
            })
            .collect();
        assert!(!joined.contains('\u{FFFD}'), "decoded output was corrupted");
        assert_eq!(joined, text);
        assert!(
            msgs.iter()
                .all(|m| !matches!(m, LogMsg::Stdout(s) if s.is_empty())),
            "empty chunks must be dropped"
        );
    }

    /// Give the test workspace a repo, so turn rows can be created. Its path
    /// doesn't exist: a started turn still fails before any agent runs.
    async fn add_test_repo(container: &LocalContainerService, workspace: &Workspace) {
        let pool = &container.db.pool;
        let repo = Repo::find_or_create(pool, Path::new("/nonexistent/queue-repo"), "repo")
            .await
            .unwrap();
        WorkspaceRepo::create_many(
            pool,
            workspace.id,
            &[db::models::workspace_repo::CreateWorkspaceRepo {
                repo_id: repo.id,
                target_branch: "main".into(),
            }],
        )
        .await
        .unwrap();
    }

    async fn turn_prompts(container: &LocalContainerService, session_id: Uuid) -> Vec<String> {
        ExecutionProcess::find_by_session_id(&container.db.pool, session_id, false)
            .await
            .unwrap()
            .iter()
            .filter_map(|process| match process.executor_action().ok()?.typ() {
                ExecutorActionType::CodingAgentInitialRequest(request) => {
                    Some(request.prompt.clone())
                }
                ExecutorActionType::CodingAgentFollowUpRequest(request) => {
                    Some(request.prompt.clone())
                }
                _ => None,
            })
            .collect()
    }

    /// Run a coding turn up to the end of its finalize, as its exit handler
    /// does; the returned hold is that handler still winding down.
    async fn finish_turn(
        container: &LocalContainerService,
        session: &Session,
        workspace: &Workspace,
        prompt: &str,
    ) -> DrainHold {
        let pool = &container.db.pool;
        let action = ExecutorAction::new(
            ExecutorActionType::CodingAgentInitialRequest(CodingAgentInitialRequest {
                prompt: prompt.into(),
                executor_config: ExecutorConfig::new(BaseCodingAgent::ClaudeCode),
                working_dir: None,
                handoff_from: None,
                handoff_session_id: None,
                handoff_user_prompt: None,
            }),
            None,
        );
        let turn = container
            .create_execution_record(
                workspace,
                session,
                &action,
                &ExecutionProcessRunReason::CodingAgent,
            )
            .await
            .unwrap();
        let exit_handler = container.queued_message_service.hold_drain(session.id);
        ExecutionProcess::update_completion(
            pool,
            turn.id,
            ExecutionProcessStatus::Completed,
            Some(0),
        )
        .await
        .unwrap();
        let ctx = ExecutionProcess::load_context(pool, turn.id).await.unwrap();
        container
            .finalize_with_queued_followup(&ctx, false, false)
            .await;
        exit_handler
    }

    /// The queued messages, front first, and whether the front one failed to
    /// start.
    fn queue_state(container: &LocalContainerService, session_id: Uuid) -> (Vec<String>, bool) {
        let queued = container.queued_message_service.get_queued(session_id);
        let front_failed = queued.first().is_some_and(|m| m.start_error.is_some());
        (
            queued.into_iter().map(|m| m.data.message).collect(),
            front_failed,
        )
    }

    /// The issue's order: turn A finishes, its finalize finds the queue empty,
    /// and only then does a queue request sent during A arrive. Landing after
    /// A's exit handling, the enqueue starts it; landing while that handling
    /// still winds down, the handler's recheck starts the front message. Each
    /// runs once, front first. Every start fails here (no worktree), so the
    /// started message comes back to the front and holds the rest behind it.
    #[tokio::test]
    async fn queued_message_after_last_finalize_runs_once_in_order() {
        let (container, session, workspace) = queue_test_container().await;
        add_test_repo(&container, &workspace).await;
        let _logs = SessionLogDir(session.id);
        let queue = container.queued_message_service.clone();

        // After A's exit handling ended: the enqueue itself starts it.
        drop(finish_turn(&container, &session, &workspace, "a").await);
        assert!(queue.get_queued(session.id).is_empty());
        let m1 = queue.enqueue(session.id, follow_up("m1", BaseCodingAgent::ClaudeCode));
        let _ = container.drain_queue_if_idle(&session, &workspace).await;
        let _ = container.drain_queue_if_idle(&session, &workspace).await;
        assert_eq!(turn_prompts(&container, session.id).await, ["a", "m1"]);
        assert_eq!(
            queue_state(&container, session.id),
            (vec!["m1".to_string()], true)
        );
        queue.cancel_message(session.id, m1.id);

        // While B's exit handling still winds down: left to its recheck.
        let b_exit_handler = finish_turn(&container, &session, &workspace, "b").await;
        for text in ["m2", "m3"] {
            queue.enqueue(session.id, follow_up(text, BaseCodingAgent::ClaudeCode));
            let started = container
                .drain_queue_if_idle(&session, &workspace)
                .await
                .unwrap();
            assert!(started.is_none(), "{text} must wait for B's exit handler");
        }
        assert_eq!(turn_prompts(&container, session.id).await, ["a", "m1", "b"]);
        drop(b_exit_handler);
        let _ = container.drain_queue_if_idle(&session, &workspace).await;
        let _ = container.drain_queue_if_idle(&session, &workspace).await;
        // Only the front message started; m3 waits behind its failure.
        assert_eq!(
            turn_prompts(&container, session.id).await,
            ["a", "m1", "b", "m2"]
        );
        assert_eq!(
            queue_state(&container, session.id),
            (vec!["m2".to_string(), "m3".to_string()], true)
        );
    }

    /// A turn that fails to spawn: a queued message's start (here a finalize
    /// drain) keeps the rest of the queue behind it, while any other start
    /// with nobody left to drain the queue drops it, as its finalize would.
    #[tokio::test]
    async fn spawn_failure_keeps_the_queue_only_behind_a_queued_message() {
        let (container, session, workspace) = queue_test_container().await;
        add_test_repo(&container, &workspace).await;
        let _logs = SessionLogDir(session.id);
        let queue = &container.queued_message_service;

        for text in ["q1", "q2"] {
            queue.enqueue(session.id, follow_up(text, BaseCodingAgent::ClaudeCode));
        }
        drop(finish_turn(&container, &session, &workspace, "a").await);
        assert_eq!(turn_prompts(&container, session.id).await, ["a", "q1"]);
        assert_eq!(
            queue_state(&container, session.id),
            (vec!["q1".to_string(), "q2".to_string()], true)
        );

        queue.clear_queue(session.id);
        queue.enqueue(session.id, follow_up("q3", BaseCodingAgent::ClaudeCode));
        let direct = follow_up("direct", BaseCodingAgent::ClaudeCode);
        assert!(
            container
                .start_followup_for_session(&session, &workspace, &direct)
                .await
                .is_err()
        );
        assert_eq!(
            turn_prompts(&container, session.id).await,
            ["a", "q1", "direct"]
        );
        assert!(!queue.has_queued(session.id));
    }

    /// The real exit handler: a message queued while a process runs is left
    /// to it, and once the process ends its recheck starts the message, once.
    /// A parallel setup script has no finalize, so only the recheck can.
    #[tokio::test]
    async fn exit_handler_starts_message_queued_while_it_ran() {
        use executors::actions::script::{ScriptContext, ScriptRequest, ScriptRequestLanguage};

        let (container, session, mut workspace) = queue_test_container().await;
        add_test_repo(&container, &workspace).await;
        let _logs = SessionLogDir(session.id);
        let dir = tempfile::tempdir().unwrap();
        let go = dir.path().join("go");
        // The script runs in the temp dir until `go` exists; its context only
        // spares it the background priority setup scripts get, which can stall
        // it for seconds on a busy machine. The stored row keeps no worktree,
        // so the follow-up started later fails before any agent spawns.
        workspace.container_ref = Some(dir.path().to_string_lossy().into_owned());
        let setup = ExecutorAction::new(
            ExecutorActionType::ScriptRequest(ScriptRequest {
                script: format!("while [ ! -f '{}' ]; do sleep 0.05; done", go.display()),
                language: ScriptRequestLanguage::Bash,
                context: ScriptContext::ToolInstallScript,
                working_dir: None,
            }),
            None,
        );
        let record = container
            .create_execution_record(
                &workspace,
                &session,
                &setup,
                &ExecutionProcessRunReason::SetupScript,
            )
            .await
            .unwrap();
        container
            .finish_execution_spawn(&workspace, &session, &record, &setup)
            .await
            .unwrap();

        container
            .queued_message_service
            .enqueue(session.id, follow_up("m1", BaseCodingAgent::ClaudeCode));
        let started = container
            .drain_queue_if_idle(&session, &workspace)
            .await
            .unwrap();
        assert!(
            started.is_none(),
            "the running script's exit handler owns it"
        );

        std::fs::write(&go, "").unwrap();
        let exit_handler = container
            .take_exit_monitor_handle(&record.id)
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(60), exit_handler)
            .await
            .expect("the script's exit handler never finished")
            .unwrap();
        assert_eq!(turn_prompts(&container, session.id).await, ["m1"]);
        assert_eq!(
            queue_state(&container, session.id),
            (vec!["m1".to_string()], true)
        );
    }

    #[tokio::test]
    async fn stopping_scripts_discards_their_queue_without_affecting_sibling_sessions() {
        use executors::actions::script::{ScriptContext, ScriptRequest, ScriptRequestLanguage};

        for reason in [
            ExecutionProcessRunReason::SetupScript,
            ExecutionProcessRunReason::CleanupScript,
        ] {
            let (container, session, mut workspace) = queue_test_container().await;
            add_test_repo(&container, &workspace).await;
            let _logs = SessionLogDir(session.id);
            let dir = tempfile::tempdir().unwrap();
            workspace.container_ref = Some(dir.path().to_string_lossy().into_owned());
            let script = ExecutorAction::new(
                ExecutorActionType::ScriptRequest(ScriptRequest {
                    script: "sleep 60".into(),
                    language: ScriptRequestLanguage::Bash,
                    // Avoid background QoS starving the test on a loaded host.
                    context: ScriptContext::ToolInstallScript,
                    working_dir: None,
                }),
                None,
            );
            let record = container
                .create_execution_record(&workspace, &session, &script, &reason)
                .await
                .unwrap();
            container
                .finish_execution_spawn(&workspace, &session, &record, &script)
                .await
                .unwrap();
            let sibling = Session::create(
                &container.db.pool,
                &CreateSession {
                    executor: None,
                    variant: None,
                    name: None,
                },
                Uuid::new_v4(),
                workspace.id,
            )
            .await
            .unwrap();
            for id in [session.id, sibling.id] {
                container
                    .queued_message_service
                    .enqueue(id, follow_up("queued", BaseCodingAgent::Codex));
            }

            container
                .try_stop(&workspace, false, Some(session.id))
                .await
                .unwrap();
            let monitor = container
                .take_exit_monitor_handle(&record.id)
                .await
                .unwrap();
            tokio::time::timeout(Duration::from_secs(15), monitor)
                .await
                .expect("stopped script did not finalize")
                .unwrap();

            let rows = ExecutionProcess::find_by_session_id(&container.db.pool, session.id, false)
                .await
                .unwrap();
            assert_eq!(
                rows.len(),
                1,
                "stopping a script must not start a queued turn"
            );
            assert_eq!(rows[0].status, ExecutionProcessStatus::Killed);
            assert!(!container.queued_message_service.has_queued(session.id));
            assert!(container.queued_message_service.has_queued(sibling.id));
            assert!(!container.has_live_child(record.id).await);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn graceful_stop_returns_before_slow_output_drain_without_losing_logs() {
        use executors::actions::script::{ScriptContext, ScriptRequest, ScriptRequestLanguage};

        let (container, session, mut workspace) = queue_test_container().await;
        add_test_repo(&container, &workspace).await;
        let _logs = SessionLogDir(session.id);
        let dir = tempfile::tempdir().unwrap();
        workspace.container_ref = Some(dir.path().to_string_lossy().into_owned());
        let script = ExecutorAction::new(
            ExecutorActionType::ScriptRequest(ScriptRequest {
                script: "sleep 60".into(),
                language: ScriptRequestLanguage::Bash,
                context: ScriptContext::ToolInstallScript,
                working_dir: None,
            }),
            None,
        );
        let record = container
            .create_execution_record(
                &workspace,
                &session,
                &script,
                &ExecutionProcessRunReason::SetupScript,
            )
            .await
            .unwrap();
        container
            .finish_execution_spawn(&workspace, &session, &record, &script)
            .await
            .unwrap();
        let store = container.get_msg_store_by_id(&record.id).await.unwrap();
        let pgid = container
            .get_child_from_store(&record.id)
            .await
            .unwrap()
            .read()
            .await
            .id()
            .unwrap();
        let cancel = CancellationToken::new();
        container
            .add_cancellation_token(record.id, cancel.clone())
            .await;
        let cooperative_exit = tokio::spawn(async move {
            cancel.cancelled().await;
            nix::sys::signal::killpg(
                nix::unistd::Pid::from_raw(pgid as i32),
                nix::sys::signal::Signal::SIGTERM,
            )
            .unwrap();
        });
        let forwarder = container.take_forwarder_handle(&record.id).await.unwrap();
        let (release, drain) = tokio::sync::oneshot::channel();
        let late_store = store.clone();
        container
            .add_forwarder_handle(
                record.id,
                tokio::spawn(async move {
                    forwarder.await.unwrap();
                    drain.await.unwrap();
                    late_store.push(LogMsg::Stdout("late output".into()));
                }),
            )
            .await;

        // A slow forwarder still owns the final logs when stop returns.
        let stopped = tokio::time::timeout(
            Duration::from_secs(3),
            container.stop_execution(&record, ExecutionProcessStatus::Killed),
        )
        .await;
        let still_draining = container.get_msg_store_by_id(&record.id).await.is_some();
        release.send(()).unwrap();
        cooperative_exit.await.unwrap();
        tokio::time::timeout(
            Duration::from_secs(10),
            container.session_finalization.wait_until_ready(session.id),
        )
        .await
        .unwrap();

        stopped
            .expect("stop waited for the slow output drain")
            .unwrap();
        assert!(
            still_draining,
            "stop removed the output store before the finalizer drained it"
        );
        let history = store.get_history();
        let late = history
            .iter()
            .position(|msg| matches!(msg, LogMsg::Stdout(text) if text == "late output"))
            .unwrap();
        let finished = history
            .iter()
            .position(|msg| matches!(msg, LogMsg::StorageFinished))
            .unwrap();
        assert!(
            late < finished,
            "late output arrived after storage shut down"
        );
        assert!(!container.has_live_child(record.id).await);
    }

    #[tokio::test]
    async fn followups_wait_for_scripts_without_bypassing_sequential_setup() {
        use executors::actions::script::{ScriptContext, ScriptRequest, ScriptRequestLanguage};

        for reason in [
            ExecutionProcessRunReason::SetupScript,
            ExecutionProcessRunReason::CleanupScript,
            ExecutionProcessRunReason::ArchiveScript,
        ] {
            let (container, session, workspace) = queue_test_container().await;
            add_test_repo(&container, &workspace).await;
            let _logs = SessionLogDir(session.id);
            let dir = tempfile::tempdir().unwrap();
            let mut script_workspace = workspace.clone();
            script_workspace.container_ref = Some(dir.path().to_string_lossy().into_owned());
            let next = (reason == ExecutionProcessRunReason::SetupScript).then(|| {
                Box::new(
                    finished_turn(&session, &workspace, ExecutionProcessStatus::Completed)
                        .execution_process
                        .executor_action()
                        .unwrap()
                        .clone(),
                )
            });
            let script = ExecutorAction::new(
                ExecutorActionType::ScriptRequest(ScriptRequest {
                    script: "sleep 60".into(),
                    language: ScriptRequestLanguage::Bash,
                    context: ScriptContext::ToolInstallScript,
                    working_dir: None,
                }),
                next,
            );
            let record = container
                .create_execution_record(&script_workspace, &session, &script, &reason)
                .await
                .unwrap();
            container
                .finish_execution_spawn(&script_workspace, &session, &record, &script)
                .await
                .unwrap();
            let message = container
                .queued_message_service
                .enqueue(session.id, follow_up("next", BaseCodingAgent::ClaudeCode));
            let dequeued = container
                .queued_message_service
                .take_next(session.id)
                .unwrap();
            let result = container
                .start_queued_followup(&session, &workspace, dequeued)
                .await;
            let early_turns = turn_prompts(&container, session.id).await;
            let queued = container.queued_message_service.get_queued(session.id);
            container
                .try_stop(&script_workspace, false, Some(session.id))
                .await
                .unwrap();
            let monitor = container
                .take_exit_monitor_handle(&record.id)
                .await
                .unwrap();
            tokio::time::timeout(Duration::from_secs(15), monitor)
                .await
                .unwrap()
                .unwrap();
            assert!(result.unwrap().is_none());
            assert!(
                early_turns.is_empty(),
                "{reason:?} must finish before a new turn"
            );
            assert_eq!(queued.len(), 1);
            assert_eq!(queued[0].id, message.id);
            assert_eq!(queued[0].data.message, "next");
            assert!(
                turn_prompts(&container, session.id).await.is_empty(),
                "stop must also cancel the chain"
            );
        }
    }

    #[tokio::test]
    async fn dev_server_does_not_block_followups() {
        let (container, session, workspace) = queue_test_container().await;
        add_test_repo(&container, &workspace).await;
        let _logs = SessionLogDir(session.id);
        let action = finished_turn(&session, &workspace, ExecutionProcessStatus::Completed)
            .execution_process
            .executor_action()
            .unwrap()
            .clone();
        container
            .create_execution_record(
                &workspace,
                &session,
                &action,
                &ExecutionProcessRunReason::DevServer,
            )
            .await
            .unwrap();
        // The deliberately missing worktree prevents launching an actual agent.
        assert!(
            container
                .start_followup_for_session(
                    &session,
                    &workspace,
                    &follow_up("next", BaseCodingAgent::ClaudeCode)
                )
                .await
                .is_err()
        );
        assert!(
            turn_prompts(&container, session.id)
                .await
                .contains(&"next".to_string())
        );
        assert!(!container.queued_message_service.has_queued(session.id));
    }

    #[tokio::test]
    async fn pending_cancel_and_resume_claim_have_only_one_winner() {
        use db::models::pending_execution_start::PendingExecutionStart;

        for watcher_first in [false, true] {
            let (container, session, workspace) = queue_test_container().await;
            add_test_repo(&container, &workspace).await;
            let action = finished_turn(&session, &workspace, ExecutionProcessStatus::Completed)
                .execution_process
                .executor_action()
                .unwrap()
                .clone();
            let record = container
                .create_execution_record(
                    &workspace,
                    &session,
                    &action,
                    &ExecutionProcessRunReason::CodingAgent,
                )
                .await
                .unwrap();
            let pool = &container.db.pool;
            PendingExecutionStart::create(
                pool,
                record.id,
                workspace.id,
                session.id,
                Uuid::new_v4(),
            )
            .await
            .unwrap();
            container
                .queued_message_service
                .enqueue(session.id, follow_up("queued", BaseCodingAgent::ClaudeCode));
            if watcher_first {
                assert_eq!(
                    PendingExecutionStart::delete_by_process_id(pool, record.id)
                        .await
                        .unwrap(),
                    1
                );
            }
            let cancelled = container
                .complete_pending_execution(record.id, session.id, ExecutionProcessStatus::Killed)
                .await
                .unwrap();
            assert_eq!(cancelled, !watcher_first);
            assert_eq!(
                PendingExecutionStart::delete_by_process_id(pool, record.id)
                    .await
                    .unwrap(),
                0
            );
            let actual = ExecutionProcess::find_by_id(pool, record.id)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                actual.status,
                if watcher_first {
                    ExecutionProcessStatus::Running
                } else {
                    ExecutionProcessStatus::Killed
                }
            );
            assert_eq!(
                container.queued_message_service.has_queued(session.id),
                watcher_first
            );
            assert_eq!(
                container.msg_stores.read().await.contains_key(&record.id),
                watcher_first
            );

            // A delayed second cancellation must leave a replacement and its queue alone.
            let replacement = container
                .create_execution_record(
                    &workspace,
                    &session,
                    &action,
                    &ExecutionProcessRunReason::CodingAgent,
                )
                .await
                .unwrap();
            PendingExecutionStart::create(
                pool,
                replacement.id,
                workspace.id,
                session.id,
                Uuid::new_v4(),
            )
            .await
            .unwrap();
            let fresh = container
                .queued_message_service
                .enqueue(session.id, follow_up("fresh", BaseCodingAgent::ClaudeCode));
            assert!(
                !container
                    .complete_pending_execution(
                        record.id,
                        session.id,
                        ExecutionProcessStatus::Killed
                    )
                    .await
                    .unwrap()
            );
            assert_eq!(
                ExecutionProcess::find_by_id(pool, replacement.id)
                    .await
                    .unwrap()
                    .unwrap()
                    .status,
                ExecutionProcessStatus::Running
            );
            assert!(
                PendingExecutionStart::find_by_process_id(pool, replacement.id)
                    .await
                    .unwrap()
                    .is_some()
            );
            assert!(
                container
                    .queued_message_service
                    .get_queued(session.id)
                    .iter()
                    .any(|m| m.id == fresh.id)
            );
        }
    }

    /// Logs of the failed starts land under the real `dev_assets/sessions/`.
    pub(super) struct SessionLogDir(pub(super) Uuid);

    impl Drop for SessionLogDir {
        fn drop(&mut self) {
            let _ =
                std::fs::remove_dir_all(utils::execution_logs::process_logs_session_dir(self.0));
        }
    }
}

/// A coding turn that made changes chains its cleanup script(s); a message is
/// queued behind it. Whether a cleanup fails before its row or child exists or
/// after it ran — even if a later cleanup in the chain succeeds — the chain
/// must end with nothing running, the message neither run nor lost, and the
/// queue held for the user to resume.
#[cfg(test)]
mod cleanup_failure_queue_tests {
    use db::models::{
        execution_process::CreateExecutionProcess,
        execution_process_repo_state::CreateExecutionProcessRepoState, scratch::DraftFollowUpData,
        workspace::CreateWorkspace, workspace_repo::CreateWorkspaceRepo,
    };
    use executors::actions::script::{ScriptContext, ScriptRequest, ScriptRequestLanguage};
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::{tests::SessionLogDir, *};

    struct Chain {
        container: LocalContainerService,
        coding: ExecutionContext,
        _dir: tempfile::TempDir,
        _logs: SessionLogDir,
    }

    /// One repo per `(script, repo_dir)`, their cleanups chained in order.
    /// `repo_dir`: whether that cleanup's working directory exists, i.e.
    /// whether its child can spawn at all.
    async fn finished_coding_turn(cleanups: &[(&str, bool)]) -> Chain {
        let dir = tempfile::tempdir().unwrap();
        let pool = SqlitePoolOptions::new()
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(dir.path().join("db.sqlite"))
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
        let container = super::tests::container_on(pool.clone());

        let mut repos = Vec::new();
        for i in 0..cleanups.len() {
            let name = format!("repo{i}");
            repos.push(
                Repo::find_or_create(&pool, &dir.path().join("source").join(&name), &name)
                    .await
                    .unwrap(),
            );
        }
        let workspace = Workspace::create(
            &pool,
            &CreateWorkspace {
                branch: "vk/cleanup".into(),
                name: None,
            },
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        let worktree = dir.path().join("worktree");
        std::fs::create_dir_all(&worktree).unwrap();
        for (repo, (_, repo_dir)) in repos.iter().zip(cleanups) {
            if *repo_dir {
                std::fs::create_dir_all(worktree.join(&repo.name)).unwrap();
            }
        }
        Workspace::update_container_ref(&pool, workspace.id, &worktree.to_string_lossy())
            .await
            .unwrap();
        WorkspaceRepo::create_many(
            &pool,
            workspace.id,
            &repos
                .iter()
                .map(|repo| CreateWorkspaceRepo {
                    repo_id: repo.id,
                    target_branch: "main".into(),
                })
                .collect::<Vec<_>>(),
        )
        .await
        .unwrap();
        let session = Session::create(
            &pool,
            &CreateSession {
                executor: None,
                variant: None,
                name: None,
            },
            Uuid::new_v4(),
            workspace.id,
        )
        .await
        .unwrap();
        let logs = SessionLogDir(session.id);

        let cleanup = repos
            .iter()
            .zip(cleanups)
            .map(|(repo, (script, _))| {
                ExecutorAction::new(
                    ExecutorActionType::ScriptRequest(ScriptRequest {
                        script: script.to_string(),
                        language: ScriptRequestLanguage::Bash,
                        context: ScriptContext::CleanupScript,
                        working_dir: Some(repo.name.clone()),
                    }),
                    None,
                )
            })
            .reduce(ExecutorAction::append_action)
            .unwrap();
        let coding = ExecutorAction::new(
            ExecutorActionType::CodingAgentInitialRequest(CodingAgentInitialRequest {
                prompt: "A".into(),
                executor_config: ExecutorConfig::new(BaseCodingAgent::ClaudeCode),
                working_dir: None,
                handoff_from: None,
                handoff_session_id: None,
                handoff_user_prompt: None,
            }),
            Some(Box::new(cleanup)),
        );
        let process = ExecutionProcess::create(
            &pool,
            &CreateExecutionProcess {
                session_id: session.id,
                executor_action: coding,
                run_reason: ExecutionProcessRunReason::CodingAgent,
            },
            Uuid::new_v4(),
            // A start HEAD the worktree no longer has: the turn made changes,
            // so its cleanup is due.
            &repos
                .iter()
                .map(|repo| CreateExecutionProcessRepoState {
                    repo_id: repo.id,
                    before_head_commit: Some("0".repeat(40)),
                    after_head_commit: None,
                    merge_commit: None,
                })
                .collect::<Vec<_>>(),
        )
        .await
        .unwrap();
        ExecutionProcess::update_completion(
            &pool,
            process.id,
            ExecutionProcessStatus::Completed,
            Some(0),
        )
        .await
        .unwrap();
        container.queued_message_service.enqueue(
            session.id,
            DraftFollowUpData {
                message: "B".into(),
                // Not A's executor: should B ever start by mistake, it fails the
                // executor check instead of launching a real agent.
                executor_config: ExecutorConfig::new(BaseCodingAgent::Codex),
            },
        );

        Chain {
            coding: ExecutionProcess::load_context(&pool, process.id)
                .await
                .unwrap(),
            container,
            _dir: dir,
            _logs: logs,
        }
    }

    impl Chain {
        /// A's completion as its exit monitor runs it: under A's drain hold,
        /// then the recheck once that is released.
        async fn finish_coding_turn(&self) {
            let ctx = &self.coding;
            let exit_handler = self
                .container
                .queued_message_service
                .hold_drain(ctx.session.id);
            self.container
                .handle_execution_post_completion(ctx, Some(0))
                .await
                .unwrap();
            drop(exit_handler);
            self.container
                .drain_queue_if_idle(&ctx.session, &ctx.workspace)
                .await
                .unwrap();
        }

        /// The cleanup rows in start order, asserting B never ran: the only
        /// coding turn is A.
        async fn cleanup_rows(&self) -> Vec<ExecutionProcess> {
            let rows = ExecutionProcess::find_by_session_id(
                &self.container.db.pool,
                self.coding.session.id,
                false,
            )
            .await
            .unwrap();
            let (cleanups, others): (Vec<_>, Vec<_>) = rows
                .into_iter()
                .partition(|p| p.run_reason == ExecutionProcessRunReason::CleanupScript);
            assert_eq!(
                others.iter().map(|p| p.id).collect::<Vec<_>>(),
                [self.coding.execution_process.id],
                "{others:?}"
            );
            cleanups
        }

        async fn wait_for_exit(&self, process: &ExecutionProcess) {
            let monitor = self
                .container
                .take_exit_monitor_handle(&process.id)
                .await
                .expect("a spawned cleanup finishes the chain from its exit monitor");
            // Generous: cleanup scripts run at background QoS (`nice` +
            // `taskpolicy -b`), which a loaded machine can starve for a while.
            tokio::time::timeout(Duration::from_secs(120), monitor)
                .await
                .unwrap()
                .unwrap();
        }

        /// Nothing runs and B waits in front, held with `reason`.
        async fn assert_ended_with_b_held(&self, reason: &str) {
            assert!(
                !ExecutionProcess::has_running_non_dev_server_processes_for_session(
                    &self.container.db.pool,
                    self.coding.session.id,
                )
                .await
                .unwrap()
            );
            let queued = self
                .container
                .queued_message_service
                .get_queued(self.coding.session.id);
            let [b] = &queued[..] else {
                panic!("queued message was lost: {queued:?}");
            };
            assert_eq!(b.data.message, "B");
            assert!(
                b.start_error.as_deref().is_some_and(|e| e.contains(reason)),
                "queue must wait for the user, not a turn: {:?}",
                b.start_error
            );
        }
    }

    #[tokio::test]
    async fn cleanup_that_cannot_spawn_ends_the_chain_and_holds_the_queue() {
        let chain = finished_coding_turn(&[("true", false)]).await;

        chain.finish_coding_turn().await;

        let [cleanup] = &chain.cleanup_rows().await[..] else {
            panic!("expected one cleanup row");
        };
        assert_eq!(cleanup.status, ExecutionProcessStatus::Failed);
        assert!(
            chain
                .container
                .take_exit_monitor_handle(&cleanup.id)
                .await
                .is_none(),
            "no child, so no exit event will ever finish this chain"
        );
        let log = std::fs::read_to_string(utils::execution_logs::process_log_file_path(
            chain.coding.session.id,
            cleanup.id,
        ))
        .unwrap();
        assert!(log.contains("Failed to start execution"), "{log}");
        // vibe's cleanup-fix prompt gets that error, not an empty log.
        assert!(
            chain
                .container
                .vibe_cleanup_failure_log(cleanup.id)
                .await
                .contains("Failed to start execution")
        );
        chain
            .assert_ended_with_b_held("Previous step could not start")
            .await;
    }

    #[tokio::test]
    async fn cleanup_that_runs_and_fails_holds_the_queue_from_its_exit() {
        let chain = finished_coding_turn(&[("exit 3", true)]).await;

        chain.finish_coding_turn().await;
        chain.wait_for_exit(&chain.cleanup_rows().await[0]).await;

        let [cleanup] = &chain.cleanup_rows().await[..] else {
            panic!("expected one cleanup row");
        };
        assert_eq!(cleanup.status, ExecutionProcessStatus::Failed);
        assert_eq!(cleanup.exit_code, Some(3));
        chain
            .assert_ended_with_b_held("Cleanup script failed")
            .await;
    }

    #[tokio::test]
    async fn cleanup_whose_row_cannot_be_written_ends_the_chain_and_holds_the_queue() {
        let chain = finished_coding_turn(&[("true", true)]).await;
        // The repos A ran with are gone by the time its cleanup is recorded.
        sqlx::query("DELETE FROM workspace_repos WHERE workspace_id = ?")
            .bind(chain.coding.workspace.id)
            .execute(&chain.container.db.pool)
            .await
            .unwrap();

        chain.finish_coding_turn().await;

        assert!(chain.cleanup_rows().await.is_empty());
        chain
            .assert_ended_with_b_held("Previous step could not start")
            .await;
    }

    #[tokio::test]
    async fn failed_cleanup_ends_its_chain_once_without_starting_the_rest() {
        let chain = finished_coding_turn(&[("exit 3", true), ("true", true)]).await;

        chain.finish_coding_turn().await;
        chain.wait_for_exit(&chain.cleanup_rows().await[0]).await;

        // The second cleanup never starts, so its exit can't finalize (and
        // run the queue) a second time.
        let [first] = &chain.cleanup_rows().await[..] else {
            panic!("expected only the first cleanup row");
        };
        assert_eq!(first.status, ExecutionProcessStatus::Failed);
        chain
            .assert_ended_with_b_held("Cleanup script failed")
            .await;
    }

    #[tokio::test]
    async fn later_cleanup_that_cannot_spawn_is_recorded_as_cleanup_and_holds_the_queue() {
        let chain = finished_coding_turn(&[("true", true), ("true", false)]).await;

        chain.finish_coding_turn().await;
        chain.wait_for_exit(&chain.cleanup_rows().await[0]).await;

        let [first, second] = &chain.cleanup_rows().await[..] else {
            panic!("expected both cleanup rows");
        };
        assert_eq!(first.status, ExecutionProcessStatus::Completed);
        assert_eq!(second.status, ExecutionProcessStatus::Failed);
        assert!(
            chain
                .container
                .take_exit_monitor_handle(&second.id)
                .await
                .is_none()
        );
        chain
            .assert_ended_with_b_held("Previous step could not start")
            .await;
    }
}
