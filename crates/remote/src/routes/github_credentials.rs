use tracing::warn;

use crate::{AppState, auth::RequestContext, db::oauth_accounts::OAuthAccountRepository};

#[derive(Debug, Clone, Copy)]
pub(crate) enum GitHubCredentialsError {
    Missing,
    Unavailable,
}

pub(crate) async fn github_access_token(
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
