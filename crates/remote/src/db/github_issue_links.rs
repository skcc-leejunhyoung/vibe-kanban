use api_types::{CreateGithubIssueLinkRequest, GithubIssueLink, UpdateGithubIssueLinkRequest};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

pub struct GithubIssueLinkRepository;

impl GithubIssueLinkRepository {
    pub async fn find_by_id(
        pool: &PgPool,
        id: Uuid,
    ) -> Result<Option<GithubIssueLink>, sqlx::Error> {
        sqlx::query_as::<_, GithubIssueLink>("SELECT * FROM github_issue_links WHERE id = $1")
            .bind(id)
            .fetch_optional(pool)
            .await
    }

    pub async fn list_by_project(
        pool: &PgPool,
        project_id: Uuid,
    ) -> Result<Vec<GithubIssueLink>, sqlx::Error> {
        sqlx::query_as::<_, GithubIssueLink>(
            "SELECT * FROM github_issue_links WHERE project_id = $1 ORDER BY created_at",
        )
        .bind(project_id)
        .fetch_all(pool)
        .await
    }

    pub async fn list_by_issue(
        pool: &PgPool,
        issue_id: Uuid,
    ) -> Result<Vec<GithubIssueLink>, sqlx::Error> {
        sqlx::query_as::<_, GithubIssueLink>(
            "SELECT * FROM github_issue_links WHERE issue_id = $1 ORDER BY created_at",
        )
        .bind(issue_id)
        .fetch_all(pool)
        .await
    }

    pub async fn create(
        tx: &mut Transaction<'_, Postgres>,
        project_id: Uuid,
        payload: CreateGithubIssueLinkRequest,
    ) -> Result<GithubIssueLink, sqlx::Error> {
        sqlx::query_as::<_, GithubIssueLink>(
            r#"
            INSERT INTO github_issue_links (
                id, project_id, issue_id, repository, number, url,
                github_node_id, project_item_id, github_state,
                github_updated_at, last_synced_vibe_updated_at,
                synced_title, synced_description, synced_vibe_status_id,
                synced_github_status_option_id, synced_parent_issue_id,
                synced_milestone_id, synced_github_milestone_number
            )
            VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                $11, $12, $13, $14, $15, $16, $17, $18
            )
            RETURNING *
            "#,
        )
        .bind(payload.id.unwrap_or_else(Uuid::new_v4))
        .bind(project_id)
        .bind(payload.issue_id)
        .bind(payload.repository)
        .bind(payload.number)
        .bind(payload.url)
        .bind(payload.github_node_id)
        .bind(payload.project_item_id)
        .bind(payload.github_state)
        .bind(payload.github_updated_at)
        .bind(payload.last_synced_vibe_updated_at)
        .bind(payload.synced_title)
        .bind(payload.synced_description)
        .bind(payload.synced_vibe_status_id)
        .bind(payload.synced_github_status_option_id)
        .bind(payload.synced_parent_issue_id)
        .bind(payload.synced_milestone_id)
        .bind(payload.synced_github_milestone_number)
        .fetch_one(&mut **tx)
        .await
    }

    pub async fn update(
        tx: &mut Transaction<'_, Postgres>,
        id: Uuid,
        payload: UpdateGithubIssueLinkRequest,
    ) -> Result<GithubIssueLink, sqlx::Error> {
        let update_synced_description = payload.synced_description.is_some();
        let synced_description = payload.synced_description.flatten();
        let update_synced_parent_issue_id = payload.synced_parent_issue_id.is_some();
        let synced_parent_issue_id = payload.synced_parent_issue_id.flatten();
        let update_synced_milestone_id = payload.synced_milestone_id.is_some();
        let synced_milestone_id = payload.synced_milestone_id.flatten();
        let update_synced_github_milestone_number =
            payload.synced_github_milestone_number.is_some();
        let synced_github_milestone_number = payload.synced_github_milestone_number.flatten();
        sqlx::query_as::<_, GithubIssueLink>(
            r#"
            UPDATE github_issue_links
            SET project_item_id = COALESCE($2, project_item_id),
                github_state = COALESCE($3, github_state),
                github_updated_at = COALESCE($4, github_updated_at),
                last_synced_vibe_updated_at = COALESCE($5, last_synced_vibe_updated_at),
                synced_title = COALESCE($6, synced_title),
                synced_description =
                    CASE WHEN $7 THEN $8 ELSE synced_description END,
                synced_vibe_status_id = COALESCE($9, synced_vibe_status_id),
                synced_github_status_option_id =
                    COALESCE($10, synced_github_status_option_id),
                synced_parent_issue_id =
                    CASE WHEN $11 THEN $12 ELSE synced_parent_issue_id END,
                synced_milestone_id =
                    CASE WHEN $13 THEN $14 ELSE synced_milestone_id END,
                synced_github_milestone_number =
                    CASE WHEN $15 THEN $16 ELSE synced_github_milestone_number END,
                comments_synced_after =
                    COALESCE($17, comments_synced_after),
                updated_at = NOW()
            WHERE id = $1
            RETURNING *
            "#,
        )
        .bind(id)
        .bind(payload.project_item_id)
        .bind(payload.github_state)
        .bind(payload.github_updated_at)
        .bind(payload.last_synced_vibe_updated_at)
        .bind(payload.synced_title)
        .bind(update_synced_description)
        .bind(synced_description)
        .bind(payload.synced_vibe_status_id)
        .bind(payload.synced_github_status_option_id)
        .bind(update_synced_parent_issue_id)
        .bind(synced_parent_issue_id)
        .bind(update_synced_milestone_id)
        .bind(synced_milestone_id)
        .bind(update_synced_github_milestone_number)
        .bind(synced_github_milestone_number)
        .bind(payload.comments_synced_after)
        .fetch_one(&mut **tx)
        .await
    }

    pub async fn delete(tx: &mut Transaction<'_, Postgres>, id: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM github_issue_links WHERE id = $1")
            .bind(id)
            .execute(&mut **tx)
            .await?;
        Ok(())
    }
}
