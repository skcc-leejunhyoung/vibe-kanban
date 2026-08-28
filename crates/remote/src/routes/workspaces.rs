use api_types::{DeleteWorkspaceRequest, UpdateWorkspaceRequest, Workspace};
use axum::{
    Json, Router,
    extract::{Extension, Path, Query, State},
    http::StatusCode,
    routing::{delete, get, head, post},
};
use serde::{Deserialize, Serialize};
use tracing::instrument;
use uuid::Uuid;

use super::{
    error::{ErrorResponse, db_error},
    organization_members::ensure_project_access,
};
use crate::{
    AppState,
    auth::RequestContext,
    db::{
        begin_tx,
        hosts::HostRepository,
        issues::IssueRepository,
        pull_request_issues::PullRequestIssueRepository,
        pull_requests::PullRequestRepository,
        workspaces::{CreateWorkspaceParams, WorkspaceRepository},
    },
};

#[derive(Debug, Deserialize)]
struct CreateWorkspaceRequest {
    pub project_id: Uuid,
    pub host_id: Uuid,
    pub local_workspace_id: Option<Uuid>,
    pub issue_id: Option<Uuid>,
    pub name: Option<String>,
    pub archived: Option<bool>,
    pub files_changed: Option<i32>,
    pub lines_added: Option<i32>,
    pub lines_removed: Option<i32>,
}

#[derive(Debug, Deserialize)]
struct HostScopedWorkspaceQuery {
    host_id: Uuid,
}

#[derive(Debug, PartialEq, Eq)]
enum WorkspaceHostAccess {
    Matched,
    ClaimLegacy,
    Denied,
}

fn workspace_host_access(
    workspace: &Workspace,
    user_id: Uuid,
    host_id: Uuid,
) -> WorkspaceHostAccess {
    if workspace.owner_user_id != user_id {
        return WorkspaceHostAccess::Denied;
    }
    match workspace.host_id {
        Some(workspace_host_id) if workspace_host_id == host_id => WorkspaceHostAccess::Matched,
        Some(_) => WorkspaceHostAccess::Denied,
        None => WorkspaceHostAccess::ClaimLegacy,
    }
}

pub(super) async fn load_owned_workspace_for_host(
    state: &AppState,
    ctx: &RequestContext,
    local_workspace_id: Uuid,
    host_id: Uuid,
) -> Result<Workspace, ErrorResponse> {
    let owns_host = HostRepository::new(state.pool())
        .is_owned_by(host_id, ctx.user.id)
        .await
        .map_err(|error| db_error(error, "failed to verify workspace host"))?;
    if !owns_host {
        return Err(ErrorResponse::new(
            StatusCode::NOT_FOUND,
            "workspace not found",
        ));
    }

    let workspace =
        WorkspaceRepository::find_owned_by_local_id(state.pool(), local_workspace_id, ctx.user.id)
            .await
            .map_err(|error| db_error(error, "failed to find workspace"))?
            .ok_or_else(|| ErrorResponse::new(StatusCode::NOT_FOUND, "workspace not found"))?;

    match workspace_host_access(&workspace, ctx.user.id, host_id) {
        WorkspaceHostAccess::Matched => Ok(workspace),
        WorkspaceHostAccess::Denied => Err(ErrorResponse::new(
            StatusCode::NOT_FOUND,
            "workspace not found",
        )),
        WorkspaceHostAccess::ClaimLegacy => {
            if let Some(claimed) = WorkspaceRepository::claim_legacy_host(
                state.pool(),
                workspace.id,
                ctx.user.id,
                host_id,
            )
            .await
            .map_err(|error| db_error(error, "failed to claim legacy workspace host"))?
            {
                return Ok(claimed);
            }

            // A concurrent request may have claimed the same legacy row first.
            // Re-read it so same-host requests converge while a competing host
            // still receives a non-enumerating 404.
            let current = WorkspaceRepository::find_owned_by_local_id(
                state.pool(),
                local_workspace_id,
                ctx.user.id,
            )
            .await
            .map_err(|error| db_error(error, "failed to verify claimed workspace host"))?;
            current
                .filter(|workspace| workspace.host_id == Some(host_id))
                .ok_or_else(|| ErrorResponse::new(StatusCode::NOT_FOUND, "workspace not found"))
        }
    }
}

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/workspaces",
            post(create_workspace)
                .patch(update_workspace)
                .delete(delete_workspace),
        )
        .route("/workspaces/{workspace_id}", delete(unlink_workspace))
        .route(
            "/workspaces/{local_workspace_id}/sync_issue_status_from_local_merge",
            post(sync_issue_status_from_local_merge),
        )
        .route(
            "/workspaces/{local_workspace_id}/auto_merge_check",
            get(auto_merge_check),
        )
        .route(
            "/workspaces/{local_workspace_id}/mark_for_review",
            post(mark_for_review),
        )
        .route(
            "/workspaces/by-local-id/{local_workspace_id}",
            get(get_workspace_by_local_id),
        )
        .route(
            "/workspaces/exists/{local_workspace_id}",
            head(workspace_exists),
        )
}

#[derive(Debug, Serialize)]
struct AutoMergeCheckResponse {
    should_auto_merge: bool,
}

#[instrument(
    name = "workspaces.create_workspace",
    skip(state, ctx, payload),
    fields(project_id = %payload.project_id, user_id = %ctx.user.id)
)]
async fn create_workspace(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Json(payload): Json<CreateWorkspaceRequest>,
) -> Result<Json<Workspace>, ErrorResponse> {
    ensure_project_access(state.pool(), ctx.user.id, payload.project_id).await?;
    let owns_host = HostRepository::new(state.pool())
        .is_owned_by(payload.host_id, ctx.user.id)
        .await
        .map_err(|error| db_error(error, "failed to verify workspace host"))?;
    if !owns_host {
        return Err(ErrorResponse::new(
            StatusCode::BAD_REQUEST,
            "invalid workspace host",
        ));
    }

    let workspace = WorkspaceRepository::create(
        state.pool(),
        CreateWorkspaceParams {
            project_id: payload.project_id,
            owner_user_id: ctx.user.id,
            host_id: payload.host_id,
            local_workspace_id: payload.local_workspace_id,
            issue_id: payload.issue_id,
            name: payload.name,
            archived: payload.archived,
            files_changed: payload.files_changed,
            lines_added: payload.lines_added,
            lines_removed: payload.lines_removed,
        },
    )
    .await
    .map_err(|error| {
        tracing::error!(?error, "failed to create workspace");
        db_error(error, "failed to create workspace")
    })?;

    if let Some(issue_id) = payload.issue_id
        && let Err(error) =
            IssueRepository::sync_issue_from_workspace_created(state.pool(), issue_id, ctx.user.id)
                .await
    {
        tracing::warn!(?error, "failed to sync issue from workspace creation");
    }

    Ok(Json(workspace))
}

#[instrument(
    name = "workspaces.update_workspace",
    skip(state, ctx, payload),
    fields(local_workspace_id = %payload.local_workspace_id, user_id = %ctx.user.id)
)]
async fn update_workspace(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Json(payload): Json<UpdateWorkspaceRequest>,
) -> Result<Json<Workspace>, ErrorResponse> {
    let workspace =
        load_owned_workspace_for_host(&state, &ctx, payload.local_workspace_id, payload.host_id)
            .await?;

    let updated = WorkspaceRepository::update(
        state.pool(),
        workspace.id,
        payload.name,
        payload.archived,
        payload.files_changed,
        payload.lines_added,
        payload.lines_removed,
    )
    .await
    .map_err(|error| {
        tracing::error!(?error, "failed to update workspace");
        ErrorResponse::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "failed to update workspace",
        )
    })?;

    Ok(Json(updated))
}

#[instrument(
    name = "workspaces.sync_issue_status_from_local_merge",
    skip(state, ctx),
    fields(local_workspace_id = %local_workspace_id, user_id = %ctx.user.id)
)]
async fn sync_issue_status_from_local_merge(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Path(local_workspace_id): Path<Uuid>,
    Query(query): Query<HostScopedWorkspaceQuery>,
) -> Result<StatusCode, ErrorResponse> {
    let workspace =
        load_owned_workspace_for_host(&state, &ctx, local_workspace_id, query.host_id).await?;

    let Some(issue_id) = workspace.issue_id else {
        return Ok(StatusCode::NO_CONTENT);
    };

    let mut conn = state.pool().acquire().await.map_err(|error| {
        tracing::error!(?error, "failed to acquire connection");
        ErrorResponse::new(StatusCode::INTERNAL_SERVER_ERROR, "internal server error")
    })?;

    IssueRepository::sync_status_from_local_workspace_merge(&mut conn, issue_id)
        .await
        .map_err(|error| {
            tracing::error!(?error, issue_id = %issue_id, "failed to sync issue status");
            ErrorResponse::new(StatusCode::INTERNAL_SERVER_ERROR, "internal server error")
        })?;

    Ok(StatusCode::NO_CONTENT)
}

#[instrument(
    name = "workspaces.auto_merge_check",
    skip(state, ctx),
    fields(local_workspace_id = %local_workspace_id, user_id = %ctx.user.id)
)]
async fn auto_merge_check(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Path(local_workspace_id): Path<Uuid>,
    Query(query): Query<HostScopedWorkspaceQuery>,
) -> Result<Json<AutoMergeCheckResponse>, ErrorResponse> {
    let workspace =
        load_owned_workspace_for_host(&state, &ctx, local_workspace_id, query.host_id).await?;

    let Some(issue_id) = workspace.issue_id else {
        return Ok(Json(AutoMergeCheckResponse {
            should_auto_merge: false,
        }));
    };

    let mut conn = state.pool().acquire().await.map_err(|error| {
        tracing::error!(?error, "failed to acquire connection");
        ErrorResponse::new(StatusCode::INTERNAL_SERVER_ERROR, "internal server error")
    })?;

    let should_auto_merge = IssueRepository::has_vibe_tag(&mut conn, issue_id)
        .await
        .map_err(|error| {
            tracing::error!(?error, issue_id = %issue_id, "failed to check vibe tag");
            ErrorResponse::new(StatusCode::INTERNAL_SERVER_ERROR, "internal server error")
        })?;

    Ok(Json(AutoMergeCheckResponse { should_auto_merge }))
}

#[instrument(
    name = "workspaces.mark_for_review",
    skip(state, ctx),
    fields(local_workspace_id = %local_workspace_id, user_id = %ctx.user.id)
)]
async fn mark_for_review(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Path(local_workspace_id): Path<Uuid>,
    Query(query): Query<HostScopedWorkspaceQuery>,
) -> Result<StatusCode, ErrorResponse> {
    let workspace =
        load_owned_workspace_for_host(&state, &ctx, local_workspace_id, query.host_id).await?;

    let Some(issue_id) = workspace.issue_id else {
        return Ok(StatusCode::NO_CONTENT);
    };

    let mut conn = state.pool().acquire().await.map_err(|error| {
        tracing::error!(?error, "failed to acquire connection");
        ErrorResponse::new(StatusCode::INTERNAL_SERVER_ERROR, "internal server error")
    })?;

    IssueRepository::mark_for_review(&mut conn, issue_id)
        .await
        .map_err(|error| {
            tracing::error!(?error, issue_id = %issue_id, "failed to mark issue for review");
            ErrorResponse::new(StatusCode::INTERNAL_SERVER_ERROR, "internal server error")
        })?;

    Ok(StatusCode::NO_CONTENT)
}

#[instrument(
    name = "workspaces.delete_workspace",
    skip(state, ctx, payload),
    fields(local_workspace_id = %payload.local_workspace_id, user_id = %ctx.user.id)
)]
async fn delete_workspace(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Json(payload): Json<DeleteWorkspaceRequest>,
) -> Result<StatusCode, ErrorResponse> {
    let workspace =
        load_owned_workspace_for_host(&state, &ctx, payload.local_workspace_id, payload.host_id)
            .await?;

    unlink_pull_request_issue_links(state.pool(), &workspace).await?;

    WorkspaceRepository::delete_by_local_id(state.pool(), payload.local_workspace_id)
        .await
        .map_err(|error| {
            tracing::error!(?error, "failed to delete workspace");
            ErrorResponse::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to delete workspace",
            )
        })?;

    Ok(StatusCode::NO_CONTENT)
}

#[instrument(
    name = "workspaces.unlink_workspace",
    skip(state, ctx),
    fields(workspace_id = %workspace_id, user_id = %ctx.user.id)
)]
async fn unlink_workspace(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Path(workspace_id): Path<Uuid>,
) -> Result<StatusCode, ErrorResponse> {
    let workspace = WorkspaceRepository::find_by_id(state.pool(), workspace_id)
        .await
        .map_err(|error| {
            tracing::error!(?error, "failed to find workspace");
            ErrorResponse::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to find workspace",
            )
        })?
        .ok_or_else(|| ErrorResponse::new(StatusCode::NOT_FOUND, "workspace not found"))?;

    if workspace.owner_user_id != ctx.user.id {
        return Err(ErrorResponse::new(
            StatusCode::NOT_FOUND,
            "workspace not found",
        ));
    }

    unlink_pull_request_issue_links(state.pool(), &workspace).await?;

    WorkspaceRepository::delete(state.pool(), workspace_id)
        .await
        .map_err(|error| {
            tracing::error!(?error, "failed to delete workspace");
            ErrorResponse::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to delete workspace",
            )
        })?;

    Ok(StatusCode::NO_CONTENT)
}

/// Removes the PR ↔ issue links a workspace established (and any PR left with no
/// remaining issue links) before the workspace is deleted. Deleting the
/// workspace only nulls the PR's `workspace_id` (ON DELETE SET NULL), so without
/// this the PR would stay attached to the issue after the workspace is unlinked.
async fn unlink_pull_request_issue_links(
    pool: &sqlx::PgPool,
    workspace: &Workspace,
) -> Result<(), ErrorResponse> {
    let Some(issue_id) = workspace.issue_id else {
        return Ok(());
    };

    let pull_requests = PullRequestRepository::list_by_workspace(pool, workspace.id)
        .await
        .map_err(|error| {
            tracing::error!(?error, "failed to list workspace pull requests");
            ErrorResponse::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to list workspace pull requests",
            )
        })?;

    if pull_requests.is_empty() {
        return Ok(());
    }

    let mut tx = begin_tx(pool).await.map_err(|error| {
        tracing::error!(?error, "failed to begin transaction");
        ErrorResponse::new(StatusCode::INTERNAL_SERVER_ERROR, "internal server error")
    })?;

    for pr in pull_requests {
        PullRequestIssueRepository::delete_and_cleanup_orphan(&mut tx, pr.id, issue_id)
            .await
            .map_err(|error| {
                tracing::error!(?error, "failed to unlink pull request from issue");
                ErrorResponse::new(StatusCode::INTERNAL_SERVER_ERROR, "internal server error")
            })?;
    }

    tx.commit().await.map_err(|error| {
        tracing::error!(?error, "failed to commit transaction");
        ErrorResponse::new(StatusCode::INTERNAL_SERVER_ERROR, "internal server error")
    })?;

    Ok(())
}

#[instrument(
    name = "workspaces.get_workspace_by_local_id",
    skip(state, ctx),
    fields(local_workspace_id = %local_workspace_id, user_id = %ctx.user.id)
)]
async fn get_workspace_by_local_id(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Path(local_workspace_id): Path<Uuid>,
    Query(query): Query<HostScopedWorkspaceQuery>,
) -> Result<Json<Workspace>, ErrorResponse> {
    let workspace =
        load_owned_workspace_for_host(&state, &ctx, local_workspace_id, query.host_id).await?;

    Ok(Json(workspace))
}

#[instrument(
    name = "workspaces.workspace_exists",
    skip(state, ctx),
    fields(local_workspace_id = %local_workspace_id)
)]
async fn workspace_exists(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Path(local_workspace_id): Path<Uuid>,
    Query(query): Query<HostScopedWorkspaceQuery>,
) -> Result<StatusCode, ErrorResponse> {
    load_owned_workspace_for_host(&state, &ctx, local_workspace_id, query.host_id).await?;
    Ok(StatusCode::OK)
}

#[cfg(test)]
mod tests {
    use api_types::Workspace;
    use chrono::Utc;
    use uuid::Uuid;

    use super::{WorkspaceHostAccess, workspace_host_access};

    fn workspace(owner_user_id: Uuid, host_id: Option<Uuid>) -> Workspace {
        Workspace {
            id: Uuid::new_v4(),
            project_id: Uuid::new_v4(),
            owner_user_id,
            host_id,
            issue_id: None,
            local_workspace_id: Some(Uuid::new_v4()),
            name: None,
            archived: false,
            files_changed: None,
            lines_added: None,
            lines_removed: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    #[test]
    fn matching_owner_and_host_are_allowed() {
        let user_id = Uuid::new_v4();
        let host_id = Uuid::new_v4();
        assert_eq!(
            workspace_host_access(&workspace(user_id, Some(host_id)), user_id, host_id),
            WorkspaceHostAccess::Matched
        );
    }

    #[test]
    fn another_owner_or_host_is_denied() {
        let user_id = Uuid::new_v4();
        let host_id = Uuid::new_v4();
        assert_eq!(
            workspace_host_access(&workspace(Uuid::new_v4(), Some(host_id)), user_id, host_id),
            WorkspaceHostAccess::Denied
        );
        assert_eq!(
            workspace_host_access(&workspace(user_id, Some(Uuid::new_v4())), user_id, host_id),
            WorkspaceHostAccess::Denied
        );
    }

    #[test]
    fn legacy_workspace_can_be_claimed_only_by_its_owner() {
        let user_id = Uuid::new_v4();
        let legacy = workspace(user_id, None);
        assert_eq!(
            workspace_host_access(&legacy, user_id, Uuid::new_v4()),
            WorkspaceHostAccess::ClaimLegacy
        );
        assert_eq!(
            workspace_host_access(&legacy, Uuid::new_v4(), Uuid::new_v4()),
            WorkspaceHostAccess::Denied
        );
    }
}
