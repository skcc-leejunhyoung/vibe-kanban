use std::{
    collections::{HashMap, HashSet, VecDeque},
    future::Future,
};

use api_types::IssueRelationshipType;
use axum::{
    Extension, Router,
    extract::{Query, State},
    middleware::from_fn,
    response::Json as ResponseJson,
    routing::{get, post},
};
use db::models::{
    execution_process::{ExecutionProcess, ExecutionProcessRunReason, ExecutionProcessStatus},
    pending_execution_start::PendingExecutionStart,
    session::{CreateSession, Session, SessionError},
    workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
use deployment::Deployment;
use executors::actions::{
    ExecutorAction, ExecutorActionType,
    script::{ScriptContext, ScriptRequest, ScriptRequestLanguage},
};
use serde::{Deserialize, Serialize};
use services::services::container::ContainerService;
use ts_rs::TS;
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError, middleware::finish_after_disconnect};

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum RunScriptError {
    NoScriptConfigured,
    ProcessAlreadyRunning,
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route(
            "/dev-server/start",
            post(start_dev_server).layer(from_fn(finish_after_disconnect)),
        )
        .route("/dev-servers", get(get_dev_servers))
        .route(
            "/cleanup",
            post(run_cleanup_script).layer(from_fn(finish_after_disconnect)),
        )
        .route(
            "/archive",
            post(run_archive_script).layer(from_fn(finish_after_disconnect)),
        )
        .route(
            "/stop",
            post(stop_workspace_execution).layer(from_fn(finish_after_disconnect)),
        )
}

/// Return dev server processes for the workspace across all of its sessions.
/// The preview is workspace-scoped, so it must not depend on which session the
/// user currently has selected.
pub async fn get_dev_servers(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<Vec<ExecutionProcess>>>, ApiError> {
    let pool = &deployment.db().pool;
    let dev_servers = ExecutionProcess::find_dev_servers_by_workspace(pool, workspace.id).await?;
    Ok(ResponseJson(ApiResponse::success(dev_servers)))
}

#[axum::debug_handler]
pub async fn start_dev_server(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<Vec<ExecutionProcess>>>, ApiError> {
    let pool = &deployment.db().pool;

    // A workspace whose create request answered early may still be getting its
    // worktree: wait for it, and run with the row as the ensure left it.
    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let mut workspace = Workspace::find_by_id(pool, workspace.id)
        .await?
        .unwrap_or(workspace);
    workspace.container_ref.get_or_insert(container_ref);

    let existing_dev_servers =
        match ExecutionProcess::find_running_dev_servers_by_workspace(pool, workspace.id).await {
            Ok(servers) => servers,
            Err(e) => {
                tracing::error!(
                    "Failed to find running dev servers for workspace {}: {}",
                    workspace.id,
                    e
                );
                return Err(ApiError::Workspace(
                    db::models::workspace::WorkspaceError::ValidationError(e.to_string()),
                ));
            }
        };

    for dev_server in existing_dev_servers {
        tracing::info!(
            "Stopping existing dev server {} for workspace {}",
            dev_server.id,
            workspace.id
        );

        if let Err(e) = deployment
            .container()
            .stop_execution(&dev_server, ExecutionProcessStatus::Killed)
            .await
        {
            tracing::error!("Failed to stop dev server {}: {}", dev_server.id, e);
        }
    }

    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let repos_with_dev_script: Vec<_> = repos
        .iter()
        .filter(|r| r.dev_server_script.as_ref().is_some_and(|s| !s.is_empty()))
        .collect();

    if repos_with_dev_script.is_empty() {
        return Ok(ResponseJson(ApiResponse::error(
            "No dev server script configured for any repository in this workspace",
        )));
    }

    let session = match Session::find_latest_by_workspace_id(pool, workspace.id).await? {
        Some(s) => s,
        None => {
            Session::create(
                pool,
                &CreateSession {
                    executor: Some("dev-server".to_string()),
                    variant: None,
                    name: None,
                },
                Uuid::new_v4(),
                workspace.id,
            )
            .await?
        }
    };

    let mut execution_processes = Vec::new();
    for repo in repos_with_dev_script {
        let executor_action = ExecutorAction::new(
            ExecutorActionType::ScriptRequest(ScriptRequest {
                script: repo.dev_server_script.clone().unwrap(),
                language: ScriptRequestLanguage::Bash,
                context: ScriptContext::DevServer,
                // In-place ("quick chat") workspaces run in the repo root itself
                // (`container_ref` IS the repo), so there is no per-repo subdir to
                // descend into — run the dev script at the root.
                working_dir: if workspace.in_place {
                    None
                } else {
                    Some(repo.name.clone())
                },
            }),
            None,
        );

        let execution_process = deployment
            .container()
            .start_execution(
                &workspace,
                &session,
                &executor_action,
                &ExecutionProcessRunReason::DevServer,
            )
            .await?;
        execution_processes.push(execution_process);
    }

    Ok(ResponseJson(ApiResponse::success(execution_processes)))
}

/// Optional session scope for the workspace-level execution routes. The chat box
/// sends the session the user acted in, so a sibling session running
/// concurrently in the same workspace is neither killed nor treated as the
/// owner of the spawned process. Omitting it keeps the workspace-wide behaviour.
#[derive(Debug, Deserialize)]
pub struct SessionScopeQuery {
    pub session_id: Option<Uuid>,
}

impl SessionScopeQuery {
    async fn has_running_processes(
        &self,
        pool: &sqlx::SqlitePool,
        workspace_id: Uuid,
    ) -> Result<bool, sqlx::Error> {
        match self.session_id {
            Some(id) => {
                ExecutionProcess::has_running_non_dev_server_processes_for_session(pool, id).await
            }
            None => {
                ExecutionProcess::has_running_non_dev_server_processes_for_workspace(
                    pool,
                    workspace_id,
                )
                .await
            }
        }
    }
}

/// Resolve which session a workspace-scoped script runs under: the caller's
/// session when given (so the process lands in the conversation the user acted
/// from), otherwise the newest session — creating one if the workspace has none.
async fn resolve_script_session(
    deployment: &DeploymentImpl,
    workspace: &Workspace,
    requested: Option<Uuid>,
) -> Result<Session, ApiError> {
    let pool = &deployment.db().pool;
    if let Some(id) = requested {
        return match Session::find_by_id(pool, id).await? {
            Some(session) if session.workspace_id == workspace.id => Ok(session),
            _ => Err(ApiError::Session(SessionError::NotFound)),
        };
    }
    Ok(
        match Session::find_latest_by_workspace_id(pool, workspace.id).await? {
            Some(s) => s,
            None => {
                Session::create(
                    pool,
                    &CreateSession {
                        executor: None,
                        variant: None,
                        name: None,
                    },
                    Uuid::new_v4(),
                    workspace.id,
                )
                .await?
            }
        },
    )
}

pub async fn stop_workspace_execution(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<SessionScopeQuery>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    let pool = &deployment.db().pool;

    // Ignore a session id that isn't this workspace's — never let it widen or
    // misdirect the kill.
    let only_session = match query.session_id {
        Some(id) => match Session::find_by_id(pool, id).await? {
            Some(session) if session.workspace_id == workspace.id => Some(id),
            _ => return Err(ApiError::Session(SessionError::NotFound)),
        },
        None => None,
    };

    // Fix the cancellation set before stopping or awaiting any cloud request.
    // A newly queued/restarted dependent must not belong to this stop.
    let pending = if workspace.task_id.is_some() && deployment.remote_client().is_ok() {
        PendingExecutionStart::find_all(pool)
            .await
            .unwrap_or_else(|error| {
                tracing::warn!(%error, "Failed to snapshot deferred starts for cascade stop");
                Vec::new()
            })
    } else {
        Vec::new()
    };

    // A stop pressed right after a send can land before the turn's row exists:
    // cancel such starts too, not only the processes running now.
    let stopped_sessions = match only_session {
        Some(id) => vec![id],
        None => Session::find_by_workspace_id(pool, workspace.id)
            .await?
            .into_iter()
            .map(|session| session.id)
            .collect(),
    };
    for &session_id in &stopped_sessions {
        deployment
            .container()
            .cancel_session_starts(session_id)
            .await;
    }

    deployment
        .container()
        .try_stop(&workspace, false, only_session)
        .await?;

    // A message sent while the stop ran (no turn running, drain held: the
    // follow-up route queued it) may have nobody else to start it. Only here,
    // not in `try_stop`: retry and delete stop first, then rewrite or remove
    // what a freshly drained turn would run on.
    for session_id in stopped_sessions {
        let Some(session) = Session::find_by_id(pool, session_id).await? else {
            continue;
        };
        if let Err(error) = deployment
            .container()
            .drain_queue_if_idle(&session, &workspace)
            .await
        {
            tracing::warn!(
                "Failed to start a follow-up queued during the stop of session {}: {}",
                session_id,
                error
            );
        }
    }

    // Cascade: a workspace deferred behind this one (linked via a `blocking`
    // issue relationship) can never be unblocked by it once it is stopped, so
    // cancel those waiting starts too — transitively down the dependency graph.
    // Only once the workspace really has stopped: with a sibling session still
    // running the work that would unblock them is still in flight.
    if let Some(task_id) = workspace.task_id
        && !ExecutionProcess::has_running_non_dev_server_processes_for_workspace(pool, workspace.id)
            .await?
    {
        // Best-effort cloud round trips: don't hold the stop response on them.
        let deployment = deployment.clone();
        tokio::spawn(async move {
            cascade_stop_blocked_dependents(&deployment, task_id, pending).await
        });
    }

    Ok(ResponseJson(ApiResponse::success(())))
}

/// Walk only through starts this stop actually cancelled. Loading relationships
/// may take arbitrarily long; all candidates retain their original process IDs.
async fn cascade_pending_starts<Load, Loaded, Cancel, Cancelled>(
    root: Uuid,
    pending: Vec<PendingExecutionStart>,
    mut load: Load,
    mut cancel: Cancel,
) -> Vec<Uuid>
where
    Load: FnMut(Uuid) -> Loaded,
    Loaded: Future<Output = Vec<Uuid>>,
    Cancel: FnMut(PendingExecutionStart) -> Cancelled,
    Cancelled: Future<Output = bool>,
{
    let mut waiting: HashMap<Uuid, Vec<PendingExecutionStart>> = HashMap::new();
    for start in pending {
        waiting.entry(start.task_id).or_default().push(start);
    }
    let mut visited = HashSet::from([root]);
    let mut queue = VecDeque::from([root]);
    let mut cancelled = Vec::new();
    while let Some(task) = queue.pop_front() {
        if waiting.is_empty() {
            break;
        }
        for dependent in load(task).await {
            if !visited.insert(dependent) {
                continue;
            }
            let Some(starts) = waiting.remove(&dependent) else {
                continue;
            };
            let mut stopped = false;
            for start in starts {
                stopped |= cancel(start).await;
            }
            if stopped {
                cancelled.push(dependent);
                queue.push_back(dependent);
            }
        }
    }
    cancelled
}

/// Best-effort cloud traversal; cancellation claims only an original pending
/// row, never a session's replacement or already-resumed execution.
async fn cascade_stop_blocked_dependents(
    deployment: &DeploymentImpl,
    root_task_id: Uuid,
    pending: Vec<PendingExecutionStart>,
) {
    let client = match deployment.remote_client() {
        Ok(c) => c,
        Err(_) => return,
    };
    let client = &client;
    cascade_pending_starts(
        root_task_id,
        pending,
        |task_id| async move {
            match client.list_issue_relationships(task_id).await {
                Ok(r) => r
                    .issue_relationships
                    .into_iter()
                    .filter(|rel| matches!(rel.relationship_type, IssueRelationshipType::Blocking))
                    .map(|rel| rel.related_issue_id)
                    .collect(),
                Err(error) => {
                    tracing::warn!(%task_id, %error, "Cascade stop could not load relationships");
                    Vec::new()
                }
            }
        },
        |start| async move {
            match deployment
                .container()
                .complete_pending_execution(
                    start.execution_process_id,
                    start.session_id,
                    ExecutionProcessStatus::Killed,
                )
                .await
            {
                Ok(cancelled) => cancelled,
                Err(error) => {
                    tracing::warn!(execution_process_id = %start.execution_process_id, %error,
                    "Cascade stop could not cancel deferred start");
                    false
                }
            }
        },
    )
    .await;
}

#[axum::debug_handler]
pub async fn run_cleanup_script(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<SessionScopeQuery>,
) -> Result<ResponseJson<ApiResponse<ExecutionProcess, RunScriptError>>, ApiError> {
    let pool = &deployment.db().pool;

    // Resolve the script before the session, so a workspace with no script and
    // no session isn't left with an empty session as a side effect.
    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let executor_action = match deployment.container().cleanup_actions_for_repos(&repos) {
        Some(action) => action,
        None => {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                RunScriptError::NoScriptConfigured,
            )));
        }
    };

    let session = resolve_script_session(&deployment, &workspace, query.session_id).await?;

    // Only an explicitly requested session narrows the workspace-wide guard.
    if query.has_running_processes(pool, workspace.id).await? {
        return Ok(ResponseJson(ApiResponse::error_with_data(
            RunScriptError::ProcessAlreadyRunning,
        )));
    }

    deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;

    let execution_process = deployment
        .container()
        .start_execution(
            &workspace,
            &session,
            &executor_action,
            &ExecutionProcessRunReason::CleanupScript,
        )
        .await?;

    Ok(ResponseJson(ApiResponse::success(execution_process)))
}

pub async fn run_archive_script(
    Extension(workspace): Extension<Workspace>,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<SessionScopeQuery>,
) -> Result<ResponseJson<ApiResponse<ExecutionProcess, RunScriptError>>, ApiError> {
    let pool = &deployment.db().pool;

    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let executor_action = match deployment.container().archive_actions_for_repos(&repos) {
        Some(action) => action,
        None => {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                RunScriptError::NoScriptConfigured,
            )));
        }
    };

    let session = resolve_script_session(&deployment, &workspace, query.session_id).await?;

    if query.has_running_processes(pool, workspace.id).await? {
        return Ok(ResponseJson(ApiResponse::error_with_data(
            RunScriptError::ProcessAlreadyRunning,
        )));
    }

    deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;

    let execution_process = deployment
        .container()
        .start_execution(
            &workspace,
            &session,
            &executor_action,
            &ExecutionProcessRunReason::ArchiveScript,
        )
        .await?;

    Ok(ResponseJson(ApiResponse::success(execution_process)))
}

#[cfg(test)]
mod cascade_tests {
    use std::collections::{HashMap, HashSet};

    use uuid::Uuid;

    use super::{PendingExecutionStart, cascade_pending_starts};

    fn pending(task_id: Uuid) -> PendingExecutionStart {
        PendingExecutionStart {
            id: Uuid::new_v4(),
            execution_process_id: Uuid::new_v4(),
            workspace_id: Uuid::new_v4(),
            session_id: Uuid::new_v4(),
            task_id,
            created_at: chrono::Utc::now(),
            last_checked_at: None,
        }
    }

    async fn cascade_order(
        root: Uuid,
        blocks: &HashMap<Uuid, Vec<Uuid>>,
        waiting: &HashSet<Uuid>,
    ) -> Vec<Uuid> {
        cascade_pending_starts(
            root,
            waiting.iter().copied().map(pending).collect(),
            |task| std::future::ready(blocks.get(&task).cloned().unwrap_or_default()),
            |_| std::future::ready(true),
        )
        .await
    }

    fn id(n: u128) -> Uuid {
        Uuid::from_u128(n)
    }

    #[tokio::test]
    async fn chain_root_stop_cancels_all_downstream() {
        // 1→2→3→4, all waiting. Stopping the root cancels the whole chain.
        let (a, b, c, d) = (id(1), id(2), id(3), id(4));
        let blocks = HashMap::from([(a, vec![b]), (b, vec![c]), (c, vec![d])]);
        let waiting = HashSet::from([a, b, c, d]);
        assert_eq!(cascade_order(a, &blocks, &waiting).await, vec![b, c, d]);
    }

    #[tokio::test]
    async fn chain_middle_stop_cancels_downstream() {
        // The reported scenario: 1→2→3→4, with 1 running and 2/3/4 waiting.
        // Stopping the MIDDLE node (2) must recursively cancel 3 and 4, and must
        // never walk back up to the untouched blocker 1.
        let (a, b, c, d) = (id(1), id(2), id(3), id(4));
        let blocks = HashMap::from([(a, vec![b]), (b, vec![c]), (c, vec![d])]);
        let waiting = HashSet::from([b, c, d]); // 1 is running, not waiting
        let cancelled = cascade_order(b, &blocks, &waiting).await;
        assert_eq!(cancelled, vec![c, d]);
        assert!(!cancelled.contains(&a), "must not touch the blocker above");
    }

    #[tokio::test]
    async fn non_waiting_intermediate_halts_propagation() {
        // 1→2→3, with 2 already running (not waiting) and 3 waiting. The
        // "descend only past a waiting dependent" guard ends the branch at the
        // non-waiting 2, so 3 is left waiting. This documents the guard — if the
        // desired semantics are "cancel everything reachable", drop the guard.
        let (a, b, c) = (id(1), id(2), id(3));
        let blocks = HashMap::from([(a, vec![b]), (b, vec![c])]);
        let waiting = HashSet::from([c]); // only 3 waiting
        assert_eq!(
            cascade_order(a, &blocks, &waiting).await,
            Vec::<Uuid>::new()
        );
    }

    #[tokio::test]
    async fn non_waiting_intermediate_reachable_when_directly_blocked() {
        // Same graph but 1 *also* directly blocks 3 (1→2, 1→3, 2→3), 2 running.
        // 3 is reached directly from 1, so it is still cancelled even though the
        // 1→2→3 branch is cut at the non-waiting 2.
        let (a, b, c) = (id(1), id(2), id(3));
        let blocks = HashMap::from([(a, vec![b, c]), (b, vec![c])]);
        let waiting = HashSet::from([c]); // 2 running, 3 waiting
        assert_eq!(cascade_order(a, &blocks, &waiting).await, vec![c]);
    }

    #[tokio::test]
    async fn fan_out_cancels_all_direct_dependents() {
        // 1 blocks 2, 3, 4 directly. Stopping 1 cancels all three.
        let (a, b, c, d) = (id(1), id(2), id(3), id(4));
        let blocks = HashMap::from([(a, vec![b, c, d])]);
        let waiting = HashSet::from([b, c, d]);
        let mut got = cascade_order(a, &blocks, &waiting).await;
        got.sort();
        let mut want = vec![b, c, d];
        want.sort();
        assert_eq!(got, want);
    }

    #[tokio::test]
    async fn cycle_terminates_without_rerunning_root() {
        // 1→2→3→1. Must terminate; the root is never re-cancelled.
        let (a, b, c) = (id(1), id(2), id(3));
        let blocks = HashMap::from([(a, vec![b]), (b, vec![c]), (c, vec![a])]);
        let waiting = HashSet::from([a, b, c]);
        assert_eq!(cascade_order(a, &blocks, &waiting).await, vec![b, c]);
    }

    #[tokio::test]
    async fn diamond_join_cancelled_once() {
        // 1→2, 1→3, 2→4, 3→4. The join (4) is cancelled exactly once.
        let (a, b, c, d) = (id(1), id(2), id(3), id(4));
        let blocks = HashMap::from([(a, vec![b, c]), (b, vec![d]), (c, vec![d])]);
        let waiting = HashSet::from([b, c, d]);
        let cancelled = cascade_order(a, &blocks, &waiting).await;
        assert_eq!(cancelled, vec![b, c, d]);
        assert_eq!(
            cancelled.iter().filter(|&&t| t == d).count(),
            1,
            "join node cancelled exactly once"
        );
    }
    #[tokio::test]
    async fn delayed_relationship_lookup_never_cancels_new_or_resumed_starts() {
        use std::sync::{Arc, Mutex};

        use tokio::sync::oneshot;

        for resumed in [false, true] {
            let (a, b, c, d) = (id(1), id(2), id(3), id(4));
            let old_b = pending(b);
            let old_c = pending(c);
            let new_b = pending(b);
            let new_d = pending(d);
            let active = Arc::new(Mutex::new(HashSet::from([
                old_b.execution_process_id,
                old_c.execution_process_id,
            ])));
            let (entered_tx, entered_rx) = oneshot::channel();
            let (release_tx, release_rx) = oneshot::channel();
            let mut entered = Some(entered_tx);
            let mut release = Some(release_rx);
            let snapshot = vec![old_b.clone(), old_c.clone()];
            let worker_active = active.clone();
            let cascade = tokio::spawn(async move {
                cascade_pending_starts(
                    a,
                    snapshot,
                    move |task| {
                        let gate = release.take();
                        let entered = entered.take();
                        async move {
                            if let Some(entered) = entered {
                                entered.send(()).unwrap();
                            }
                            if let Some(gate) = gate {
                                gate.await.unwrap();
                            }
                            if task == a {
                                vec![b, d]
                            } else if task == b {
                                vec![c]
                            } else {
                                vec![]
                            }
                        }
                    },
                    move |start| {
                        std::future::ready(
                            worker_active
                                .lock()
                                .unwrap()
                                .remove(&start.execution_process_id),
                        )
                    },
                )
                .await
            });
            entered_rx.await.unwrap();
            {
                let mut active = active.lock().unwrap();
                if resumed {
                    active.remove(&old_b.execution_process_id);
                }
                // These starts arrived after the stop response, while cloud IO waited.
                active.insert(new_b.execution_process_id);
                active.insert(new_d.execution_process_id);
            }
            release_tx.send(()).unwrap();
            let cancelled = cascade.await.unwrap();
            assert_eq!(cancelled, if resumed { vec![] } else { vec![b, c] });
            let active = active.lock().unwrap();
            assert!(active.contains(&new_b.execution_process_id));
            assert!(active.contains(&new_d.execution_process_id));
            assert_eq!(active.contains(&old_c.execution_process_id), resumed);
        }
    }
}

#[cfg(test)]
mod session_scope_query_tests {
    use axum::{extract::Query, http::Uri};

    use super::{SessionScopeQuery, Uuid};

    fn parse(uri: &str) -> SessionScopeQuery {
        let uri: Uri = uri.parse().unwrap();
        Query::<SessionScopeQuery>::try_from_uri(&uri).unwrap().0
    }

    // Every pre-existing caller (MCP, kanban, older web builds) POSTs these
    // routes with no query string at all; that must stay workspace-wide, not 400.
    #[test]
    fn absent_session_id_is_none() {
        assert!(
            parse("/api/workspaces/x/execution/stop")
                .session_id
                .is_none()
        );
    }

    #[test]
    fn present_session_id_parses() {
        let id = Uuid::from_u128(7);
        assert_eq!(
            parse(&format!("/api/workspaces/x/execution/stop?session_id={id}")).session_id,
            Some(id)
        );
    }

    #[tokio::test]
    async fn only_an_explicit_session_scope_ignores_running_siblings() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql(
            "CREATE TABLE sessions (id BLOB PRIMARY KEY, workspace_id BLOB); \
             CREATE TABLE execution_processes (session_id BLOB, status TEXT, run_reason TEXT);",
        )
        .execute(&pool)
        .await
        .unwrap();
        let workspace_id = Uuid::from_u128(1);
        let running = Uuid::from_u128(2);
        let idle = Uuid::from_u128(3);
        for id in [running, idle] {
            sqlx::query("INSERT INTO sessions VALUES (?, ?)")
                .bind(id)
                .bind(workspace_id)
                .execute(&pool)
                .await
                .unwrap();
        }
        sqlx::query("INSERT INTO execution_processes VALUES (?, 'running', 'codingagent')")
            .bind(running)
            .execute(&pool)
            .await
            .unwrap();
        for (session_id, expected) in [(None, true), (Some(running), true), (Some(idle), false)] {
            assert_eq!(
                SessionScopeQuery { session_id }
                    .has_running_processes(&pool, workspace_id)
                    .await
                    .unwrap(),
                expected
            );
        }
        let unscoped = SessionScopeQuery { session_id: None };
        assert!(
            !unscoped
                .has_running_processes(&pool, Uuid::from_u128(4))
                .await
                .unwrap()
        );
        sqlx::query("UPDATE execution_processes SET run_reason = 'devserver'")
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            !unscoped
                .has_running_processes(&pool, workspace_id)
                .await
                .unwrap()
        );
    }
}
