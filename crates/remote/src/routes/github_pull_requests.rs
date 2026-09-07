use std::{
    collections::{HashMap, HashSet},
    sync::LazyLock,
    time::Duration,
};

use api_types::{
    GitHubPullRequestComment as UnifiedPrComment,
    GitHubPullRequestCommentsResponse as PrCommentsResponse,
    GitHubPullRequestCommit as PullRequestCommit, GitHubPullRequestDetail as PullRequestDetail,
    GitHubPullRequestReview as PullRequestReview,
    GitHubPullRequestReviewRequest as PullRequestReviewRequest,
    GitHubPullRequestReviewRequestAction as PullRequestReviewRequestAction,
    GitHubPullRequestStatus as MergeStatus, GitHubPullRequestSummary as PullRequestSummary,
    GitHubRepository, PullRequest as StoredPullRequest,
    PullRequestStatus as StoredPullRequestStatus,
    SetGitHubReviewThreadResolvedRequest as SetReviewThreadResolvedRequest,
};
use axum::{
    Extension, Json, Router,
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use moka::future::Cache;
use reqwest::{StatusCode as ReqwestStatusCode, header};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tracing::{instrument, warn};
use url::Url;
use uuid::Uuid;

use crate::{
    AppState,
    audit::{self, AuditAction, AuditEvent},
    auth::RequestContext,
    db::pull_requests::PullRequestRepository,
    routes::{
        github_credentials::{GitHubCredentialsError, github_access_token},
        pull_requests::{UpdatePullRequestRequest, update_pull_request_for_user},
    },
};

const GITHUB_API_BASE: &str = "https://api.github.com";
const GITHUB_GRAPHQL_URL: &str = "https://api.github.com/graphql";
const GITHUB_USER_AGENT: &str = "VibeKanbanRemote/1.0";
const GITHUB_API_VERSION: &str = "2022-11-28";
const PAGE_SIZE: usize = 100;
const MAX_REPOSITORY_PAGES: usize = 100;
const MAX_PULL_REQUEST_PAGES: usize = 3;
const MAX_COMMENT_PAGES: usize = 100;
const MAX_REPOSITORY_CACHE_ENTRIES: usize = 1_024;
const MAX_PULL_REQUEST_LIST_CACHE_ENTRIES: usize = 128;
const MAX_PULL_REQUEST_DETAIL_CACHE_ENTRIES: usize = 1_024;
const REPOSITORY_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const PULL_REQUEST_CACHE_TTL: Duration = Duration::from_secs(60);
const TRACKED_PULL_REQUEST_SYNC_TTL: Duration = Duration::from_secs(5);
const GITHUB_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/github/repositories", get(list_repositories))
        .route("/github/pull-requests", get(list_pull_requests))
        .route("/github/pull-requests/detail", get(get_pull_request))
        .route(
            "/github/pull-requests/tracked/sync",
            post(sync_tracked_pull_requests),
        )
        .route(
            "/github/pull-requests/comments",
            get(get_pull_request_comments),
        )
        .route(
            "/github/pull-requests/review-thread",
            post(set_review_thread_resolved),
        )
}

#[derive(Debug, Clone, thiserror::Error)]
enum GitHubApiError {
    #[error("invalid GitHub pull request or repository")]
    InvalidInput,
    #[error("GitHub authentication is required")]
    AuthenticationRequired,
    #[error("GitHub token is missing required scopes; sync a host's GitHub CLI login in Settings")]
    InsufficientScopes,
    #[error("GitHub denied access to this resource")]
    Forbidden,
    #[error("GitHub resource not found")]
    NotFound,
    #[error("GitHub API rate limit exceeded")]
    RateLimited,
    #[error("GitHub API request failed")]
    Upstream,
    #[error("failed to read GitHub credentials")]
    Credentials,
    #[error("failed to synchronize pull request state")]
    Database,
}

impl GitHubApiError {
    fn status_and_code(&self) -> (StatusCode, &'static str) {
        match self {
            Self::InvalidInput => (StatusCode::BAD_REQUEST, "invalid_github_request"),
            Self::AuthenticationRequired => (StatusCode::FAILED_DEPENDENCY, "github_auth_required"),
            Self::InsufficientScopes => {
                (StatusCode::FAILED_DEPENDENCY, "github_insufficient_scopes")
            }
            Self::Forbidden => (StatusCode::FORBIDDEN, "github_forbidden"),
            Self::NotFound => (StatusCode::NOT_FOUND, "github_not_found"),
            Self::RateLimited => (StatusCode::TOO_MANY_REQUESTS, "github_rate_limited"),
            Self::Upstream | Self::Credentials => {
                (StatusCode::BAD_GATEWAY, "github_upstream_error")
            }
            Self::Database => (StatusCode::INTERNAL_SERVER_ERROR, "github_sync_failed"),
        }
    }
}

impl IntoResponse for GitHubApiError {
    fn into_response(self) -> Response {
        let (status, code) = self.status_and_code();
        (
            status,
            Json(json!({ "error": self.to_string(), "code": code })),
        )
            .into_response()
    }
}

impl From<GitHubCredentialsError> for GitHubApiError {
    fn from(error: GitHubCredentialsError) -> Self {
        match error {
            GitHubCredentialsError::Missing => Self::AuthenticationRequired,
            GitHubCredentialsError::Unavailable => Self::Credentials,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct PullRequestListCacheKey {
    user_id: Uuid,
    repository: String,
    involves_me: bool,
}

static REPOSITORY_CACHE: LazyLock<Cache<Uuid, Vec<GitHubRepository>>> = LazyLock::new(|| {
    Cache::builder()
        .time_to_live(REPOSITORY_CACHE_TTL)
        .max_capacity(MAX_REPOSITORY_CACHE_ENTRIES as u64)
        .build()
});
static PULL_REQUEST_LIST_CACHE: LazyLock<Cache<PullRequestListCacheKey, Vec<PullRequestSummary>>> =
    LazyLock::new(|| {
        Cache::builder()
            .time_to_live(PULL_REQUEST_CACHE_TTL)
            .max_capacity(MAX_PULL_REQUEST_LIST_CACHE_ENTRIES as u64)
            .build()
    });
static PULL_REQUEST_DETAIL_CACHE: LazyLock<Cache<(Uuid, String), PullRequestDetail>> =
    LazyLock::new(|| {
        Cache::builder()
            .time_to_live(PULL_REQUEST_CACHE_TTL)
            .max_capacity(MAX_PULL_REQUEST_DETAIL_CACHE_ENTRIES as u64)
            .build()
    });
static TRACKED_PULL_REQUEST_SYNC_CACHE: LazyLock<Cache<Uuid, Result<(), GitHubApiError>>> =
    LazyLock::new(|| {
        Cache::builder()
            .time_to_live(TRACKED_PULL_REQUEST_SYNC_TTL)
            .max_capacity(MAX_REPOSITORY_CACHE_ENTRIES as u64)
            .build()
    });

/// A new credential must not keep serving data fetched with the old one, which
/// may have seen fewer organizations. Every cache here is keyed by user.
pub(super) async fn invalidate_user_github_caches(user_id: Uuid) {
    REPOSITORY_CACHE.invalidate(&user_id).await;
    TRACKED_PULL_REQUEST_SYNC_CACHE.invalidate(&user_id).await;
    let _ = PULL_REQUEST_LIST_CACHE
        .invalidate_entries_if(move |key, _| key.user_id == user_id);
    let _ = PULL_REQUEST_DETAIL_CACHE
        .invalidate_entries_if(move |(cached_user_id, _), _| *cached_user_id == user_id);
}

#[instrument(name = "github.repositories.list", skip(state, ctx), fields(user_id = %ctx.user.id))]
async fn list_repositories(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
) -> Result<Json<Vec<GitHubRepository>>, GitHubApiError> {
    let token = github_access_token(&state, &ctx).await?;
    if let Some(repositories) = REPOSITORY_CACHE.get(&ctx.user.id).await {
        return Ok(Json(repositories));
    }

    let mut repositories = Vec::new();
    for page in 1..=MAX_REPOSITORY_PAGES {
        let path = format!(
            "/user/repos?per_page={PAGE_SIZE}&page={page}&affiliation=owner,collaborator,organization_member&sort=pushed"
        );
        let batch: Vec<GitHubRepositoryResponse> = github_rest_get(&state, &token, &path).await?;
        let is_last_page = batch.len() < PAGE_SIZE;
        repositories.extend(unarchived_repositories(batch));
        if is_last_page {
            break;
        }
    }
    repositories.sort_by(|left, right| left.full_name.cmp(&right.full_name));
    repositories.dedup_by(|left, right| left.full_name == right.full_name);
    REPOSITORY_CACHE
        .insert(ctx.user.id, repositories.clone())
        .await;
    Ok(Json(repositories))
}

#[derive(Debug, Deserialize)]
struct GitHubRepositoryResponse {
    name: String,
    full_name: String,
    #[serde(default)]
    archived: bool,
}

fn unarchived_repositories(batch: Vec<GitHubRepositoryResponse>) -> Vec<GitHubRepository> {
    batch
        .into_iter()
        .filter(|repository| !repository.archived)
        .map(|repository| GitHubRepository {
            name: repository.name,
            full_name: repository.full_name,
        })
        .collect()
}

#[derive(Debug, Deserialize)]
struct ListPullRequestsQuery {
    repository: String,
    #[serde(default)]
    involves_me: bool,
    #[serde(default)]
    refresh: bool,
}

#[instrument(name = "github.pull_requests.list", skip(state, ctx, query), fields(user_id = %ctx.user.id))]
async fn list_pull_requests(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Query(query): Query<ListPullRequestsQuery>,
) -> Result<Json<Vec<PullRequestSummary>>, GitHubApiError> {
    let (owner, name) = parse_repository(&query.repository)?;
    let repository = format!("{owner}/{name}");
    let key = PullRequestListCacheKey {
        user_id: ctx.user.id,
        repository: repository.clone(),
        involves_me: query.involves_me,
    };
    let token = github_access_token(&state, &ctx).await?;
    if query.refresh {
        PULL_REQUEST_LIST_CACHE.invalidate(&key).await;
    } else if let Some(pull_requests) = PULL_REQUEST_LIST_CACHE.get(&key).await {
        return Ok(Json(pull_requests));
    }

    let pull_requests =
        fetch_pull_request_summaries(&state, &token, &repository, query.involves_me).await?;
    PULL_REQUEST_LIST_CACHE
        .insert(key, pull_requests.clone())
        .await;
    Ok(Json(pull_requests))
}

#[derive(Debug, Deserialize)]
struct PullRequestUrlQuery {
    url: String,
}

#[instrument(name = "github.pull_requests.get", skip(state, ctx, query), fields(user_id = %ctx.user.id))]
async fn get_pull_request(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Query(query): Query<PullRequestUrlQuery>,
) -> Result<Json<PullRequestDetail>, GitHubApiError> {
    let pull_request = GitHubPullRequestRef::parse(&query.url)?;
    let key = (ctx.user.id, pull_request.url.clone());
    let token = github_access_token(&state, &ctx).await?;
    if let Some(detail) = PULL_REQUEST_DETAIL_CACHE.get(&key).await {
        return Ok(Json(detail));
    }

    let detail = fetch_pull_request_detail(&state, &token, &pull_request).await?;
    PULL_REQUEST_DETAIL_CACHE.insert(key, detail.clone()).await;
    Ok(Json(detail))
}

#[derive(Debug, Deserialize)]
struct GitHubPullRequestStatusResponse {
    state: String,
    merged_at: Option<DateTime<Utc>>,
    merge_commit_sha: Option<String>,
}

impl GitHubPullRequestStatusResponse {
    fn into_stored_state(
        self,
    ) -> Option<(
        StoredPullRequestStatus,
        Option<DateTime<Utc>>,
        Option<String>,
    )> {
        if self.merged_at.is_some() {
            return Some((
                StoredPullRequestStatus::Merged,
                self.merged_at,
                self.merge_commit_sha,
            ));
        }
        match merge_status_from_github(&self.state) {
            MergeStatus::Open => Some((StoredPullRequestStatus::Open, None, None)),
            MergeStatus::Closed => Some((StoredPullRequestStatus::Closed, None, None)),
            MergeStatus::Merged => Some((
                StoredPullRequestStatus::Merged,
                self.merged_at,
                self.merge_commit_sha,
            )),
            MergeStatus::Unknown => None,
        }
    }
}

fn stored_pull_request_needs_update(
    pull_requests: &[StoredPullRequest],
    status: StoredPullRequestStatus,
    merged_at: Option<DateTime<Utc>>,
    merge_commit_sha: &Option<String>,
) -> bool {
    pull_requests.iter().any(|pull_request| {
        pull_request.status != status
            || pull_request.merged_at != merged_at
            || &pull_request.merge_commit_sha != merge_commit_sha
    })
}

#[instrument(name = "github.pull_requests.tracked.sync", skip(state, ctx), fields(user_id = %ctx.user.id))]
async fn sync_tracked_pull_requests(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
) -> Result<StatusCode, GitHubApiError> {
    let user_id = ctx.user.id;
    let result = TRACKED_PULL_REQUEST_SYNC_CACHE
        .get_with(user_id, sync_tracked_pull_requests_for_user(&state, &ctx))
        .await;
    if result.is_err() {
        TRACKED_PULL_REQUEST_SYNC_CACHE.invalidate(&user_id).await;
    }
    result?;
    Ok(StatusCode::NO_CONTENT)
}

async fn sync_tracked_pull_requests_for_user(
    state: &AppState,
    ctx: &RequestContext,
) -> Result<(), GitHubApiError> {
    let token = github_access_token(state, ctx).await?;
    let urls =
        PullRequestRepository::list_unresolved_github_urls_for_user(state.pool(), ctx.user.id)
            .await
            .map_err(|error| {
                warn!(?error, "failed to list tracked GitHub pull requests");
                GitHubApiError::Database
            })?;
    let mut failures = 0usize;

    // ponytail: one REST call per tracked PR; batch with GraphQL if account-scale
    // tracking makes rate-limit usage material.
    for url in urls {
        let pull_request = match GitHubPullRequestRef::parse(&url) {
            Ok(pull_request) => pull_request,
            Err(_) => {
                failures += 1;
                continue;
            }
        };
        let path = format!(
            "/repos/{}/{}/pulls/{}",
            pull_request.owner, pull_request.name, pull_request.number
        );
        let detail: GitHubPullRequestStatusResponse = match github_rest_get(state, &token, &path)
            .await
        {
            Ok(detail) => detail,
            Err(error @ (GitHubApiError::AuthenticationRequired | GitHubApiError::RateLimited)) => {
                return Err(error);
            }
            Err(_) => {
                failures += 1;
                continue;
            }
        };
        let Some((status, merged_at, merge_commit_sha)) = detail.into_stored_state() else {
            failures += 1;
            continue;
        };
        let stored = PullRequestRepository::list_by_url_for_user(state.pool(), &url, ctx.user.id)
            .await
            .map_err(|error| {
                warn!(?error, "failed to load tracked GitHub pull request");
                GitHubApiError::Database
            })?;
        if !stored_pull_request_needs_update(&stored, status, merged_at, &merge_commit_sha) {
            continue;
        }

        update_pull_request_for_user(
            state,
            ctx.user.id,
            UpdatePullRequestRequest {
                url,
                status: Some(status),
                merged_at: Some(merged_at),
                merge_commit_sha: Some(merge_commit_sha),
            },
        )
        .await
        .map_err(|error| {
            warn!(?error, "failed to persist tracked GitHub pull request");
            GitHubApiError::Database
        })?;
    }

    if failures > 0 {
        warn!(
            failures,
            "some tracked GitHub pull requests were not synchronized"
        );
    }
    Ok(())
}

#[instrument(name = "github.pull_requests.comments", skip(state, ctx, query), fields(user_id = %ctx.user.id))]
async fn get_pull_request_comments(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Query(query): Query<PullRequestUrlQuery>,
) -> Result<Json<PrCommentsResponse>, GitHubApiError> {
    let pull_request = GitHubPullRequestRef::parse(&query.url)?;
    let token = github_access_token(&state, &ctx).await?;

    let (general_comments, review_comments, review_threads) = tokio::join!(
        fetch_general_comments(&state, &token, &pull_request),
        fetch_review_comments(&state, &token, &pull_request),
        fetch_review_threads(&state, &token, &pull_request),
    );
    Ok(Json(build_comments_response(
        general_comments,
        review_comments,
        review_threads,
        pull_request.number,
    )?))
}

#[instrument(name = "github.pull_requests.review_thread.update", skip(state, ctx, payload), fields(user_id = %ctx.user.id))]
async fn set_review_thread_resolved(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Json(payload): Json<SetReviewThreadResolvedRequest>,
) -> Result<StatusCode, GitHubApiError> {
    let pull_request = GitHubPullRequestRef::parse(&payload.url)?;
    if payload.thread_id.is_empty() || payload.thread_id.len() > 256 {
        return Err(GitHubApiError::InvalidInput);
    }
    let token = github_access_token(&state, &ctx).await?;

    // Ownership needs thread IDs, not every reply in every thread.
    let threads = fetch_review_thread_nodes(&state, &token, &pull_request).await?;
    if !threads.iter().any(|thread| thread.id == payload.thread_id) {
        return Err(GitHubApiError::NotFound);
    }

    let mutation = review_thread_mutation(payload.resolved);
    let _: Value = github_graphql(
        &state,
        &token,
        mutation,
        json!({ "threadId": payload.thread_id }),
    )
    .await?;

    audit::emit(
        AuditEvent::from_request(&ctx, AuditAction::GitHubReviewThreadUpdate)
            .resource("github_pull_request_review_thread", None)
            .http("POST", "/v1/github/pull-requests/review-thread", 204)
            .description(format!(
                "{} review thread for {}",
                if payload.resolved {
                    "resolved"
                } else {
                    "unresolved"
                },
                pull_request.url
            )),
    );
    Ok(StatusCode::NO_CONTENT)
}

fn review_thread_mutation(resolved: bool) -> &'static str {
    if resolved {
        "mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}"
    } else {
        "mutation($threadId:ID!){unresolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}"
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GitHubPullRequestRef {
    owner: String,
    name: String,
    number: i64,
    url: String,
}

impl GitHubPullRequestRef {
    fn parse(value: &str) -> Result<Self, GitHubApiError> {
        let url = Url::parse(value).map_err(|_| GitHubApiError::InvalidInput)?;
        if url.scheme() != "https"
            || url.host_str() != Some("github.com")
            || url.port().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(GitHubApiError::InvalidInput);
        }
        let segments = url
            .path_segments()
            .ok_or(GitHubApiError::InvalidInput)?
            .filter(|segment| !segment.is_empty())
            .collect::<Vec<_>>();
        if segments.len() != 4 || segments[2] != "pull" {
            return Err(GitHubApiError::InvalidInput);
        }
        let (owner, name) = parse_repository(&format!("{}/{}", segments[0], segments[1]))?;
        let number = segments[3]
            .parse::<i64>()
            .ok()
            .filter(|number| *number > 0 && *number <= i32::MAX as i64)
            .ok_or(GitHubApiError::InvalidInput)?;
        let url = format!("https://github.com/{owner}/{name}/pull/{number}");
        Ok(Self {
            owner,
            name,
            number,
            url,
        })
    }
}

fn parse_repository(value: &str) -> Result<(String, String), GitHubApiError> {
    let (owner, name) = value
        .split_once('/')
        .filter(|(owner, name)| !owner.is_empty() && !name.is_empty() && !name.contains('/'))
        .ok_or(GitHubApiError::InvalidInput)?;
    if !is_repository_component(owner) || !is_repository_component(name) {
        return Err(GitHubApiError::InvalidInput);
    }
    Ok((owner.to_string(), name.to_string()))
}

fn is_repository_component(value: &str) -> bool {
    !matches!(value, "." | "..")
        && value.len() <= 100
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

async fn github_rest_get<T: DeserializeOwned>(
    state: &AppState,
    token: &str,
    path: &str,
) -> Result<T, GitHubApiError> {
    github_json(github_request(
        &state.http_client,
        reqwest::Method::GET,
        &format!("{GITHUB_API_BASE}{path}"),
        token,
    ))
    .await
}

pub(super) fn github_request(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: &str,
    token: &str,
) -> reqwest::RequestBuilder {
    client
        .request(method, url)
        // RequestBuilder's timeout covers connection, headers, and the full response body.
        .timeout(GITHUB_REQUEST_TIMEOUT)
        .header(header::ACCEPT, "application/vnd.github+json")
        .header(header::USER_AGENT, GITHUB_USER_AGENT)
        .header("x-github-api-version", GITHUB_API_VERSION)
        .bearer_auth(token)
}

async fn github_json<T: DeserializeOwned>(
    request: reqwest::RequestBuilder,
) -> Result<T, GitHubApiError> {
    let response = request.send().await.map_err(|error| {
        warn!(error = %error.without_url(), "GitHub request failed");
        GitHubApiError::Upstream
    })?;
    ensure_github_success(&response)?;
    response.json().await.map_err(|error| {
        warn!(error = %error.without_url(), "failed to decode GitHub response");
        GitHubApiError::Upstream
    })
}

async fn github_rest_pages<T: DeserializeOwned>(
    state: &AppState,
    token: &str,
    path: &str,
) -> Result<Vec<T>, GitHubApiError> {
    let separator = if path.contains('?') { '&' } else { '?' };
    let mut all = Vec::new();
    for page in 1..=MAX_COMMENT_PAGES {
        let page_path = format!("{path}{separator}per_page={PAGE_SIZE}&page={page}");
        let batch: Vec<T> = github_rest_get(state, token, &page_path).await?;
        let is_last_page = batch.len() < PAGE_SIZE;
        all.extend(batch);
        if is_last_page {
            return Ok(all);
        }
    }
    Err(GitHubApiError::Upstream)
}

fn ensure_github_success(response: &reqwest::Response) -> Result<(), GitHubApiError> {
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    if status == ReqwestStatusCode::UNAUTHORIZED {
        return Err(GitHubApiError::AuthenticationRequired);
    }
    if is_github_rate_limited(status, response.headers()) {
        return Err(GitHubApiError::RateLimited);
    }
    match status {
        ReqwestStatusCode::FORBIDDEN => Err(GitHubApiError::Forbidden),
        ReqwestStatusCode::NOT_FOUND => Err(GitHubApiError::NotFound),
        _ => {
            warn!(%status, "GitHub API returned an unexpected status");
            Err(GitHubApiError::Upstream)
        }
    }
}

fn is_github_rate_limited(status: ReqwestStatusCode, headers: &header::HeaderMap) -> bool {
    status == ReqwestStatusCode::TOO_MANY_REQUESTS
        || (status == ReqwestStatusCode::FORBIDDEN
            && (headers
                .get("x-ratelimit-remaining")
                .and_then(|value| value.to_str().ok())
                == Some("0")
                || headers.contains_key(header::RETRY_AFTER)))
}

#[derive(Debug, Deserialize)]
struct GraphQlEnvelope<T> {
    data: Option<T>,
    #[serde(default)]
    errors: Vec<GraphQlError>,
}

#[derive(Debug, Deserialize)]
struct GraphQlError {
    #[serde(rename = "type")]
    kind: Option<String>,
    message: Option<String>,
    extensions: Option<GraphQlErrorExtensions>,
}

#[derive(Debug, Deserialize)]
struct GraphQlErrorExtensions {
    #[serde(rename = "type")]
    kind: Option<String>,
}

async fn github_graphql<T: DeserializeOwned>(
    state: &AppState,
    token: &str,
    query: &str,
    variables: Value,
) -> Result<T, GitHubApiError> {
    let payload: GraphQlEnvelope<T> = github_json(
        github_request(
            &state.http_client,
            reqwest::Method::POST,
            GITHUB_GRAPHQL_URL,
            token,
        )
        .json(&json!({ "query": query, "variables": variables })),
    )
    .await?;
    if !payload.errors.is_empty() {
        return Err(classify_graphql_errors(&payload.errors));
    }
    payload.data.ok_or(GitHubApiError::Upstream)
}

fn classify_graphql_errors(errors: &[GraphQlError]) -> GitHubApiError {
    let kinds = errors
        .iter()
        .filter_map(|error| {
            error.kind.as_deref().or_else(|| {
                error
                    .extensions
                    .as_ref()
                    .and_then(|extensions| extensions.kind.as_deref())
            })
        })
        .collect::<Vec<_>>();
    if kinds.contains(&"RATE_LIMITED") {
        return GitHubApiError::RateLimited;
    }
    if kinds.contains(&"INSUFFICIENT_SCOPES") {
        return GitHubApiError::InsufficientScopes;
    }
    // Organization policies (OAuth App access restrictions, SAML SSO) arrive
    // as an untyped message; they are denials, not upstream failures.
    let policy_denied = errors
        .iter()
        .filter_map(|error| error.message.as_deref())
        .any(|message| {
            message.contains("OAuth App access restrictions") || message.contains("SAML")
        });
    if kinds.contains(&"FORBIDDEN") || policy_denied {
        return GitHubApiError::Forbidden;
    }
    if kinds.contains(&"NOT_FOUND") {
        return GitHubApiError::NotFound;
    }
    warn!(error_count = errors.len(), "GitHub GraphQL returned errors");
    GitHubApiError::Upstream
}

const PULL_REQUEST_LIST_QUERY: &str = r#"
query($query:String!,$cursor:String){
  search(type:ISSUE,query:$query,first:100,after:$cursor){
    pageInfo{hasNextPage endCursor}
    nodes{
      ... on PullRequest{
        number url state title body isDraft reviewDecision createdAt updatedAt closedAt
        author{login}
        assignees(first:100){nodes{login}}
        labels(first:100){nodes{name}}
        repository{nameWithOwner}
        reviewRequests(first:1){totalCount}
        comments{totalCount}
        reviewThreads(first:100){nodes{comments{totalCount}} pageInfo{hasNextPage}}
      }
    }
  }
}"#;

async fn fetch_pull_request_summaries(
    state: &AppState,
    token: &str,
    repository: &str,
    involves_me: bool,
) -> Result<Vec<PullRequestSummary>, GitHubApiError> {
    let mut query = format!("repo:{repository} is:pr sort:updated-desc");
    if involves_me {
        query.push_str(" involves:@me");
    }
    let mut cursor: Option<String> = None;
    let mut pull_requests = Vec::new();
    for _ in 0..MAX_PULL_REQUEST_PAGES {
        let data: PullRequestListData = github_graphql(
            state,
            token,
            PULL_REQUEST_LIST_QUERY,
            json!({ "query": query, "cursor": cursor }),
        )
        .await?;
        pull_requests.extend(data.search.nodes.into_iter().map(PullRequestSummary::from));
        match next_page_cursor(&data.search.page_info)? {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    Ok(pull_requests)
}

#[derive(Debug, Deserialize)]
struct PullRequestListData {
    search: PullRequestSearchConnection,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullRequestSearchConnection {
    page_info: PageInfo,
    nodes: Vec<PullRequestSummaryNode>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}

fn next_page_cursor(page_info: &PageInfo) -> Result<Option<String>, GitHubApiError> {
    if !page_info.has_next_page {
        return Ok(None);
    }
    page_info
        .end_cursor
        .clone()
        .filter(|cursor| !cursor.is_empty())
        .map(Some)
        .ok_or(GitHubApiError::Upstream)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitHubConnection<T> {
    page_info: PageInfo,
    nodes: Vec<T>,
}

/// Refuse truncated or cyclic responses instead of caching an incomplete timeline.
async fn collect_github_connection<T, F, Fut>(
    mut connection: GitHubConnection<T>,
    mut fetch_next: F,
) -> Result<Vec<T>, GitHubApiError>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<GitHubConnection<T>, GitHubApiError>>,
{
    let mut nodes = Vec::new();
    let mut seen_cursors = HashSet::new();
    for page in 0..MAX_COMMENT_PAGES {
        nodes.extend(connection.nodes);
        let Some(cursor) = next_page_cursor(&connection.page_info)? else {
            return Ok(nodes);
        };
        if page + 1 == MAX_COMMENT_PAGES || !seen_cursors.insert(cursor.clone()) {
            return Err(GitHubApiError::Upstream);
        }
        connection = fetch_next(cursor).await?;
    }
    Err(GitHubApiError::Upstream)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullRequestSummaryNode {
    number: i64,
    url: String,
    state: String,
    title: String,
    #[serde(default)]
    body: String,
    author: Option<LoginNode>,
    assignees: Nodes<LoginNode>,
    labels: Nodes<LabelNode>,
    repository: RepositoryNode,
    #[serde(default)]
    is_draft: bool,
    review_decision: Option<String>,
    review_requests: TotalCount,
    comments: TotalCount,
    review_threads: ReviewThreadCountConnection,
    created_at: Option<DateTime<Utc>>,
    updated_at: Option<DateTime<Utc>>,
    closed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
struct Nodes<T> {
    nodes: Vec<T>,
}

#[derive(Debug, Deserialize)]
struct LoginNode {
    login: String,
}

#[derive(Debug, Deserialize)]
struct LabelNode {
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryNode {
    name_with_owner: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TotalCount {
    total_count: i64,
}

#[derive(Debug, Deserialize)]
struct ReviewThreadCountNode {
    comments: TotalCount,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewThreadCountConnection {
    nodes: Vec<ReviewThreadCountNode>,
    page_info: PageInfo,
}

impl ReviewThreadCountConnection {
    fn comment_count(&self) -> i64 {
        // ponytail: use the base count past 100 review threads; paginate per PR if this becomes common.
        if self.page_info.has_next_page {
            return 0;
        }
        self.nodes
            .iter()
            .map(|thread| thread.comments.total_count)
            .sum()
    }
}

impl From<PullRequestSummaryNode> for PullRequestSummary {
    fn from(value: PullRequestSummaryNode) -> Self {
        let review_comment_count = value.review_threads.comment_count();
        Self {
            number: value.number,
            url: value.url,
            status: merge_status_from_github(&value.state),
            title: value.title,
            body: value.body,
            author: value.author.map(|author| author.login),
            assignees: value
                .assignees
                .nodes
                .into_iter()
                .map(|user| user.login)
                .collect(),
            labels: value
                .labels
                .nodes
                .into_iter()
                .map(|label| label.name)
                .collect(),
            repository: value.repository.name_with_owner,
            is_draft: value.is_draft,
            review_decision: value.review_decision,
            is_review_requested: value.review_requests.total_count > 0,
            comments_count: value.comments.total_count + review_comment_count,
            created_at: value.created_at,
            updated_at: value.updated_at,
            closed_at: value.closed_at,
        }
    }
}

fn merge_status_from_github(value: &str) -> MergeStatus {
    if value.eq_ignore_ascii_case("open") {
        MergeStatus::Open
    } else if value.eq_ignore_ascii_case("merged") {
        MergeStatus::Merged
    } else if value.eq_ignore_ascii_case("closed") {
        MergeStatus::Closed
    } else {
        MergeStatus::Unknown
    }
}

const PULL_REQUEST_DETAIL_QUERY: &str = r#"
query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      number url state mergedAt mergeCommit{oid} title body author{login}
      assignees(first:100){nodes{login}}
      reviews(first:100){pageInfo{hasNextPage endCursor} nodes{id author{login} state body submittedAt}}
      commits(first:100){pageInfo{hasNextPage endCursor} nodes{commit{oid messageHeadline committedDate authors(first:100){nodes{name user{login}}}}}}
      reviewDecision isDraft createdAt updatedAt baseRefName headRefName
    }
  }
}"#;

async fn fetch_pull_request_detail(
    state: &AppState,
    token: &str,
    pull_request: &GitHubPullRequestRef,
) -> Result<PullRequestDetail, GitHubApiError> {
    let data: PullRequestDetailData = github_graphql(
        state,
        token,
        PULL_REQUEST_DETAIL_QUERY,
        json!({
            "owner": pull_request.owner,
            "name": pull_request.name,
            "number": pull_request.number,
        }),
    )
    .await?;
    let node = data
        .repository
        .and_then(|repository| repository.pull_request)
        .ok_or(GitHubApiError::NotFound)?;
    let (reviews, commits) = tokio::try_join!(
        collect_github_connection(node.reviews, |cursor| fetch_pull_request_connection(
            state,
            token,
            pull_request,
            "reviews",
            "id author{login} state body submittedAt",
            cursor,
        )),
        collect_github_connection(node.commits, |cursor| fetch_pull_request_connection(
            state,
            token,
            pull_request,
            "commits",
            "commit{oid messageHeadline committedDate authors(first:100){nodes{name user{login}}}}",
            cursor,
        )),
    )?;
    let review_requests = fetch_review_request_events(state, token, pull_request)
        .await
        .unwrap_or_else(|error| {
            warn!(
                %error,
                pr_number = pull_request.number,
                "failed to load PR review request timeline; continuing without it"
            );
            Vec::new()
        });
    let reviewers = fetch_requested_reviewers(state, token, pull_request)
        .await
        .unwrap_or_else(|error| {
            warn!(
                %error,
                pr_number = pull_request.number,
                "failed to load requested reviewers; continuing without them"
            );
            Vec::new()
        });

    Ok(PullRequestDetail {
        number: node.number,
        url: node.url,
        status: merge_status_from_github(&node.state),
        merged_at: node.merged_at,
        merge_commit_sha: node.merge_commit.map(|commit| commit.oid),
        title: node.title,
        body: node.body,
        author: node.author.map(|author| author.login),
        assignees: node
            .assignees
            .nodes
            .into_iter()
            .map(|user| user.login)
            .collect(),
        reviewers,
        reviews: reviews
            .into_iter()
            .map(|review| PullRequestReview {
                id: review.id,
                author: review.author.map(|author| author.login).unwrap_or_default(),
                state: review.state,
                body: review.body,
                submitted_at: review.submitted_at,
            })
            .collect(),
        review_requests,
        commits: commits
            .into_iter()
            .map(|commit| PullRequestCommit {
                oid: commit.commit.oid,
                message: commit.commit.message_headline,
                authors: commit
                    .commit
                    .authors
                    .nodes
                    .into_iter()
                    .map(|author| author.user.map(|user| user.login).unwrap_or(author.name))
                    .collect(),
                committed_at: commit.commit.committed_date,
            })
            .collect(),
        review_decision: node.review_decision,
        is_draft: node.is_draft,
        created_at: node.created_at,
        updated_at: node.updated_at,
        base_branch: node.base_ref_name,
        head_branch: node.head_ref_name,
    })
}

async fn fetch_pull_request_connection<T: DeserializeOwned>(
    state: &AppState,
    token: &str,
    pull_request: &GitHubPullRequestRef,
    field: &str,
    selection: &str,
    cursor: String,
) -> Result<GitHubConnection<T>, GitHubApiError> {
    // Field and selection are internal constants; all caller input stays in variables.
    let query = format!(
        "query($owner:String!,$name:String!,$number:Int!,$cursor:String!){{
          repository(owner:$owner,name:$name){{pullRequest(number:$number){{
            connection:{field}(first:100,after:$cursor){{pageInfo{{hasNextPage endCursor}} nodes{{{selection}}}}}
          }}}}
        }}"
    );
    let data: PullRequestConnectionData<T> = github_graphql(
        state,
        token,
        &query,
        json!({ "owner": pull_request.owner, "name": pull_request.name,
            "number": pull_request.number, "cursor": cursor }),
    )
    .await?;
    data.repository
        .and_then(|repository| repository.pull_request)
        .map(|pull_request| pull_request.connection)
        .ok_or(GitHubApiError::NotFound)
}

#[derive(Debug, Deserialize)]
struct PullRequestConnectionData<T> {
    repository: Option<PullRequestConnectionRepository<T>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullRequestConnectionRepository<T> {
    pull_request: Option<PullRequestConnectionNode<T>>,
}

#[derive(Debug, Deserialize)]
struct PullRequestConnectionNode<T> {
    connection: GitHubConnection<T>,
}

#[derive(Debug, Deserialize)]
struct PullRequestDetailData {
    repository: Option<PullRequestDetailRepository>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullRequestDetailRepository {
    pull_request: Option<PullRequestDetailNode>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullRequestDetailNode {
    number: i64,
    url: String,
    state: String,
    merged_at: Option<DateTime<Utc>>,
    merge_commit: Option<MergeCommitNode>,
    title: String,
    #[serde(default)]
    body: String,
    author: Option<LoginNode>,
    assignees: Nodes<LoginNode>,
    reviews: GitHubConnection<ReviewNode>,
    commits: GitHubConnection<PullRequestCommitNode>,
    review_decision: Option<String>,
    is_draft: bool,
    created_at: Option<DateTime<Utc>>,
    updated_at: Option<DateTime<Utc>>,
    base_ref_name: String,
    head_ref_name: String,
}

#[derive(Debug, Deserialize)]
struct MergeCommitNode {
    oid: String,
}

#[derive(Debug, Deserialize)]
struct RequestedReviewers {
    #[serde(default)]
    users: Vec<RestUser>,
    #[serde(default)]
    teams: Vec<RestTeam>,
}

impl RequestedReviewers {
    fn names(self) -> Vec<String> {
        self.users
            .into_iter()
            .map(|user| user.login)
            .chain(self.teams.into_iter().map(|team| team.slug))
            .collect()
    }
}

/// REST lists team reviewers with the `repo` scope alone; the GraphQL `Team`
/// type needs `read:org`, which the Vibe OAuth app does not request.
async fn fetch_requested_reviewers(
    state: &AppState,
    token: &str,
    pull_request: &GitHubPullRequestRef,
) -> Result<Vec<String>, GitHubApiError> {
    let path = format!(
        "/repos/{}/{}/pulls/{}/requested_reviewers",
        pull_request.owner, pull_request.name, pull_request.number
    );
    let reviewers: RequestedReviewers = github_rest_get(state, token, &path).await?;
    Ok(reviewers.names())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewNode {
    id: String,
    author: Option<LoginNode>,
    state: String,
    #[serde(default)]
    body: String,
    submitted_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
struct PullRequestCommitNode {
    commit: CommitNode,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitNode {
    oid: String,
    message_headline: String,
    committed_date: Option<DateTime<Utc>>,
    authors: Nodes<CommitAuthorNode>,
}

#[derive(Debug, Deserialize)]
struct CommitAuthorNode {
    name: String,
    user: Option<LoginNode>,
}

#[derive(Debug, Deserialize)]
struct ReviewRequestEvent {
    id: Option<i64>,
    node_id: Option<String>,
    event: String,
    actor: Option<RestUser>,
    review_requester: Option<RestUser>,
    requested_reviewer: Option<RestUser>,
    requested_team: Option<RestTeam>,
    created_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
struct RestTeam {
    slug: String,
}

async fn fetch_review_request_events(
    state: &AppState,
    token: &str,
    pull_request: &GitHubPullRequestRef,
) -> Result<Vec<PullRequestReviewRequest>, GitHubApiError> {
    let path = format!(
        "/repos/{}/{}/issues/{}/timeline",
        pull_request.owner, pull_request.name, pull_request.number
    );
    let events: Vec<ReviewRequestEvent> = github_rest_pages(state, token, &path).await?;
    let mut previously_requested = HashSet::new();
    let mut review_requests = Vec::new();
    for event in events {
        if event.event != "review_requested" {
            continue;
        }
        let target = event
            .requested_reviewer
            .map(|reviewer| (format!("user:{}", reviewer.login), reviewer.login))
            .or_else(|| {
                event
                    .requested_team
                    .map(|team| (format!("team:{}", team.slug), team.slug))
            });
        let (Some((target_key, requested_reviewer)), Some(created_at), Some(id)) = (
            target,
            event.created_at,
            event.id.map(|id| id.to_string()).or(event.node_id),
        ) else {
            continue;
        };
        review_requests.push(PullRequestReviewRequest {
            id,
            actor: event
                .review_requester
                .or(event.actor)
                .map(|actor| actor.login)
                .unwrap_or_default(),
            requested_reviewer,
            action: if previously_requested.insert(target_key) {
                PullRequestReviewRequestAction::Requested
            } else {
                PullRequestReviewRequestAction::Rerequested
            },
            created_at,
        });
    }
    Ok(review_requests)
}

#[derive(Debug, Deserialize)]
struct GeneralComment {
    id: i64,
    node_id: Option<String>,
    user: Option<RestUser>,
    author_association: Option<String>,
    #[serde(default)]
    body: String,
    created_at: DateTime<Utc>,
    html_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ReviewComment {
    id: i64,
    user: Option<RestUser>,
    author_association: Option<String>,
    #[serde(default)]
    body: String,
    created_at: DateTime<Utc>,
    html_url: Option<String>,
    #[serde(default)]
    path: String,
    line: Option<i64>,
    side: Option<String>,
    diff_hunk: Option<String>,
    in_reply_to_id: Option<i64>,
    pull_request_review_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct RestUser {
    login: String,
}

async fn fetch_general_comments(
    state: &AppState,
    token: &str,
    pull_request: &GitHubPullRequestRef,
) -> Result<Vec<GeneralComment>, GitHubApiError> {
    github_rest_pages(
        state,
        token,
        &format!(
            "/repos/{}/{}/issues/{}/comments",
            pull_request.owner, pull_request.name, pull_request.number
        ),
    )
    .await
}

async fn fetch_review_comments(
    state: &AppState,
    token: &str,
    pull_request: &GitHubPullRequestRef,
) -> Result<Vec<ReviewComment>, GitHubApiError> {
    github_rest_pages(
        state,
        token,
        &format!(
            "/repos/{}/{}/pulls/{}/comments",
            pull_request.owner, pull_request.name, pull_request.number
        ),
    )
    .await
}

const REVIEW_THREADS_QUERY: &str = r#"
query($owner:String!,$name:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviewThreads(first:100,after:$cursor){
        pageInfo{hasNextPage endCursor}
        nodes{id isResolved isOutdated comments(first:100){pageInfo{hasNextPage endCursor} nodes{databaseId}}}
      }
    }
  }
}"#;

async fn fetch_review_threads(
    state: &AppState,
    token: &str,
    pull_request: &GitHubPullRequestRef,
) -> Result<Vec<ReviewThread>, GitHubApiError> {
    let nodes = fetch_review_thread_nodes(state, token, pull_request).await?;
    let mut threads = Vec::new();
    for thread in nodes {
        let comments = collect_github_connection(thread.comments, |cursor| {
            fetch_review_thread_comments(state, token, &thread.id, cursor)
        })
        .await?;
        threads.push(ReviewThread {
            id: thread.id,
            comment_ids: comments
                .into_iter()
                .filter_map(|comment| comment.database_id)
                .collect(),
            is_resolved: thread.is_resolved,
            is_outdated: thread.is_outdated,
        });
    }
    Ok(threads)
}

async fn fetch_review_thread_nodes(
    state: &AppState,
    token: &str,
    pull_request: &GitHubPullRequestRef,
) -> Result<Vec<ReviewThreadNode>, GitHubApiError> {
    collect_github_connection(
        fetch_review_threads_page(state, token, pull_request, None).await?,
        |cursor| fetch_review_threads_page(state, token, pull_request, Some(cursor)),
    )
    .await
}

async fn fetch_review_threads_page(
    state: &AppState,
    token: &str,
    pull_request: &GitHubPullRequestRef,
    cursor: Option<String>,
) -> Result<GitHubConnection<ReviewThreadNode>, GitHubApiError> {
    let data: ReviewThreadsData = github_graphql(
        state,
        token,
        REVIEW_THREADS_QUERY,
        json!({
            "owner": pull_request.owner,
            "name": pull_request.name,
            "number": pull_request.number,
            "cursor": cursor,
        }),
    )
    .await?;
    data.repository
        .and_then(|repository| repository.pull_request)
        .map(|pull_request| pull_request.review_threads)
        .ok_or(GitHubApiError::NotFound)
}

async fn fetch_review_thread_comments(
    state: &AppState,
    token: &str,
    thread_id: &str,
    cursor: String,
) -> Result<GitHubConnection<ReviewThreadCommentNode>, GitHubApiError> {
    let data: ReviewThreadCommentsData = github_graphql(
        state,
        token,
        "query($threadId:ID!,$cursor:String!){node(id:$threadId){... on PullRequestReviewThread{
          comments(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{databaseId}}
        }}}",
        json!({ "threadId": thread_id, "cursor": cursor }),
    )
    .await?;
    data.node
        .map(|node| node.comments)
        .ok_or(GitHubApiError::NotFound)
}

#[derive(Debug, Deserialize)]
struct ReviewThreadCommentsData {
    node: Option<ReviewThreadCommentsNode>,
}

#[derive(Debug, Deserialize)]
struct ReviewThreadCommentsNode {
    comments: GitHubConnection<ReviewThreadCommentNode>,
}

#[derive(Debug, Deserialize)]
struct ReviewThreadsData {
    repository: Option<ReviewThreadsRepository>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewThreadsRepository {
    pull_request: Option<ReviewThreadsPullRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewThreadsPullRequest {
    review_threads: GitHubConnection<ReviewThreadNode>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewThreadNode {
    id: String,
    is_resolved: bool,
    is_outdated: bool,
    comments: GitHubConnection<ReviewThreadCommentNode>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewThreadCommentNode {
    database_id: Option<i64>,
}

struct ReviewThread {
    id: String,
    comment_ids: Vec<i64>,
    is_resolved: bool,
    is_outdated: bool,
}

fn build_comments_response(
    general_result: Result<Vec<GeneralComment>, GitHubApiError>,
    review_result: Result<Vec<ReviewComment>, GitHubApiError>,
    threads_result: Result<Vec<ReviewThread>, GitHubApiError>,
    pr_number: i64,
) -> Result<PrCommentsResponse, GitHubApiError> {
    let (general_comments, review_comments) = match (general_result, review_result) {
        (Ok(general), Ok(review)) => (general, review),
        (Ok(general), Err(error)) => {
            warn!(
                %error,
                pr_number,
                "failed to load inline PR comments; returning general comments"
            );
            (general, Vec::new())
        }
        (Err(error), Ok(review)) => {
            warn!(
                %error,
                pr_number,
                "failed to load general PR comments; returning inline comments"
            );
            (Vec::new(), review)
        }
        (Err(error), Err(_)) => return Err(error),
    };
    let review_threads = threads_result.unwrap_or_else(|error| {
        warn!(
            %error,
            pr_number, "failed to load PR review thread metadata; returning comments without it"
        );
        Vec::new()
    });

    Ok(PrCommentsResponse {
        comments: unify_comments(general_comments, review_comments, &review_threads),
    })
}

fn unify_comments(
    general_comments: Vec<GeneralComment>,
    review_comments: Vec<ReviewComment>,
    review_threads: &[ReviewThread],
) -> Vec<UnifiedPrComment> {
    let thread_by_comment = review_threads
        .iter()
        .flat_map(|thread| {
            thread
                .comment_ids
                .iter()
                .map(move |comment_id| (*comment_id, thread))
        })
        .collect::<HashMap<_, _>>();
    let mut comments = general_comments
        .into_iter()
        .map(|comment| UnifiedPrComment::General {
            id: comment.node_id.unwrap_or_else(|| comment.id.to_string()),
            author: comment
                .user
                .map(|user| user.login)
                .unwrap_or_else(|| "unknown".to_string()),
            author_association: comment.author_association,
            body: comment.body,
            created_at: comment.created_at,
            url: comment.html_url,
            parent_id: None,
        })
        .collect::<Vec<_>>();
    comments.extend(review_comments.into_iter().map(|comment| {
        let thread = thread_by_comment.get(&comment.id);
        UnifiedPrComment::Review {
            id: comment.id.to_string(),
            author: comment
                .user
                .map(|user| user.login)
                .unwrap_or_else(|| "unknown".to_string()),
            author_association: comment.author_association,
            body: comment.body,
            created_at: comment.created_at,
            url: comment.html_url,
            path: comment.path,
            line: comment.line,
            side: comment.side,
            diff_hunk: comment.diff_hunk,
            parent_id: comment.in_reply_to_id.map(|id| id.to_string()),
            review_id: comment.pull_request_review_id.map(|id| id.to_string()),
            thread_id: thread.map(|thread| thread.id.clone()),
            is_resolved: thread.map(|thread| thread.is_resolved),
            is_outdated: thread.map(|thread| thread.is_outdated),
        }
    }));
    comments.sort_by_key(|comment| match comment {
        UnifiedPrComment::General { created_at, .. }
        | UnifiedPrComment::Review { created_at, .. } => *created_at,
    });
    comments
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn github_requests_bound_header_and_body_stalls() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        for send_headers in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut buffer = [0; 1];
                stream.read_exact(&mut buffer).await.unwrap();
                if send_headers {
                    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{").await.unwrap();
                }
                std::future::pending::<()>().await;
            });
            let request = github_request(&client, reqwest::Method::GET, &url, "test-token");
            assert_eq!(
                request.try_clone().unwrap().build().unwrap().timeout(),
                Some(&GITHUB_REQUEST_TIMEOUT),
            );
            let result = tokio::time::timeout(
                Duration::from_secs(2),
                github_json::<Value>(request.timeout(Duration::from_millis(50))),
            )
            .await;
            server.abort();
            let error = result
                .expect("GitHub request must stop waiting")
                .unwrap_err();
            assert_eq!(
                error.status_and_code(),
                (StatusCode::BAD_GATEWAY, "github_upstream_error")
            );
        }
    }

    fn connection<T>(nodes: Vec<T>, next_cursor: Option<&str>) -> GitHubConnection<T> {
        GitHubConnection {
            nodes,
            page_info: PageInfo {
                has_next_page: next_cursor.is_some(),
                end_cursor: next_cursor.map(str::to_owned),
            },
        }
    }

    #[tokio::test]
    async fn connection_pagination_keeps_every_review_and_commit_past_one_page() {
        fn activity_page<T: DeserializeOwned>(
            field: &str,
            start: i32,
            end: i32,
            next: Option<&str>,
        ) -> GitHubConnection<T> {
            let nodes = (start..end).map(|id| if field == "reviews" {
                json!({ "id": id.to_string(), "state": "APPROVED", "body": "review" })
            } else {
                json!({ "commit": { "oid": id.to_string(), "messageHeadline": "commit", "authors": { "nodes": [] } } })
            }).collect::<Vec<_>>();
            let data: PullRequestConnectionData<T> = serde_json::from_value(json!({
                "repository": { "pullRequest": { "connection": {
                    "nodes": nodes,
                    "pageInfo": { "hasNextPage": next.is_some(), "endCursor": next }
                } } }
            }))
            .unwrap();
            data.repository.unwrap().pull_request.unwrap().connection
        }
        let mut cursors = Vec::new();
        let reviews: Vec<ReviewNode> =
            collect_github_connection(activity_page("reviews", 0, 100, Some("100")), |cursor| {
                cursors.push(cursor.clone());
                std::future::ready(Ok(if cursor == "100" {
                    activity_page("reviews", 100, 200, Some("200"))
                } else {
                    activity_page("reviews", 200, 201, None)
                }))
            })
            .await
            .unwrap();
        assert_eq!(reviews.len(), 201);
        assert_eq!(reviews.last().unwrap().id, "200");
        assert_eq!(cursors, ["100", "200"]);

        let commits: Vec<PullRequestCommitNode> = collect_github_connection(
            activity_page("commits", 0, 100, Some("100")),
            |cursor| async move {
                assert_eq!(cursor, "100");
                Ok(activity_page("commits", 100, 101, None))
            },
        )
        .await
        .unwrap();
        assert_eq!(commits.len(), 101);
        assert_eq!(commits.last().unwrap().commit.oid, "100");
    }

    #[tokio::test]
    async fn connection_pagination_rejects_missing_repeated_and_excessive_cursors() {
        for invalid in [None, Some("")] {
            let first = GitHubConnection {
                nodes: vec![1],
                page_info: PageInfo {
                    has_next_page: true,
                    end_cursor: invalid.map(str::to_owned),
                },
            };
            assert!(
                collect_github_connection(first, |_| async {
                    panic!("invalid cursor must not be requested")
                })
                .await
                .is_err()
            );
        }
        assert!(
            collect_github_connection(connection(vec![1], Some("same")), |_| async {
                Ok(connection(vec![2], Some("same")))
            })
            .await
            .is_err()
        );
        assert!(
            collect_github_connection(connection(vec![1], Some("next")), |_| async {
                Err(GitHubApiError::RateLimited)
            })
            .await
            .is_err()
        );
        let mut requests = 0;
        assert!(
            collect_github_connection(connection(vec![0], Some("0")), |_| {
                requests += 1;
                std::future::ready(Ok(connection(vec![requests], Some(&requests.to_string()))))
            })
            .await
            .is_err()
        );
        assert_eq!(requests, MAX_COMMENT_PAGES - 1);
    }

    #[tokio::test]
    async fn nested_thread_comments_keep_resolved_metadata_past_one_page() {
        let comments = collect_github_connection(
            connection(
                (1..=100)
                    .map(|id| ReviewThreadCommentNode {
                        database_id: Some(id),
                    })
                    .collect(),
                Some("next"),
            ),
            |cursor| async move {
                assert_eq!(cursor, "next");
                let data: ReviewThreadCommentsData = serde_json::from_value(json!({
                    "node": { "comments": {
                        "nodes": [{ "databaseId": 101 }],
                        "pageInfo": { "hasNextPage": false, "endCursor": null }
                    } }
                }))
                .unwrap();
                Ok(data.node.unwrap().comments)
            },
        )
        .await
        .unwrap();
        let thread = ReviewThread {
            id: "thread".to_string(),
            comment_ids: comments
                .into_iter()
                .filter_map(|comment| comment.database_id)
                .collect(),
            is_resolved: true,
            is_outdated: false,
        };
        let comment: ReviewComment = serde_json::from_value(json!({
            "id": 101, "body": "last reply", "created_at": "2026-09-06T00:00:00Z",
            "in_reply_to_id": 1
        }))
        .unwrap();
        let result = unify_comments(Vec::new(), vec![comment], &[thread]);
        let serialized = serde_json::to_value(&result[0]).unwrap();
        assert_eq!(serialized["thread_id"], "thread");
        assert_eq!(serialized["is_resolved"], true);
    }

    #[test]
    fn accepts_only_canonical_github_pull_request_urls() {
        let parsed = GitHubPullRequestRef::parse(
            "https://github.com/acme/widgets/pull/42?notification_referrer_id=1",
        )
        .unwrap();
        assert_eq!(parsed.owner, "acme");
        assert_eq!(parsed.name, "widgets");
        assert_eq!(parsed.number, 42);
        assert_eq!(parsed.url, "https://github.com/acme/widgets/pull/42");

        for invalid in [
            "http://github.com/acme/widgets/pull/42",
            "https://github.com.evil.test/acme/widgets/pull/42",
            "https://github.com/acme/widgets/issues/42",
            "https://github.com/acme/widgets/pull/42/files",
            "https://github.com/acme/widgets/pull/not-a-number",
        ] {
            assert!(GitHubPullRequestRef::parse(invalid).is_err(), "{invalid}");
        }
        assert!(parse_repository("../widgets").is_err());
    }

    #[test]
    fn pull_request_cache_keys_are_user_scoped() {
        let repository = "acme/widgets".to_string();
        let first = PullRequestListCacheKey {
            user_id: Uuid::from_u128(1),
            repository: repository.clone(),
            involves_me: false,
        };
        let second = PullRequestListCacheKey {
            user_id: Uuid::from_u128(2),
            repository,
            involves_me: false,
        };
        assert_ne!(first, second);
    }

    #[test]
    fn archived_repositories_are_not_exposed() {
        let repositories = unarchived_repositories(vec![
            GitHubRepositoryResponse {
                name: "active".to_string(),
                full_name: "acme/active".to_string(),
                archived: false,
            },
            GitHubRepositoryResponse {
                name: "old".to_string(),
                full_name: "acme/old".to_string(),
                archived: true,
            },
        ]);

        assert_eq!(repositories.len(), 1);
        assert_eq!(repositories[0].full_name, "acme/active");
    }

    #[test]
    fn pagination_requires_a_cursor_only_when_more_pages_exist() {
        assert_eq!(
            next_page_cursor(&PageInfo {
                has_next_page: false,
                end_cursor: None,
            })
            .unwrap(),
            None
        );
        assert_eq!(
            next_page_cursor(&PageInfo {
                has_next_page: true,
                end_cursor: Some("next".to_string()),
            })
            .unwrap(),
            Some("next".to_string())
        );
        assert!(
            next_page_cursor(&PageInfo {
                has_next_page: true,
                end_cursor: None,
            })
            .is_err()
        );
    }

    #[test]
    fn pull_request_summary_maps_github_fields() {
        let node: PullRequestSummaryNode = serde_json::from_value(json!({
            "number": 42,
            "url": "https://github.com/acme/widgets/pull/42",
            "state": "OPEN",
            "title": "Ship it",
            "body": "Ready",
            "author": { "login": "octocat" },
            "assignees": { "nodes": [{ "login": "reviewer" }] },
            "labels": { "nodes": [{ "name": "feature" }] },
            "repository": { "nameWithOwner": "acme/widgets" },
            "isDraft": false,
            "reviewDecision": "APPROVED",
            "reviewRequests": { "totalCount": 1 },
            "comments": { "totalCount": 2 },
            "reviewThreads": {
                "nodes": [{ "comments": { "totalCount": 3 } }],
                "pageInfo": { "hasNextPage": false, "endCursor": null }
            },
            "createdAt": null,
            "updatedAt": null,
            "closedAt": null
        }))
        .unwrap();

        let summary = PullRequestSummary::from(node);
        assert_eq!(summary.status, MergeStatus::Open);
        assert_eq!(summary.repository, "acme/widgets");
        assert_eq!(summary.comments_count, 5);
        assert!(summary.is_review_requested);
    }

    #[test]
    fn review_thread_mutation_matches_the_requested_action() {
        assert!(review_thread_mutation(true).contains("{resolveReviewThread"));
        assert!(review_thread_mutation(false).contains("{unresolveReviewThread"));
    }

    #[test]
    fn github_failures_keep_distinct_http_statuses() {
        assert_eq!(
            GitHubApiError::AuthenticationRequired.status_and_code(),
            (StatusCode::FAILED_DEPENDENCY, "github_auth_required")
        );
        assert_eq!(
            GitHubApiError::Forbidden.status_and_code(),
            (StatusCode::FORBIDDEN, "github_forbidden")
        );
        assert_eq!(
            GitHubApiError::NotFound.status_and_code(),
            (StatusCode::NOT_FOUND, "github_not_found")
        );
        assert_eq!(
            GitHubApiError::RateLimited.status_and_code(),
            (StatusCode::TOO_MANY_REQUESTS, "github_rate_limited")
        );
    }

    #[test]
    #[allow(deprecated)]
    fn tracked_sync_updates_only_changed_persisted_state() {
        let now = Utc::now();
        let pull_request = StoredPullRequest {
            id: Uuid::from_u128(1),
            url: "https://github.com/acme/widgets/pull/42".to_string(),
            number: 42,
            status: StoredPullRequestStatus::Open,
            merged_at: None,
            merge_commit_sha: None,
            target_branch_name: "main".to_string(),
            project_id: Uuid::from_u128(2),
            issue_id: Uuid::from_u128(3),
            workspace_id: None,
            created_at: now,
            updated_at: now,
        };

        assert!(!stored_pull_request_needs_update(
            std::slice::from_ref(&pull_request),
            StoredPullRequestStatus::Open,
            None,
            &None,
        ));
        assert!(stored_pull_request_needs_update(
            &[pull_request],
            StoredPullRequestStatus::Closed,
            None,
            &None,
        ));
        assert_eq!(
            GitHubPullRequestStatusResponse {
                state: "CLOSED".to_string(),
                merged_at: Some(now),
                merge_commit_sha: Some("abc".to_string()),
            }
            .into_stored_state(),
            Some((
                StoredPullRequestStatus::Merged,
                Some(now),
                Some("abc".to_string()),
            ))
        );
        assert_eq!(
            GitHubPullRequestStatusResponse {
                state: "open".to_string(),
                merged_at: None,
                merge_commit_sha: Some("temporary-test-merge".to_string()),
            }
            .into_stored_state(),
            Some((StoredPullRequestStatus::Open, None, None))
        );
        assert_eq!(merge_status_from_github("closed"), MergeStatus::Closed);
    }

    #[test]
    fn github_secondary_rate_limit_is_not_reported_as_forbidden() {
        let mut headers = header::HeaderMap::new();
        headers.insert(header::RETRY_AFTER, "60".parse().unwrap());

        assert!(is_github_rate_limited(
            ReqwestStatusCode::FORBIDDEN,
            &headers
        ));
    }

    #[test]
    fn graphql_error_type_accepts_github_and_extension_shapes() {
        let payload: GraphQlEnvelope<Value> = serde_json::from_value(json!({
            "errors": [
                { "type": "NOT_FOUND" },
                { "extensions": { "type": "RATE_LIMITED" } }
            ]
        }))
        .unwrap();

        assert_eq!(payload.errors[0].kind.as_deref(), Some("NOT_FOUND"));
        assert_eq!(
            payload.errors[1]
                .extensions
                .as_ref()
                .and_then(|extensions| extensions.kind.as_deref()),
            Some("RATE_LIMITED")
        );
    }

    #[test]
    fn review_comment_count_falls_back_when_threads_are_truncated() {
        let mut threads = ReviewThreadCountConnection {
            nodes: vec![ReviewThreadCountNode {
                comments: TotalCount { total_count: 3 },
            }],
            page_info: PageInfo {
                has_next_page: true,
                end_cursor: Some("next".to_string()),
            },
        };

        assert_eq!(threads.comment_count(), 0);
        threads.page_info.has_next_page = false;
        assert_eq!(threads.comment_count(), 3);
    }

    #[test]
    fn graphql_scope_and_policy_errors_are_not_upstream_failures() {
        fn classify(errors: Value) -> (StatusCode, &'static str) {
            let payload: GraphQlEnvelope<Value> =
                serde_json::from_value(json!({ "errors": errors })).unwrap();
            classify_graphql_errors(&payload.errors).status_and_code()
        }

        assert_eq!(
            classify(json!([{ "type": "INSUFFICIENT_SCOPES", "message": "scopes" }])),
            (StatusCode::FAILED_DEPENDENCY, "github_insufficient_scopes")
        );
        assert_eq!(
            classify(
                json!([{ "message": "Although you appear to have the correct authorization credentials, the `acme` organization has enabled OAuth App access restrictions" }])
            ),
            (StatusCode::FORBIDDEN, "github_forbidden")
        );
        assert_eq!(
            classify(json!([{ "type": "NOT_FOUND" }])),
            (StatusCode::NOT_FOUND, "github_not_found")
        );
        assert_eq!(
            classify(json!([{ "message": "Something else" }])),
            (StatusCode::BAD_GATEWAY, "github_upstream_error")
        );
    }

    #[test]
    fn requested_reviewers_include_teams_from_rest() {
        let reviewers: RequestedReviewers = serde_json::from_value(json!({
            "users": [{ "login": "octocat" }],
            "teams": [{ "slug": "platform" }]
        }))
        .unwrap();
        assert_eq!(reviewers.names(), ["octocat", "platform"]);
    }

    #[test]
    fn comment_partial_failures_keep_the_available_conversation() {
        let general = GeneralComment {
            id: 1,
            node_id: None,
            user: Some(RestUser {
                login: "octocat".to_string(),
            }),
            author_association: None,
            body: "available".to_string(),
            created_at: Utc::now(),
            html_url: None,
        };

        let response = build_comments_response(
            Ok(vec![general]),
            Err(GitHubApiError::Upstream),
            Err(GitHubApiError::Upstream),
            42,
        )
        .unwrap();
        assert_eq!(response.comments.len(), 1);

        assert!(
            build_comments_response(
                Err(GitHubApiError::Upstream),
                Ok(Vec::new()),
                Ok(Vec::new()),
                42,
            )
            .is_ok()
        );
        assert!(
            build_comments_response(
                Err(GitHubApiError::Upstream),
                Err(GitHubApiError::Forbidden),
                Ok(Vec::new()),
                42,
            )
            .is_err()
        );
    }
}
