use api_types::{CreateGithubIssueLinkRequest, GithubIssueLink, UpdateGithubIssueLinkRequest};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

#[derive(Debug, serde::Serialize, sqlx::FromRow)]
pub struct GithubIssueCommentVersion {
    pub issue_id: Uuid,
    pub comment_count: i64,
    pub version: String,
}

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

    /// Called only with issue IDs from an already authorized link listing.
    /// Hash every row's revision so an edit to an older comment is detected too.
    pub async fn comment_versions(
        pool: &PgPool,
        issue_ids: &[Uuid],
    ) -> Result<Vec<GithubIssueCommentVersion>, sqlx::Error> {
        sqlx::query_as::<_, GithubIssueCommentVersion>(
            r#"
            SELECT ids.issue_id, COUNT(c.id) AS comment_count,
                   MD5(COALESCE(STRING_AGG(c.id::text || ':' || c.updated_at::text,
                                          ',' ORDER BY c.id), '')) AS version
            FROM (SELECT DISTINCT UNNEST($1::uuid[]) AS issue_id) ids
            LEFT JOIN issue_comments c ON c.issue_id = ids.issue_id
            GROUP BY ids.issue_id
            "#,
        )
        .bind(issue_ids)
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
        let updated = sqlx::query_as::<_, GithubIssueLink>(
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
              AND ROW(
                  project_item_id, github_state, github_updated_at,
                  last_synced_vibe_updated_at, synced_title, synced_description,
                  synced_vibe_status_id, synced_github_status_option_id,
                  synced_parent_issue_id, synced_milestone_id,
                  synced_github_milestone_number, comments_synced_after
              ) IS DISTINCT FROM ROW(
                  COALESCE($2, project_item_id), COALESCE($3, github_state),
                  COALESCE($4, github_updated_at),
                  COALESCE($5, last_synced_vibe_updated_at),
                  COALESCE($6, synced_title),
                  CASE WHEN $7 THEN $8 ELSE synced_description END,
                  COALESCE($9, synced_vibe_status_id),
                  COALESCE($10, synced_github_status_option_id),
                  CASE WHEN $11 THEN $12 ELSE synced_parent_issue_id END,
                  CASE WHEN $13 THEN $14 ELSE synced_milestone_id END,
                  CASE WHEN $15 THEN $16 ELSE synced_github_milestone_number END,
                  COALESCE($17, comments_synced_after)
              )
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
        .fetch_optional(&mut **tx)
        .await?;
        match updated {
            Some(link) => Ok(link),
            // A separate READ COMMITTED statement also sees a concurrent updater
            // that made our PATCH a no-op while UPDATE waited on its row lock.
            None => {
                sqlx::query_as::<_, GithubIssueLink>(
                    "SELECT * FROM github_issue_links WHERE id = $1",
                )
                .bind(id)
                .fetch_one(&mut **tx)
                .await
            }
        }
    }

    pub async fn delete(tx: &mut Transaction<'_, Postgres>, id: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM github_issue_links WHERE id = $1")
            .bind(id)
            .execute(&mut **tx)
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Uses only a connection-local temporary table; no application rows touched.
    #[tokio::test]
    #[ignore = "requires SKC_TEST_DATABASE_URL pointing to an isolated PostgreSQL"]
    async fn no_op_keeps_tuple_and_nullable_updates_work() {
        let pool = PgPool::connect(&std::env::var("SKC_TEST_DATABASE_URL").unwrap())
            .await
            .unwrap();
        let mut tx = pool.begin().await.unwrap();
        sqlx::raw_sql(
            "CREATE TEMP TABLE github_issue_links (
                id uuid PRIMARY KEY, project_id uuid, issue_id uuid,
                repository text, number integer, url text, github_node_id text,
                project_item_id text, github_state text, github_updated_at timestamptz,
                last_synced_vibe_updated_at timestamptz, synced_title text,
                synced_description text, synced_vibe_status_id uuid,
                synced_github_status_option_id text, synced_parent_issue_id uuid,
                synced_milestone_id uuid, synced_github_milestone_number integer,
                comments_synced_after timestamptz, created_at timestamptz,
                updated_at timestamptz
            ) ON COMMIT DROP;
            INSERT INTO github_issue_links
                (id, project_id, issue_id, repository, number, url, github_state,
                 synced_title, synced_description, created_at, updated_at)
            VALUES ('00000000-0000-0000-0000-000000000001',
                    gen_random_uuid(), gen_random_uuid(), 'owner/repo', 1, 'url',
                    'open', 'title', 'description', '2026-01-01Z', '2026-01-01Z');",
        )
        .execute(&mut *tx)
        .await
        .unwrap();
        let id = Uuid::from_u128(1);
        let before: (String, chrono::DateTime<chrono::Utc>) =
            sqlx::query_as("SELECT ctid::text, updated_at FROM github_issue_links")
                .fetch_one(&mut *tx)
                .await
                .unwrap();
        for payload in [
            UpdateGithubIssueLinkRequest::default(),
            serde_json::from_value(
                serde_json::json!({"synced_title": "title", "github_state": null}),
            )
            .unwrap(),
        ] {
            let row = GithubIssueLinkRepository::update(&mut tx, id, payload)
                .await
                .unwrap();
            assert_eq!(row.synced_title.as_deref(), Some("title"));
        }
        let after: (String, chrono::DateTime<chrono::Utc>) =
            sqlx::query_as("SELECT ctid::text, updated_at FROM github_issue_links")
                .fetch_one(&mut *tx)
                .await
                .unwrap();
        assert_eq!(
            before, after,
            "no-op must not create a tuple or update timestamp"
        );
        let changed = GithubIssueLinkRepository::update(
            &mut tx,
            id,
            serde_json::from_value(serde_json::json!({
                "synced_title": "changed", "synced_description": null,
                "synced_github_milestone_number": 3
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(changed.synced_title.as_deref(), Some("changed"));
        assert_eq!(changed.synced_description, None);
        assert_eq!(changed.synced_github_milestone_number, Some(3));
        let new_tuple: String = sqlx::query_scalar("SELECT ctid::text FROM github_issue_links")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        assert_ne!(before.0, new_tuple);
        let cleared = GithubIssueLinkRepository::update(
            &mut tx,
            id,
            serde_json::from_value(serde_json::json!({"synced_github_milestone_number": null}))
                .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(cleared.synced_github_milestone_number, None);
        assert!(matches!(
            GithubIssueLinkRepository::update(
                &mut tx,
                Uuid::nil(),
                UpdateGithubIssueLinkRequest::default()
            )
            .await,
            Err(sqlx::Error::RowNotFound)
        ));
        tx.rollback().await.unwrap();
    }
}
