use api_types::{
    CreateIssueTagRequest, DeleteResponse, IssueTag, ListIssueTagsQuery, ListIssueTagsResponse,
    MutationResponse, NotificationPayload, NotificationType,
};
use axum::{
    Json,
    extract::{Extension, Path, Query, State},
    http::StatusCode,
};
use tracing::instrument;
use uuid::Uuid;

use super::{
    error::{ErrorResponse, db_error},
    organization_members::ensure_issue_access,
};
use crate::{
    AppState,
    auth::RequestContext,
    db::{
        issue_tags::IssueTagRepository, issues::IssueRepository, organization_members,
        project_statuses::ProjectStatusRepository, tags::TagRepository,
        user_notification_preferences::UserNotificationPreferenceRepository,
    },
    mutation_definition::{MutationBuilder, NoUpdate},
    notifications::send_issue_notifications,
};

const REVIEW_TAG_NAME: &str = "review";

/// Issue status a review PR must be in for a "ready for review" notification.
/// A review-tagged PR issue sits in "To do" until a review-mode workspace is
/// created for it (which moves it to "In review").
const TODO_STATUS_NAME: &str = "To do";

/// Mutation definition for IssueTag - provides both router and TypeScript metadata.
pub fn mutation() -> MutationBuilder<IssueTag, CreateIssueTagRequest, NoUpdate> {
    MutationBuilder::new("issue_tags")
        .list(list_issue_tags)
        .get(get_issue_tag)
        .create(create_issue_tag)
        .delete(delete_issue_tag)
}

pub fn router() -> axum::Router<AppState> {
    mutation().router()
}

#[instrument(
    name = "issue_tags.list_issue_tags",
    skip(state, ctx),
    fields(issue_id = %query.issue_id, user_id = %ctx.user.id)
)]
async fn list_issue_tags(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Query(query): Query<ListIssueTagsQuery>,
) -> Result<Json<ListIssueTagsResponse>, ErrorResponse> {
    ensure_issue_access(state.pool(), ctx.user.id, query.issue_id).await?;

    let issue_tags = IssueTagRepository::list_by_issue(state.pool(), query.issue_id)
        .await
        .map_err(|error| {
            tracing::error!(?error, issue_id = %query.issue_id, "failed to list issue tags");
            ErrorResponse::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to list issue tags",
            )
        })?;

    Ok(Json(ListIssueTagsResponse { issue_tags }))
}

#[instrument(
    name = "issue_tags.get_issue_tag",
    skip(state, ctx),
    fields(issue_tag_id = %issue_tag_id, user_id = %ctx.user.id)
)]
async fn get_issue_tag(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Path(issue_tag_id): Path<Uuid>,
) -> Result<Json<IssueTag>, ErrorResponse> {
    let issue_tag = IssueTagRepository::find_by_id(state.pool(), issue_tag_id)
        .await
        .map_err(|error| {
            tracing::error!(?error, %issue_tag_id, "failed to load issue tag");
            ErrorResponse::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to load issue tag",
            )
        })?
        .ok_or_else(|| ErrorResponse::new(StatusCode::NOT_FOUND, "issue tag not found"))?;

    ensure_issue_access(state.pool(), ctx.user.id, issue_tag.issue_id).await?;

    Ok(Json(issue_tag))
}

#[instrument(
    name = "issue_tags.create_issue_tag",
    skip(state, ctx, payload),
    fields(issue_id = %payload.issue_id, user_id = %ctx.user.id)
)]
async fn create_issue_tag(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Json(payload): Json<CreateIssueTagRequest>,
) -> Result<Json<MutationResponse<IssueTag>>, ErrorResponse> {
    let organization_id = ensure_issue_access(state.pool(), ctx.user.id, payload.issue_id).await?;

    let response =
        IssueTagRepository::create(state.pool(), payload.id, payload.issue_id, payload.tag_id)
            .await
            .map_err(|error| {
                tracing::error!(?error, "failed to create issue tag");
                db_error(error, "failed to create issue tag")
            })?;

    notify_review_tag_added(&state, organization_id, ctx.user.id, &response.data).await;

    Ok(Json(response))
}

async fn notify_review_tag_added(
    state: &AppState,
    organization_id: Uuid,
    actor_user_id: Uuid,
    issue_tag: &IssueTag,
) {
    let tag = match TagRepository::find_by_id(state.pool(), issue_tag.tag_id).await {
        Ok(Some(tag)) => tag,
        Ok(None) => return,
        Err(error) => {
            tracing::warn!(
                ?error,
                tag_id = %issue_tag.tag_id,
                "failed to load tag for review notification"
            );
            return;
        }
    };

    if tag.name.trim().to_lowercase() != REVIEW_TAG_NAME {
        return;
    }

    let issue = match IssueRepository::find_by_id(state.pool(), issue_tag.issue_id).await {
        Ok(Some(issue)) => issue,
        Ok(None) => return,
        Err(error) => {
            tracing::warn!(
                ?error,
                issue_id = %issue_tag.issue_id,
                "failed to load issue for review notification"
            );
            return;
        }
    };

    // Only notify while the review-tagged issue is still in "To do" (a review PR
    // waiting to be picked up). A PR-link check can't be used here: the PR link
    // is only created once a review-mode workspace exists, so it isn't present
    // yet when the `review` tag is added. Once a review-mode workspace is created
    // the issue moves to "In review", which this guard excludes.
    match ProjectStatusRepository::find_by_id(state.pool(), issue.status_id).await {
        Ok(Some(status)) if status.name.trim().eq_ignore_ascii_case(TODO_STATUS_NAME) => {}
        Ok(_) => return,
        Err(error) => {
            tracing::warn!(
                ?error,
                issue_id = %issue.id,
                "failed to load issue status for review notification"
            );
            return;
        }
    }

    let members =
        match organization_members::list_by_organization(state.pool(), organization_id).await {
            Ok(members) => members,
            Err(error) => {
                tracing::warn!(
                    ?error,
                    organization_id = %organization_id,
                    "failed to list organization members for review notification"
                );
                return;
            }
        };

    let recipients: Vec<Uuid> = members.into_iter().map(|member| member.user_id).collect();

    let recipients = match UserNotificationPreferenceRepository::review_enabled_user_ids(
        state.pool(),
        &recipients,
    )
    .await
    {
        Ok(enabled_user_ids) => recipients
            .into_iter()
            .filter(|user_id| enabled_user_ids.contains(user_id))
            .collect::<Vec<_>>(),
        Err(error) => {
            tracing::warn!(
                ?error,
                organization_id = %organization_id,
                "failed to load review notification preferences"
            );
            return;
        }
    };

    send_issue_notifications(
        state.pool(),
        organization_id,
        actor_user_id,
        &recipients,
        &issue,
        NotificationType::IssueReviewRequested,
        NotificationPayload {
            tag_name: Some(tag.name),
            ..Default::default()
        },
        None,
        Some(issue.id),
    )
    .await;
}

#[instrument(
    name = "issue_tags.delete_issue_tag",
    skip(state, ctx),
    fields(issue_tag_id = %issue_tag_id, user_id = %ctx.user.id)
)]
async fn delete_issue_tag(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Path(issue_tag_id): Path<Uuid>,
) -> Result<Json<DeleteResponse>, ErrorResponse> {
    let issue_tag = IssueTagRepository::find_by_id(state.pool(), issue_tag_id)
        .await
        .map_err(|error| {
            tracing::error!(?error, %issue_tag_id, "failed to load issue tag");
            ErrorResponse::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to load issue tag",
            )
        })?
        .ok_or_else(|| ErrorResponse::new(StatusCode::NOT_FOUND, "issue tag not found"))?;

    ensure_issue_access(state.pool(), ctx.user.id, issue_tag.issue_id).await?;

    let response = IssueTagRepository::delete(state.pool(), issue_tag_id)
        .await
        .map_err(|error| {
            tracing::error!(?error, "failed to delete issue tag");
            ErrorResponse::new(StatusCode::INTERNAL_SERVER_ERROR, "internal server error")
        })?;

    Ok(Json(response))
}
