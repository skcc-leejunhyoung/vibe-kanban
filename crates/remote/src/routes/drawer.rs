//! The Drawer (`api_types::drawer`): owner-scoped notes and comments. Every
//! route checks `owner_user_id == ctx.user.id`; which side may write what
//! (Autopilot vs user) is a UI/CLI contract, not a server rule — one person
//! owns both ends.

use api_types::{
    CreateDrawerCommentRequest, CreateDrawerNoteRequest, DeleteResponse, DrawerComment, DrawerNote,
    ListDrawerCommentsQuery, ListDrawerCommentsResponse, ListDrawerNotesQuery,
    ListDrawerNotesResponse, MutationResponse, UpdateDrawerNoteRequest,
};
use axum::{
    Json, Router,
    extract::{Extension, Path, Query, State},
    http::StatusCode,
};
use sqlx::PgPool;
use uuid::Uuid;

use super::error::ErrorResponse;
use crate::{
    AppState,
    auth::RequestContext,
    db::{drawer::DrawerRepository, hosts::HostRepository},
    mutation_definition::{MutationBuilder, NoUpdate},
};

pub fn note_mutation()
-> MutationBuilder<DrawerNote, CreateDrawerNoteRequest, UpdateDrawerNoteRequest> {
    MutationBuilder::new("drawer_notes")
        .list(list_notes)
        .get(get_note)
        .create(create_note)
        .update(update_note)
        .delete(delete_note)
}

pub fn comment_mutation() -> MutationBuilder<DrawerComment, CreateDrawerCommentRequest, NoUpdate> {
    MutationBuilder::new("drawer_comments")
        .list(list_comments)
        .get(get_comment)
        .create(create_comment)
        .delete(delete_comment)
}

pub fn router() -> Router<AppState> {
    note_mutation().router().merge(comment_mutation().router())
}

fn internal(error: sqlx::Error, what: &'static str) -> ErrorResponse {
    tracing::error!(?error, what, "drawer query failed");
    ErrorResponse::new(StatusCode::INTERNAL_SERVER_ERROR, what)
}

fn not_found(what: &'static str) -> ErrorResponse {
    ErrorResponse::new(StatusCode::NOT_FOUND, what)
}

fn bad_request(message: impl Into<String>) -> ErrorResponse {
    ErrorResponse::new(StatusCode::BAD_REQUEST, message)
}

/// Write errors the client can cause: a client-chosen id that already exists,
/// or a note deleted between the ownership check and the write.
fn write_error(error: sqlx::Error, what: &'static str) -> ErrorResponse {
    match &error {
        sqlx::Error::RowNotFound => not_found("drawer note not found"),
        sqlx::Error::Database(db) if db.is_unique_violation() => {
            ErrorResponse::new(StatusCode::CONFLICT, "drawer id already exists")
        }
        sqlx::Error::Database(db) if db.constraint() == Some("drawer_notes_host_id_fkey") => {
            bad_request("unknown host_id")
        }
        sqlx::Error::Database(db) if db.is_foreign_key_violation() => {
            not_found("drawer note not found")
        }
        sqlx::Error::Database(db) if db.is_check_violation() => {
            bad_request("drawer field too long")
        }
        _ => internal(error, what),
    }
}

// Also CHECK constraints (migration `drawer_limits`).
const MAX_TITLE_CHARS: usize = 200;
const MAX_LABEL_CHARS: usize = 40;
const MAX_NOTE_BODY_BYTES: usize = 64 * 1024;
const MAX_COMMENT_BODY_BYTES: usize = 16 * 1024;

fn check_note_fields(
    title: Option<&str>,
    body: Option<&str>,
    label: Option<&str>,
) -> Result<(), ErrorResponse> {
    if title.is_some_and(|t| t.trim().is_empty()) {
        return Err(bad_request("drawer note title cannot be empty"));
    }
    if title.is_some_and(|t| t.chars().count() > MAX_TITLE_CHARS) {
        return Err(bad_request(format!(
            "drawer note title exceeds {MAX_TITLE_CHARS} characters"
        )));
    }
    if body.is_some_and(|b| b.len() > MAX_NOTE_BODY_BYTES) {
        return Err(bad_request(format!(
            "drawer note body exceeds {MAX_NOTE_BODY_BYTES} bytes"
        )));
    }
    if label.is_some_and(|l| l.chars().count() > MAX_LABEL_CHARS) {
        return Err(bad_request(format!(
            "drawer note label exceeds {MAX_LABEL_CHARS} characters"
        )));
    }
    Ok(())
}

/// The note's artifacts are fetched from this host, so it has to be one the
/// caller can reach.
async fn check_host(
    pool: &PgPool,
    ctx: &RequestContext,
    host_id: Option<Uuid>,
) -> Result<(), ErrorResponse> {
    let Some(host_id) = host_id else {
        return Ok(());
    };
    match HostRepository::new(pool)
        .is_accessible_by(host_id, ctx.user.id)
        .await
    {
        Ok(true) => Ok(()),
        Ok(false) => Err(bad_request("unknown host_id")),
        Err(error) => Err(internal(error, "failed to check drawer host")),
    }
}

async fn owned_note(
    pool: &PgPool,
    ctx: &RequestContext,
    id: Uuid,
) -> Result<DrawerNote, ErrorResponse> {
    DrawerRepository::find_note(pool, id)
        .await
        .map_err(|error| internal(error, "failed to load drawer note"))?
        .filter(|note| note.owner_user_id == ctx.user.id)
        .ok_or_else(|| not_found("drawer note not found"))
}

async fn owned_comment(
    pool: &PgPool,
    ctx: &RequestContext,
    id: Uuid,
) -> Result<DrawerComment, ErrorResponse> {
    DrawerRepository::find_comment(pool, id)
        .await
        .map_err(|error| internal(error, "failed to load drawer comment"))?
        .filter(|comment| comment.owner_user_id == ctx.user.id)
        .ok_or_else(|| not_found("drawer comment not found"))
}

pub(crate) async fn list_notes(
    State(pool): State<PgPool>,
    Extension(ctx): Extension<RequestContext>,
    Query(query): Query<ListDrawerNotesQuery>,
) -> Result<Json<ListDrawerNotesResponse>, ErrorResponse> {
    let drawer_notes = DrawerRepository::list_notes(&pool, ctx.user.id, query.archived)
        .await
        .map_err(|error| internal(error, "failed to list drawer notes"))?;
    Ok(Json(ListDrawerNotesResponse { drawer_notes }))
}

async fn get_note(
    State(pool): State<PgPool>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<Uuid>,
) -> Result<Json<DrawerNote>, ErrorResponse> {
    Ok(Json(owned_note(&pool, &ctx, id).await?))
}

async fn create_note(
    State(pool): State<PgPool>,
    Extension(ctx): Extension<RequestContext>,
    Json(payload): Json<CreateDrawerNoteRequest>,
) -> Result<Json<MutationResponse<DrawerNote>>, ErrorResponse> {
    check_note_fields(
        Some(&payload.title),
        Some(&payload.body),
        payload.label.as_deref(),
    )?;
    check_host(&pool, &ctx, payload.host_id).await?;
    let response = DrawerRepository::create_note(&pool, ctx.user.id, payload)
        .await
        .map_err(|error| write_error(error, "failed to create drawer note"))?;
    Ok(Json(response))
}

async fn update_note(
    State(pool): State<PgPool>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<Uuid>,
    Json(payload): Json<UpdateDrawerNoteRequest>,
) -> Result<Json<MutationResponse<DrawerNote>>, ErrorResponse> {
    owned_note(&pool, &ctx, id).await?;
    check_note_fields(
        payload.title.as_deref(),
        payload.body.as_deref(),
        payload.label.as_ref().and_then(Option::as_deref),
    )?;
    check_host(&pool, &ctx, payload.host_id).await?;
    let response = DrawerRepository::update_note(&pool, id, payload)
        .await
        .map_err(|error| write_error(error, "failed to update drawer note"))?;
    Ok(Json(response))
}

async fn delete_note(
    State(pool): State<PgPool>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<Uuid>,
) -> Result<Json<DeleteResponse>, ErrorResponse> {
    owned_note(&pool, &ctx, id).await?;
    let txid = DrawerRepository::delete_note(&pool, id)
        .await
        .map_err(|error| internal(error, "failed to delete drawer note"))?;
    Ok(Json(DeleteResponse { txid }))
}

pub(crate) async fn list_comments(
    State(pool): State<PgPool>,
    Extension(ctx): Extension<RequestContext>,
    Query(query): Query<ListDrawerCommentsQuery>,
) -> Result<Json<ListDrawerCommentsResponse>, ErrorResponse> {
    let drawer_comments = DrawerRepository::list_comments(&pool, ctx.user.id, query.note_id)
        .await
        .map_err(|error| internal(error, "failed to list drawer comments"))?;
    Ok(Json(ListDrawerCommentsResponse { drawer_comments }))
}

async fn get_comment(
    State(pool): State<PgPool>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<Uuid>,
) -> Result<Json<DrawerComment>, ErrorResponse> {
    Ok(Json(owned_comment(&pool, &ctx, id).await?))
}

async fn create_comment(
    State(pool): State<PgPool>,
    Extension(ctx): Extension<RequestContext>,
    Json(payload): Json<CreateDrawerCommentRequest>,
) -> Result<Json<MutationResponse<DrawerComment>>, ErrorResponse> {
    if payload.body.trim().is_empty() {
        return Err(bad_request("drawer comment body is required"));
    }
    if payload.body.len() > MAX_COMMENT_BODY_BYTES {
        return Err(bad_request(format!(
            "drawer comment body exceeds {MAX_COMMENT_BODY_BYTES} bytes"
        )));
    }
    owned_note(&pool, &ctx, payload.note_id).await?;
    let response = DrawerRepository::create_comment(&pool, ctx.user.id, payload)
        .await
        .map_err(|error| write_error(error, "failed to create drawer comment"))?;
    Ok(Json(response))
}

async fn delete_comment(
    State(pool): State<PgPool>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<Uuid>,
) -> Result<Json<DeleteResponse>, ErrorResponse> {
    owned_comment(&pool, &ctx, id).await?;
    let txid = DrawerRepository::delete_comment(&pool, id)
        .await
        .map_err(|error| internal(error, "failed to delete drawer comment"))?;
    Ok(Json(DeleteResponse { txid }))
}

#[cfg(test)]
mod tests {
    use api_types::User;
    use axum::response::IntoResponse;
    use chrono::Utc;

    use super::*;

    fn status<T>(result: Result<T, ErrorResponse>) -> StatusCode {
        result.map_or_else(|error| error.into_response().status(), |_| StatusCode::OK)
    }

    async fn user(pool: &PgPool) -> RequestContext {
        let id = Uuid::new_v4();
        let user = sqlx::query_as::<_, User>(
            "INSERT INTO users (id, email) VALUES ($1, $2)
             RETURNING id, email, first_name, last_name, username, created_at, updated_at",
        )
        .bind(id)
        .bind(format!("{id}@example.test"))
        .fetch_one(pool)
        .await
        .unwrap();
        RequestContext {
            user,
            session_id: Uuid::new_v4(),
            access_token_expires_at: Utc::now() + chrono::Duration::hours(1),
        }
    }

    async fn host(pool: &PgPool, owner: Uuid) -> Uuid {
        sqlx::query_scalar(
            "INSERT INTO hosts (owner_user_id, machine_id, name) VALUES ($1, 'm', 'Host') RETURNING id",
        )
        .bind(owner)
        .fetch_one(pool)
        .await
        .unwrap()
    }

    fn note(host_id: Option<Uuid>) -> CreateDrawerNoteRequest {
        CreateDrawerNoteRequest {
            id: Some(Uuid::new_v4()),
            title: "PR 리뷰".to_string(),
            body: "본문".to_string(),
            label: None,
            pinned: None,
            host_id,
            workspace_id: None,
            session_id: None,
            execution_id: None,
        }
    }

    fn comment(note_id: Uuid, body: &str) -> CreateDrawerCommentRequest {
        CreateDrawerCommentRequest {
            id: Some(Uuid::new_v4()),
            note_id,
            body: body.to_string(),
            author: None,
        }
    }

    #[tokio::test]
    #[ignore = "requires DRAWER_TEST_DATABASE_URL pointing to migrated disposable PostgreSQL"]
    async fn rejects_bad_input_with_client_errors() {
        let url = std::env::var("DRAWER_TEST_DATABASE_URL")
            .expect("provide a migrated disposable PostgreSQL database");
        let pool = PgPool::connect(&url).await.unwrap();
        let ctx = user(&pool).await;
        let stranger = user(&pool).await;
        let my_host = host(&pool, ctx.user.id).await;
        let their_host = host(&pool, stranger.user.id).await;
        let create =
            |request| create_note(State(pool.clone()), Extension(ctx.clone()), Json(request));
        let update = |id, request| {
            update_note(
                State(pool.clone()),
                Extension(ctx.clone()),
                Path(id),
                Json(request),
            )
        };
        let reply =
            |request| create_comment(State(pool.clone()), Extension(ctx.clone()), Json(request));

        // Caps: chars for title/label, bytes for bodies; the limit itself is fine.
        let ok = create(CreateDrawerNoteRequest {
            title: "가".repeat(MAX_TITLE_CHARS),
            body: "a".repeat(MAX_NOTE_BODY_BYTES),
            label: Some("라".repeat(MAX_LABEL_CHARS)),
            ..note(Some(my_host))
        })
        .await
        .unwrap()
        .0
        .data;
        assert_eq!(ok.host_id, Some(my_host));
        // A normal Autopilot edit (new turn's scope included) still goes through.
        let edited = update(
            ok.id,
            UpdateDrawerNoteRequest {
                title: Some("PR 리뷰 진행 현황".to_string()),
                body: Some("새 본문".to_string()),
                label: Some(Some("확인 필요".to_string())),
                host_id: Some(my_host),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .0
        .data;
        assert_eq!(
            (edited.body.as_str(), edited.label.as_deref()),
            ("새 본문", Some("확인 필요"))
        );
        for request in [
            CreateDrawerNoteRequest {
                title: "가".repeat(MAX_TITLE_CHARS + 1),
                ..note(None)
            },
            CreateDrawerNoteRequest {
                body: "a".repeat(MAX_NOTE_BODY_BYTES + 1),
                ..note(None)
            },
            CreateDrawerNoteRequest {
                label: Some("라".repeat(MAX_LABEL_CHARS + 1)),
                ..note(None)
            },
            CreateDrawerNoteRequest {
                title: " ".to_string(),
                ..note(None)
            },
        ] {
            assert_eq!(status(create(request).await), StatusCode::BAD_REQUEST);
        }
        let too_long = UpdateDrawerNoteRequest {
            body: Some("a".repeat(MAX_NOTE_BODY_BYTES + 1)),
            ..Default::default()
        };
        assert_eq!(
            status(update(ok.id, too_long).await),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            status(reply(comment(ok.id, &"a".repeat(MAX_COMMENT_BODY_BYTES + 1))).await),
            StatusCode::BAD_REQUEST
        );
        // The CHECK constraints back the route checks up.
        let unchecked = DrawerRepository::create_note(
            &pool,
            ctx.user.id,
            CreateDrawerNoteRequest {
                title: "가".repeat(MAX_TITLE_CHARS + 1),
                ..note(None)
            },
        )
        .await
        .unwrap_err();
        assert_eq!(
            status::<()>(Err(write_error(unchecked, "x"))),
            StatusCode::BAD_REQUEST
        );

        // Hosts the caller cannot reach (or that do not exist) are not stored.
        for host_id in [their_host, Uuid::new_v4()] {
            assert_eq!(
                status(create(note(Some(host_id))).await),
                StatusCode::BAD_REQUEST
            );
            let moved = UpdateDrawerNoteRequest {
                host_id: Some(host_id),
                ..Default::default()
            };
            assert_eq!(status(update(ok.id, moved).await), StatusCode::BAD_REQUEST);
        }

        // A reused client id conflicts.
        let request = note(None);
        assert_eq!(status(create(request.clone()).await), StatusCode::OK);
        assert_eq!(status(create(request).await), StatusCode::CONFLICT);
        let first = comment(ok.id, "확인");
        assert_eq!(status(reply(first.clone()).await), StatusCode::OK);
        assert_eq!(status(reply(first).await), StatusCode::CONFLICT);

        // The note vanished after the ownership check.
        let gone = DrawerRepository::update_note(&pool, Uuid::new_v4(), Default::default())
            .await
            .unwrap_err();
        assert_eq!(
            status::<()>(Err(write_error(gone, "x"))),
            StatusCode::NOT_FOUND
        );
        let orphan =
            DrawerRepository::create_comment(&pool, ctx.user.id, comment(Uuid::new_v4(), "x"))
                .await
                .unwrap_err();
        assert_eq!(
            status::<()>(Err(write_error(orphan, "x"))),
            StatusCode::NOT_FOUND
        );

        // A comment committing late does not move the note's stamps back.
        let later: chrono::DateTime<Utc> = sqlx::query_scalar(
            "UPDATE drawer_notes SET last_comment_at = NOW() + INTERVAL '1 hour',
                user_seen_at = NOW() + INTERVAL '1 hour'
             WHERE id = $1 RETURNING last_comment_at",
        )
        .bind(ok.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            status(reply(comment(ok.id, "늦은 댓글")).await),
            StatusCode::OK
        );
        let after = DrawerRepository::find_note(&pool, ok.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(after.last_comment_at, Some(later));
        assert_eq!(after.user_seen_at, Some(later));

        sqlx::query("DELETE FROM users WHERE id = ANY($1)")
            .bind(vec![ctx.user.id, stranger.user.id])
            .execute(&pool)
            .await
            .unwrap();
    }
}
