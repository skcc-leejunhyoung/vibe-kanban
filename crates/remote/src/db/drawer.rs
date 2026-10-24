//! Drawer notes and comments (see `api_types::drawer`). Runtime queries, so no
//! offline SQLx data is needed.

use api_types::{
    CreateDrawerCommentRequest, CreateDrawerNoteRequest, DrawerComment, DrawerCommentAuthor,
    DrawerNote, MutationResponse, UpdateDrawerNoteRequest,
};
use chrono::{DateTime, Utc};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use super::get_txid;

/// Archived notes are deleted this many days after being archived.
const ARCHIVE_RETENTION_DAYS: i32 = 90;

pub async fn prune_archived(pool: &PgPool) -> Result<u64, sqlx::Error> {
    Ok(sqlx::query(
        "DELETE FROM drawer_notes WHERE archived_at < NOW() - make_interval(days => $1)",
    )
    .bind(ARCHIVE_RETENTION_DAYS)
    .execute(pool)
    .await?
    .rows_affected())
}

pub fn spawn_retention(pool: PgPool) {
    tokio::spawn(async move {
        loop {
            if let Err(error) = prune_archived(&pool).await {
                tracing::warn!(?error, "Drawer retention deferred");
            }
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
        }
    });
}

#[derive(FromRow)]
struct CommentRow {
    id: Uuid,
    note_id: Uuid,
    owner_user_id: Uuid,
    author: String,
    body: String,
    created_at: DateTime<Utc>,
}

impl From<CommentRow> for DrawerComment {
    fn from(row: CommentRow) -> Self {
        Self {
            id: row.id,
            note_id: row.note_id,
            owner_user_id: row.owner_user_id,
            author: DrawerCommentAuthor::parse(&row.author),
            body: row.body,
            created_at: row.created_at,
        }
    }
}

const NOTE_COLUMNS: &str = "id, owner_user_id, host_id, workspace_id, session_id, execution_id, \
     title, body, label, pinned, archived_at, user_seen_at, last_comment_at, created_at, updated_at";

pub struct DrawerRepository;

impl DrawerRepository {
    /// `archived`: `Some(true)` archived only, `Some(false)` inbox only, `None` both.
    pub async fn list_notes(
        pool: &PgPool,
        owner_user_id: Uuid,
        archived: Option<bool>,
    ) -> Result<Vec<DrawerNote>, sqlx::Error> {
        sqlx::query_as::<_, DrawerNote>(&format!(
            "SELECT {NOTE_COLUMNS} FROM drawer_notes
             WHERE owner_user_id = $1
               AND ($2::bool IS NULL OR (archived_at IS NOT NULL) = $2)
             ORDER BY pinned DESC, GREATEST(updated_at, COALESCE(last_comment_at, updated_at)) DESC"
        ))
        .bind(owner_user_id)
        .bind(archived)
        .fetch_all(pool)
        .await
    }

    pub async fn find_note(pool: &PgPool, id: Uuid) -> Result<Option<DrawerNote>, sqlx::Error> {
        sqlx::query_as::<_, DrawerNote>(&format!(
            "SELECT {NOTE_COLUMNS} FROM drawer_notes WHERE id = $1"
        ))
        .bind(id)
        .fetch_optional(pool)
        .await
    }

    pub async fn create_note(
        pool: &PgPool,
        owner_user_id: Uuid,
        request: CreateDrawerNoteRequest,
    ) -> Result<MutationResponse<DrawerNote>, sqlx::Error> {
        let mut tx = super::begin_tx(pool).await?;
        let data = sqlx::query_as::<_, DrawerNote>(&format!(
            "INSERT INTO drawer_notes
                (id, owner_user_id, host_id, workspace_id, session_id, execution_id,
                 title, body, label, pinned)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING {NOTE_COLUMNS}"
        ))
        .bind(request.id.unwrap_or_else(Uuid::new_v4))
        .bind(owner_user_id)
        .bind(request.host_id)
        .bind(request.workspace_id)
        .bind(request.session_id)
        .bind(request.execution_id)
        .bind(request.title)
        .bind(request.body)
        .bind(request.label)
        .bind(request.pinned.unwrap_or(false))
        .fetch_one(&mut *tx)
        .await?;
        let txid = get_txid(&mut *tx).await?;
        tx.commit().await?;
        Ok(MutationResponse { data, txid })
    }

    /// Absent fields keep their value. Title/body changes bump `updated_at`
    /// (which makes the note unread again); seen/archive changes do not.
    pub async fn update_note(
        pool: &PgPool,
        id: Uuid,
        request: UpdateDrawerNoteRequest,
    ) -> Result<MutationResponse<DrawerNote>, sqlx::Error> {
        let content_changed = request.title.is_some() || request.body.is_some();
        let (label_set, label) = match request.label {
            Some(label) => (true, label),
            None => (false, None),
        };
        let mut tx = super::begin_tx(pool).await?;
        let data = sqlx::query_as::<_, DrawerNote>(&format!(
            "UPDATE drawer_notes SET
                title = COALESCE($2, title),
                body = COALESCE($3, body),
                label = CASE WHEN $4 THEN $5 ELSE label END,
                pinned = COALESCE($6, pinned),
                archived_at = CASE
                    WHEN $7 = TRUE AND archived_at IS NULL THEN NOW()
                    WHEN $7 = FALSE THEN NULL
                    ELSE archived_at END,
                user_seen_at = CASE WHEN $8 = TRUE THEN NOW() ELSE user_seen_at END,
                host_id = COALESCE($9, host_id),
                workspace_id = COALESCE($10, workspace_id),
                session_id = COALESCE($11, session_id),
                execution_id = COALESCE($12, execution_id),
                updated_at = CASE WHEN $13 THEN NOW() ELSE updated_at END
             WHERE id = $1
             RETURNING {NOTE_COLUMNS}"
        ))
        .bind(id)
        .bind(request.title)
        .bind(request.body)
        .bind(label_set)
        .bind(label)
        .bind(request.pinned)
        .bind(request.archived)
        .bind(request.seen)
        .bind(request.host_id)
        .bind(request.workspace_id)
        .bind(request.session_id)
        .bind(request.execution_id)
        .bind(content_changed)
        .fetch_one(&mut *tx)
        .await?;
        let txid = get_txid(&mut *tx).await?;
        tx.commit().await?;
        Ok(MutationResponse { data, txid })
    }

    pub async fn delete_note(pool: &PgPool, id: Uuid) -> Result<i64, sqlx::Error> {
        let mut tx = super::begin_tx(pool).await?;
        sqlx::query("DELETE FROM drawer_notes WHERE id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        let txid = get_txid(&mut *tx).await?;
        tx.commit().await?;
        Ok(txid)
    }

    pub async fn list_comments(
        pool: &PgPool,
        owner_user_id: Uuid,
        note_id: Option<Uuid>,
    ) -> Result<Vec<DrawerComment>, sqlx::Error> {
        let rows = sqlx::query_as::<_, CommentRow>(
            "SELECT id, note_id, owner_user_id, author, body, created_at
             FROM drawer_comments
             WHERE owner_user_id = $1 AND ($2::uuid IS NULL OR note_id = $2)
             ORDER BY created_at",
        )
        .bind(owner_user_id)
        .bind(note_id)
        .fetch_all(pool)
        .await?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn find_comment(
        pool: &PgPool,
        id: Uuid,
    ) -> Result<Option<DrawerComment>, sqlx::Error> {
        Ok(sqlx::query_as::<_, CommentRow>(
            "SELECT id, note_id, owner_user_id, author, body, created_at
             FROM drawer_comments WHERE id = $1",
        )
        .bind(id)
        .fetch_optional(pool)
        .await?
        .map(Into::into))
    }

    /// Also stamps the note: `last_comment_at` always, and `user_seen_at` when
    /// the user is the one commenting (they are looking at it).
    pub async fn create_comment(
        pool: &PgPool,
        owner_user_id: Uuid,
        request: CreateDrawerCommentRequest,
    ) -> Result<MutationResponse<DrawerComment>, sqlx::Error> {
        let author = request.author.unwrap_or(DrawerCommentAuthor::User);
        let mut tx = super::begin_tx(pool).await?;
        let row = sqlx::query_as::<_, CommentRow>(
            "INSERT INTO drawer_comments (id, note_id, owner_user_id, author, body)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, note_id, owner_user_id, author, body, created_at",
        )
        .bind(request.id.unwrap_or_else(Uuid::new_v4))
        .bind(request.note_id)
        .bind(owner_user_id)
        .bind(author.as_str())
        .bind(request.body)
        .fetch_one(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE drawer_notes SET
                last_comment_at = $2,
                user_seen_at = CASE WHEN $3 THEN $2 ELSE user_seen_at END
             WHERE id = $1",
        )
        .bind(request.note_id)
        .bind(row.created_at)
        .bind(author == DrawerCommentAuthor::User)
        .execute(&mut *tx)
        .await?;
        let txid = get_txid(&mut *tx).await?;
        tx.commit().await?;
        Ok(MutationResponse {
            data: row.into(),
            txid,
        })
    }

    pub async fn delete_comment(pool: &PgPool, id: Uuid) -> Result<i64, sqlx::Error> {
        let mut tx = super::begin_tx(pool).await?;
        sqlx::query("DELETE FROM drawer_comments WHERE id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        let txid = get_txid(&mut *tx).await?;
        tx.commit().await?;
        Ok(txid)
    }
}

#[cfg(test)]
mod tests {
    use api_types::{
        CreateDrawerCommentRequest, CreateDrawerNoteRequest, DrawerCommentAuthor,
        UpdateDrawerNoteRequest,
    };
    use serde_json::Value;

    use super::*;

    async fn user(pool: &PgPool) -> Uuid {
        let user = Uuid::new_v4();
        sqlx::query("INSERT INTO users (id, email) VALUES ($1, $2)")
            .bind(user)
            .bind(format!("{user}@example.test"))
            .execute(pool)
            .await
            .unwrap();
        user
    }

    fn note(title: &str) -> CreateDrawerNoteRequest {
        CreateDrawerNoteRequest {
            id: None,
            title: title.to_string(),
            body: "본문".to_string(),
            label: None,
            pinned: None,
            host_id: None,
            workspace_id: Some(Uuid::new_v4()),
            session_id: None,
            execution_id: None,
        }
    }

    #[tokio::test]
    #[ignore = "requires DRAWER_TEST_DATABASE_URL pointing to migrated disposable PostgreSQL"]
    async fn notes_comments_events_and_retention() {
        let url = std::env::var("DRAWER_TEST_DATABASE_URL")
            .expect("provide a migrated disposable PostgreSQL database");
        let pool = PgPool::connect(&url).await.unwrap();
        let owner = user(&pool).await;
        let stranger = user(&pool).await;

        let created = DrawerRepository::create_note(&pool, owner, note("PR 리뷰 진행 현황"))
            .await
            .unwrap();
        assert!(created.txid > 0);
        let mine = created.data;
        assert!(mine.user_seen_at.is_none() && mine.archived_at.is_none());
        DrawerRepository::create_note(&pool, stranger, note("남의 노트"))
            .await
            .unwrap();

        // Listing is per owner; the inbox filter hides archived notes.
        let inbox = DrawerRepository::list_notes(&pool, owner, Some(false))
            .await
            .unwrap();
        assert_eq!(inbox.iter().map(|n| n.id).collect::<Vec<_>>(), [mine.id]);

        // Seen does not bump updated_at; a body edit does (and makes it unread again).
        let seen = DrawerRepository::update_note(
            &pool,
            mine.id,
            UpdateDrawerNoteRequest {
                seen: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .data;
        assert!(seen.user_seen_at.is_some());
        assert_eq!(seen.updated_at, mine.updated_at);
        let edited = DrawerRepository::update_note(
            &pool,
            mine.id,
            UpdateDrawerNoteRequest {
                body: Some("새 본문".to_string()),
                label: Some(Some("확인 필요".to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .data;
        assert!(edited.updated_at > seen.updated_at);
        assert_eq!(edited.label.as_deref(), Some("확인 필요"));
        assert_eq!(edited.body, "새 본문");
        let cleared = DrawerRepository::update_note(
            &pool,
            mine.id,
            UpdateDrawerNoteRequest {
                label: Some(None),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .data;
        assert!(cleared.label.is_none());

        // A user comment stamps the note and joins the agent-event stream
        // untagged; the Autopilot's reply is tagged so automation skips it.
        let user_comment = DrawerRepository::create_comment(
            &pool,
            owner,
            CreateDrawerCommentRequest {
                id: None,
                note_id: mine.id,
                body: "1072는 내일 해도 돼".to_string(),
                author: None,
            },
        )
        .await
        .unwrap()
        .data;
        assert_eq!(user_comment.author, DrawerCommentAuthor::User);
        let reply = DrawerRepository::create_comment(
            &pool,
            owner,
            CreateDrawerCommentRequest {
                id: None,
                note_id: mine.id,
                body: "알겠습니다".to_string(),
                author: Some(DrawerCommentAuthor::Autopilot),
            },
        )
        .await
        .unwrap()
        .data;
        let after = DrawerRepository::find_note(&pool, mine.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(after.last_comment_at, Some(reply.created_at));
        // The user's own comment counted as reading the note at that moment.
        assert_eq!(after.user_seen_at, Some(user_comment.created_at));
        let events: Vec<(String, bool, Value)> = sqlx::query_as(
            "SELECT kind, autopilot, data FROM agent_events
             WHERE owner_user_id = $1 AND kind = 'drawer.comment' ORDER BY id",
        )
        .bind(owner)
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(
            (events[0].0.as_str(), events[0].1),
            ("drawer.comment", false)
        );
        assert_eq!(
            events[0].2["comment_id"],
            Value::String(user_comment.id.to_string())
        );
        assert_eq!(events[0].2["note_id"], Value::String(mine.id.to_string()));
        assert_eq!(
            events[0].2["title"],
            Value::String("PR 리뷰 진행 현황: 1072는 내일 해도 돼".to_string())
        );
        assert!(events[1].1, "the Autopilot's reply is tagged");
        let comments = DrawerRepository::list_comments(&pool, owner, Some(mine.id))
            .await
            .unwrap();
        assert_eq!(comments.len(), 2);
        assert!(
            DrawerRepository::list_comments(&pool, stranger, Some(mine.id))
                .await
                .unwrap()
                .is_empty()
        );

        // Archive, restore, archive again; only old archives are pruned.
        let archived = DrawerRepository::update_note(
            &pool,
            mine.id,
            UpdateDrawerNoteRequest {
                archived: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .data;
        assert!(archived.archived_at.is_some());
        assert!(
            DrawerRepository::list_notes(&pool, owner, Some(false))
                .await
                .unwrap()
                .is_empty()
        );
        let restored = DrawerRepository::update_note(
            &pool,
            mine.id,
            UpdateDrawerNoteRequest {
                archived: Some(false),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .data;
        assert!(restored.archived_at.is_none());
        DrawerRepository::update_note(
            &pool,
            mine.id,
            UpdateDrawerNoteRequest {
                archived: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(prune_archived(&pool).await.unwrap(), 0);
        sqlx::query(
            "UPDATE drawer_notes SET archived_at = NOW() - INTERVAL '91 days' WHERE id = $1",
        )
        .bind(mine.id)
        .execute(&pool)
        .await
        .unwrap();
        assert_eq!(prune_archived(&pool).await.unwrap(), 1);
        assert!(
            DrawerRepository::find_note(&pool, mine.id)
                .await
                .unwrap()
                .is_none()
        );
        // Comments go with the note; the stream rows stay until their own retention.
        assert!(
            DrawerRepository::list_comments(&pool, owner, Some(mine.id))
                .await
                .unwrap()
                .is_empty()
        );
    }
}
