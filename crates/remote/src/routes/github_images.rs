use axum::{
    Router,
    body::Body,
    extract::{Extension, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::StreamExt;
use reqwest::{Client, StatusCode as ReqwestStatusCode, redirect::Policy};
use serde::Deserialize;
use tracing::{instrument, warn};
use url::Url;

use crate::{AppState, auth::RequestContext, db::oauth_accounts::OAuthAccountRepository};

const GITHUB_ATTACHMENT_PATH_PREFIX: &str = "/user-attachments/assets/";
const MAX_REDIRECTS: usize = 3;
const MAX_IMAGE_SIZE_BYTES: usize = 20 * 1024 * 1024;
const GITHUB_USER_AGENT: &str = "VibeKanbanRemote/1.0";
const GITHUB_USER_API_URL: &str = "https://api.github.com/user";
const GITHUB_OAUTH_SCOPES_HEADER: &str = "x-oauth-scopes";
const GITHUB_USER_ASSET_S3_HOST: &str = "github-production-user-asset-6210df.s3.amazonaws.com";

pub fn router() -> Router<AppState> {
    Router::new().route("/github/image", get(get_github_image))
}

#[derive(Deserialize)]
struct GitHubImageQuery {
    url: String,
}

#[derive(Debug, thiserror::Error)]
enum GitHubImageError {
    #[error("invalid GitHub attachment URL")]
    InvalidUrl,
    #[error("GitHub authentication is required")]
    AuthenticationRequired,
    #[error("GitHub attachment not found")]
    NotFound,
    #[error("GitHub denied access to this attachment")]
    AccessDenied,
    #[error("GitHub returned a non-image response")]
    NotImage,
    #[error("GitHub attachment is too large")]
    TooLarge,
    #[error("failed to fetch GitHub attachment")]
    Upstream,
    #[error("failed to read GitHub credentials")]
    Credentials,
}

impl IntoResponse for GitHubImageError {
    fn into_response(self) -> Response {
        let status = match self {
            Self::InvalidUrl => StatusCode::BAD_REQUEST,
            Self::AuthenticationRequired | Self::AccessDenied => StatusCode::FORBIDDEN,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::NotImage => StatusCode::UNSUPPORTED_MEDIA_TYPE,
            Self::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::Upstream | Self::Credentials => StatusCode::BAD_GATEWAY,
        };
        (status, self.to_string()).into_response()
    }
}

#[instrument(name = "github_images.get", skip(state, ctx, query), fields(user_id = %ctx.user.id))]
async fn get_github_image(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Query(query): Query<GitHubImageQuery>,
) -> Result<Response, GitHubImageError> {
    let url = validate_initial_url(&query.url)?;
    let account = OAuthAccountRepository::new(state.pool())
        .get_by_user_provider(ctx.user.id, "github")
        .await
        .map_err(|error| {
            warn!(?error, "failed to load GitHub OAuth account");
            GitHubImageError::Credentials
        })?
        .ok_or(GitHubImageError::AuthenticationRequired)?;
    let encrypted_tokens = account
        .encrypted_provider_tokens
        .ok_or(GitHubImageError::AuthenticationRequired)?;
    let token_details = state
        .jwt()
        .decrypt_provider_tokens(&encrypted_tokens)
        .map_err(|error| {
            warn!(?error, "failed to decrypt GitHub OAuth token");
            GitHubImageError::Credentials
        })?;
    if token_details.provider != "github" {
        return Err(GitHubImageError::AuthenticationRequired);
    }

    let response = fetch_image(&url, token_details.access_token.as_str()).await?;
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.starts_with("image/"))
        .ok_or(GitHubImageError::NotImage)?;
    let content_type =
        HeaderValue::from_str(content_type).map_err(|_| GitHubImageError::NotImage)?;
    if response
        .content_length()
        .is_some_and(|size| size > MAX_IMAGE_SIZE_BYTES as u64)
    {
        return Err(GitHubImageError::TooLarge);
    }
    let bytes = read_image_bytes(response).await?;

    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, content_type);
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=300"),
    );
    headers.insert(header::VARY, HeaderValue::from_static("Authorization"));
    Ok((StatusCode::OK, headers, Body::from(bytes)).into_response())
}

async fn read_image_bytes(response: reqwest::Response) -> Result<Vec<u8>, GitHubImageError> {
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| {
            warn!(?error, "failed to read GitHub attachment response");
            GitHubImageError::Upstream
        })?;
        if exceeds_image_size(bytes.len(), chunk.len()) {
            return Err(GitHubImageError::TooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }

    Ok(bytes)
}

fn exceeds_image_size(current_size: usize, chunk_size: usize) -> bool {
    current_size > MAX_IMAGE_SIZE_BYTES
        || chunk_size > MAX_IMAGE_SIZE_BYTES.saturating_sub(current_size)
}

async fn fetch_image(url: &Url, access_token: &str) -> Result<reqwest::Response, GitHubImageError> {
    let client = Client::builder()
        .redirect(Policy::none())
        .user_agent(GITHUB_USER_AGENT)
        .build()
        .map_err(|error| {
            warn!(?error, "failed to create GitHub image client");
            GitHubImageError::Upstream
        })?;
    let mut next_url = url.clone();

    for _ in 0..=MAX_REDIRECTS {
        let mut request = client
            .get(next_url.clone())
            .header(header::ACCEPT, "image/avif,image/webp,image/*,*/*;q=0.8");
        if next_url.host_str() == Some("github.com") {
            request = request.bearer_auth(access_token);
        }
        let response = request.send().await.map_err(|error| {
            warn!(?error, "failed to request GitHub attachment");
            GitHubImageError::Upstream
        })?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or(GitHubImageError::Upstream)?;
            let redirect_url = next_url
                .join(location)
                .map_err(|_| GitHubImageError::Upstream)?;
            if !is_allowed_redirect_url(&redirect_url) {
                return Err(GitHubImageError::InvalidUrl);
            }
            next_url = redirect_url;
            continue;
        }
        return match response.status() {
            ReqwestStatusCode::OK => Ok(response),
            ReqwestStatusCode::NOT_FOUND => {
                if token_has_private_repository_scope(&client, access_token).await? {
                    Err(GitHubImageError::NotFound)
                } else {
                    Err(GitHubImageError::AccessDenied)
                }
            }
            ReqwestStatusCode::UNAUTHORIZED | ReqwestStatusCode::FORBIDDEN => {
                Err(GitHubImageError::AccessDenied)
            }
            status if status.is_client_error() || status.is_server_error() => {
                warn!(%status, "GitHub attachment request failed");
                Err(GitHubImageError::Upstream)
            }
            _ => Err(GitHubImageError::Upstream),
        };
    }
    Err(GitHubImageError::Upstream)
}

async fn token_has_private_repository_scope(
    client: &Client,
    access_token: &str,
) -> Result<bool, GitHubImageError> {
    let response = client
        .get(GITHUB_USER_API_URL)
        .header(header::ACCEPT, "application/vnd.github+json")
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|error| {
            warn!(?error, "failed to inspect GitHub OAuth scopes");
            GitHubImageError::Upstream
        })?;

    match response.status() {
        ReqwestStatusCode::OK => Ok(has_private_repository_scope(response.headers())),
        ReqwestStatusCode::UNAUTHORIZED | ReqwestStatusCode::FORBIDDEN => Ok(false),
        status => {
            warn!(%status, "failed to inspect GitHub OAuth scopes");
            Err(GitHubImageError::Upstream)
        }
    }
}

fn has_private_repository_scope(headers: &HeaderMap) -> bool {
    headers
        .get(GITHUB_OAUTH_SCOPES_HEADER)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|scopes| {
            scopes
                .split(',')
                .any(|scope| scope.trim().eq_ignore_ascii_case("repo"))
        })
}

fn validate_initial_url(raw_url: &str) -> Result<Url, GitHubImageError> {
    let url = Url::parse(raw_url).map_err(|_| GitHubImageError::InvalidUrl)?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url.path().starts_with(GITHUB_ATTACHMENT_PATH_PREFIX)
    {
        return Err(GitHubImageError::InvalidUrl);
    }
    Ok(url)
}

fn is_allowed_redirect_url(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    url.scheme() == "https"
        && (host == "github.com"
            || host == "githubusercontent.com"
            || host.ends_with(".githubusercontent.com")
            || host == GITHUB_USER_ASSET_S3_HOST)
}

#[cfg(test)]
mod tests {
    use axum::http::{HeaderMap, HeaderValue};
    use url::Url;

    use super::{
        GITHUB_OAUTH_SCOPES_HEADER, exceeds_image_size, has_private_repository_scope,
        is_allowed_redirect_url, validate_initial_url,
    };

    #[test]
    fn accepts_github_user_attachment_urls() {
        assert!(
            validate_initial_url("https://github.com/user-attachments/assets/attachment-id")
                .is_ok()
        );
    }

    #[test]
    fn rejects_non_attachment_or_insecure_urls() {
        assert!(validate_initial_url("http://github.com/user-attachments/assets/id").is_err());
        assert!(validate_initial_url("https://example.com/user-attachments/assets/id").is_err());
        assert!(validate_initial_url("https://github.com/example/repo").is_err());
    }

    #[test]
    fn only_allows_github_redirect_hosts() {
        assert!(is_allowed_redirect_url(
            &Url::parse("https://private-user-images.githubusercontent.com/image").unwrap()
        ));
        assert!(is_allowed_redirect_url(
            &Url::parse("https://github-production-user-asset-6210df.s3.amazonaws.com/attachment")
                .unwrap()
        ));
        assert!(!is_allowed_redirect_url(
            &Url::parse("https://githubusercontent.com.evil.example/image").unwrap()
        ));
        assert!(!is_allowed_redirect_url(
            &Url::parse("https://github-production-user-asset-evil.s3.amazonaws.com/attachment")
                .unwrap()
        ));
        assert!(!is_allowed_redirect_url(
            &Url::parse(
                "https://github-production-user-asset-6210df.s3.amazonaws.com.evil.example/image"
            )
            .unwrap()
        ));
    }

    #[test]
    fn detects_image_sizes_that_exceed_the_limit() {
        assert!(!exceeds_image_size(20 * 1024 * 1024 - 1, 1));
        assert!(exceeds_image_size(20 * 1024 * 1024, 1));
        assert!(exceeds_image_size(20 * 1024 * 1024 + 1, 0));
    }

    #[test]
    fn detects_private_repository_scope() {
        let mut headers = HeaderMap::new();
        headers.insert(
            GITHUB_OAUTH_SCOPES_HEADER,
            HeaderValue::from_static("read:user, user:email, repo"),
        );

        assert!(has_private_repository_scope(&headers));
    }

    #[test]
    fn rejects_missing_or_public_only_repository_scopes() {
        assert!(!has_private_repository_scope(&HeaderMap::new()));

        let mut headers = HeaderMap::new();
        headers.insert(
            GITHUB_OAUTH_SCOPES_HEADER,
            HeaderValue::from_static("read:user, user:email, public_repo"),
        );

        assert!(!has_private_repository_scope(&headers));
    }
}
