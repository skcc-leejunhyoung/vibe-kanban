use std::{str::FromStr, sync::Arc};

use db::{
    DBService,
    models::{
        execution_process::ExecutionProcess, scratch::Scratch, session::Session, vibe_run::VibeRun,
        workspace::Workspace,
    },
};
use serde_json::json;
use sqlx::{Error as SqlxError, Sqlite, SqlitePool, decode::Decode, sqlite::SqliteOperation};
use tokio::sync::RwLock;
use utils::msg_store::MsgStore;
use uuid::Uuid;

#[path = "events/patches.rs"]
pub mod patches;
#[path = "events/streams.rs"]
mod streams;
#[path = "events/types.rs"]
pub mod types;

pub use patches::{execution_process_patch, scratch_patch, workspace_patch};
pub use types::{EventError, EventPatch, EventPatchInner, HookTables, RecordTypes};

#[derive(Clone)]
pub struct EventService {
    msg_store: Arc<MsgStore>,
    db: DBService,
    #[allow(dead_code)]
    entry_count: Arc<RwLock<usize>>,
}

/// A row change seen by the SQLite hooks, published once its commit lands.
enum RowChange {
    Row(HookTables, SqliteOperation, i64),
    Removed(json_patch::Patch),
}

/// The commit hook runs before its commit is visible to other connections.
/// Taking the write lock waits until the committing writer has released it,
/// so reads that start afterwards see this commit (or a newer one). Both
/// statements go to the connection's worker as one batch, so the lock is
/// released without waiting on the async runtime in between.
async fn wait_for_commit(pool: &SqlitePool) {
    // An empty write transaction cannot fail to commit once BEGIN succeeded,
    // so the pooled connection is never left inside a transaction.
    if let Err(error) = sqlx::raw_sql("BEGIN IMMEDIATE; COMMIT").execute(pool).await {
        tracing::warn!(%error, "Commit barrier failed; publishing anyway");
    }
}

/// Workspace id of a `/workspaces/{id}` removal patch built by the pre-update hook.
fn removed_workspace_id(patch: &json_patch::Patch) -> Option<Uuid> {
    patch.0.iter().find_map(|op| match op {
        json_patch::PatchOperation::Remove(remove) => remove
            .path
            .as_str()
            .strip_prefix("/workspaces/")?
            .parse()
            .ok(),
        _ => None,
    })
}

/// Re-reads one committed row change and publishes it to the event stream.
async fn publish_row(
    table: HookTables,
    operation: SqliteOperation,
    rowid: i64,
    db: &DBService,
    msg_store: &Arc<MsgStore>,
    entry_count: &Arc<RwLock<usize>>,
) {
    let record_type: RecordTypes = match (table, operation.clone()) {
        (HookTables::Workspaces, SqliteOperation::Delete)
        | (HookTables::ExecutionProcesses, SqliteOperation::Delete)
        | (HookTables::Scratch, SqliteOperation::Delete)
        | (HookTables::VibeRuns, SqliteOperation::Delete) => {
            return;
        }
        // Vibe runs only feed the agent journal; the live UI has no patch for them.
        (HookTables::VibeRuns, _) => {
            match VibeRun::find_by_rowid(&db.pool, rowid).await {
                Ok(Some(run)) => crate::services::agent_journal::observe_vibe_run(
                    &run,
                    matches!(operation, SqliteOperation::Insert),
                ),
                Ok(None) => {}
                Err(e) => tracing::error!("Failed to fetch vibe_run: {:?}", e),
            }
            return;
        }
        (HookTables::Workspaces, _) => match Workspace::find_by_rowid(&db.pool, rowid).await {
            Ok(Some(workspace)) => RecordTypes::Workspace(workspace),
            Ok(None) => RecordTypes::DeletedWorkspace { rowid },
            Err(e) => {
                tracing::error!("Failed to fetch workspace: {:?}", e);
                return;
            }
        },
        (HookTables::ExecutionProcesses, _) => {
            match ExecutionProcess::find_by_rowid(&db.pool, rowid).await {
                Ok(Some(process)) => RecordTypes::ExecutionProcess(process),
                Ok(None) => RecordTypes::DeletedExecutionProcess {
                    rowid,
                    session_id: None,
                    process_id: None,
                },
                Err(e) => {
                    tracing::error!("Failed to fetch execution_process: {:?}", e);
                    return;
                }
            }
        }
        (HookTables::Scratch, _) => match Scratch::find_by_rowid(&db.pool, rowid).await {
            Ok(Some(scratch)) => RecordTypes::Scratch(scratch),
            Ok(None) => RecordTypes::DeletedScratch {
                rowid,
                scratch_id: None,
                scratch_type: None,
            },
            Err(e) => {
                tracing::error!("Failed to fetch scratch: {:?}", e);
                return;
            }
        },
    };

    let db_op: &str = match operation {
        SqliteOperation::Insert => "insert",
        SqliteOperation::Delete => "delete",
        SqliteOperation::Update => "update",
        SqliteOperation::Unknown(_) => "unknown",
    };

    // Handle operations with direct patches
    match &record_type {
        RecordTypes::Scratch(scratch) => {
            let patch = match operation {
                SqliteOperation::Insert => scratch_patch::add(scratch),
                SqliteOperation::Update => scratch_patch::replace(scratch),
                _ => scratch_patch::replace(scratch),
            };
            msg_store.push_patch(patch);
            return;
        }
        RecordTypes::DeletedScratch {
            scratch_id: Some(scratch_id),
            scratch_type: Some(scratch_type_str),
            ..
        } => {
            let patch = scratch_patch::remove(*scratch_id, scratch_type_str);
            msg_store.push_patch(patch);
            return;
        }
        RecordTypes::Workspace(workspace) => {
            // Ephemeral workspaces (e.g. spec-intake) are
            // throwaway and must never surface in the live UI.
            if workspace.ephemeral {
                return;
            }
            crate::services::agent_journal::observe_workspace(
                workspace,
                matches!(operation, SqliteOperation::Insert),
            );
            // Emit workspace patch with status
            if let Ok(Some(workspace_with_status)) =
                Workspace::find_by_id_with_status(&db.pool, workspace.id).await
            {
                let patch = match operation {
                    SqliteOperation::Insert => workspace_patch::add(&workspace_with_status),
                    _ => workspace_patch::replace(&workspace_with_status),
                };
                msg_store.push_patch(patch);
            }
            return;
        }
        RecordTypes::DeletedWorkspace { .. } => {
            return;
        }
        RecordTypes::ExecutionProcess(process) => {
            let workspace_id = Session::find_by_id(&db.pool, process.session_id)
                .await
                .ok()
                .flatten()
                .map(|session| session.workspace_id);
            crate::services::agent_journal::observe_process(
                process,
                workspace_id,
                matches!(operation, SqliteOperation::Insert),
            );
            let patch = match operation {
                SqliteOperation::Insert => execution_process_patch::add(process),
                SqliteOperation::Update => execution_process_patch::replace(process),
                _ => execution_process_patch::replace(process), // fallback
            };
            msg_store.push_patch(patch);

            if let Err(err) = EventService::push_workspace_update_for_session(
                &db.pool,
                msg_store.clone(),
                process.session_id,
            )
            .await
            {
                tracing::error!(
                    "Failed to push workspace update after execution process change: {:?}",
                    err
                );
            }

            return;
        }
        RecordTypes::DeletedExecutionProcess {
            process_id: Some(process_id),
            session_id,
            ..
        } => {
            let patch = execution_process_patch::remove(*process_id);
            msg_store.push_patch(patch);

            if let Some(session_id) = session_id
                && let Err(err) = EventService::push_workspace_update_for_session(
                    &db.pool,
                    msg_store.clone(),
                    *session_id,
                )
                .await
            {
                tracing::error!(
                    "Failed to push workspace update after execution process removal: {:?}",
                    err
                );
            }

            return;
        }
        _ => {}
    }

    // Fallback: use the old entries format for other record types
    let next_entry_count = {
        let mut entry_count = entry_count.write().await;
        *entry_count += 1;
        *entry_count
    };

    let event_patch: EventPatch = EventPatch {
        op: "add".to_string(),
        path: format!("/entries/{next_entry_count}"),
        value: EventPatchInner {
            db_op: db_op.to_string(),
            record: record_type,
        },
    };

    let patch =
        serde_json::from_value(json!([serde_json::to_value(event_patch).unwrap()])).unwrap();

    msg_store.push_patch(patch);
}

impl EventService {
    /// Creates a new EventService that will work with a DBService configured with hooks
    pub fn new(db: DBService, msg_store: Arc<MsgStore>, entry_count: Arc<RwLock<usize>>) -> Self {
        Self {
            msg_store,
            db,
            entry_count,
        }
    }

    async fn push_workspace_update_for_session(
        pool: &SqlitePool,
        msg_store: Arc<MsgStore>,
        session_id: Uuid,
    ) -> Result<(), SqlxError> {
        if let Some(session) = Session::find_by_id(pool, session_id).await?
            && let Some(workspace_with_status) =
                Workspace::find_by_id_with_status(pool, session.workspace_id).await?
            // Ephemeral workspaces (e.g. spec-intake) never surface in the live UI.
            && !workspace_with_status.ephemeral
        {
            msg_store.push_patch(workspace_patch::replace(&workspace_with_status));
        }
        Ok(())
    }

    /// Publish an execution-process update after its database statement has
    /// completed. SQLite's update hook fires before the statement commits, so
    /// a re-read through another pooled connection can observe the previous
    /// `running` value and leave clients waiting for reconciliation.
    pub async fn publish_execution_process_update(
        &self,
        process: &ExecutionProcess,
    ) -> Result<(), SqlxError> {
        self.msg_store
            .push_patch(execution_process_patch::replace(process));
        Self::push_workspace_update_for_session(
            &self.db.pool,
            self.msg_store.clone(),
            process.session_id,
        )
        .await?;
        Ok(())
    }

    /// Creates the hook function that should be used with DBService::new_with_after_connect
    ///
    /// SQLite fires its update and preupdate hooks while a statement runs,
    /// before the transaction commits, and other connections only see a commit
    /// after it completes. Row changes are therefore queued per connection,
    /// handed over in the commit hook (which SQLite calls in commit order, under
    /// the write lock) and published by a single task in that same order, after
    /// waiting for the commit to land. A rolled-back change is never published.
    pub fn create_hook(
        msg_store: Arc<MsgStore>,
        entry_count: Arc<RwLock<usize>>,
        db_service: DBService,
    ) -> impl for<'a> Fn(
        &'a mut sqlx::sqlite::SqliteConnection,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<(), sqlx::Error>> + Send + 'a>,
    > + Send
    + Sync
    + 'static {
        let (commits, mut committed) = tokio::sync::mpsc::unbounded_channel::<Vec<RowChange>>();
        tokio::spawn(async move {
            while let Some(mut changes) = committed.recv().await {
                // Commits that queued up meanwhile share one wait.
                while let Ok(more) = committed.try_recv() {
                    changes.extend(more);
                }
                wait_for_commit(&db_service.pool).await;
                // One task publishes every event, so a panic must cost only
                // this batch, not the live UI for the rest of the process.
                let batch = std::panic::AssertUnwindSafe(async {
                    for change in changes {
                        match change {
                            RowChange::Row(table, operation, rowid) => {
                                publish_row(
                                    table,
                                    operation,
                                    rowid,
                                    &db_service,
                                    &msg_store,
                                    &entry_count,
                                )
                                .await
                            }
                            RowChange::Removed(patch) => {
                                if let Some(workspace_id) = removed_workspace_id(&patch) {
                                    crate::services::agent_journal::observe_workspace_deleted(
                                        workspace_id,
                                    );
                                }
                                msg_store.push_patch(patch)
                            }
                        }
                    }
                });
                if futures::FutureExt::catch_unwind(batch).await.is_err() {
                    tracing::error!("Event publisher panicked; one batch of row events dropped");
                }
            }
        });
        move |conn: &mut sqlx::sqlite::SqliteConnection| {
            let commits = commits.clone();
            Box::pin(async move {
                let mut handle = conn.lock_handle().await?;
                let pending = Arc::new(std::sync::Mutex::new(Vec::<RowChange>::new()));
                handle.set_preupdate_hook({
                    let pending = pending.clone();
                    move |preupdate: sqlx::sqlite::PreupdateHookResult<'_>| {
                        if preupdate.operation != SqliteOperation::Delete {
                            return;
                        }
                        // The old row is only readable here, so the removal
                        // patch is built now and published with the commit.
                        let patch = match preupdate.table {
                            "workspaces" => preupdate
                                .get_old_column_value(0)
                                .ok()
                                .and_then(|value| <Uuid as Decode<Sqlite>>::decode(value).ok())
                                .map(workspace_patch::remove),
                            "execution_processes" => preupdate
                                .get_old_column_value(0)
                                .ok()
                                .and_then(|value| <Uuid as Decode<Sqlite>>::decode(value).ok())
                                .map(execution_process_patch::remove),
                            // Composite key: need both id (column 0) and scratch_type (column 1)
                            "scratch" => {
                                let id = preupdate
                                    .get_old_column_value(0)
                                    .ok()
                                    .and_then(|value| <Uuid as Decode<Sqlite>>::decode(value).ok());
                                let kind =
                                    preupdate.get_old_column_value(1).ok().and_then(|value| {
                                        <String as Decode<Sqlite>>::decode(value).ok()
                                    });
                                id.zip(kind)
                                    .map(|(id, kind)| scratch_patch::remove(id, &kind))
                            }
                            _ => None,
                        };
                        if let Some(patch) = patch {
                            pending
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner)
                                .push(RowChange::Removed(patch));
                        }
                    }
                });
                handle.set_update_hook({
                    let pending = pending.clone();
                    move |hook: sqlx::sqlite::UpdateHookResult<'_>| {
                        // Deletions are published from the preupdate hook.
                        if hook.operation == SqliteOperation::Delete {
                            return;
                        }
                        if let Ok(table) = HookTables::from_str(hook.table) {
                            pending
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner)
                                .push(RowChange::Row(table, hook.operation.clone(), hook.rowid));
                        }
                    }
                });
                handle.set_rollback_hook({
                    let pending = pending.clone();
                    move || {
                        pending
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .clear()
                    }
                });
                handle.set_commit_hook(move || {
                    let changes = std::mem::take(
                        &mut *pending
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner),
                    );
                    if !changes.is_empty() {
                        // Only fails once the publisher is gone (shutdown).
                        let _ = commits.send(changes);
                    }
                    // `false` would turn the commit into a rollback.
                    true
                });

                Ok(())
            })
        }
    }

    pub fn msg_store(&self) -> &Arc<MsgStore> {
        &self.msg_store
    }
}
