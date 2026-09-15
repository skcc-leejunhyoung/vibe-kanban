use api_types::{DeleteResponse, IssueComment, MutationResponse};
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

use super::get_txid;

#[derive(Debug, Error)]
pub enum IssueCommentError {
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
}

pub struct IssueCommentRepository;

impl IssueCommentRepository {
    pub async fn find_by_id(
        pool: &PgPool,
        id: Uuid,
    ) -> Result<Option<IssueComment>, IssueCommentError> {
        let record = sqlx::query_as!(
            IssueComment,
            r#"
            SELECT
                id          AS "id!: Uuid",
                issue_id    AS "issue_id!: Uuid",
                author_id   AS "author_id: Uuid",
                parent_id   AS "parent_id: Uuid",
                message     AS "message!",
                github_comment_id   AS "github_comment_id: String",
                github_author_login AS "github_author_login: String",
                created_at  AS "created_at!: DateTime<Utc>",
                updated_at  AS "updated_at!: DateTime<Utc>"
            FROM issue_comments
            WHERE id = $1
            "#,
            id
        )
        .fetch_optional(pool)
        .await?;

        Ok(record)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn create(
        pool: &PgPool,
        id: Option<Uuid>,
        issue_id: Uuid,
        author_id: Uuid,
        parent_id: Option<Uuid>,
        message: String,
        github_comment_id: Option<String>,
        github_author_login: Option<String>,
    ) -> Result<MutationResponse<IssueComment>, IssueCommentError> {
        let id = id.unwrap_or_else(Uuid::new_v4);
        let now = Utc::now();
        let mut tx = super::begin_tx(pool).await?;
        let data = sqlx::query_as!(
            IssueComment,
            r#"
            INSERT INTO issue_comments (id, issue_id, author_id, parent_id, message, github_comment_id, github_author_login, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING
                id          AS "id!: Uuid",
                issue_id    AS "issue_id!: Uuid",
                author_id   AS "author_id: Uuid",
                parent_id   AS "parent_id: Uuid",
                message     AS "message!",
                github_comment_id   AS "github_comment_id: String",
                github_author_login AS "github_author_login: String",
                created_at  AS "created_at!: DateTime<Utc>",
                updated_at  AS "updated_at!: DateTime<Utc>"
            "#,
            id,
            issue_id,
            author_id,
            parent_id,
            message,
            github_comment_id,
            github_author_login,
            now,
            now
        )
        .fetch_one(&mut *tx)
        .await?;
        let txid = get_txid(&mut *tx).await?;
        tx.commit().await?;

        Ok(MutationResponse { data, txid })
    }

    /// Update an issue comment with partial fields. Uses COALESCE to preserve existing values
    /// when None is provided.
    pub async fn update(
        pool: &PgPool,
        id: Uuid,
        message: Option<String>,
        github_comment_id: Option<String>,
    ) -> Result<MutationResponse<IssueComment>, IssueCommentError> {
        let updated_at = Utc::now();
        let mut tx = super::begin_tx(pool).await?;
        let data = sqlx::query_as!(
            IssueComment,
            r#"
            UPDATE issue_comments
            SET
                message = COALESCE($1, message),
                github_comment_id = COALESCE($4, github_comment_id),
                updated_at = $2
            WHERE id = $3
            RETURNING
                id          AS "id!: Uuid",
                issue_id    AS "issue_id!: Uuid",
                author_id   AS "author_id: Uuid",
                parent_id   AS "parent_id: Uuid",
                message     AS "message!",
                github_comment_id   AS "github_comment_id: String",
                github_author_login AS "github_author_login: String",
                created_at  AS "created_at!: DateTime<Utc>",
                updated_at  AS "updated_at!: DateTime<Utc>"
            "#,
            message,
            updated_at,
            id,
            github_comment_id
        )
        .fetch_one(&mut *tx)
        .await?;
        let txid = get_txid(&mut *tx).await?;
        tx.commit().await?;

        Ok(MutationResponse { data, txid })
    }

    pub async fn delete(pool: &PgPool, id: Uuid) -> Result<DeleteResponse, IssueCommentError> {
        let mut tx = super::begin_tx(pool).await?;
        sqlx::query!("DELETE FROM issue_comments WHERE id = $1", id)
            .execute(&mut *tx)
            .await?;
        let txid = get_txid(&mut *tx).await?;
        tx.commit().await?;
        Ok(DeleteResponse { txid })
    }

    pub async fn list_by_issue(
        pool: &PgPool,
        issue_id: Uuid,
    ) -> Result<Vec<IssueComment>, IssueCommentError> {
        Self::list_by_issue_updated_after(pool, issue_id, None).await
    }

    pub async fn list_by_issue_updated_after(
        pool: &PgPool,
        issue_id: Uuid,
        updated_after: Option<DateTime<Utc>>,
    ) -> Result<Vec<IssueComment>, IssueCommentError> {
        let records = sqlx::query_as!(
            IssueComment,
            r#"
            SELECT
                id          AS "id!: Uuid",
                issue_id    AS "issue_id!: Uuid",
                author_id   AS "author_id: Uuid",
                parent_id   AS "parent_id: Uuid",
                message     AS "message!",
                github_comment_id   AS "github_comment_id: String",
                github_author_login AS "github_author_login: String",
                created_at  AS "created_at!: DateTime<Utc>",
                updated_at  AS "updated_at!: DateTime<Utc>"
            FROM issue_comments
            WHERE issue_id = $1
              AND ($2::timestamptz IS NULL OR updated_at >= $2)
            "#,
            issue_id,
            updated_after
        )
        .fetch_all(pool)
        .await?;

        Ok(records)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::github_issue_links::GithubIssueLinkRepository;

    #[tokio::test]
    #[ignore = "requires SKC_TEST_DATABASE_URL pointing to an isolated PostgreSQL"]
    async fn cursor_is_inclusive_and_versions_detect_old_comment_edits() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .connect(&std::env::var("SKC_TEST_DATABASE_URL").unwrap())
            .await
            .unwrap();
        sqlx::raw_sql(
            "CREATE TEMP TABLE issue_comments (
            id uuid PRIMARY KEY, issue_id uuid NOT NULL, author_id uuid, parent_id uuid,
            message text NOT NULL, github_comment_id text, github_author_login text,
            created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
        )",
        )
        .execute(&pool)
        .await
        .unwrap();
        let issue_id = Uuid::from_u128(1);
        let cutoff: DateTime<Utc> = "2026-09-15T00:00:00Z".parse().unwrap();
        for (id, issue, seconds) in [
            (1, issue_id, -1),
            (2, issue_id, 0),
            (3, issue_id, 1),
            (4, Uuid::from_u128(2), 1),
        ] {
            sqlx::query(
                "INSERT INTO issue_comments
                (id, issue_id, message, created_at, updated_at) VALUES ($1, $2, 'body', $3, $3)",
            )
            .bind(Uuid::from_u128(id))
            .bind(issue)
            .bind(cutoff + chrono::Duration::seconds(seconds))
            .execute(&pool)
            .await
            .unwrap();
        }
        let all = IssueCommentRepository::list_by_issue(&pool, issue_id)
            .await
            .unwrap();
        assert_eq!(all.len(), 3);
        let delta =
            IssueCommentRepository::list_by_issue_updated_after(&pool, issue_id, Some(cutoff))
                .await
                .unwrap();
        assert_eq!(delta.len(), 2);
        assert!(delta.iter().any(|row| row.updated_at == cutoff));
        assert!(delta.iter().all(|row| row.issue_id == issue_id));
        let versions = GithubIssueLinkRepository::comment_versions(&pool, &[issue_id, Uuid::nil()])
            .await
            .unwrap();
        let before = versions
            .iter()
            .find(|row| row.issue_id == issue_id)
            .unwrap();
        assert_eq!(before.comment_count, 3);
        assert_eq!(
            versions
                .iter()
                .find(|row| row.issue_id.is_nil())
                .unwrap()
                .comment_count,
            0
        );
        assert_eq!(versions.len(), 2, "unrequested issues must not be returned");
        sqlx::query("UPDATE issue_comments SET updated_at = $1 WHERE id = $2")
            .bind(cutoff)
            .bind(Uuid::from_u128(1))
            .execute(&pool)
            .await
            .unwrap();
        let after = GithubIssueLinkRepository::comment_versions(&pool, &[issue_id])
            .await
            .unwrap();
        assert_ne!(
            before.version, after[0].version,
            "an older row edit must change the revision even when MAX(updated_at) does not"
        );
        assert_eq!(after[0].comment_count, 3);
        sqlx::query("DELETE FROM issue_comments WHERE id = $1")
            .bind(Uuid::from_u128(1))
            .execute(&pool)
            .await
            .unwrap();
        let deleted = GithubIssueLinkRepository::comment_versions(&pool, &[issue_id])
            .await
            .unwrap();
        assert_eq!(deleted[0].comment_count, 2);
        assert_ne!(after[0].version, deleted[0].version);
        pool.close().await;
    }
}
