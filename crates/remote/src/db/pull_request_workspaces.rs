use api_types::PullRequestWorkspace;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

pub struct PullRequestWorkspaceRepository;

impl PullRequestWorkspaceRepository {
    pub async fn list_by_project(
        pool: &PgPool,
        project_id: Uuid,
    ) -> Result<Vec<PullRequestWorkspace>, sqlx::Error> {
        sqlx::query_as(
            "SELECT id, pull_request_id, workspace_id, issue_id, project_id
             FROM pull_request_workspaces WHERE project_id = $1",
        )
        .bind(project_id)
        .fetch_all(pool)
        .await
    }

    /// Caller holds the workspace and PR row locks, in that order.
    pub async fn create(
        tx: &mut Transaction<'_, Postgres>,
        pull_request_id: Uuid,
        workspace_id: Uuid,
        issue_id: Uuid,
        project_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO pull_request_issues (pull_request_id, issue_id, project_id, is_explicit)
             VALUES ($1, $2, $3, FALSE)
             ON CONFLICT (pull_request_id, issue_id) DO NOTHING",
        )
        .bind(pull_request_id)
        .bind(issue_id)
        .bind(project_id)
        .execute(&mut **tx)
        .await?;
        sqlx::query(
            "INSERT INTO pull_request_workspaces (pull_request_id, workspace_id, issue_id, project_id)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (pull_request_id, workspace_id) DO NOTHING",
        )
        .bind(pull_request_id)
        .bind(workspace_id)
        .bind(issue_id)
        .bind(project_id)
        .execute(&mut **tx)
        .await?;
        Ok(())
    }

    /// Caller holds the workspace lock. Lock PRs in order to serialize shared unlinks.
    pub async fn unlink_workspace(
        tx: &mut Transaction<'_, Postgres>,
        workspace_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        let prs: Vec<Uuid> = sqlx::query_scalar(
            "SELECT id FROM pull_requests
             WHERE id IN (SELECT pull_request_id FROM pull_request_workspaces WHERE workspace_id = $1)
             ORDER BY id FOR UPDATE",
        )
        .bind(workspace_id)
        .fetch_all(&mut **tx)
        .await?;
        for pr_id in prs {
            let issue: Option<Uuid> = sqlx::query_scalar(
                "DELETE FROM pull_request_workspaces
                 WHERE pull_request_id = $1 AND workspace_id = $2 RETURNING issue_id",
            )
            .bind(pr_id)
            .bind(workspace_id)
            .fetch_optional(&mut **tx)
            .await?;
            if let Some(issue_id) = issue {
                sqlx::query(
                    "DELETE FROM pull_request_issues
                     WHERE pull_request_id = $1 AND issue_id = $2 AND NOT is_explicit
                     AND NOT EXISTS (
                         SELECT 1 FROM pull_request_workspaces
                         WHERE pull_request_id = $1 AND issue_id = $2
                     )",
                )
                .bind(pr_id)
                .bind(issue_id)
                .execute(&mut **tx)
                .await?;
                sqlx::query(
                    "DELETE FROM pull_requests WHERE id = $1
                     AND NOT EXISTS (SELECT 1 FROM pull_request_issues WHERE pull_request_id = $1)",
                )
                .bind(pr_id)
                .execute(&mut **tx)
                .await?;
            }
        }
        Ok(())
    }
}
