use api_types::{GitHubCredentialSource, GitHubCredentialStatus, RegisterGitHubCredentialRequest};
use axum::{
    Extension, Json, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::json;
use tracing::{instrument, warn};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{ProviderTokenDetails, RequestContext},
    db::{
        github_host_credentials::GitHubHostCredentialRepository,
        oauth_accounts::OAuthAccountRepository,
    },
    routes::{
        github_credentials::{GitHubTokenProbeError, forget_host_token_check, probe_github_token},
        github_pull_requests::invalidate_user_github_caches,
    },
};

const MAX_TOKEN_LEN: usize = 512;
/// `repo` reads private repositories; `read:org` covers team reviewers and
/// organization data the Vibe OAuth app is not approved for.
const REQUIRED_SCOPES: [&str; 2] = ["repo", "read:org"];

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/github/credentials",
        get(status).put(register).delete(remove),
    )
}

#[derive(Debug, thiserror::Error)]
enum CredentialError {
    #[error("{0}")]
    InvalidToken(&'static str),
    #[error("GitHub token is missing required scopes: {}", .0.join(", "))]
    MissingScopes(Vec<String>),
    #[error("GitHub token belongs to a different account than the linked GitHub sign-in")]
    AccountMismatch,
    #[error("GitHub API request failed")]
    Upstream,
    #[error("failed to store GitHub credential")]
    Internal,
}

impl IntoResponse for CredentialError {
    fn into_response(self) -> Response {
        let (status, code) = match &self {
            Self::InvalidToken(_) => (StatusCode::BAD_REQUEST, "invalid_github_token"),
            Self::MissingScopes(_) => (StatusCode::BAD_REQUEST, "github_token_missing_scopes"),
            Self::AccountMismatch => (StatusCode::CONFLICT, "github_account_mismatch"),
            Self::Upstream => (StatusCode::BAD_GATEWAY, "github_upstream_error"),
            Self::Internal => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "github_credential_failed",
            ),
        };
        (
            status,
            Json(json!({ "error": self.to_string(), "code": code })),
        )
            .into_response()
    }
}

impl From<sqlx::Error> for CredentialError {
    fn from(error: sqlx::Error) -> Self {
        warn!(?error, "GitHub credential database error");
        Self::Internal
    }
}

#[instrument(name = "github.credentials.status", skip(state, ctx), fields(user_id = %ctx.user.id))]
async fn status(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
) -> Result<Json<GitHubCredentialStatus>, CredentialError> {
    Ok(Json(credential_status(&state, ctx.user.id).await?))
}

async fn credential_status(
    state: &AppState,
    user_id: Uuid,
) -> Result<GitHubCredentialStatus, CredentialError> {
    if let Some(row) = GitHubHostCredentialRepository::get(state.pool(), user_id).await? {
        return Ok(GitHubCredentialStatus {
            source: GitHubCredentialSource::HostGh,
            login: Some(row.github_login),
            scopes: row.scopes,
            updated_at: Some(row.updated_at),
        });
    }
    let account = linked_github_account(state, user_id).await?;
    Ok(match account {
        Some(account) if account.encrypted_provider_tokens.is_some() => GitHubCredentialStatus {
            source: GitHubCredentialSource::OAuth,
            login: account.username,
            scopes: Vec::new(),
            updated_at: Some(account.updated_at),
        },
        _ => GitHubCredentialStatus {
            source: GitHubCredentialSource::None,
            login: None,
            scopes: Vec::new(),
            updated_at: None,
        },
    })
}

async fn linked_github_account(
    state: &AppState,
    user_id: Uuid,
) -> Result<Option<crate::db::oauth_accounts::OAuthAccount>, CredentialError> {
    OAuthAccountRepository::new(state.pool())
        .get_by_user_provider(user_id, "github")
        .await
        .map_err(|error| {
            warn!(?error, "failed to load GitHub OAuth account");
            CredentialError::Internal
        })
}

#[instrument(name = "github.credentials.register", skip(state, ctx, payload), fields(user_id = %ctx.user.id))]
async fn register(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Json(payload): Json<RegisterGitHubCredentialRequest>,
) -> Result<Json<GitHubCredentialStatus>, CredentialError> {
    let token = payload.token.trim();
    if token.is_empty()
        || token.len() > MAX_TOKEN_LEN
        || !token.bytes().all(|byte| byte.is_ascii_graphic())
    {
        return Err(CredentialError::InvalidToken("invalid GitHub token"));
    }
    let identity = probe_github_token(&state, token)
        .await
        .map_err(|error| match error {
            GitHubTokenProbeError::Rejected => {
                CredentialError::InvalidToken("GitHub rejected the token")
            }
            GitHubTokenProbeError::Upstream => CredentialError::Upstream,
        })?;
    let missing = missing_scopes(&identity.scopes);
    if !missing.is_empty() {
        return Err(CredentialError::MissingScopes(missing));
    }
    // One GitHub identity per user: a token for another account must not
    // silently change whose repositories and pull requests this user sees.
    if linked_github_account(&state, ctx.user.id)
        .await?
        .is_some_and(|account| account.provider_user_id != identity.user_id)
    {
        return Err(CredentialError::AccountMismatch);
    }
    let encrypted = state
        .jwt()
        .encrypt_provider_tokens(&ProviderTokenDetails {
            provider: "github".to_string(),
            access_token: token.to_string(),
            refresh_token: None,
            expires_at: None,
        })
        .map_err(|error| {
            warn!(?error, "failed to encrypt GitHub credential");
            CredentialError::Internal
        })?;
    GitHubHostCredentialRepository::upsert(
        state.pool(),
        ctx.user.id,
        &identity.user_id,
        &identity.login,
        &identity.scopes,
        &encrypted,
    )
    .await?;
    forget_host_token_check(ctx.user.id).await;
    invalidate_user_github_caches(ctx.user.id).await;
    Ok(Json(credential_status(&state, ctx.user.id).await?))
}

#[instrument(name = "github.credentials.remove", skip(state, ctx), fields(user_id = %ctx.user.id))]
async fn remove(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
) -> Result<StatusCode, CredentialError> {
    GitHubHostCredentialRepository::delete(state.pool(), ctx.user.id).await?;
    forget_host_token_check(ctx.user.id).await;
    invalidate_user_github_caches(ctx.user.id).await;
    Ok(StatusCode::NO_CONTENT)
}

fn missing_scopes(granted: &[String]) -> Vec<String> {
    REQUIRED_SCOPES
        .iter()
        .filter(|required| !scope_granted(granted, required))
        .map(|scope| scope.to_string())
        .collect()
}

/// Classic scopes nest: `admin:org` implies `write:org` implies `read:org`.
fn scope_granted(granted: &[String], required: &str) -> bool {
    granted.iter().any(|scope| {
        scope == required
            || matches!(
                (required, scope.as_str()),
                ("read:org", "write:org" | "admin:org")
            )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scopes(values: &[&str]) -> Vec<String> {
        values.iter().map(|scope| scope.to_string()).collect()
    }

    #[test]
    fn host_tokens_need_repo_and_org_read_access() {
        assert_eq!(missing_scopes(&scopes(&["repo"])), ["read:org"]);
        assert!(missing_scopes(&scopes(&["repo", "admin:org", "gist"])).is_empty());
        assert_eq!(missing_scopes(&scopes(&[])), ["repo", "read:org"]);
    }

    #[test]
    fn rejected_and_missing_scope_tokens_are_client_errors() {
        assert_eq!(
            CredentialError::InvalidToken("bad")
                .into_response()
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            CredentialError::MissingScopes(vec!["read:org".to_string()])
                .into_response()
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            CredentialError::AccountMismatch.into_response().status(),
            StatusCode::CONFLICT
        );
    }
}
