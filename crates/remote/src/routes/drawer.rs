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
use uuid::Uuid;

use super::error::ErrorResponse;
use crate::{
    AppState,
    auth::RequestContext,
    db::drawer::DrawerRepository,
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

async fn owned_note(
    state: &AppState,
    ctx: &RequestContext,
    id: Uuid,
) -> Result<DrawerNote, ErrorResponse> {
    DrawerRepository::find_note(state.pool(), id)
        .await
        .map_err(|error| internal(error, "failed to load drawer note"))?
        .filter(|note| note.owner_user_id == ctx.user.id)
        .ok_or_else(|| not_found("drawer note not found"))
}

async fn owned_comment(
    state: &AppState,
    ctx: &RequestContext,
    id: Uuid,
) -> Result<DrawerComment, ErrorResponse> {
    DrawerRepository::find_comment(state.pool(), id)
        .await
        .map_err(|error| internal(error, "failed to load drawer comment"))?
        .filter(|comment| comment.owner_user_id == ctx.user.id)
        .ok_or_else(|| not_found("drawer comment not found"))
}

pub(crate) async fn list_notes(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Query(query): Query<ListDrawerNotesQuery>,
) -> Result<Json<ListDrawerNotesResponse>, ErrorResponse> {
    let drawer_notes = DrawerRepository::list_notes(state.pool(), ctx.user.id, query.archived)
        .await
        .map_err(|error| internal(error, "failed to list drawer notes"))?;
    Ok(Json(ListDrawerNotesResponse { drawer_notes }))
}

async fn get_note(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<Uuid>,
) -> Result<Json<DrawerNote>, ErrorResponse> {
    Ok(Json(owned_note(&state, &ctx, id).await?))
}

async fn create_note(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Json(payload): Json<CreateDrawerNoteRequest>,
) -> Result<Json<MutationResponse<DrawerNote>>, ErrorResponse> {
    if payload.title.trim().is_empty() {
        return Err(ErrorResponse::new(
            StatusCode::BAD_REQUEST,
            "drawer note title is required",
        ));
    }
    let response = DrawerRepository::create_note(state.pool(), ctx.user.id, payload)
        .await
        .map_err(|error| internal(error, "failed to create drawer note"))?;
    Ok(Json(response))
}

async fn update_note(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<Uuid>,
    Json(payload): Json<UpdateDrawerNoteRequest>,
) -> Result<Json<MutationResponse<DrawerNote>>, ErrorResponse> {
    owned_note(&state, &ctx, id).await?;
    if payload
        .title
        .as_deref()
        .is_some_and(|t| t.trim().is_empty())
    {
        return Err(ErrorResponse::new(
            StatusCode::BAD_REQUEST,
            "drawer note title cannot be empty",
        ));
    }
    let response = DrawerRepository::update_note(state.pool(), id, payload)
        .await
        .map_err(|error| internal(error, "failed to update drawer note"))?;
    Ok(Json(response))
}

async fn delete_note(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<Uuid>,
) -> Result<Json<DeleteResponse>, ErrorResponse> {
    owned_note(&state, &ctx, id).await?;
    let txid = DrawerRepository::delete_note(state.pool(), id)
        .await
        .map_err(|error| internal(error, "failed to delete drawer note"))?;
    Ok(Json(DeleteResponse { txid }))
}

pub(crate) async fn list_comments(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Query(query): Query<ListDrawerCommentsQuery>,
) -> Result<Json<ListDrawerCommentsResponse>, ErrorResponse> {
    let drawer_comments = DrawerRepository::list_comments(state.pool(), ctx.user.id, query.note_id)
        .await
        .map_err(|error| internal(error, "failed to list drawer comments"))?;
    Ok(Json(ListDrawerCommentsResponse { drawer_comments }))
}

async fn get_comment(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<Uuid>,
) -> Result<Json<DrawerComment>, ErrorResponse> {
    Ok(Json(owned_comment(&state, &ctx, id).await?))
}

async fn create_comment(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Json(payload): Json<CreateDrawerCommentRequest>,
) -> Result<Json<MutationResponse<DrawerComment>>, ErrorResponse> {
    if payload.body.trim().is_empty() {
        return Err(ErrorResponse::new(
            StatusCode::BAD_REQUEST,
            "drawer comment body is required",
        ));
    }
    owned_note(&state, &ctx, payload.note_id).await?;
    let response = DrawerRepository::create_comment(state.pool(), ctx.user.id, payload)
        .await
        .map_err(|error| internal(error, "failed to create drawer comment"))?;
    Ok(Json(response))
}

async fn delete_comment(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<Uuid>,
) -> Result<Json<DeleteResponse>, ErrorResponse> {
    owned_comment(&state, &ctx, id).await?;
    let txid = DrawerRepository::delete_comment(state.pool(), id)
        .await
        .map_err(|error| internal(error, "failed to delete drawer comment"))?;
    Ok(Json(DeleteResponse { txid }))
}
