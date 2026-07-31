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
        pending_execution_start::PendingExecutionStart,
        pending_rate_limit_resume::PendingRateLimitResume,
        repo::Repo,
        scratch::{Scratch, ScratchType},
        session::{CreateSession, Session},
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
    executors::{BaseCodingAgent, CancellationToken, ExecutorExitResult, ExecutorExitSignal},
    logs::{NormalizedEntryType, utils::patch::extract_normalized_entry_from_patch},
    model_selector::PermissionPolicy,
    profile::ExecutorConfig,
};
use futures::{FutureExt, TryStreamExt, stream::select};
use git::{GitService, GitServiceError};
use services::services::{
    approvals::{Approvals, executor_approvals::ExecutorApprovalBridge},
    config::{Config, DEFAULT_COMMIT_REMINDER_PROMPT},
    container::{ContainerError, ContainerRef, ContainerService},
    diff_stream::{self, DiffStreamHandle},
    events::EventService,
    file::FileService,
    notification::NotificationService,
    queued_message::QueuedMessageService,
    remote_client::RemoteClient,
    remote_sync, vibe_orchestrator,
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
    text::{git_branch_id, short_uuid, truncate_to_char_boundary},
};
use uuid::Uuid;
use workspace_manager::{RepoWorkspaceInput, WorkspaceError, WorkspaceManager};

use crate::{command, copy};

const WORKSPACE_TOUCH_DEBOUNCE: Duration = Duration::from_mins(2);

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
    workspace_touch_times: Arc<RwLock<HashMap<Uuid, Instant>>>,
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
        let db_stream_handles = Arc::new(RwLock::new(HashMap::new()));
        let forwarder_handles = Arc::new(RwLock::new(HashMap::new()));
        let normalizer_handles = Arc::new(RwLock::new(HashMap::new()));
        let exit_monitor_handles = Arc::new(RwLock::new(HashMap::new()));
        let output_pipeline = Arc::new(OutputPipelineBarrier::default());
        let session_finalization = Arc::new(SessionFinalizationBarrier::default());
        let workspace_touch_times = Arc::new(RwLock::new(HashMap::new()));
        let notification_service =
            NotificationService::new(config.clone(), db.pool.clone(), remote_client.clone());

        let container = LocalContainerService {
            db,
            events,
            workspace_manager,
            child_store,
            cancellation_tokens,
            msg_stores,
            db_stream_handles,
            forwarder_handles,
            normalizer_handles,
            exit_monitor_handles,
            output_pipeline,
            session_finalization,
            workspace_touch_times,
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

    async fn cleanup_workspace(&self, workspace: &Workspace) {
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
            return;
        }

        let Some(container_ref) = &workspace.container_ref else {
            return;
        };
        let workspace_dir = PathBuf::from(container_ref);

        let repositories = WorkspaceRepo::find_repos_for_workspace(&self.db.pool, workspace.id)
            .await
            .unwrap_or_default();

        if repositories.is_empty() {
            tracing::warn!(
                "No repositories found for workspace {}, cleaning up workspace directory only",
                workspace.id
            );
            if workspace_dir.exists()
                && let Err(e) = tokio::fs::remove_dir_all(&workspace_dir).await
            {
                tracing::warn!("Failed to remove workspace directory: {}", e);
            }
        } else {
            WorkspaceManager::cleanup_workspace(&workspace_dir, &repositories)
                .await
                .unwrap_or_else(|e| {
                    tracing::warn!(
                        "Failed to clean up workspace for workspace {}: {}",
                        workspace.id,
                        e
                    );
                });
        }

        let _ = Workspace::mark_worktree_deleted(&self.db.pool, workspace.id).await;
    }

    async fn cleanup_expired_workspaces(&self) -> Result<(), DeploymentError> {
        if std::env::var("DISABLE_WORKTREE_CLEANUP").is_ok() {
            tracing::info!(
                "Expired workspace cleanup is disabled via DISABLE_WORKTREE_CLEANUP environment variable"
            );
            return Ok(());
        }

        let expired_workspaces = Workspace::find_expired_for_cleanup(&self.db.pool).await?;
        if expired_workspaces.is_empty() {
            tracing::debug!("No expired workspaces found");
            return Ok(());
        }
        tracing::info!(
            "Found {} expired workspaces to clean up",
            expired_workspaces.len()
        );
        for workspace in &expired_workspaces {
            self.cleanup_workspace(workspace).await;
        }
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
    /// cleans up the execution entry when it exits.
    fn spawn_exit_monitor(
        &self,
        exec_id: &Uuid,
        session_id: Uuid,
        exit_signal: Option<ExecutorExitSignal>,
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
            if !ExecutionProcess::was_stopped(&db.pool, exec_id).await {
                match ExecutionProcess::update_completion(&db.pool, exec_id, status, exit_code)
                    .await
                {
                    Ok(process) => {
                        if let Err(e) = container
                            .events
                            .publish_execution_process_update(&process)
                            .await
                        {
                            tracing::error!(
                                "Failed to publish execution process completion: {}",
                                e
                            );
                        }
                    }
                    Err(e) => {
                        tracing::error!("Failed to update execution process completion: {}", e);
                    }
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

                // When a parallel setup script finishes and no coding agent is running,
                // consume any queued message that was stuck waiting
                if matches!(
                    ctx.execution_process.run_reason,
                    ExecutionProcessRunReason::SetupScript
                ) && !container.should_finalize(&ctx)
                {
                    let has_running_agent = ExecutionProcess::has_running_coding_agent_for_session(
                        &db.pool,
                        ctx.session.id,
                    )
                    .await
                    .unwrap_or(true);

                    if !has_running_agent
                        && let Some(queued_msg) =
                            container.queued_message_service.take_next(ctx.session.id)
                    {
                        tracing::info!(
                            "Parallel setup script finished with queued message for session {}, starting follow-up",
                            ctx.session.id
                        );

                        if let Err(e) =
                            Scratch::delete(&db.pool, ctx.session.id, &ScratchType::DraftFollowUp)
                                .await
                        {
                            tracing::warn!(
                                "Failed to delete scratch after consuming queued message: {}",
                                e
                            );
                        }

                        if let Err(e) = container
                            .start_followup_for_session(
                                &ctx.session,
                                &ctx.workspace,
                                &queued_msg.data,
                            )
                            .await
                        {
                            tracing::error!(
                                "Failed to start queued follow-up from setup script completion: {}",
                                e
                            );
                        }
                    }
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

        // Map stdout bytes -> LogMsg::Stdout
        let out = ReaderStream::new(out)
            .map_ok(|chunk| LogMsg::Stdout(String::from_utf8_lossy(&chunk).into_owned()));

        // Map stderr bytes -> LogMsg::Stderr
        let err = ReaderStream::new(err)
            .map_ok(|chunk| LogMsg::Stderr(String::from_utf8_lossy(&chunk).into_owned()));

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

        for msg in history.iter().rev() {
            if let LogMsg::JsonPatch(patch) = msg {
                // Try to extract a NormalizedEntry from the patch
                if let Some((_, entry)) = extract_normalized_entry_from_patch(patch)
                    && matches!(entry.entry_type, NormalizedEntryType::AssistantMessage)
                {
                    let content = entry.content.trim();
                    if !content.is_empty() {
                        const MAX_SUMMARY_LENGTH: usize = 4096;
                        if content.len() > MAX_SUMMARY_LENGTH {
                            let truncated = truncate_to_char_boundary(content, MAX_SUMMARY_LENGTH);
                            return Some(format!("{truncated}..."));
                        }
                        return Some(content.to_string());
                    }
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
        for msg in msg_store.get_history().iter().rev() {
            if let LogMsg::JsonPatch(patch) = msg
                && let Some((_, entry)) = extract_normalized_entry_from_patch(patch)
                && matches!(entry.entry_type, NormalizedEntryType::AssistantMessage)
            {
                let content = entry.content.trim();
                if !content.is_empty() {
                    return Some(content.to_string());
                }
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

    /// If this execution stopped because a usage rate limit was reached and the
    /// session has auto-resume enabled, schedule an automatic "continue"
    /// follow-up. Uses the agent-reported reset time when present and in the
    /// future, otherwise a conservative estimate.
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

        let Some(reset_hint) = Self::rate_limit_reset_hint_from_msgs(&msgs) else {
            return Ok(false);
        };

        // Prefer the agent-reported reset time when present and in the future;
        // otherwise fall back to a conservative estimate.
        let now = Utc::now();
        let resume_at = reset_hint
            .as_deref()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.with_timezone(&Utc) + chrono::Duration::seconds(60))
            .filter(|dt| *dt > now)
            .unwrap_or_else(|| now + chrono::Duration::seconds(Self::RATE_LIMIT_RESUME_DELAY_SECS));

        PendingRateLimitResume::upsert(
            &self.db.pool,
            ctx.session.id,
            ctx.execution_process.id,
            resume_at,
            "continue",
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
        let start_next = success_or_cleanup && should_start_next;
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
        // (which discards the queue). On a drain failure we fall through to normal
        // completion handling so the turn still finalizes.
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
                .start_followup_for_session(&ctx.session, &ctx.workspace, &queued_msg.data)
                .await
            {
                Ok(_) => return Ok(()),
                Err(e) => {
                    tracing::error!(
                        "Failed to start steered follow-up for session {}: {}; falling back to normal completion handling",
                        ctx.session.id,
                        e
                    );
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
            self.finalize_with_queued_followup(ctx, has_chained).await;
        }

        Ok(())
    }

    /// Whether a session's queued follow-up should be executed (rather than
    /// discarded) given the terminal status of the just-finished execution.
    ///
    /// A successfully completed turn — including a "no changes made" turn that
    /// finalizes early without running the cleanup script — must still drain its
    /// queue; only failed or killed turns discard it. Shared decision for both
    /// finalize paths in [`Self::finalize_with_queued_followup`].
    fn should_execute_queued_message(status: &ExecutionProcessStatus) -> bool {
        !matches!(
            status,
            ExecutionProcessStatus::Failed | ExecutionProcessStatus::Killed
        )
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
    async fn finalize_with_queued_followup(
        &self,
        ctx: &ExecutionContext,
        has_chained_follow_up: bool,
    ) {
        let mut started_queued_follow_up = false;

        // Only execute queued messages if the execution succeeded.
        // If it failed or was killed, discard the queue and finalize.
        let should_execute_queued =
            Self::should_execute_queued_message(&ctx.execution_process.status);

        if !should_execute_queued {
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
            if let Err(e) = self
                .start_followup_for_session(&ctx.session, &ctx.workspace, &queued_msg.data)
                .await
            {
                tracing::error!("Failed to start queued follow-up: {}", e);
                // Fall back to finalization if follow-up fails
                self.finalize_task(ctx).await;
                self.vibe_on_finalize(ctx).await;
            } else {
                started_queued_follow_up = true;
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
                self.vibe_start_review_session(&ctx.workspace, &ctx.session, &prompt)
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

                let outcome = self.vibe_perform_merge(ctx).await;
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
                        self.vibe_notify_ready_for_review(ctx).await;
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
        // path above; fall back to the DB only if the store is already gone.
        let msgs = if let Some(store) = self.get_msg_store_by_id(&exec_id).await {
            store.get_history()
        } else {
            match ExecutionProcessLogs::find_by_execution_id(&self.db.pool, exec_id).await {
                Ok(records) => ExecutionProcessLogs::parse_logs(&records).unwrap_or_default(),
                Err(e) => {
                    tracing::warn!("vibe: failed to load cleanup logs for {}: {}", exec_id, e);
                    Vec::new()
                }
            }
        };
        vibe_orchestrator::cleanup_failure_log_text(&msgs, 4000)
    }

    /// Build the executor config for a backend-driven vibe turn: the session's
    /// current profile with `permission_policy = Auto` so tool/plan approvals
    /// never block the automated run.
    async fn vibe_executor_config(&self, session_id: Uuid) -> Option<ExecutorConfig> {
        // Carry the user's full executor config (model / reasoning / agent
        // overrides), not just the profile identity — otherwise every
        // backend-driven turn would silently downgrade to the default model.
        let mut cfg =
            ExecutionProcess::latest_executor_config_for_session(&self.db.pool, session_id)
                .await
                .ok()
                .flatten()?;
        cfg.permission_policy = Some(PermissionPolicy::Auto);
        Some(cfg)
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
    ) -> Result<Session, ContainerError> {
        // See `vibe_send_followup`: a missing profile must error, not no-op, so
        // the run is not silently abandoned in a non-terminal phase. The review
        // session inherits the source session's executor config.
        let Some(executor_config) = self.vibe_executor_config(session.id).await else {
            return Err(ContainerError::Other(anyhow!(
                "vibe: no executor profile for session {}, cannot start review",
                session.id
            )));
        };

        let session_id = Uuid::new_v4();
        let create = CreateSession {
            executor: Some(executor_config.executor.to_string()),
            name: Some("vibe-review".to_string()),
        };
        let review_session =
            Session::create(&self.db.pool, &create, session_id, workspace.id).await?;

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
            &review_session,
            &action,
            &ExecutionProcessRunReason::CodingAgent,
        )
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

    /// Rule 5: fast-forward merge each qualifying repo into its target branch,
    /// classifying the outcome for [`decide_after_merge`]. Remote-only targets
    /// are first materialized as local tracking branches, matching manual Merge.
    /// Skips repos with an open PR or an already-recorded direct merge.
    async fn vibe_perform_merge(&self, ctx: &ExecutionContext) -> MergeOutcome {
        let workspace = ctx.workspace.clone();
        let workspace_id = workspace.id;

        let workspace_repos =
            match WorkspaceRepo::find_by_workspace_id(&self.db.pool, workspace_id).await {
                Ok(v) if !v.is_empty() => v,
                Ok(_) => return MergeOutcome::Success,
                Err(e) => {
                    tracing::error!("vibe merge: load workspace_repos failed: {}", e);
                    return MergeOutcome::OtherFailure;
                }
            };

        let container_ref = match self.ensure_container_exists(&workspace).await {
            Ok(r) => r,
            Err(e) => {
                tracing::error!("vibe merge: ensure container failed: {}", e);
                return MergeOutcome::OtherFailure;
            }
        };
        let workspace_path = Path::new(&container_ref);

        let mut any_conflict = false;
        let mut any_other_failure = false;
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
                    any_other_failure = true;
                    continue;
                }
                Err(e) => {
                    tracing::error!("vibe merge: load repo failed: {}", e);
                    any_other_failure = true;
                    continue;
                }
            };

            let merges = Merge::find_by_workspace_and_repo_id(&self.db.pool, workspace_id, repo.id)
                .await
                .unwrap_or_default();
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
                        any_other_failure = true;
                    } else {
                        any_review_ready = true;
                    }
                }
                Err(GitServiceError::MergeConflicts { .. })
                | Err(GitServiceError::BranchesDiverged(_)) => {
                    tracing::warn!("vibe merge: conflict merging {}", repo.name);
                    any_conflict = true;
                }
                Err(e) => {
                    tracing::warn!("vibe merge: merge_changes failed for {}: {}", repo.name, e);
                    any_other_failure = true;
                }
            }
        }

        if any_conflict {
            MergeOutcome::Conflict
        } else if any_other_failure {
            MergeOutcome::OtherFailure
        } else if any_review_ready {
            MergeOutcome::Success
        } else {
            // Nothing merged and no review artifact. Escalate to a human instead
            // of silently marking the issue as merged.
            MergeOutcome::OtherFailure
        }
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

        self.handle_execution_post_completion(&ctx, ctx.execution_process.exit_code)
            .await
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
        self.try_stop(workspace, true).await;
        self.cleanup_workspace(workspace).await;
        Ok(())
    }

    async fn ensure_container_exists(
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
        if workspace.in_place {
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

        // Spawn unified exit monitor: watches OS exit and optional executor signal
        let hn = self.spawn_exit_monitor(
            &execution_process.id,
            execution_process.session_id,
            spawned.exit_signal,
        );
        self.add_exit_monitor_handle(execution_process.id, hn).await;

        Ok(())
    }

    async fn stop_execution(
        &self,
        execution_process: &ExecutionProcess,
        status: ExecutionProcessStatus,
    ) -> Result<(), ContainerError> {
        // Blocker-gated deferred execution: the row exists with status=Running but
        // no child was ever spawned (the spawn was deferred until the linked
        // issue's blockers resolve, see `blocker_watcher`). Cancel the pending
        // start and mark the process finished instead of failing on the missing
        // child — this is how a user "stops" a waiting vibe session.
        if PendingExecutionStart::find_by_process_id(&self.db.pool, execution_process.id)
            .await
            .ok()
            .flatten()
            .is_some()
        {
            PendingExecutionStart::delete_by_process_id(&self.db.pool, execution_process.id)
                .await
                .map_err(|e| ContainerError::Other(anyhow!(e)))?;
            let completed_process = ExecutionProcess::update_completion(
                &self.db.pool,
                execution_process.id,
                status,
                None,
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
                    "Failed to publish deferred execution cancellation"
                );
            }
            if let Some(msg) = self.msg_stores.write().await.remove(&execution_process.id) {
                msg.push_finished();
                msg.push(LogMsg::StorageFinished);
            }
            tracing::info!(
                "Cancelled deferred (blocker-gated) execution {}",
                execution_process.id
            );
            return Ok(());
        }

        let child = self
            .get_child_from_store(&execution_process.id)
            .await
            .ok_or_else(|| {
                ContainerError::Other(anyhow!("Child process not found for execution"))
            })?;
        let exit_code = if status == ExecutionProcessStatus::Completed {
            Some(0)
        } else {
            None
        };

        // The stopped status becomes visible before the exit monitor finishes
        // draining logs. Register first so an immediate follow-up cannot slip
        // through the finalization barrier. The exit monitor registers the same
        // execution idempotently when it observes process exit.
        self.session_finalization
            .mark_active(execution_process.session_id, execution_process.id)
            .await;
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

            // Wait for exit monitor to finish gracefully
            if let Some(monitor_handle) = self.take_exit_monitor_handle(&execution_process.id).await
            {
                match tokio::time::timeout(Duration::from_secs(5), monitor_handle).await {
                    Ok(_) => {
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
        self.vibe_tag(&client, task_id, vibe_orchestrator::TAG_VIBE)
            .await;
        self.vibe_tag(&client, task_id, vibe_orchestrator::TAG_DONE)
            .await;

        let prompt = vibe_orchestrator::with_review_preamble(vibe_orchestrator::PROMPT_REVIEW_A);
        self.vibe_start_review_session(workspace, session, &prompt)
            .await
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
    use executors::logs::{NormalizedEntry, RateLimitInfo, utils::patch::ConversationPatch};

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

        // Success with changes, last action -> start next then finalize, carrying has_chained.
        assert_eq!(
            LocalContainerService::plan_post_completion(true, true, true, true),
            PostCompletionPlan {
                start_next: true,
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
}
