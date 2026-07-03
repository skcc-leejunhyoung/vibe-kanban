use api_types::{ListPullRequestsQuery, ListPullRequestsResponse};
use axum::{
    Json, Router,
    extract::{Query, State},
    response::Json as ResponseJson,
    routing::{get, post},
};
use chrono::Utc;
use db::models::{merge::MergeStatus, pull_request::PullRequest};
use deployment::Deployment;
use git_host::{GitHostProvider, GitHostService};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use utils::response::ApiResponse;

use crate::{DeploymentImpl, error::ApiError};

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/pull-requests", get(list_pull_requests))
        .route("/pull-requests/link", post(link_pr_to_issue))
}

async fn list_pull_requests(
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<ListPullRequestsQuery>,
) -> Result<ResponseJson<ApiResponse<ListPullRequestsResponse>>, ApiError> {
    let client = deployment.remote_client()?;
    let response = client.list_pull_requests(query.issue_id).await?;
    Ok(ResponseJson(ApiResponse::success(response)))
}

/// Tracks a PR in the local database so `pr_monitor` can poll for status
/// changes and sync them to the remote. No remote server call is made here;
/// the actual remote PR creation is handled by the Electric mutation system.
#[derive(Debug, Deserialize, Serialize, TS)]
pub struct LinkPrToIssueRequest {
    pub pr_url: String,
    pub pr_number: i32,
    pub base_branch: String,
}

async fn link_pr_to_issue(
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<LinkPrToIssueRequest>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    let pool = &deployment.db().pool;

    PullRequest::create(
        pool,
        None,
        None,
        &request.pr_url,
        request.pr_number as i64,
        &request.base_branch,
        None,
    )
    .await?;

    // Fetch the real status right away so linking an already merged/closed PR
    // doesn't sit as "open" until the next poll — and so re-linking refreshes a
    // stale status. Best-effort: linking still succeeds if the host is
    // unreachable, and `pr_monitor` will reconcile it later.
    if let Ok(git_host) = GitHostService::from_url(&request.pr_url) {
        match git_host.get_pr_status(&request.pr_url).await {
            Ok(detail) if detail.status != MergeStatus::Unknown => {
                let merged_at = if detail.status == MergeStatus::Merged {
                    Some(detail.merged_at.unwrap_or_else(Utc::now))
                } else {
                    None
                };
                if let Err(e) = PullRequest::update_status(
                    pool,
                    &request.pr_url,
                    &detail.status,
                    merged_at,
                    detail.merge_commit_sha,
                )
                .await
                {
                    tracing::warn!(
                        "Failed to persist fetched status for PR {}: {e}",
                        request.pr_url
                    );
                }
            }
            Ok(_) => {}
            Err(e) => tracing::warn!(
                "Failed to fetch status on link for PR {}: {e}",
                request.pr_url
            ),
        }
    }

    Ok(ResponseJson(ApiResponse::success(())))
}
