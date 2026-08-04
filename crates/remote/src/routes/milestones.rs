use api_types::{
    CreateIssueMilestoneRequest, CreateProjectMilestoneRequest, DeleteResponse, IssueMilestone,
    MutationResponse, ProjectMilestone, UpdateProjectMilestoneRequest,
};
use axum::{
    Json,
    extract::{Extension, Path, Query, State},
    http::StatusCode,
};
use serde::Deserialize;
use uuid::Uuid;

use super::{
    error::{ErrorResponse, db_error},
    organization_members::{ensure_issue_access, ensure_project_access},
};
use crate::{
    AppState,
    auth::RequestContext,
    db::milestones::{IssueMilestoneRepository, MilestoneRepository},
    mutation_definition::{MutationBuilder, NoUpdate},
};

#[derive(Deserialize)]
struct ProjectQuery {
    project_id: Uuid,
}

pub fn milestone_mutation()
-> MutationBuilder<ProjectMilestone, CreateProjectMilestoneRequest, UpdateProjectMilestoneRequest> {
    MutationBuilder::new("project_milestones")
        .list(list_milestones)
        .get(get_milestone)
        .create(create_milestone)
        .update(update_milestone)
        .delete(delete_milestone)
}

pub fn issue_milestone_mutation()
-> MutationBuilder<IssueMilestone, CreateIssueMilestoneRequest, NoUpdate> {
    MutationBuilder::new("issue_milestones")
        .list(list_issue_milestones)
        .get(get_issue_milestone)
        .create(create_issue_milestone)
        .delete(delete_issue_milestone)
}

pub fn router() -> axum::Router<AppState> {
    milestone_mutation()
        .router()
        .merge(issue_milestone_mutation().router())
}

async fn list_milestones(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Query(q): Query<ProjectQuery>,
) -> Result<Json<Vec<ProjectMilestone>>, ErrorResponse> {
    ensure_project_access(state.pool(), ctx.user.id, q.project_id).await?;
    Ok(Json(
        MilestoneRepository::list(state.pool(), q.project_id)
            .await
            .map_err(|e| db_error(e, "failed to list milestones"))?,
    ))
}
async fn get_milestone(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<Uuid>,
) -> Result<Json<ProjectMilestone>, ErrorResponse> {
    let item = MilestoneRepository::find(state.pool(), id)
        .await
        .map_err(|e| db_error(e, "failed to load milestone"))?
        .ok_or_else(|| ErrorResponse::new(StatusCode::NOT_FOUND, "milestone not found"))?;
    ensure_project_access(state.pool(), ctx.user.id, item.project_id).await?;
    Ok(Json(item))
}
async fn create_milestone(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Json(payload): Json<CreateProjectMilestoneRequest>,
) -> Result<Json<MutationResponse<ProjectMilestone>>, ErrorResponse> {
    ensure_project_access(state.pool(), ctx.user.id, payload.project_id).await?;
    if payload.name.trim().is_empty() {
        return Err(ErrorResponse::new(
            StatusCode::BAD_REQUEST,
            "milestone name is required",
        ));
    }
    Ok(Json(
        MilestoneRepository::create(state.pool(), payload)
            .await
            .map_err(|e| db_error(e, "failed to create milestone"))?,
    ))
}
async fn update_milestone(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<Uuid>,
    Json(payload): Json<UpdateProjectMilestoneRequest>,
) -> Result<Json<MutationResponse<ProjectMilestone>>, ErrorResponse> {
    let item = MilestoneRepository::find(state.pool(), id)
        .await
        .map_err(|e| db_error(e, "failed to load milestone"))?
        .ok_or_else(|| ErrorResponse::new(StatusCode::NOT_FOUND, "milestone not found"))?;
    ensure_project_access(state.pool(), ctx.user.id, item.project_id).await?;
    Ok(Json(
        MilestoneRepository::update(state.pool(), id, payload)
            .await
            .map_err(|e| db_error(e, "failed to update milestone"))?,
    ))
}
async fn delete_milestone(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<Uuid>,
) -> Result<Json<DeleteResponse>, ErrorResponse> {
    let item = MilestoneRepository::find(state.pool(), id)
        .await
        .map_err(|e| db_error(e, "failed to load milestone"))?
        .ok_or_else(|| ErrorResponse::new(StatusCode::NOT_FOUND, "milestone not found"))?;
    ensure_project_access(state.pool(), ctx.user.id, item.project_id).await?;
    Ok(Json(
        MilestoneRepository::delete(state.pool(), id)
            .await
            .map_err(|e| db_error(e, "failed to delete milestone"))?,
    ))
}
async fn list_issue_milestones(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Query(q): Query<ProjectQuery>,
) -> Result<Json<Vec<IssueMilestone>>, ErrorResponse> {
    ensure_project_access(state.pool(), ctx.user.id, q.project_id).await?;
    Ok(Json(
        IssueMilestoneRepository::list(state.pool(), q.project_id)
            .await
            .map_err(|e| db_error(e, "failed to list issue milestones"))?,
    ))
}
async fn get_issue_milestone(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<Uuid>,
) -> Result<Json<IssueMilestone>, ErrorResponse> {
    let item = IssueMilestoneRepository::find(state.pool(), id)
        .await
        .map_err(|e| db_error(e, "failed to load issue milestone"))?
        .ok_or_else(|| ErrorResponse::new(StatusCode::NOT_FOUND, "issue milestone not found"))?;
    ensure_issue_access(state.pool(), ctx.user.id, item.issue_id).await?;
    Ok(Json(item))
}
async fn create_issue_milestone(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Json(payload): Json<CreateIssueMilestoneRequest>,
) -> Result<Json<MutationResponse<IssueMilestone>>, ErrorResponse> {
    ensure_issue_access(state.pool(), ctx.user.id, payload.issue_id).await?;
    Ok(Json(
        IssueMilestoneRepository::upsert(state.pool(), payload)
            .await
            .map_err(|e| db_error(e, "failed to set issue milestone"))?,
    ))
}
async fn delete_issue_milestone(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<Uuid>,
) -> Result<Json<DeleteResponse>, ErrorResponse> {
    let item = IssueMilestoneRepository::find(state.pool(), id)
        .await
        .map_err(|e| db_error(e, "failed to load issue milestone"))?
        .ok_or_else(|| ErrorResponse::new(StatusCode::NOT_FOUND, "issue milestone not found"))?;
    ensure_issue_access(state.pool(), ctx.user.id, item.issue_id).await?;
    Ok(Json(
        IssueMilestoneRepository::delete(state.pool(), id)
            .await
            .map_err(|e| db_error(e, "failed to clear issue milestone"))?,
    ))
}
