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
            "#,
            issue_id
        )
        .fetch_all(pool)
        .await?;

        Ok(records)
    }
}
