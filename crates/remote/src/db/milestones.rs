use api_types::{
    CreateIssueMilestoneRequest, CreateProjectMilestoneRequest, DeleteResponse, IssueMilestone,
    MutationResponse, ProjectMilestone, UpdateProjectMilestoneRequest,
};
use sqlx::PgPool;
use uuid::Uuid;

use super::get_txid;

pub struct MilestoneRepository;

impl MilestoneRepository {
    pub async fn find(pool: &PgPool, id: Uuid) -> Result<Option<ProjectMilestone>, sqlx::Error> {
        sqlx::query_as("SELECT * FROM project_milestones WHERE id = $1")
            .bind(id)
            .fetch_optional(pool)
            .await
    }

    pub async fn list(
        pool: &PgPool,
        project_id: Uuid,
    ) -> Result<Vec<ProjectMilestone>, sqlx::Error> {
        sqlx::query_as(
            "SELECT * FROM project_milestones WHERE project_id = $1 ORDER BY completed_at NULLS FIRST, target_date NULLS LAST, name",
        )
        .bind(project_id)
        .fetch_all(pool)
        .await
    }

    pub async fn create(
        pool: &PgPool,
        payload: CreateProjectMilestoneRequest,
    ) -> Result<MutationResponse<ProjectMilestone>, sqlx::Error> {
        let mut tx = super::begin_tx(pool).await?;
        let data = sqlx::query_as(
            r#"INSERT INTO project_milestones
               (id, project_id, name, start_date, target_date, completed_at, source_repository, source_number)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *"#,
        )
        .bind(payload.id.unwrap_or_else(Uuid::new_v4))
        .bind(payload.project_id)
        .bind(payload.name)
        .bind(payload.start_date)
        .bind(payload.target_date)
        .bind(payload.completed_at)
        .bind(payload.source_repository)
        .bind(payload.source_number)
        .fetch_one(&mut *tx)
        .await?;
        let txid = get_txid(&mut *tx).await?;
        tx.commit().await?;
        Ok(MutationResponse { data, txid })
    }

    pub async fn update(
        pool: &PgPool,
        id: Uuid,
        payload: UpdateProjectMilestoneRequest,
    ) -> Result<MutationResponse<ProjectMilestone>, sqlx::Error> {
        let mut tx = super::begin_tx(pool).await?;
        let set_start = payload.start_date.is_some();
        let start_date = payload.start_date.flatten();
        let set_target = payload.target_date.is_some();
        let target_date = payload.target_date.flatten();
        let set_completed = payload.completed_at.is_some();
        let completed_at = payload.completed_at.flatten();
        let set_source_repository = payload.source_repository.is_some();
        let source_repository = payload.source_repository.flatten();
        let set_source_number = payload.source_number.is_some();
        let source_number = payload.source_number.flatten();
        let data = sqlx::query_as(
            r#"UPDATE project_milestones SET
               name = COALESCE($2, name),
               start_date = CASE WHEN $3 THEN $4 ELSE start_date END,
               target_date = CASE WHEN $5 THEN $6 ELSE target_date END,
               completed_at = CASE WHEN $7 THEN $8 ELSE completed_at END,
               source_repository = CASE WHEN $9 THEN $10 ELSE source_repository END,
               source_number = CASE WHEN $11 THEN $12 ELSE source_number END,
               updated_at = NOW()
               WHERE id = $1 RETURNING *"#,
        )
        .bind(id)
        .bind(payload.name)
        .bind(set_start)
        .bind(start_date)
        .bind(set_target)
        .bind(target_date)
        .bind(set_completed)
        .bind(completed_at)
        .bind(set_source_repository)
        .bind(source_repository)
        .bind(set_source_number)
        .bind(source_number)
        .fetch_one(&mut *tx)
        .await?;
        let txid = get_txid(&mut *tx).await?;
        tx.commit().await?;
        Ok(MutationResponse { data, txid })
    }

    pub async fn delete(pool: &PgPool, id: Uuid) -> Result<DeleteResponse, sqlx::Error> {
        let mut tx = super::begin_tx(pool).await?;
        sqlx::query("DELETE FROM project_milestones WHERE id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        let txid = get_txid(&mut *tx).await?;
        tx.commit().await?;
        Ok(DeleteResponse { txid })
    }
}

pub struct IssueMilestoneRepository;

impl IssueMilestoneRepository {
    pub async fn find(pool: &PgPool, id: Uuid) -> Result<Option<IssueMilestone>, sqlx::Error> {
        sqlx::query_as("SELECT * FROM issue_milestones WHERE id = $1")
            .bind(id)
            .fetch_optional(pool)
            .await
    }

    pub async fn list(pool: &PgPool, project_id: Uuid) -> Result<Vec<IssueMilestone>, sqlx::Error> {
        sqlx::query_as("SELECT * FROM issue_milestones WHERE project_id = $1")
            .bind(project_id)
            .fetch_all(pool)
            .await
    }

    pub async fn upsert(
        pool: &PgPool,
        payload: CreateIssueMilestoneRequest,
    ) -> Result<MutationResponse<IssueMilestone>, sqlx::Error> {
        let mut tx = super::begin_tx(pool).await?;
        let data = sqlx::query_as(
            r#"INSERT INTO issue_milestones (id, project_id, issue_id, milestone_id)
               SELECT $1, i.project_id, i.id, $3
               FROM issues i JOIN project_milestones m ON m.id = $3 AND m.project_id = i.project_id
               WHERE i.id = $2
               ON CONFLICT (issue_id) DO UPDATE SET milestone_id = EXCLUDED.milestone_id
               RETURNING *"#,
        )
        .bind(payload.id.unwrap_or_else(Uuid::new_v4))
        .bind(payload.issue_id)
        .bind(payload.milestone_id)
        .fetch_one(&mut *tx)
        .await?;
        let txid = get_txid(&mut *tx).await?;
        tx.commit().await?;
        Ok(MutationResponse { data, txid })
    }

    pub async fn delete(pool: &PgPool, id: Uuid) -> Result<DeleteResponse, sqlx::Error> {
        let mut tx = super::begin_tx(pool).await?;
        sqlx::query("DELETE FROM issue_milestones WHERE id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        let txid = get_txid(&mut *tx).await?;
        tx.commit().await?;
        Ok(DeleteResponse { txid })
    }
}
