use chrono::{DateTime, Utc};
use executors::actions::{ExecutorAction, ExecutorActionType};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use thiserror::Error;
use ts_rs::TS;
use uuid::Uuid;

/// Maximum length for auto-generated workspace names (derived from first user prompt)
const WORKSPACE_NAME_MAX_LEN: usize = 60;

use super::{
    execution_process::ExecutorActionField,
    session::Session,
    workspace_repo::{RepoWithTargetBranch, WorkspaceRepo},
};

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error("Workspace not found")]
    WorkspaceNotFound,
    #[error("Validation error: {0}")]
    ValidationError(String),
    #[error("Branch not found: {0}")]
    BranchNotFound(String),
}

#[derive(Debug, Clone, Serialize)]
pub struct ContainerInfo {
    pub workspace_id: Uuid,
}

#[derive(Debug)]
struct WorkspaceContainerRefRow {
    id: Uuid,
    container_ref: String,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
pub struct Workspace {
    pub id: Uuid,
    pub task_id: Option<Uuid>,
    pub container_ref: Option<String>,
    pub branch: String,
    pub setup_completed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub archived: bool,
    pub pinned: bool,
    pub name: Option<String>,
    pub worktree_deleted: bool,
    /// Throwaway workspace (e.g. spec-intake generation). Excluded from list/
    /// kanban queries and event streams; skips normal finalize side effects;
    /// reaped on startup.
    pub ephemeral: bool,
    /// "Quick chat" workspace: the agent runs directly in an existing checkout
    /// (`container_ref` points at the chosen folder) instead of a fresh `vk/`
    /// worktree. No worktree is materialized, no branch is forked, the agent's
    /// edits stay uncommitted in the user's working tree, and the destructive
    /// expiry/delete cleanup is skipped so it can never remove the real repo.
    pub in_place: bool,
    /// Why automatic expiry cleanup refuses to touch this workspace. `None`
    /// means eligible. Set when the uncommitted-change check cannot run at all
    /// (directory present but not a usable git worktree), which would otherwise
    /// retry and fail on every cleanup pass forever. Explicit user deletion is
    /// unaffected.
    pub cleanup_blocked_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct WorkspaceWithStatus {
    #[serde(flatten)]
    #[ts(flatten)]
    pub workspace: Workspace,
    pub is_running: bool,
    pub is_errored: bool,
}

struct WorkspaceStatusRow {
    id: Uuid,
    task_id: Option<Uuid>,
    container_ref: Option<String>,
    branch: String,
    setup_completed_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    archived: bool,
    pinned: bool,
    name: Option<String>,
    worktree_deleted: bool,
    ephemeral: bool,
    in_place: bool,
    cleanup_blocked_reason: Option<String>,
    is_running: i64,
    is_errored: i64,
}

impl std::ops::Deref for WorkspaceWithStatus {
    type Target = Workspace;
    fn deref(&self) -> &Self::Target {
        &self.workspace
    }
}

#[derive(Debug, Deserialize, TS)]
pub struct CreateFollowUpAttempt {
    pub prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceContext {
    pub workspace: Workspace,
    pub workspace_repos: Vec<RepoWithTargetBranch>,
    pub orchestrator_session_id: Option<Uuid>,
}

#[derive(Debug, Deserialize, TS)]
pub struct CreateWorkspace {
    pub branch: String,
    pub name: Option<String>,
}

impl Workspace {
    /// Fetch all workspaces. Newest first.
    pub async fn fetch_all(pool: &SqlitePool) -> Result<Vec<Self>, WorkspaceError> {
        let workspaces = sqlx::query_as!(
            Workspace,
            r#"SELECT id AS "id!: Uuid",
                          task_id AS "task_id: Uuid",
                          container_ref,
                          branch,
                          setup_completed_at AS "setup_completed_at: DateTime<Utc>",
                          created_at AS "created_at!: DateTime<Utc>",
                          updated_at AS "updated_at!: DateTime<Utc>",
                          archived AS "archived!: bool",
                          pinned AS "pinned!: bool",
                          name,
                          worktree_deleted AS "worktree_deleted!: bool",
                          ephemeral AS "ephemeral!: bool",
                          in_place AS "in_place!: bool",
                          cleanup_blocked_reason
                   FROM workspaces
                   ORDER BY created_at DESC"#
        )
        .fetch_all(pool)
        .await
        .map_err(WorkspaceError::Database)?;

        Ok(workspaces)
    }

    /// Load full workspace context by workspace ID.
    pub async fn load_context(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<WorkspaceContext, WorkspaceError> {
        let workspace = Workspace::find_by_id(pool, workspace_id)
            .await?
            .ok_or(WorkspaceError::WorkspaceNotFound)?;

        let workspace_repos =
            WorkspaceRepo::find_repos_with_target_branch_for_workspace(pool, workspace_id).await?;
        let orchestrator_session_id = Session::find_first_by_workspace_id(pool, workspace_id)
            .await?
            .map(|session| session.id);

        Ok(WorkspaceContext {
            workspace,
            workspace_repos,
            orchestrator_session_id,
        })
    }

    /// Update container reference
    pub async fn update_container_ref(
        pool: &SqlitePool,
        workspace_id: Uuid,
        container_ref: &str,
    ) -> Result<(), sqlx::Error> {
        let now = Utc::now();
        sqlx::query!(
            "UPDATE workspaces SET container_ref = $1, updated_at = $2 WHERE id = $3",
            container_ref,
            now,
            workspace_id
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn mark_worktree_deleted(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        sqlx::query!(
            "UPDATE workspaces SET worktree_deleted = TRUE, updated_at = datetime('now') WHERE id = ?",
            workspace_id
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Quarantine a workspace whose uncommitted changes cannot be verified, so
    /// automatic expiry cleanup stops retrying it. Records once: a workspace
    /// already blocked keeps its original reason. `updated_at` is deliberately
    /// left alone — it drives both the expiry clock and the list ordering, and
    /// a background quarantine should not resurface the workspace as recent.
    /// Returns true when this call is the one that blocked it.
    pub async fn mark_cleanup_blocked(
        pool: &SqlitePool,
        workspace_id: Uuid,
        reason: &str,
    ) -> Result<bool, sqlx::Error> {
        let result = sqlx::query!(
            "UPDATE workspaces SET cleanup_blocked_reason = ? WHERE id = ? AND cleanup_blocked_reason IS NULL",
            reason,
            workspace_id
        )
        .execute(pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn clear_worktree_deleted(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        sqlx::query!(
            "UPDATE workspaces SET worktree_deleted = FALSE, updated_at = datetime('now') WHERE id = ?",
            workspace_id
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Sets or clears the upstream task/issue id for a workspace. Used by the
    /// link/unlink flow so blocker-gating can detect the linked issue locally
    /// without an extra round trip to the cloud backend.
    pub async fn set_task_id(
        pool: &SqlitePool,
        workspace_id: Uuid,
        task_id: Option<Uuid>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE workspaces SET task_id = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(task_id)
            .bind(workspace_id)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// Update the workspace's updated_at timestamp to prevent cleanup.
    /// Call this when the workspace is accessed (e.g., opened in editor).
    pub async fn touch(pool: &SqlitePool, workspace_id: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query!(
            "UPDATE workspaces SET updated_at = datetime('now', 'subsec') WHERE id = ?",
            workspace_id
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn find_by_id(pool: &SqlitePool, id: Uuid) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as!(
            Workspace,
            r#"SELECT  id                AS "id!: Uuid",
                       task_id           AS "task_id: Uuid",
                       container_ref,
                       branch,
                       setup_completed_at AS "setup_completed_at: DateTime<Utc>",
                       created_at        AS "created_at!: DateTime<Utc>",
                       updated_at        AS "updated_at!: DateTime<Utc>",
                       archived          AS "archived!: bool",
                       pinned            AS "pinned!: bool",
                       name,
                       worktree_deleted  AS "worktree_deleted!: bool",
                       ephemeral         AS "ephemeral!: bool",
                       in_place          AS "in_place!: bool",
                       cleanup_blocked_reason
               FROM    workspaces
               WHERE   id = $1"#,
            id
        )
        .fetch_optional(pool)
        .await
    }

    pub async fn find_by_rowid(pool: &SqlitePool, rowid: i64) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as!(
            Workspace,
            r#"SELECT  id                AS "id!: Uuid",
                       task_id           AS "task_id: Uuid",
                       container_ref,
                       branch,
                       setup_completed_at AS "setup_completed_at: DateTime<Utc>",
                       created_at        AS "created_at!: DateTime<Utc>",
                       updated_at        AS "updated_at!: DateTime<Utc>",
                       archived          AS "archived!: bool",
                       pinned            AS "pinned!: bool",
                       name,
                       worktree_deleted  AS "worktree_deleted!: bool",
                       ephemeral         AS "ephemeral!: bool",
                       in_place          AS "in_place!: bool",
                       cleanup_blocked_reason
               FROM    workspaces
               WHERE   rowid = $1"#,
            rowid
        )
        .fetch_optional(pool)
        .await
    }

    pub async fn container_ref_exists(
        pool: &SqlitePool,
        container_ref: &str,
    ) -> Result<bool, sqlx::Error> {
        let result = sqlx::query!(
            r#"SELECT EXISTS(SELECT 1 FROM workspaces WHERE container_ref = ?) as "exists!: bool""#,
            container_ref
        )
        .fetch_one(pool)
        .await?;

        Ok(result.exists)
    }

    /// Find workspaces that are expired and eligible for cleanup.
    /// Uses accelerated cleanup (1 hour) for archived workspaces.
    /// Uses standard cleanup (72 hours) for non-archived workspaces.
    pub async fn find_expired_for_cleanup(
        pool: &SqlitePool,
        workspace_id: Option<Uuid>,
    ) -> Result<Vec<Workspace>, sqlx::Error> {
        sqlx::query_as::<_, Workspace>(
            r#"
            SELECT w.*
            FROM workspaces w
            LEFT JOIN sessions s ON w.id = s.workspace_id
            LEFT JOIN execution_processes ep ON s.id = ep.session_id AND ep.completed_at IS NOT NULL
            WHERE w.container_ref IS NOT NULL
                AND ($1 IS NULL OR w.id = $1)
                AND w.worktree_deleted = FALSE
                AND w.pinned = FALSE
                -- In-place ("quick chat") workspaces point container_ref at the
                -- user's real checkout; never select them for destructive cleanup.
                AND w.in_place = FALSE
                -- Quarantined: the uncommitted-change check could not run, so
                -- only an explicit user deletion may remove this one.
                AND w.cleanup_blocked_reason IS NULL
                AND w.id NOT IN (
                    SELECT DISTINCT s2.workspace_id
                    FROM sessions s2
                    JOIN execution_processes ep2 ON s2.id = ep2.session_id
                    WHERE ep2.completed_at IS NULL
                )
            GROUP BY w.id, w.container_ref, w.updated_at
            HAVING datetime('now',
                CASE
                    WHEN w.archived = 1
                    THEN '-1 hours'
                    ELSE '-72 hours'
                END
            ) > datetime(
                MAX(
                    max(
                        datetime(w.updated_at),
                        COALESCE(datetime(ep.completed_at), datetime(w.updated_at))
                    )
                )
            )
            ORDER BY MAX(
                CASE
                    WHEN ep.completed_at IS NOT NULL THEN ep.completed_at
                    ELSE w.updated_at
                END
            ) ASC
            "#,
        )
        .bind(workspace_id)
        .fetch_all(pool)
        .await
    }

    /// Find inactive workspaces whose Cargo debug outputs are stale.
    /// Unlike worktree expiry, read-only workspace access does not make build
    /// outputs fresh; only the latest completed execution does.
    pub async fn find_expired_for_build_cache_cleanup(
        pool: &SqlitePool,
        workspace_id: Option<Uuid>,
    ) -> Result<Vec<Workspace>, sqlx::Error> {
        sqlx::query_as::<_, Workspace>(
            r#"
            SELECT w.*
            FROM workspaces w
            JOIN sessions s ON w.id = s.workspace_id
            JOIN execution_processes ep ON s.id = ep.session_id
                AND ep.completed_at IS NOT NULL
            WHERE w.container_ref IS NOT NULL
                AND ($1 IS NULL OR w.id = $1)
                AND w.worktree_deleted = FALSE
                AND w.pinned = FALSE
                AND w.in_place = FALSE
                AND w.id NOT IN (
                    SELECT DISTINCT s2.workspace_id
                    FROM sessions s2
                    JOIN execution_processes ep2 ON s2.id = ep2.session_id
                    WHERE ep2.completed_at IS NULL
                )
            GROUP BY w.id, w.container_ref
            HAVING datetime('now',
                CASE
                    WHEN w.archived = 1
                    THEN '-1 hours'
                    ELSE '-72 hours'
                END
            ) > datetime(MAX(ep.completed_at))
            ORDER BY MAX(ep.completed_at) ASC
            "#,
        )
        .bind(workspace_id)
        .fetch_all(pool)
        .await
    }

    pub async fn create(
        pool: &SqlitePool,
        data: &CreateWorkspace,
        id: Uuid,
    ) -> Result<Self, WorkspaceError> {
        Ok(sqlx::query_as!(
            Workspace,
            r#"INSERT INTO workspaces (id, task_id, container_ref, branch, setup_completed_at, name)
               VALUES ($1, $2, $3, $4, $5, $6)
               RETURNING id as "id!: Uuid", task_id as "task_id: Uuid", container_ref, branch, setup_completed_at as "setup_completed_at: DateTime<Utc>", created_at as "created_at!: DateTime<Utc>", updated_at as "updated_at!: DateTime<Utc>", archived as "archived!: bool", pinned as "pinned!: bool", name, worktree_deleted as "worktree_deleted!: bool", ephemeral as "ephemeral!: bool", in_place as "in_place!: bool", cleanup_blocked_reason"#,
            id,
            Option::<Uuid>::None,
            Option::<String>::None,
            data.branch,
            Option::<DateTime<Utc>>::None,
            data.name
        )
        .fetch_one(pool)
        .await?)
    }

    /// Create a throwaway (ephemeral) workspace, e.g. for spec-intake spec
    /// generation. Excluded from list/kanban queries and event streams; reaped
    /// on startup. Normal workspace creation must never set this.
    pub async fn create_ephemeral(
        pool: &SqlitePool,
        data: &CreateWorkspace,
        id: Uuid,
    ) -> Result<Self, WorkspaceError> {
        Ok(sqlx::query_as!(
            Workspace,
            r#"INSERT INTO workspaces (id, task_id, container_ref, branch, setup_completed_at, name, ephemeral)
               VALUES ($1, $2, $3, $4, $5, $6, TRUE)
               RETURNING id as "id!: Uuid", task_id as "task_id: Uuid", container_ref, branch, setup_completed_at as "setup_completed_at: DateTime<Utc>", created_at as "created_at!: DateTime<Utc>", updated_at as "updated_at!: DateTime<Utc>", archived as "archived!: bool", pinned as "pinned!: bool", name, worktree_deleted as "worktree_deleted!: bool", ephemeral as "ephemeral!: bool", in_place as "in_place!: bool", cleanup_blocked_reason"#,
            id,
            Option::<Uuid>::None,
            Option::<String>::None,
            data.branch,
            Option::<DateTime<Utc>>::None,
            data.name
        )
        .fetch_one(pool)
        .await?)
    }

    /// Create an in-place ("quick chat") workspace whose `container_ref` already
    /// points at the chosen existing checkout. No worktree is ever materialized
    /// for it; the agent runs directly in that folder. `branch` is the folder's
    /// current branch (display only — no checkout happens).
    pub async fn create_in_place(
        pool: &SqlitePool,
        data: &CreateWorkspace,
        id: Uuid,
        container_ref: &str,
    ) -> Result<Self, WorkspaceError> {
        Ok(sqlx::query_as!(
            Workspace,
            r#"INSERT INTO workspaces (id, task_id, container_ref, branch, setup_completed_at, name, in_place)
               VALUES ($1, $2, $3, $4, $5, $6, TRUE)
               RETURNING id as "id!: Uuid", task_id as "task_id: Uuid", container_ref, branch, setup_completed_at as "setup_completed_at: DateTime<Utc>", created_at as "created_at!: DateTime<Utc>", updated_at as "updated_at!: DateTime<Utc>", archived as "archived!: bool", pinned as "pinned!: bool", name, worktree_deleted as "worktree_deleted!: bool", ephemeral as "ephemeral!: bool", in_place as "in_place!: bool", cleanup_blocked_reason"#,
            id,
            Option::<Uuid>::None,
            container_ref,
            data.branch,
            Option::<DateTime<Utc>>::None,
            data.name
        )
        .fetch_one(pool)
        .await?)
    }

    /// Find all ephemeral workspaces (used by the startup reaper).
    pub async fn find_ephemeral(pool: &SqlitePool) -> Result<Vec<Self>, WorkspaceError> {
        let workspaces = sqlx::query_as!(
            Workspace,
            r#"SELECT id AS "id!: Uuid",
                      task_id AS "task_id: Uuid",
                      container_ref,
                      branch,
                      setup_completed_at AS "setup_completed_at: DateTime<Utc>",
                      created_at AS "created_at!: DateTime<Utc>",
                      updated_at AS "updated_at!: DateTime<Utc>",
                      archived AS "archived!: bool",
                      pinned AS "pinned!: bool",
                      name,
                      worktree_deleted AS "worktree_deleted!: bool",
                      ephemeral AS "ephemeral!: bool",
                      in_place AS "in_place!: bool",
                      cleanup_blocked_reason
               FROM workspaces
               WHERE ephemeral = TRUE"#
        )
        .fetch_all(pool)
        .await
        .map_err(WorkspaceError::Database)?;

        Ok(workspaces)
    }

    pub async fn update_branch_name(
        pool: &SqlitePool,
        workspace_id: Uuid,
        new_branch_name: &str,
    ) -> Result<(), WorkspaceError> {
        sqlx::query!(
            "UPDATE workspaces SET branch = $1, updated_at = datetime('now') WHERE id = $2",
            new_branch_name,
            workspace_id,
        )
        .execute(pool)
        .await?;

        Ok(())
    }

    /// Find workspace by path using container-ref path containment.
    /// Used by clients that may open a repo subfolder rather than the workspace root.
    pub async fn resolve_container_ref_by_prefix(
        pool: &SqlitePool,
        path: &str,
    ) -> Result<ContainerInfo, sqlx::Error> {
        let workspaces = sqlx::query_as!(
            WorkspaceContainerRefRow,
            r#"SELECT id as "id!: Uuid",
                      container_ref as "container_ref!"
               FROM workspaces
               WHERE container_ref IS NOT NULL"#,
        )
        .fetch_all(pool)
        .await?;

        Self::best_matching_container_ref(
            path,
            workspaces
                .iter()
                .map(|ws| (ws.id, ws.container_ref.as_str())),
        )
        .map(|workspace_id| ContainerInfo { workspace_id })
        .ok_or(sqlx::Error::RowNotFound)
    }

    fn best_matching_container_ref<'a>(
        path: &str,
        candidates: impl Iterator<Item = (Uuid, &'a str)>,
    ) -> Option<Uuid> {
        let path = std::path::Path::new(path);

        candidates
            .filter(|(_, container_ref)| {
                let container_ref = std::path::Path::new(container_ref);
                path.starts_with(container_ref) || container_ref.starts_with(path)
            })
            .max_by_key(|(_, container_ref)| {
                std::path::Path::new(container_ref).components().count()
            })
            .map(|(workspace_id, _)| workspace_id)
    }

    pub async fn set_archived(
        pool: &SqlitePool,
        workspace_id: Uuid,
        archived: bool,
    ) -> Result<(), sqlx::Error> {
        sqlx::query!(
            "UPDATE workspaces SET archived = $1, updated_at = datetime('now', 'subsec') WHERE id = $2",
            archived,
            workspace_id
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Update workspace fields. Only non-None values will be updated.
    /// For `name`, pass `Some("")` to clear the name, `Some("foo")` to set it, or `None` to leave unchanged.
    pub async fn update(
        pool: &SqlitePool,
        workspace_id: Uuid,
        archived: Option<bool>,
        pinned: Option<bool>,
        name: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        // Convert empty string to None for name field (to store as NULL)
        let name_value = name.filter(|s| !s.is_empty());
        let name_provided = name.is_some();

        sqlx::query!(
            r#"UPDATE workspaces SET
                archived = COALESCE($1, archived),
                pinned = COALESCE($2, pinned),
                name = CASE WHEN $3 THEN $4 ELSE name END,
                updated_at = datetime('now', 'subsec')
            WHERE id = $5"#,
            archived,
            pinned,
            name_provided,
            name_value,
            workspace_id
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn get_first_user_message(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<Option<String>, sqlx::Error> {
        let actions = sqlx::query_scalar!(
            r#"SELECT ep.executor_action as "executor_action!: sqlx::types::Json<ExecutorActionField>"
               FROM sessions s
               JOIN execution_processes ep ON ep.session_id = s.id
               WHERE s.workspace_id = $1
               ORDER BY s.created_at ASC, ep.created_at ASC"#,
            workspace_id
        )
        .fetch_all(pool)
        .await?;

        for action in actions {
            if let ExecutorActionField::ExecutorAction(action) = action.0
                && let Some(prompt) = Self::extract_first_prompt_from_executor_action(&action)
            {
                return Ok(Some(prompt));
            }
        }

        Ok(None)
    }

    fn extract_first_prompt_from_executor_action(action: &ExecutorAction) -> Option<String> {
        let mut current = Some(action);
        while let Some(action) = current {
            match action.typ() {
                ExecutorActionType::CodingAgentInitialRequest(request) => {
                    return Some(request.prompt.clone());
                }
                ExecutorActionType::CodingAgentFollowUpRequest(request) => {
                    return Some(request.prompt.clone());
                }
                ExecutorActionType::ReviewRequest(request) => {
                    return Some(request.prompt.clone());
                }
                ExecutorActionType::ScriptRequest(_) => {
                    current = action.next_action();
                }
            }
        }
        None
    }

    pub fn truncate_to_name(prompt: &str, max_len: usize) -> String {
        let trimmed = prompt.trim();
        if trimmed.chars().count() <= max_len {
            trimmed.to_string()
        } else {
            let truncated: String = trimmed.chars().take(max_len).collect();
            if let Some(last_space) = truncated.rfind(' ') {
                format!("{}...", &truncated[..last_space])
            } else {
                format!("{}...", truncated)
            }
        }
    }

    pub async fn find_all_with_status(
        pool: &SqlitePool,
        archived: Option<bool>,
        limit: Option<i64>,
    ) -> Result<Vec<WorkspaceWithStatus>, sqlx::Error> {
        let records = if let Some(archived) = archived {
            sqlx::query_as!(
                WorkspaceStatusRow,
                r#"SELECT
                w.id AS "id!: Uuid",
                w.task_id AS "task_id: Uuid",
                w.container_ref,
                w.branch,
                w.setup_completed_at AS "setup_completed_at: DateTime<Utc>",
                w.created_at AS "created_at!: DateTime<Utc>",
                w.updated_at AS "updated_at!: DateTime<Utc>",
                w.archived AS "archived!: bool",
                w.pinned AS "pinned!: bool",
                w.name,
                w.worktree_deleted AS "worktree_deleted!: bool",
                w.ephemeral AS "ephemeral!: bool",
                w.in_place AS "in_place!: bool",
                w.cleanup_blocked_reason,

                CASE WHEN EXISTS (
                    SELECT 1
                    FROM sessions s
                    JOIN execution_processes ep ON ep.session_id = s.id
                    WHERE s.workspace_id = w.id
                      AND ep.status = 'running'
                      AND ep.run_reason IN ('setupscript','cleanupscript','codingagent')
                    LIMIT 1
                ) THEN 1 ELSE 0 END AS "is_running!: i64",

                CASE WHEN (
                    SELECT ep.status
                    FROM sessions s
                    JOIN execution_processes ep ON ep.session_id = s.id
                    WHERE s.workspace_id = w.id
                      AND ep.run_reason IN ('setupscript','cleanupscript','codingagent')
                    ORDER BY ep.created_at DESC
                    LIMIT 1
                ) IN ('failed','killed') THEN 1 ELSE 0 END AS "is_errored!: i64"

            FROM workspaces w
            WHERE w.ephemeral = FALSE
              AND w.archived = $1
            ORDER BY w.updated_at DESC"#,
                archived
            )
            .fetch_all(pool)
            .await?
        } else {
            sqlx::query_as!(
                WorkspaceStatusRow,
                r#"SELECT
                w.id AS "id!: Uuid",
                w.task_id AS "task_id: Uuid",
                w.container_ref,
                w.branch,
                w.setup_completed_at AS "setup_completed_at: DateTime<Utc>",
                w.created_at AS "created_at!: DateTime<Utc>",
                w.updated_at AS "updated_at!: DateTime<Utc>",
                w.archived AS "archived!: bool",
                w.pinned AS "pinned!: bool",
                w.name,
                w.worktree_deleted AS "worktree_deleted!: bool",
                w.ephemeral AS "ephemeral!: bool",
                w.in_place AS "in_place!: bool",
                w.cleanup_blocked_reason,

                CASE WHEN EXISTS (
                    SELECT 1
                    FROM sessions s
                    JOIN execution_processes ep ON ep.session_id = s.id
                    WHERE s.workspace_id = w.id
                      AND ep.status = 'running'
                      AND ep.run_reason IN ('setupscript','cleanupscript','codingagent')
                    LIMIT 1
                ) THEN 1 ELSE 0 END AS "is_running!: i64",

                CASE WHEN (
                    SELECT ep.status
                    FROM sessions s
                    JOIN execution_processes ep ON ep.session_id = s.id
                    WHERE s.workspace_id = w.id
                      AND ep.run_reason IN ('setupscript','cleanupscript','codingagent')
                    ORDER BY ep.created_at DESC
                    LIMIT 1
                ) IN ('failed','killed') THEN 1 ELSE 0 END AS "is_errored!: i64"

            FROM workspaces w
            WHERE w.ephemeral = FALSE
            ORDER BY w.updated_at DESC"#
            )
            .fetch_all(pool)
            .await?
        };

        let mut workspaces: Vec<WorkspaceWithStatus> = records
            .into_iter()
            .map(|rec| WorkspaceWithStatus {
                workspace: Workspace {
                    id: rec.id,
                    task_id: rec.task_id,
                    container_ref: rec.container_ref,
                    branch: rec.branch,
                    setup_completed_at: rec.setup_completed_at,
                    created_at: rec.created_at,
                    updated_at: rec.updated_at,
                    archived: rec.archived,
                    pinned: rec.pinned,
                    name: rec.name,
                    worktree_deleted: rec.worktree_deleted,
                    ephemeral: rec.ephemeral,
                    in_place: rec.in_place,
                    cleanup_blocked_reason: rec.cleanup_blocked_reason,
                },
                is_running: rec.is_running != 0,
                is_errored: rec.is_errored != 0,
            })
            .collect();

        // Apply limit if provided (already sorted by updated_at DESC from query)
        if let Some(lim) = limit {
            workspaces.truncate(lim as usize);
        }

        for ws in &mut workspaces {
            if ws.workspace.name.is_none()
                && let Some(prompt) = Self::get_first_user_message(pool, ws.workspace.id).await?
            {
                let name = Self::truncate_to_name(&prompt, WORKSPACE_NAME_MAX_LEN);
                Self::update(pool, ws.workspace.id, None, None, Some(&name)).await?;
                ws.workspace.name = Some(name);
            }
        }

        Ok(workspaces)
    }

    /// Delete a workspace by ID
    pub async fn delete(pool: &SqlitePool, id: Uuid) -> Result<u64, sqlx::Error> {
        let result = sqlx::query!("DELETE FROM workspaces WHERE id = $1", id)
            .execute(pool)
            .await?;
        Ok(result.rows_affected())
    }

    /// Count total workspaces across all projects
    pub async fn find_by_id_with_status(
        pool: &SqlitePool,
        id: Uuid,
    ) -> Result<Option<WorkspaceWithStatus>, sqlx::Error> {
        let rec = sqlx::query_as!(
            WorkspaceStatusRow,
            r#"SELECT
                w.id AS "id!: Uuid",
                w.task_id AS "task_id: Uuid",
                w.container_ref,
                w.branch,
                w.setup_completed_at AS "setup_completed_at: DateTime<Utc>",
                w.created_at AS "created_at!: DateTime<Utc>",
                w.updated_at AS "updated_at!: DateTime<Utc>",
                w.archived AS "archived!: bool",
                w.pinned AS "pinned!: bool",
                w.name,
                w.worktree_deleted AS "worktree_deleted!: bool",
                w.ephemeral AS "ephemeral!: bool",
                w.in_place AS "in_place!: bool",
                w.cleanup_blocked_reason,

                CASE WHEN EXISTS (
                    SELECT 1
                    FROM sessions s
                    JOIN execution_processes ep ON ep.session_id = s.id
                    WHERE s.workspace_id = w.id
                      AND ep.status = 'running'
                      AND ep.run_reason IN ('setupscript','cleanupscript','codingagent')
                    LIMIT 1
                ) THEN 1 ELSE 0 END AS "is_running!: i64",

                CASE WHEN (
                    SELECT ep.status
                    FROM sessions s
                    JOIN execution_processes ep ON ep.session_id = s.id
                    WHERE s.workspace_id = w.id
                      AND ep.run_reason IN ('setupscript','cleanupscript','codingagent')
                    ORDER BY ep.created_at DESC
                    LIMIT 1
                ) IN ('failed','killed') THEN 1 ELSE 0 END AS "is_errored!: i64"

            FROM workspaces w
            WHERE w.id = $1"#,
            id
        )
        .fetch_optional(pool)
        .await?;

        let Some(rec) = rec else {
            return Ok(None);
        };

        let mut ws = WorkspaceWithStatus {
            workspace: Workspace {
                id: rec.id,
                task_id: rec.task_id,
                container_ref: rec.container_ref,
                branch: rec.branch,
                setup_completed_at: rec.setup_completed_at,
                created_at: rec.created_at,
                updated_at: rec.updated_at,
                archived: rec.archived,
                pinned: rec.pinned,
                name: rec.name,
                worktree_deleted: rec.worktree_deleted,
                ephemeral: rec.ephemeral,
                in_place: rec.in_place,
                cleanup_blocked_reason: rec.cleanup_blocked_reason,
            },
            is_running: rec.is_running != 0,
            is_errored: rec.is_errored != 0,
        };

        if ws.workspace.name.is_none()
            && let Some(prompt) = Self::get_first_user_message(pool, ws.workspace.id).await?
        {
            let name = Self::truncate_to_name(&prompt, WORKSPACE_NAME_MAX_LEN);
            Self::update(pool, ws.workspace.id, None, None, Some(&name)).await?;
            ws.workspace.name = Some(name);
        }

        Ok(Some(ws))
    }
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, Utc};
    use sqlx::sqlite::SqlitePoolOptions;
    use uuid::Uuid;

    use super::Workspace;

    #[tokio::test]
    async fn cleanup_selects_expired_workspaces_and_keeps_recent_or_protected_ones() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql(
            "CREATE TABLE workspaces (
                id BLOB PRIMARY KEY, task_id BLOB, container_ref TEXT,
                branch TEXT NOT NULL, setup_completed_at TEXT,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                archived INTEGER NOT NULL, pinned INTEGER NOT NULL,
                name TEXT, worktree_deleted INTEGER NOT NULL,
                ephemeral INTEGER NOT NULL, in_place INTEGER NOT NULL,
                cleanup_blocked_reason TEXT
            );
            CREATE TABLE sessions (id BLOB PRIMARY KEY, workspace_id BLOB);
            CREATE TABLE execution_processes (id BLOB PRIMARY KEY, session_id BLOB, completed_at TEXT);",
        )
        .execute(&pool)
        .await
        .unwrap();

        let now = Utc::now();
        let mut expected = Vec::new();
        let expected_build_cache =
            ["archived", "expired", "recent archive", "recent workspace"].map(str::to_owned);
        // The same query must handle workspaces with no runs, all sessions'
        // completion times, UTC retention boundaries, and protected workspaces.
        for (name, hours, archived, pinned, in_place, deleted, run_ages, expired) in [
            ("never run", 100, false, false, false, false, vec![], true),
            (
                "expired",
                100,
                false,
                false,
                false,
                false,
                vec![Some(80)],
                true,
            ),
            (
                "recent run",
                100,
                false,
                false,
                false,
                false,
                vec![Some(90), Some(1)],
                false,
            ),
            (
                "running",
                100,
                false,
                false,
                false,
                false,
                vec![Some(90), None],
                false,
            ),
            (
                "recent workspace",
                70,
                false,
                false,
                false,
                false,
                vec![Some(80)],
                false,
            ),
            (
                "archived",
                2,
                true,
                false,
                false,
                false,
                vec![Some(2)],
                true,
            ),
            (
                "recent archive",
                0,
                true,
                false,
                false,
                false,
                vec![Some(2)],
                false,
            ),
            (
                "pinned",
                100,
                false,
                true,
                false,
                false,
                vec![Some(80)],
                false,
            ),
            (
                "in place",
                100,
                true,
                false,
                true,
                false,
                vec![Some(80)],
                false,
            ),
            (
                "already deleted",
                100,
                true,
                false,
                false,
                true,
                vec![Some(80)],
                false,
            ),
        ] {
            let id = Uuid::new_v4();
            let updated_at = now - Duration::hours(hours);
            sqlx::query(
                "INSERT INTO workspaces (id, container_ref, branch, created_at, updated_at,
                    archived, pinned, name, worktree_deleted, ephemeral, in_place)
                 VALUES (?, '/test/workspace', 'test', ?, ?, ?, ?, ?, ?, 0, ?)",
            )
            .bind(id)
            .bind(updated_at)
            .bind(updated_at)
            .bind(archived)
            .bind(pinned)
            .bind(name)
            .bind(deleted)
            .bind(in_place)
            .execute(&pool)
            .await
            .unwrap();
            for age in run_ages {
                let session_id = Uuid::new_v4();
                sqlx::query("INSERT INTO sessions VALUES (?, ?)")
                    .bind(session_id)
                    .bind(id)
                    .execute(&pool)
                    .await
                    .unwrap();
                sqlx::query("INSERT INTO execution_processes VALUES (?, ?, ?)")
                    .bind(Uuid::new_v4())
                    .bind(session_id)
                    .bind(age.map(|hours| now - Duration::hours(hours)))
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            if expired {
                expected.push(name.to_owned());
            }
        }
        let candidates = Workspace::find_expired_for_cleanup(&pool, None)
            .await
            .unwrap();
        let mut actual: Vec<_> = candidates
            .iter()
            .map(|workspace| workspace.name.clone().unwrap())
            .collect();
        actual.sort();
        expected.sort();
        assert_eq!(actual, expected);

        let mut actual_build_cache: Vec<_> =
            Workspace::find_expired_for_build_cache_cleanup(&pool, None)
                .await
                .unwrap()
                .into_iter()
                .map(|workspace| workspace.name.unwrap())
                .collect();
        actual_build_cache.sort();
        assert_eq!(actual_build_cache, expected_build_cache);

        // A workspace whose uncommitted changes could not be verified is
        // quarantined instead of retried, so it drops out of the candidates.
        let blocked = candidates
            .iter()
            .find(|workspace| workspace.name.as_deref() == Some("expired"))
            .unwrap()
            .id;
        assert!(
            Workspace::mark_cleanup_blocked(&pool, blocked, "not a readable git worktree")
                .await
                .unwrap()
        );
        // Recorded once: a second pass must not overwrite the original reason.
        assert!(
            !Workspace::mark_cleanup_blocked(&pool, blocked, "some other reason")
                .await
                .unwrap()
        );
        let after: Vec<_> = Workspace::find_expired_for_cleanup(&pool, None)
            .await
            .unwrap()
            .into_iter()
            .map(|workspace| workspace.id)
            .collect();
        assert!(!after.contains(&blocked));
        assert_eq!(after.len(), candidates.len() - 1);
        assert!(
            Workspace::find_expired_for_build_cache_cleanup(&pool, Some(blocked))
                .await
                .unwrap()
                .iter()
                .any(|workspace| workspace.id == blocked)
        );
        assert!(
            Workspace::find_expired_for_cleanup(&pool, Some(blocked))
                .await
                .unwrap()
                .is_empty()
        );

        let id = candidates
            .iter()
            .find(|workspace| workspace.name.as_deref() == Some("archived"))
            .unwrap()
            .id;
        assert_eq!(
            Workspace::find_expired_for_cleanup(&pool, Some(id))
                .await
                .unwrap()
                .len(),
            1
        );
        Workspace::touch(&pool, id).await.unwrap();
        assert!(
            Workspace::find_expired_for_cleanup(&pool, Some(id))
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            Workspace::find_expired_for_build_cache_cleanup(&pool, Some(id))
                .await
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn best_matching_container_ref_prefers_deepest_match() {
        let broad_id = Uuid::new_v4();
        let exact_id = Uuid::new_v4();
        let selected = Workspace::best_matching_container_ref(
            "/tmp/ws/repo/packages/app",
            [(broad_id, "/tmp"), (exact_id, "/tmp/ws")].into_iter(),
        );

        assert_eq!(selected, Some(exact_id));
    }

    #[test]
    fn best_matching_container_ref_supports_parent_request_path() {
        let workspace_id = Uuid::new_v4();
        let selected = Workspace::best_matching_container_ref(
            "/tmp/ws/repo",
            [(workspace_id, "/tmp/ws/repo/packages/app")].into_iter(),
        );

        assert_eq!(selected, Some(workspace_id));
    }

    #[test]
    fn best_matching_container_ref_ignores_unrelated_paths() {
        let workspace_id = Uuid::new_v4();
        let selected = Workspace::best_matching_container_ref(
            "/tmp/other/path",
            [(workspace_id, "/tmp/ws")].into_iter(),
        );

        assert_eq!(selected, None);
    }
}
