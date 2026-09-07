use std::{sync::LazyLock, time::Duration};

use moka::future::Cache;
use reqwest::StatusCode;
use serde::Deserialize;
use tracing::warn;
use uuid::Uuid;

use crate::{
    AppState,
    auth::RequestContext,
    db::{
        github_host_credentials::GitHubHostCredentialRepository,
        oauth_accounts::OAuthAccountRepository,
    },
    routes::github_pull_requests::github_request,
};

const GITHUB_USER_URL: &str = "https://api.github.com/user";
const HOST_TOKEN_CHECK_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_HOST_TOKEN_CHECK_ENTRIES: u64 = 4_096;

#[derive(Debug, Clone, Copy)]
pub(crate) enum GitHubCredentialsError {
    Missing,
    Unavailable,
}

// ponytail: one GET /user per user per 10 minutes confirms the uploaded CLI
// token still works; a revoked one is dropped so the OAuth token takes over.
static HOST_TOKEN_CHECKED: LazyLock<Cache<Uuid, ()>> = LazyLock::new(|| {
    Cache::builder()
        .time_to_live(HOST_TOKEN_CHECK_TTL)
        .max_capacity(MAX_HOST_TOKEN_CHECK_ENTRIES)
        .build()
});

pub(crate) async fn forget_host_token_check(user_id: Uuid) {
    HOST_TOKEN_CHECKED.invalidate(&user_id).await;
}

/// The GitHub token `/v1/github/*` acts with: a host's GitHub CLI login when
/// one was uploaded (organization approvals, `read:org`), else the OAuth
/// app token from sign-in.
pub(crate) async fn github_access_token(
    state: &AppState,
    ctx: &RequestContext,
) -> Result<String, GitHubCredentialsError> {
    if let Some(token) = host_gh_token(state, ctx.user.id).await {
        return Ok(token);
    }
    oauth_token(state, ctx).await
}

async fn oauth_token(
    state: &AppState,
    ctx: &RequestContext,
) -> Result<String, GitHubCredentialsError> {
    let account = OAuthAccountRepository::new(state.pool())
        .get_by_user_provider(ctx.user.id, "github")
        .await
        .map_err(|error| {
            warn!(?error, "failed to load GitHub OAuth account");
            GitHubCredentialsError::Unavailable
        })?
        .ok_or(GitHubCredentialsError::Missing)?;
    let encrypted_tokens = account
        .encrypted_provider_tokens
        .ok_or(GitHubCredentialsError::Missing)?;
    let token_details = state
        .jwt()
        .decrypt_provider_tokens(&encrypted_tokens)
        .map_err(|error| {
            warn!(?error, "failed to decrypt GitHub OAuth token");
            GitHubCredentialsError::Unavailable
        })?;

    if token_details.provider != "github" {
        return Err(GitHubCredentialsError::Missing);
    }

    Ok(token_details.access_token)
}

async fn host_gh_token(state: &AppState, user_id: Uuid) -> Option<String> {
    let row = match GitHubHostCredentialRepository::get(state.pool(), user_id).await {
        Ok(row) => row?,
        Err(error) => {
            warn!(?error, "failed to load host GitHub credential");
            return None;
        }
    };
    let token = match state.jwt().decrypt_provider_tokens(&row.encrypted_token) {
        Ok(details) if details.provider == "github" => details.access_token,
        Ok(_) => return None,
        Err(error) => {
            warn!(?error, "failed to decrypt host GitHub credential");
            return None;
        }
    };
    if HOST_TOKEN_CHECKED.get(&user_id).await.is_some() {
        return Some(token);
    }
    match probe_github_token(state, &token).await {
        Ok(_) => {
            HOST_TOKEN_CHECKED.insert(user_id, ()).await;
            Some(token)
        }
        Err(GitHubTokenProbeError::Rejected) => {
            warn!(%user_id, "host GitHub credential was rejected by GitHub; removing it");
            if let Err(error) = GitHubHostCredentialRepository::delete(state.pool(), user_id).await
            {
                warn!(?error, "failed to remove rejected host GitHub credential");
            }
            None
        }
        // GitHub is unreachable: let the real request report that.
        Err(GitHubTokenProbeError::Upstream) => Some(token),
    }
}

pub(crate) struct GitHubTokenIdentity {
    pub login: String,
    pub user_id: String,
    pub scopes: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum GitHubTokenProbeError {
    Rejected,
    Upstream,
}

#[derive(Debug, Deserialize)]
struct GitHubUserResponse {
    login: String,
    id: u64,
}

/// Ask GitHub who a token belongs to and which classic scopes it carries.
pub(crate) async fn probe_github_token(
    state: &AppState,
    token: &str,
) -> Result<GitHubTokenIdentity, GitHubTokenProbeError> {
    let response = github_request(
        &state.http_client,
        reqwest::Method::GET,
        GITHUB_USER_URL,
        token,
    )
    .send()
    .await
    .map_err(|error| {
        warn!(error = %error.without_url(), "GitHub token probe failed");
        GitHubTokenProbeError::Upstream
    })?;
    if response.status() == StatusCode::UNAUTHORIZED {
        return Err(GitHubTokenProbeError::Rejected);
    }
    if !response.status().is_success() {
        warn!(status = %response.status(), "GitHub token probe returned an unexpected status");
        return Err(GitHubTokenProbeError::Upstream);
    }
    let scopes = parse_oauth_scopes(
        response
            .headers()
            .get("x-oauth-scopes")
            .and_then(|value| value.to_str().ok()),
    );
    let user: GitHubUserResponse = response.json().await.map_err(|error| {
        warn!(error = %error.without_url(), "failed to decode GitHub user");
        GitHubTokenProbeError::Upstream
    })?;
    Ok(GitHubTokenIdentity {
        login: user.login,
        user_id: user.id.to_string(),
        scopes,
    })
}

fn parse_oauth_scopes(header: Option<&str>) -> Vec<String> {
    header
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|scope| !scope.is_empty())
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oauth_scopes_header_is_split_and_trimmed() {
        assert_eq!(
            parse_oauth_scopes(Some("gist, read:org, repo, workflow")),
            ["gist", "read:org", "repo", "workflow"]
        );
        assert!(parse_oauth_scopes(Some("")).is_empty());
        assert!(parse_oauth_scopes(None).is_empty());
    }
}
