use api_types::{
    CreateGithubIssueLinkRequest, DeleteResponse, GithubIssueLink, ListGithubIssueLinksResponse,
    MutationResponse, UpdateGithubIssueLinkRequest,
};
use axum::{
    Json,
    extract::{Extension, Path, Query, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{
    error::{ErrorResponse, db_error},
    organization_members::{ensure_issue_access, ensure_project_access},
};
use crate::{
    AppState,
    auth::RequestContext,
    db::{
        begin_tx, get_txid,
        github_issue_links::{GithubIssueCommentVersion, GithubIssueLinkRepository},
        issues::IssueRepository,
    },
    mutation_definition::MutationBuilder,
};

#[derive(Debug, Deserialize)]
pub struct ListGithubIssueLinksQuery {
    pub project_id: Option<Uuid>,
    pub issue_id: Option<Uuid>,
    #[serde(default)]
    pub include_comment_versions: bool,
}

#[derive(Serialize)]
struct GithubIssueLinksWithCommentVersions {
    #[serde(flatten)]
    links: ListGithubIssueLinksResponse,
    #[serde(skip_serializing_if = "Option::is_none")]
    comment_versions: Option<Vec<GithubIssueCommentVersion>>,
}

pub fn mutation()
-> MutationBuilder<GithubIssueLink, CreateGithubIssueLinkRequest, UpdateGithubIssueLinkRequest> {
    MutationBuilder::new("github_issue_links")
        .list(list_github_issue_links)
        .get(get_github_issue_link)
        .create(create_github_issue_link)
        .update(update_github_issue_link)
        .delete(delete_github_issue_link)
}

pub fn router() -> axum::Router<AppState> {
    mutation().router()
}

async fn list_github_issue_links(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Query(query): Query<ListGithubIssueLinksQuery>,
) -> Result<Json<GithubIssueLinksWithCommentVersions>, ErrorResponse> {
    let links = match (query.project_id, query.issue_id) {
        (Some(project_id), None) => {
            ensure_project_access(state.pool(), ctx.user.id, project_id).await?;
            GithubIssueLinkRepository::list_by_project(state.pool(), project_id).await
        }
        (None, Some(issue_id)) => {
            ensure_issue_access(state.pool(), ctx.user.id, issue_id).await?;
            GithubIssueLinkRepository::list_by_issue(state.pool(), issue_id).await
        }
        _ => {
            return Err(ErrorResponse::new(
                StatusCode::BAD_REQUEST,
                "provide exactly one of project_id or issue_id",
            ));
        }
    }
    .map_err(internal_error)?;

    let comment_versions = if query.include_comment_versions {
        let issue_ids: Vec<_> = links.iter().map(|link| link.issue_id).collect();
        Some(
            GithubIssueLinkRepository::comment_versions(state.pool(), &issue_ids)
                .await
                .map_err(internal_error)?,
        )
    } else {
        None
    };
    Ok(Json(GithubIssueLinksWithCommentVersions {
        links: ListGithubIssueLinksResponse {
            github_issue_links: links,
        },
        comment_versions,
    }))
}

async fn get_github_issue_link(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<Uuid>,
) -> Result<Json<GithubIssueLink>, ErrorResponse> {
    let link = load_link(&state, id).await?;
    ensure_issue_access(state.pool(), ctx.user.id, link.issue_id).await?;
    Ok(Json(link))
}

async fn create_github_issue_link(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Json(payload): Json<CreateGithubIssueLinkRequest>,
) -> Result<Json<MutationResponse<GithubIssueLink>>, ErrorResponse> {
    ensure_issue_access(state.pool(), ctx.user.id, payload.issue_id).await?;
    let issue = IssueRepository::find_by_id(state.pool(), payload.issue_id)
        .await
        .map_err(|error| {
            tracing::error!(?error, "failed to load issue for github link");
            ErrorResponse::new(StatusCode::INTERNAL_SERVER_ERROR, "failed to load issue")
        })?
        .ok_or_else(|| ErrorResponse::new(StatusCode::NOT_FOUND, "issue not found"))?;

    let mut tx = begin_tx(state.pool()).await.map_err(internal_error)?;
    let data = GithubIssueLinkRepository::create(&mut tx, issue.project_id, payload)
        .await
        .map_err(|error| db_error(error, "failed to create github issue link"))?;
    let txid = get_txid(&mut *tx).await.map_err(internal_error)?;
    tx.commit().await.map_err(internal_error)?;
    Ok(Json(MutationResponse { data, txid }))
}

async fn update_github_issue_link(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<Uuid>,
    Json(payload): Json<UpdateGithubIssueLinkRequest>,
) -> Result<Json<MutationResponse<GithubIssueLink>>, ErrorResponse> {
    let link = load_link(&state, id).await?;
    ensure_issue_access(state.pool(), ctx.user.id, link.issue_id).await?;

    let mut tx = begin_tx(state.pool()).await.map_err(internal_error)?;
    let data = GithubIssueLinkRepository::update(&mut tx, id, payload)
        .await
        .map_err(internal_error)?;
    let txid = get_txid(&mut *tx).await.map_err(internal_error)?;
    tx.commit().await.map_err(internal_error)?;
    Ok(Json(MutationResponse { data, txid }))
}

async fn delete_github_issue_link(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Path(id): Path<Uuid>,
) -> Result<Json<DeleteResponse>, ErrorResponse> {
    let link = load_link(&state, id).await?;
    ensure_issue_access(state.pool(), ctx.user.id, link.issue_id).await?;

    let mut tx = begin_tx(state.pool()).await.map_err(internal_error)?;
    GithubIssueLinkRepository::delete(&mut tx, id)
        .await
        .map_err(internal_error)?;
    let txid = get_txid(&mut *tx).await.map_err(internal_error)?;
    tx.commit().await.map_err(internal_error)?;
    Ok(Json(DeleteResponse { txid }))
}

async fn load_link(state: &AppState, id: Uuid) -> Result<GithubIssueLink, ErrorResponse> {
    GithubIssueLinkRepository::find_by_id(state.pool(), id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| ErrorResponse::new(StatusCode::NOT_FOUND, "github issue link not found"))
}

fn internal_error(error: sqlx::Error) -> ErrorResponse {
    tracing::error!(?error, "github issue link database operation failed");
    ErrorResponse::new(StatusCode::INTERNAL_SERVER_ERROR, "internal server error")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comment_versions_are_opt_in_and_preserve_the_existing_list_shape() {
        let response = GithubIssueLinksWithCommentVersions {
            links: ListGithubIssueLinksResponse {
                github_issue_links: vec![],
            },
            comment_versions: None,
        };
        assert_eq!(
            serde_json::to_value(response).unwrap(),
            serde_json::json!({ "github_issue_links": [] })
        );
        let base = "/v1/github_issue_links?project_id=00000000-0000-0000-0000-000000000001";
        let default =
            Query::<ListGithubIssueLinksQuery>::try_from_uri(&base.parse().unwrap()).unwrap();
        assert!(!default.include_comment_versions);
        let enabled = format!("{base}&include_comment_versions=true");
        let query =
            Query::<ListGithubIssueLinksQuery>::try_from_uri(&enabled.parse().unwrap()).unwrap();
        assert!(query.include_comment_versions);
    }
}
