use std::str::FromStr;

use chrono::{DateTime, Utc};
use executors::{
    executors::BaseCodingAgent,
    profile::{ExecutorConfigs, ExecutorProfileId},
};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use thiserror::Error;
use ts_rs::TS;
use uuid::Uuid;

use super::{workspace::Workspace, workspace_repo::WorkspaceRepo};

#[derive(Debug, Error)]
pub enum SessionError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error("Session not found")]
    NotFound,
    #[error("Workspace not found")]
    WorkspaceNotFound,
    #[error("Executor mismatch: session uses {expected} but request specified {actual}")]
    ExecutorMismatch { expected: String, actual: String },
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
pub struct Session {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub name: Option<String>,
    pub executor: Option<String>,
    pub agent_working_dir: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Whether usage-based auto-resume is enabled for this session. Seeded from
    /// the agent's `auto_resume_on_limit` setting at creation; toggled per
    /// session from the workspace chat UI.
    pub auto_resume_enabled: bool,
}

#[derive(Debug, Deserialize, TS)]
pub struct CreateSession {
    pub executor: Option<String>,
    /// Variant of `executor` this session will run, when the caller already
    /// knows it. Only used to seed the auto-resume toggle from the right
    /// profile; the column stores the base executor alone.
    #[serde(default)]
    pub variant: Option<String>,
    pub name: Option<String>,
}

impl Session {
    pub async fn find_by_id(pool: &SqlitePool, id: Uuid) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as!(
            Session,
            r#"SELECT id AS "id!: Uuid",
                      workspace_id AS "workspace_id!: Uuid",
                      name,
                      executor,
                      agent_working_dir,
                      created_at AS "created_at!: DateTime<Utc>",
                      updated_at AS "updated_at!: DateTime<Utc>",
                      auto_resume_enabled AS "auto_resume_enabled!: bool"
               FROM sessions
               WHERE id = $1"#,
            id
        )
        .fetch_optional(pool)
        .await
    }

    /// Find all sessions for a workspace, ordered by most recently used.
    /// "Most recently used" is defined as the most recent non-dev server execution process.
    /// Sessions with no executions fall back to created_at for ordering.
    pub async fn find_by_workspace_id(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as!(
            Session,
            r#"SELECT s.id AS "id!: Uuid",
                      s.workspace_id AS "workspace_id!: Uuid",
                      s.name,
                      s.executor,
                      s.agent_working_dir,
                      s.created_at AS "created_at!: DateTime<Utc>",
                      COALESCE(latest_ep.last_used, s.created_at) AS "updated_at!: DateTime<Utc>",
                      s.auto_resume_enabled AS "auto_resume_enabled!: bool"
               FROM sessions s
               LEFT JOIN (
                   SELECT ep.session_id, MAX(ep.created_at) as last_used
                   FROM execution_processes ep
                   WHERE ep.run_reason != 'devserver' AND ep.dropped = FALSE
                   GROUP BY ep.session_id
               ) latest_ep ON s.id = latest_ep.session_id
               WHERE s.workspace_id = $1
               ORDER BY COALESCE(latest_ep.last_used, s.created_at) DESC"#,
            workspace_id
        )
        .fetch_all(pool)
        .await
    }

    /// Find the most recently used session for a workspace.
    /// "Most recently used" is defined as the most recent non-dev server execution process.
    /// Sessions with no executions fall back to created_at for ordering.
    pub async fn find_latest_by_workspace_id(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as!(
            Session,
            r#"SELECT s.id AS "id!: Uuid",
                      s.workspace_id AS "workspace_id!: Uuid",
                      s.name,
                      s.executor,
                      s.agent_working_dir,
                      s.created_at AS "created_at!: DateTime<Utc>",
                      s.updated_at AS "updated_at!: DateTime<Utc>",
                      s.auto_resume_enabled AS "auto_resume_enabled!: bool"
               FROM sessions s
               LEFT JOIN (
                   SELECT ep.session_id, MAX(ep.created_at) as last_used
                   FROM execution_processes ep
                   WHERE ep.run_reason != 'devserver' AND ep.dropped = FALSE
                   GROUP BY ep.session_id
               ) latest_ep ON s.id = latest_ep.session_id
               WHERE s.workspace_id = $1
               ORDER BY COALESCE(latest_ep.last_used, s.created_at) DESC
               LIMIT 1"#,
            workspace_id
        )
        .fetch_optional(pool)
        .await
    }

    /// Find the first-created session for a workspace.
    /// This is a temporary policy for orchestrator MCP session discovery.
    pub async fn find_first_by_workspace_id(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Session>(
            r#"SELECT id,
                      workspace_id,
                      name,
                      executor,
                      agent_working_dir,
                      created_at,
                      updated_at,
                      auto_resume_enabled
               FROM sessions
               WHERE workspace_id = ?
               ORDER BY created_at ASC, id ASC
               LIMIT 1"#,
        )
        .bind(workspace_id)
        .fetch_optional(pool)
        .await
    }

    pub async fn create(
        pool: &SqlitePool,
        data: &CreateSession,
        id: Uuid,
        workspace_id: Uuid,
    ) -> Result<Self, SessionError> {
        let agent_working_dir = Self::resolve_agent_working_dir(pool, workspace_id).await?;
        let name = data.name.as_deref().filter(|s| !s.is_empty());
        let auto_resume_enabled = Self::seeded_auto_resume(
            &ExecutorConfigs::get_cached(),
            data.executor.as_deref(),
            data.variant.as_deref(),
        );

        Ok(sqlx::query_as!(
            Session,
            r#"INSERT INTO sessions (id, workspace_id, name, executor, agent_working_dir, auto_resume_enabled)
               VALUES ($1, $2, $3, $4, $5, $6)
               RETURNING id AS "id!: Uuid",
                         workspace_id AS "workspace_id!: Uuid",
                         name,
                         executor,
                         agent_working_dir,
                         created_at AS "created_at!: DateTime<Utc>",
                         updated_at AS "updated_at!: DateTime<Utc>",
                         auto_resume_enabled AS "auto_resume_enabled!: bool""#,
            id,
            workspace_id,
            name,
            data.executor,
            agent_working_dir,
            auto_resume_enabled
        )
        .fetch_one(pool)
        .await?)
    }

    /// Seed the per-session auto-resume toggle from the agent's
    /// `auto_resume_on_limit` setting. Seeding here rather than at the call
    /// sites is what makes that setting actually reach sessions started from the
    /// board, from automation or for a review — none of those go through the
    /// sessions route, and they create the session with `executor` already set,
    /// which also skips the follow-up route's late seeding. Executors that are
    /// not coding agents (`dev-server`, `gh-cli`, …) don't parse and stay off.
    fn seeded_auto_resume(
        configs: &ExecutorConfigs,
        executor: Option<&str>,
        variant: Option<&str>,
    ) -> bool {
        let Some(executor) = executor.and_then(|executor| BaseCodingAgent::from_str(executor).ok())
        else {
            return false;
        };
        // Variants carry their own `auto_resume_on_limit`, so one that opts out
        // must not inherit DEFAULT's opt-in. An unknown variant falls back to
        // DEFAULT, matching the config the run itself resolves.
        configs
            .get_coding_agent(&ExecutorProfileId {
                executor,
                variant: variant.map(str::to_string),
            })
            .or_else(|| configs.get_coding_agent(&ExecutorProfileId::new(executor)))
            .is_some_and(|agent| agent.auto_resume_on_limit())
    }

    async fn resolve_agent_working_dir(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<Option<String>, sqlx::Error> {
        // In-place ("quick chat") workspaces set `container_ref` to the repo root
        // itself, so the agent runs there directly with no per-repo subdir offset.
        if let Some(workspace) = Workspace::find_by_id(pool, workspace_id).await?
            && workspace.in_place
        {
            return Ok(None);
        }

        let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace_id).await?;
        if repos.len() != 1 {
            return Ok(None);
        }

        let repo = &repos[0];
        let path = match repo.default_working_dir.as_deref() {
            Some(subdir) if !subdir.is_empty() => std::path::PathBuf::from(&repo.name).join(subdir),
            _ => std::path::PathBuf::from(&repo.name),
        };

        Ok(Some(path.to_string_lossy().to_string()))
    }

    pub async fn update(
        pool: &SqlitePool,
        id: Uuid,
        name: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        let name_value = name.filter(|s| !s.is_empty());
        let name_provided = name.is_some();

        sqlx::query!(
            r#"UPDATE sessions SET
                name = CASE WHEN $1 THEN $2 ELSE name END,
                updated_at = datetime('now', 'subsec')
            WHERE id = $3"#,
            name_provided,
            name_value,
            id
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn update_executor(
        pool: &SqlitePool,
        id: Uuid,
        executor: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query!(
            r#"UPDATE sessions SET executor = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2"#,
            executor,
            id
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Toggle usage-based auto-resume for a session.
    pub async fn set_auto_resume_enabled(
        pool: &SqlitePool,
        id: Uuid,
        enabled: bool,
    ) -> Result<(), sqlx::Error> {
        sqlx::query!(
            r#"UPDATE sessions SET auto_resume_enabled = $1, updated_at = datetime('now', 'subsec') WHERE id = $2"#,
            enabled,
            id
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Delete a session. Related rows (execution_processes and their children)
    /// are removed via `ON DELETE CASCADE`. Returns the number of rows affected.
    pub async fn delete(pool: &SqlitePool, id: Uuid) -> Result<u64, sqlx::Error> {
        let result = sqlx::query!(r#"DELETE FROM sessions WHERE id = $1"#, id)
            .execute(pool)
            .await?;
        Ok(result.rows_affected())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The guard that keeps script/setup sessions (`dev-server`, `gh-cli`,
    /// `cursor`) out of auto-resume now that every creation path seeds here:
    /// none of those names parse as a coding agent. Coding agents are left out
    /// because their answer comes from the machine's profiles.json.
    #[test]
    fn only_coding_agents_can_seed_auto_resume() {
        let configs = profiles();
        for executor in [None, Some("dev-server"), Some("gh-cli"), Some("cursor")] {
            assert!(
                !Session::seeded_auto_resume(&configs, executor, None),
                "{executor:?} must not seed auto-resume"
            );
        }
    }

    /// A variant that opts out must not inherit DEFAULT's opt-in; an unknown
    /// variant falls back to DEFAULT, which is what the run itself resolves.
    #[test]
    fn variant_overrides_the_default_auto_resume() {
        let configs = profiles();
        for (variant, expected) in [
            (None, true),
            (Some("NO_RESUME"), false),
            (Some("NOT_A_VARIANT"), true),
        ] {
            assert_eq!(
                Session::seeded_auto_resume(&configs, Some("CLAUDE_CODE"), variant),
                expected,
                "CLAUDE_CODE:{variant:?}"
            );
        }
    }

    fn profiles() -> ExecutorConfigs {
        serde_json::from_str(
            r#"{"executors":{"CLAUDE_CODE":{
                 "DEFAULT":{"CLAUDE_CODE":{"auto_resume_on_limit":true}},
                 "NO_RESUME":{"CLAUDE_CODE":{"auto_resume_on_limit":false}}}}}"#,
        )
        .expect("test profiles must parse")
    }
}
