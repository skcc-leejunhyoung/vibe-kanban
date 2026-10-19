use std::sync::Arc;

use anyhow::Error as AnyhowError;
use async_trait::async_trait;
use axum::response::sse::Event;
use client_info::ClientInfo;
use db::{DBService, models::workspace::WorkspaceError};
use executors::executors::ExecutorError;
use futures::{StreamExt, TryStreamExt};
use git::{GitService, GitServiceError};
use preview_proxy::PreviewProxyService;
use relay_control::{RelayControl, signing::RelaySigningService};
use relay_hosts::RelayHosts;
use remote_info::RemoteInfo;
use services::services::{
    approvals::Approvals,
    auth::AuthContext,
    config::{Config, ConfigError},
    container::{ContainerError, ContainerService},
    events::{EventError, EventService},
    file::{FileError, FileService},
    file_search::FileSearchCache,
    filesystem::{FilesystemError, FilesystemService},
    filesystem_watcher::FilesystemWatcherError,
    queued_message::QueuedMessageService,
    remote_client::RemoteClient,
    repo::RepoService,
};
use sqlx::Error as SqlxError;
use thiserror::Error;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;
use trusted_key_auth::runtime::TrustedKeyAuthRuntime;
use worktree_manager::WorktreeError;

#[derive(Debug, Clone, Copy, Error)]
#[error("Remote client not configured")]
pub struct RemoteClientNotConfigured;

#[derive(Debug, Clone, Copy, Error)]
#[error("Relay hosts not configured")]
pub struct RelayHostsNotConfigured;

#[derive(Debug, Error)]
pub enum DeploymentError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Sqlx(#[from] SqlxError),
    #[error(transparent)]
    GitServiceError(#[from] GitServiceError),
    #[error(transparent)]
    FilesystemWatcherError(#[from] FilesystemWatcherError),
    #[error(transparent)]
    Workspace(#[from] WorkspaceError),
    #[error(transparent)]
    Container(#[from] ContainerError),
    #[error(transparent)]
    Executor(#[from] ExecutorError),
    #[error(transparent)]
    File(#[from] FileError),
    #[error(transparent)]
    Filesystem(#[from] FilesystemError),
    #[error(transparent)]
    Worktree(#[from] WorktreeError),
    #[error(transparent)]
    Event(#[from] EventError),
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error("Remote client not configured")]
    RemoteClientNotConfigured,
    #[error(transparent)]
    Other(#[from] AnyhowError),
}

#[async_trait]
pub trait Deployment: Clone + Send + Sync + 'static {
    async fn new(shutdown: CancellationToken) -> Result<Self, DeploymentError>;

    fn user_id(&self) -> &str;

    fn config(&self) -> &Arc<RwLock<Config>>;

    fn db(&self) -> &DBService;

    fn container(&self) -> &impl ContainerService;

    fn git(&self) -> &GitService;

    fn repo(&self) -> &RepoService;

    fn file(&self) -> &FileService;

    fn filesystem(&self) -> &FilesystemService;

    fn events(&self) -> &EventService;

    fn file_search_cache(&self) -> &Arc<FileSearchCache>;

    fn approvals(&self) -> &Approvals;

    fn queued_message_service(&self) -> &QueuedMessageService;

    fn auth_context(&self) -> &AuthContext;

    fn relay_control(&self) -> &Arc<RelayControl>;

    fn relay_signing(&self) -> &RelaySigningService;

    fn client_info(&self) -> &ClientInfo;

    fn remote_info(&self) -> &RemoteInfo;

    fn preview_proxy(&self) -> &PreviewProxyService;

    fn relay_hosts(&self) -> Result<&Arc<RelayHosts>, RelayHostsNotConfigured> {
        Err(RelayHostsNotConfigured)
    }

    fn trusted_key_auth(&self) -> &TrustedKeyAuthRuntime;

    fn remote_client(&self) -> Result<RemoteClient, RemoteClientNotConfigured> {
        Err(RemoteClientNotConfigured)
    }

    async fn stream_events(
        &self,
    ) -> futures::stream::BoxStream<'static, Result<Event, std::io::Error>> {
        self.events()
            .msg_store()
            .history_plus_stream()
            .map_ok(|m| m.to_sse_event())
            .boxed()
    }
}
/// Scope of a request made through central account access.
#[derive(Debug, Clone, Copy)]
pub struct AccountHostRequest {
    /// The actor registered this host and the host's saved central session is
    /// also theirs, so nested cloud requests act as the actor themselves.
    pub host_owner: bool,
}

tokio::task_local! {
    /// A remote account may operate local work, but only the host owner may
    /// borrow the host's saved central user session for a nested cloud request.
    pub static ACCOUNT_HOST_REQUEST: AccountHostRequest;
}

pub fn account_host_request() -> Option<AccountHostRequest> {
    ACCOUNT_HOST_REQUEST.try_with(|request| *request).ok()
}

/// True when the current task is an account request from someone other than
/// the host owner, who must not use the host's central session.
pub fn host_cloud_session_denied() -> bool {
    account_host_request().is_some_and(|request| !request.host_owner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn only_owner_account_requests_may_use_host_cloud_session() {
        assert!(!host_cloud_session_denied());
        let scoped = |host_owner| {
            ACCOUNT_HOST_REQUEST.scope(AccountHostRequest { host_owner }, async {
                (
                    host_cloud_session_denied(),
                    account_host_request().is_some(),
                )
            })
        };
        // Owners still count as account requests for centrally managed config.
        assert_eq!(scoped(false).await, (true, true));
        assert_eq!(scoped(true).await, (false, true));
    }
}
