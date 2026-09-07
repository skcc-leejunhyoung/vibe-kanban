use std::time::Duration;

use api_types::GitHubCredentialStatus;
use git_host::github::{GhCli, GhCliError};
use thiserror::Error;

use super::remote_client::{RemoteClient, RemoteClientError};

#[derive(Debug, Error)]
pub enum GitHubHostCredentialError {
    #[error(transparent)]
    Gh(#[from] GhCliError),
    #[error(transparent)]
    Remote(#[from] RemoteClientError),
}

/// Reuse this host's `gh` login as the account's central GitHub credential.
pub async fn sync(
    client: &RemoteClient,
) -> Result<GitHubCredentialStatus, GitHubHostCredentialError> {
    let token = tokio::task::spawn_blocking(|| GhCli::new().auth_token())
        .await
        .map_err(|error| GhCliError::CommandFailed(error.to_string()))??;
    Ok(client.register_github_host_credential(&token).await?)
}

/// Best-effort sync after boot or sign-in. Never logs the token.
pub async fn sync_in_background(client: RemoteClient, delay: Duration) {
    tokio::time::sleep(delay).await;
    if client.access_token().await.is_err() {
        return;
    }
    match sync(&client).await {
        Ok(status) => {
            tracing::info!(login = ?status.login, "synced host GitHub CLI credential")
        }
        Err(GitHubHostCredentialError::Gh(
            GhCliError::NotAvailable | GhCliError::AuthFailed(_),
        )) => {
            tracing::info!("no GitHub CLI login on this host; keeping the sign-in credential")
        }
        Err(error) => tracing::warn!(%error, "failed to sync host GitHub CLI credential"),
    }
}
