//! OAuth client for authorization-code handoffs with automatic retries.

use std::time::Duration;

use api_types::{
    AcceptInvitationResponse, AgentMemoryInboxResponse, AgentMemoryKind, AgentMemoryMutation,
    AgentMemoryMutationInboxResponse, AgentMemoryReceipt, AgentMemoryScope, AgentMemorySyncJob,
    AgentMemorySyncSession, AgentMemorySyncSessionTarget, AgentMemorySyncTarget,
    AuthMethodsResponse, CreateAgentMemoryMutationRequest, CreateAgentMemorySyncSessionRequest,
    CreateInvitationRequest, CreateInvitationResponse, CreateIssueAssigneeRequest,
    CreateIssueRelationshipRequest, CreateIssueRequest, CreateIssueTagRequest,
    CreateOrganizationRequest, CreateOrganizationResponse, CreateTagRequest,
    CreateWorkspaceRequest, DeleteResponse, DeleteWorkspaceRequest, GetInvitationResponse,
    GetOrganizationResponse, GitHubCredentialStatus, HandoffInitRequest, HandoffInitResponse,
    HandoffRedeemRequest, HandoffRedeemResponse, Issue, IssueAssignee, IssueRelationship, IssueTag,
    ListAttachmentsResponse, ListInvitationsResponse, ListIssueAssigneesResponse,
    ListIssueRelationshipsResponse, ListIssueTagsResponse, ListIssuesResponse, ListMembersResponse,
    ListOrganizationsResponse, ListProjectStatusesResponse, ListProjectsResponse,
    ListPullRequestsResponse, ListTagsResponse, LocalLoginRequest, LocalLoginResponse,
    MutationResponse, Organization, ProfileResponse, PullRequest,
    RecordAgentMemoryMutationReceiptRequest, RecordAgentMemoryReceiptRequest,
    RegisterAgentMemorySyncTargetRequest, RegisterGitHubCredentialRequest,
    ReportAgentMemorySyncJobRequest, RevokeInvitationRequest, SearchIssuesRequest, Tag,
    TokenRefreshRequest, TokenRefreshResponse, UpdateIssueRequest, UpdateMemberRoleRequest,
    UpdateMemberRoleResponse, UpdateOrganizationRequest, UpdatePullRequestApiRequest,
    UpdateWorkspaceRequest, UpsertAgentMemorySnapshotRequest, UpsertAgentMemorySnapshotResponse,
    UpsertPullRequestRequest, Workspace,
};
use backon::{ExponentialBuilder, Retryable};
use bytes::Bytes;
use chrono::Duration as ChronoDuration;
use relay_types::{ListRelayHostsResponse, RelayHost};
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tracing::{Instrument, warn};
use url::Url;
use utils::jwt::extract_expiration;
use uuid::Uuid;

use super::{auth::AuthContext, oauth_credentials::Credentials};

#[derive(Debug, Clone, Error)]
pub enum RemoteClientError {
    #[error("network error: {0}")]
    Transport(String),
    #[error("timeout")]
    Timeout,
    #[error("http {status}: {body}")]
    Http { status: u16, body: String },
    #[error("api error: {0:?}")]
    Api(HandoffErrorCode),
    #[error("unauthorized")]
    Auth,
    #[error("OAuth reconnect is in progress. Please try again after completing it.")]
    ReconnectPending,
    #[error("json error: {0}")]
    Serde(String),
    #[error("url error: {0}")]
    Url(String),
    #[error("credentials storage error: {0}")]
    Storage(String),
    #[error("invalid access token: {0}")]
    Token(String),
}

impl RemoteClientError {
    pub fn generic_degraded_slug() -> &'static str {
        "remote_auth_unavailable"
    }

    /// Returns true if the error is transient and should be retried.
    fn should_retry(&self) -> bool {
        match self {
            Self::Transport(_) | Self::Timeout => true,
            Self::Http { status, .. } => (500..=599).contains(status),
            _ => false,
        }
    }

    fn is_definitive_auth_failure(&self) -> bool {
        match self {
            Self::Auth => true,
            Self::Api(code) => code.is_definitive_auth_failure(),
            _ => false,
        }
    }

    pub fn degraded_slug(&self) -> Option<&'static str> {
        match self {
            Self::Timeout
            | Self::Transport(_)
            | Self::Storage(_)
            | Self::Serde(_)
            | Self::ReconnectPending => Some(Self::generic_degraded_slug()),
            Self::Http { status, .. } if (500..=599).contains(status) => {
                Some(Self::generic_degraded_slug())
            }
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub enum HandoffErrorCode {
    UnsupportedProvider,
    InvalidReturnUrl,
    InvalidChallenge,
    ProviderError,
    NotFound,
    Expired,
    AccessDenied,
    InternalError,
    Other(String),
}

impl HandoffErrorCode {
    fn is_definitive_auth_failure(&self) -> bool {
        match self {
            Self::Expired | Self::AccessDenied => true,
            Self::Other(code) => matches!(
                code.as_str(),
                "invalid_token"
                    | "expired_token"
                    | "session_revoked"
                    | "token_reuse_detected"
                    | "provider_token_revoked"
                    | "identity_error"
            ),
            _ => false,
        }
    }
}

fn map_error_code(code: Option<&str>) -> HandoffErrorCode {
    match code.unwrap_or("internal_error") {
        "unsupported_provider" => HandoffErrorCode::UnsupportedProvider,
        "invalid_return_url" => HandoffErrorCode::InvalidReturnUrl,
        "invalid_challenge" => HandoffErrorCode::InvalidChallenge,
        "provider_error" => HandoffErrorCode::ProviderError,
        "not_found" => HandoffErrorCode::NotFound,
        "expired" | "expired_token" => HandoffErrorCode::Expired,
        "access_denied" => HandoffErrorCode::AccessDenied,
        "internal_error" => HandoffErrorCode::InternalError,
        other => HandoffErrorCode::Other(other.to_string()),
    }
}

/// The refresh token a refresh started from, and what the refresh produced.
type RefreshOutcome =
    Result<(String, Result<Option<Credentials>, RemoteClientError>), RemoteClientError>;

/// Shared by every caller waiting on the same token refresh.
pub(crate) type RefreshFlight = tokio::sync::watch::Receiver<Option<RefreshOutcome>>;

#[derive(Deserialize)]
struct ApiErrorResponse {
    error: String,
}

/// HTTP client for the remote OAuth server with automatic retries.
pub struct RemoteClient {
    base: Url,
    http: Client,
    auth_context: AuthContext,
    machine_id: String,
}

impl std::fmt::Debug for RemoteClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemoteClient")
            .field("base", &self.base)
            .field("http", &self.http)
            .field("auth_context", &"<present>")
            .finish()
    }
}

impl Clone for RemoteClient {
    fn clone(&self) -> Self {
        Self {
            base: self.base.clone(),
            http: self.http.clone(),
            auth_context: self.auth_context.clone(),
            machine_id: self.machine_id.clone(),
        }
    }
}

impl RemoteClient {
    const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
    const TOKEN_REFRESH_LEEWAY_SECS: i64 = 20;

    pub fn new(
        base_url: &str,
        auth_context: AuthContext,
        machine_id: String,
    ) -> Result<Self, RemoteClientError> {
        let base = Url::parse(base_url).map_err(|e| RemoteClientError::Url(e.to_string()))?;
        let mut builder = Client::builder()
            .timeout(Self::REQUEST_TIMEOUT)
            .user_agent(concat!("remote-client/", env!("CARGO_PKG_VERSION")));

        #[cfg(debug_assertions)]
        {
            builder = builder.danger_accept_invalid_certs(true);
        }

        let http = builder
            .build()
            .map_err(|e| RemoteClientError::Transport(e.to_string()))?;
        Ok(Self {
            base,
            http,
            auth_context,
            machine_id,
        })
    }

    pub async fn current_host_id(&self) -> Result<Uuid, RemoteClientError> {
        // Host registrations and authenticated accounts can change while the
        // local backend stays alive. Resolve against the current account on
        // every host-scoped operation instead of retaining a stale UUID.
        self.list_relay_hosts()
            .await?
            .into_iter()
            .find(|host| host.machine_id == self.machine_id)
            .map(|host| host.id)
            .ok_or_else(|| {
                RemoteClientError::Transport(
                    "this computer is not registered as a remote host".to_string(),
                )
            })
    }

    /// Returns a valid access token, refreshing when it's about to expire.
    fn require_token(
        &self,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<String, RemoteClientError>> + Send + '_>,
    > {
        Box::pin(async move {
            let leeway = ChronoDuration::seconds(Self::TOKEN_REFRESH_LEEWAY_SECS);
            let creds = self
                .auth_context
                .get_credentials()
                .await
                .ok_or(RemoteClientError::Auth)?;

            if let Some(token) = creds.access_token.as_ref()
                && !creds.expires_soon(leeway)
            {
                return Ok(token.clone());
            }

            let (refresh_token, refreshed) = self
                .join_refresh(leeway)
                .wait_for(Option::is_some)
                .await
                .ok()
                .and_then(|outcome| outcome.clone())
                .ok_or_else(|| {
                    RemoteClientError::Transport("token refresh task failed".to_string())
                })??;

            match refreshed {
                Ok(Some(updated)) => {
                    self.auth_context.clear_remote_auth_degraded_slug().await;
                    updated.access_token.ok_or(RemoteClientError::Auth)
                }
                Ok(None) => self.require_token().await,
                Err(err) if err.is_definitive_auth_failure() => {
                    let cleared = self
                        .auth_context
                        .replace_credentials(&refresh_token, None)
                        .await
                        .map_err(|e| RemoteClientError::Storage(e.to_string()))?;
                    if !cleared {
                        return self.require_token().await;
                    }
                    warn!(error = %err, "Cleared cloud credentials: token refresh was rejected");
                    self.auth_context.clear_remote_auth_degraded_slug().await;
                    Err(err)
                }
                Err(err) => {
                    if let Some(slug) = err.degraded_slug() {
                        self.auth_context.set_remote_auth_degraded_slug(slug).await;
                    }
                    Err(err)
                }
            }
        })
    }

    /// Joins the refresh in flight, or starts one.
    ///
    /// The server commits the rotation before replying. If the caller were
    /// dropped mid-refresh and the response lost, the next refresh would resend
    /// the old token past the grace window and the server would revoke the
    /// whole session as reuse. So the refresh runs detached until saved, and
    /// callers only wait on its outcome; dropping them cancels nothing.
    fn join_refresh(&self, leeway: ChronoDuration) -> RefreshFlight {
        let mut slot = self
            .auth_context
            .refresh_flight()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // A flight is over once it has an outcome or its task died without one.
        if let Some(flight) = slot.as_ref()
            && flight.borrow().is_none()
            && flight.has_changed().is_ok()
        {
            return flight.clone();
        }

        let (sender, flight) = tokio::sync::watch::channel(None);
        *slot = Some(flight.clone());
        let client = self.clone();
        tokio::spawn(
            async move {
                let outcome = client.run_refresh(leeway, &sender).await;
                sender.send_replace(Some(outcome));
            }
            .in_current_span(),
        );
        flight
    }

    async fn run_refresh(
        &self,
        leeway: ChronoDuration,
        sender: &tokio::sync::watch::Sender<Option<RefreshOutcome>>,
    ) -> RefreshOutcome {
        let latest = self
            .auth_context
            .get_credentials()
            .await
            .ok_or(RemoteClientError::Auth)?;
        if !latest.expires_soon(leeway) {
            return Ok((latest.refresh_token.clone(), Ok(Some(latest))));
        }

        // Do not refresh a revoked provider credential while the user
        // is replacing it. This is temporary unavailability, not logout.
        if self.auth_context.is_reconnecting().await {
            return Ok((
                latest.refresh_token,
                Err(RemoteClientError::ReconnectPending),
            ));
        }

        let result = self.refresh_credentials(&latest).await;
        // Only the slot still holds a receiver: every caller was dropped.
        // Before detaching, this case lost the rotated token.
        if sender.receiver_count() <= 1 {
            tracing::info!(
                saved = matches!(result, Ok(Some(_))),
                "Finished token refresh after its caller was dropped"
            );
        }
        Ok((latest.refresh_token, result))
    }

    async fn refresh_credentials(
        &self,
        creds: &Credentials,
    ) -> Result<Option<Credentials>, RemoteClientError> {
        let response = self.refresh_token_request(&creds.refresh_token).await?;
        let access_token = response.access_token;
        let refresh_token = response.refresh_token;
        let expires_at = extract_expiration(&access_token)
            .map_err(|err| RemoteClientError::Token(err.to_string()))?;
        let new_creds = Credentials {
            access_token: Some(access_token),
            refresh_token,
            expires_at: Some(expires_at),
        };
        let saved = self
            .auth_context
            .replace_credentials(&creds.refresh_token, Some(&new_creds))
            .await
            .map_err(|e| RemoteClientError::Storage(e.to_string()))?;
        self.auth_context.clear_remote_auth_degraded_slug().await;
        Ok(saved.then_some(new_creds))
    }

    async fn refresh_token_request(
        &self,
        refresh_token: &str,
    ) -> Result<TokenRefreshResponse, RemoteClientError> {
        let request = TokenRefreshRequest {
            refresh_token: refresh_token.to_string(),
        };

        self.post_public("/v1/tokens/refresh", Some(&request))
            .await
            .map_err(|e| self.map_api_error(e))
    }

    /// Returns a valid access token for use-cases like maintaining a websocket connection.
    pub async fn access_token(&self) -> Result<String, RemoteClientError> {
        self.require_token().await
    }

    /// Forwards a local notification (e.g. coding-agent task completion) to the
    /// authenticated user's remote web push subscriptions (phone, etc.).
    pub async fn send_self_web_push(
        &self,
        title: &str,
        body: &str,
        workspace_id: Option<Uuid>,
    ) -> Result<(), RemoteClientError> {
        #[derive(Serialize)]
        struct Request<'a> {
            title: &'a str,
            body: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            workspace_id: Option<Uuid>,
        }

        self.send(
            reqwest::Method::POST,
            "/v1/web-push/self",
            true,
            Some(&Request {
                title,
                body,
                workspace_id,
            }),
        )
        .await?;
        Ok(())
    }

    /// Initiates an authorization-code handoff for the given provider.
    pub async fn handoff_init(
        &self,
        request: &HandoffInitRequest,
        reconnect_refresh_token: Option<&str>,
    ) -> Result<HandoffInitResponse, RemoteClientError> {
        if let Some(refresh_token) = reconnect_refresh_token {
            // Recovery must not refresh/validate the broken GitHub credential.
            let response = self
                .send_internal_with_request(
                    reqwest::Method::POST,
                    "/v1/oauth/web/reconnect",
                    false,
                    |builder| builder.bearer_auth(refresh_token).json(request),
                )
                .await
                .map_err(|e| self.map_api_error(e))?;
            return response
                .json()
                .await
                .map_err(|e| RemoteClientError::Serde(e.to_string()));
        }
        self.post_public("/v1/oauth/web/init", Some(request))
            .await
            .map_err(|e| self.map_api_error(e))
    }

    /// Redeems an application code for an access token.
    pub async fn handoff_redeem(
        &self,
        request: &HandoffRedeemRequest,
    ) -> Result<HandoffRedeemResponse, RemoteClientError> {
        self.post_public("/v1/oauth/web/redeem", Some(request))
            .await
            .map_err(|e| self.map_api_error(e))
    }

    pub async fn local_login(
        &self,
        request: &LocalLoginRequest,
    ) -> Result<LocalLoginResponse, RemoteClientError> {
        self.post_public("/v1/auth/local/login", Some(request))
            .await
            .map_err(|e| self.map_api_error(e))
    }

    pub async fn auth_methods(&self) -> Result<AuthMethodsResponse, RemoteClientError> {
        self.get_public("/v1/auth/methods").await
    }

    /// Gets an invitation by token (public, no auth required).
    pub async fn get_invitation(
        &self,
        invitation_token: &str,
    ) -> Result<GetInvitationResponse, RemoteClientError> {
        self.get_public(&format!("/v1/invitations/{invitation_token}"))
            .await
    }

    async fn send<B>(
        &self,
        method: reqwest::Method,
        path: &str,
        requires_auth: bool,
        body: Option<&B>,
    ) -> Result<reqwest::Response, RemoteClientError>
    where
        B: Serialize,
    {
        self.send_internal(method, path, requires_auth, body).await
    }

    async fn send_internal<B>(
        &self,
        method: reqwest::Method,
        path: &str,
        requires_auth: bool,
        body: Option<&B>,
    ) -> Result<reqwest::Response, RemoteClientError>
    where
        B: Serialize,
    {
        self.send_internal_with_request(method, path, requires_auth, |req| {
            if let Some(body) = body {
                req.json(body)
            } else {
                req
            }
        })
        .await
    }

    async fn send_internal_with_request<F>(
        &self,
        method: reqwest::Method,
        path: &str,
        requires_auth: bool,
        customize_request: F,
    ) -> Result<reqwest::Response, RemoteClientError>
    where
        F: Fn(reqwest::RequestBuilder) -> reqwest::RequestBuilder,
    {
        let url = self
            .base
            .join(path)
            .map_err(|e| RemoteClientError::Url(e.to_string()))?;

        let operation = || async {
            let mut req = self
                .http
                .request(method.clone(), url.clone())
                .header("X-Client-Version", env!("CARGO_PKG_VERSION"))
                .header("X-Client-Type", "local-backend");

            if requires_auth {
                let token = self.require_token().await?;
                req = req.bearer_auth(token);
            }

            req = customize_request(req);

            let res = req.send().await.map_err(map_reqwest_error)?;

            match res.status() {
                s if s.is_success() => Ok(res),
                StatusCode::UNAUTHORIZED => {
                    // Auth drops the body; log the server's reason (e.g.
                    // token_reuse_detected) since this can end in a logout.
                    let reason = res
                        .json::<ApiErrorResponse>()
                        .await
                        .map(|body| body.error)
                        .ok();
                    warn!(?reason, "Remote server rejected credentials");
                    Err(RemoteClientError::Auth)
                }
                StatusCode::FORBIDDEN => Err(RemoteClientError::Auth),
                s => {
                    let status = s.as_u16();
                    let body = res.text().await.unwrap_or_default();
                    Err(RemoteClientError::Http { status, body })
                }
            }
        };

        operation
            .retry(
                &ExponentialBuilder::default()
                    .with_min_delay(Duration::from_millis(500))
                    .with_max_delay(Duration::from_secs(2))
                    .with_max_times(2)
                    .with_jitter(),
            )
            .when(RemoteClientError::should_retry)
            .notify(|e, dur| {
                warn!(
                    "Remote call failed, retrying after {:.2}s: {}",
                    dur.as_secs_f64(),
                    e
                )
            })
            .await
    }

    // Public endpoint helpers (no auth required)
    async fn get_public<T>(&self, path: &str) -> Result<T, RemoteClientError>
    where
        T: for<'de> Deserialize<'de>,
    {
        let res = self
            .send(reqwest::Method::GET, path, false, None::<&()>)
            .await?;
        res.json::<T>()
            .await
            .map_err(|e| RemoteClientError::Serde(e.to_string()))
    }

    async fn post_public<T, B>(&self, path: &str, body: Option<&B>) -> Result<T, RemoteClientError>
    where
        T: for<'de> Deserialize<'de>,
        B: Serialize,
    {
        let res = self.send(reqwest::Method::POST, path, false, body).await?;
        res.json::<T>()
            .await
            .map_err(|e| RemoteClientError::Serde(e.to_string()))
    }

    // Authenticated endpoint helpers (require token)
    async fn get_authed<T>(&self, path: &str) -> Result<T, RemoteClientError>
    where
        T: for<'de> Deserialize<'de>,
    {
        let res = self
            .send(reqwest::Method::GET, path, true, None::<&()>)
            .await?;
        res.json::<T>()
            .await
            .map_err(|e| RemoteClientError::Serde(e.to_string()))
    }

    pub async fn post_authed<T, B>(
        &self,
        path: &str,
        body: Option<&B>,
    ) -> Result<T, RemoteClientError>
    where
        T: for<'de> Deserialize<'de>,
        B: Serialize,
    {
        let res = self.send(reqwest::Method::POST, path, true, body).await?;
        res.json::<T>()
            .await
            .map_err(|e| RemoteClientError::Serde(e.to_string()))
    }

    async fn patch_authed<T, B>(&self, path: &str, body: &B) -> Result<T, RemoteClientError>
    where
        T: for<'de> Deserialize<'de>,
        B: Serialize,
    {
        let res = self
            .send(reqwest::Method::PATCH, path, true, Some(body))
            .await?;
        res.json::<T>()
            .await
            .map_err(|e| RemoteClientError::Serde(e.to_string()))
    }

    async fn delete_authed(&self, path: &str) -> Result<(), RemoteClientError> {
        self.send(reqwest::Method::DELETE, path, true, None::<&()>)
            .await?;
        Ok(())
    }

    async fn delete_authed_with_body<B>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<(), RemoteClientError>
    where
        B: Serialize,
    {
        self.send(reqwest::Method::DELETE, path, true, Some(body))
            .await?;
        Ok(())
    }

    fn map_api_error(&self, err: RemoteClientError) -> RemoteClientError {
        if let RemoteClientError::Http { body, .. } = &err
            && let Ok(api_err) = serde_json::from_str::<ApiErrorResponse>(body)
        {
            return RemoteClientError::Api(map_error_code(Some(&api_err.error)));
        }
        err
    }

    /// Raw passthrough for the agent-facing cloud proxy: forwards `method` +
    /// `path_and_query` (relative to the API base, e.g. `/v1/notifications`)
    /// with this host's bearer token and returns the upstream status and body
    /// unchanged. Non-2xx upstream replies come back as `Ok` too, so the caller
    /// can relay them verbatim.
    pub async fn proxy_raw(
        &self,
        method: reqwest::Method,
        path_and_query: &str,
        body: Option<Bytes>,
        content_type: Option<&str>,
    ) -> Result<(StatusCode, Bytes), RemoteClientError> {
        let result = self
            .send_internal_with_request(method, path_and_query, true, |req| {
                let mut req = req;
                if let Some(body) = &body {
                    req = req.body(body.clone());
                    if let Some(content_type) = content_type {
                        req = req.header(reqwest::header::CONTENT_TYPE, content_type);
                    }
                }
                req
            })
            .await;
        match result {
            Ok(response) => {
                let status = response.status();
                let bytes = response.bytes().await.map_err(map_reqwest_error)?;
                Ok((status, bytes))
            }
            Err(RemoteClientError::Http { status, body }) => Ok((
                StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
                Bytes::from(body),
            )),
            Err(error) => Err(error),
        }
    }

    /// The signed-in user's cloud notifications, newest first.
    pub async fn list_notifications(
        &self,
        include_dismissed: bool,
    ) -> Result<Vec<api_types::Notification>, RemoteClientError> {
        #[derive(Deserialize)]
        struct ListNotificationsResponse {
            notifications: Vec<api_types::Notification>,
        }
        let response: ListNotificationsResponse = self
            .get_authed(&format!(
                "/v1/notifications?include_dismissed={include_dismissed}"
            ))
            .await?;
        Ok(response.notifications)
    }

    /// Uploads this host's GitHub CLI login so `/v1/github/*` can act with it.
    /// HTTP errors keep their body: the server explains missing scopes or an
    /// account mismatch in it.
    pub async fn register_github_host_credential(
        &self,
        token: &str,
    ) -> Result<GitHubCredentialStatus, RemoteClientError> {
        let request = RegisterGitHubCredentialRequest {
            token: token.to_string(),
        };
        let res = self
            .send(
                reqwest::Method::PUT,
                "/v1/github/credentials",
                true,
                Some(&request),
            )
            .await?;
        res.json::<GitHubCredentialStatus>()
            .await
            .map_err(|e| RemoteClientError::Serde(e.to_string()))
    }

    /// Fetches user profile.
    pub async fn profile(&self) -> Result<ProfileResponse, RemoteClientError> {
        self.get_authed("/v1/profile").await
    }

    /// Revokes the session associated with the token.
    pub async fn logout(&self) -> Result<(), RemoteClientError> {
        self.delete_authed("/v1/oauth/logout").await
    }

    /// Lists organizations for the authenticated user.
    pub async fn list_organizations(&self) -> Result<ListOrganizationsResponse, RemoteClientError> {
        self.get_authed("/v1/organizations").await
    }

    /// Gets a specific organization by ID.
    pub async fn get_organization(
        &self,
        org_id: Uuid,
    ) -> Result<GetOrganizationResponse, RemoteClientError> {
        self.get_authed(&format!("/v1/organizations/{org_id}"))
            .await
    }

    /// Creates a new organization.
    pub async fn create_organization(
        &self,
        request: &CreateOrganizationRequest,
    ) -> Result<CreateOrganizationResponse, RemoteClientError> {
        self.post_authed("/v1/organizations", Some(request)).await
    }

    /// Updates an organization's name.
    pub async fn update_organization(
        &self,
        org_id: Uuid,
        request: &UpdateOrganizationRequest,
    ) -> Result<Organization, RemoteClientError> {
        self.patch_authed(&format!("/v1/organizations/{org_id}"), request)
            .await
    }

    /// Deletes an organization.
    pub async fn delete_organization(&self, org_id: Uuid) -> Result<(), RemoteClientError> {
        self.delete_authed(&format!("/v1/organizations/{org_id}"))
            .await
    }

    /// Creates an invitation to an organization.
    pub async fn create_invitation(
        &self,
        org_id: Uuid,
        request: &CreateInvitationRequest,
    ) -> Result<CreateInvitationResponse, RemoteClientError> {
        self.post_authed(
            &format!("/v1/organizations/{org_id}/invitations"),
            Some(request),
        )
        .await
    }

    /// Lists invitations for an organization.
    pub async fn list_invitations(
        &self,
        org_id: Uuid,
    ) -> Result<ListInvitationsResponse, RemoteClientError> {
        self.get_authed(&format!("/v1/organizations/{org_id}/invitations"))
            .await
    }

    pub async fn revoke_invitation(
        &self,
        org_id: Uuid,
        invitation_id: Uuid,
    ) -> Result<(), RemoteClientError> {
        let body = RevokeInvitationRequest { invitation_id };
        self.send(
            reqwest::Method::POST,
            &format!("/v1/organizations/{org_id}/invitations/revoke"),
            true,
            Some(&body),
        )
        .await?;
        Ok(())
    }

    /// Accepts an invitation.
    pub async fn accept_invitation(
        &self,
        invitation_token: &str,
    ) -> Result<AcceptInvitationResponse, RemoteClientError> {
        self.post_authed(
            &format!("/v1/invitations/{invitation_token}/accept"),
            None::<&()>,
        )
        .await
    }

    /// Lists members of an organization.
    pub async fn list_members(
        &self,
        org_id: Uuid,
    ) -> Result<ListMembersResponse, RemoteClientError> {
        self.get_authed(&format!("/v1/organizations/{org_id}/members"))
            .await
    }

    /// Removes a member from an organization.
    pub async fn remove_member(
        &self,
        org_id: Uuid,
        user_id: Uuid,
    ) -> Result<(), RemoteClientError> {
        self.delete_authed(&format!("/v1/organizations/{org_id}/members/{user_id}"))
            .await
    }

    /// Updates a member's role in an organization.
    pub async fn update_member_role(
        &self,
        org_id: Uuid,
        user_id: Uuid,
        request: &UpdateMemberRoleRequest,
    ) -> Result<UpdateMemberRoleResponse, RemoteClientError> {
        self.patch_authed(
            &format!("/v1/organizations/{org_id}/members/{user_id}/role"),
            request,
        )
        .await
    }

    /// Lists relay hosts visible to the current user.
    pub async fn list_relay_hosts(&self) -> Result<Vec<RelayHost>, RemoteClientError> {
        let response: ListRelayHostsResponse = self.get_authed("/v1/hosts").await?;
        Ok(response.hosts)
    }

    pub async fn upsert_agent_memory_snapshot(
        &self,
        request: &UpsertAgentMemorySnapshotRequest,
    ) -> Result<UpsertAgentMemorySnapshotResponse, RemoteClientError> {
        let response = self
            .send(
                reqwest::Method::PUT,
                "/v1/agent-memory/snapshots",
                true,
                Some(request),
            )
            .await?;
        response
            .json()
            .await
            .map_err(|error| RemoteClientError::Serde(error.to_string()))
    }

    pub async fn agent_memory_inbox(
        &self,
        target_host_id: Uuid,
        target_agent: AgentMemoryKind,
        scope: AgentMemoryScope,
        scope_key: Option<&str>,
    ) -> Result<AgentMemoryInboxResponse, RemoteClientError> {
        let target_agent = enum_query_value(target_agent)?;
        let scope = enum_query_value(scope)?;
        let path = {
            let mut query = url::form_urlencoded::Serializer::new(String::new());
            query.append_pair("target_host_id", &target_host_id.to_string());
            query.append_pair("target_agent", &target_agent);
            query.append_pair("scope", &scope);
            if let Some(scope_key) = scope_key {
                query.append_pair("scope_key", scope_key);
            }
            format!("/v1/agent-memory/inbox?{}", query.finish())
        };
        self.get_authed(&path).await
    }

    pub async fn agent_memory_snapshot(
        &self,
        source_host_id: Uuid,
        source_agent: AgentMemoryKind,
        scope: AgentMemoryScope,
        scope_key: Option<&str>,
    ) -> Result<Option<api_types::AgentMemorySnapshot>, RemoteClientError> {
        let source_agent = enum_query_value(source_agent)?;
        let scope = enum_query_value(scope)?;
        let path = {
            let mut query = url::form_urlencoded::Serializer::new(String::new());
            query.append_pair("source_host_id", &source_host_id.to_string());
            query.append_pair("source_agent", &source_agent);
            query.append_pair("scope", &scope);
            if let Some(scope_key) = scope_key {
                query.append_pair("scope_key", scope_key);
            }
            format!("/v1/agent-memory/snapshots?{}", query.finish())
        };
        match self.get_authed(&path).await {
            Ok(snapshot) => Ok(Some(snapshot)),
            Err(RemoteClientError::Http { status: 404, .. }) => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub async fn record_agent_memory_receipt(
        &self,
        request: &RecordAgentMemoryReceiptRequest,
    ) -> Result<AgentMemoryReceipt, RemoteClientError> {
        self.post_authed("/v1/agent-memory/receipts", Some(request))
            .await
    }

    pub async fn list_agent_memory_mutations(
        &self,
    ) -> Result<Vec<AgentMemoryMutation>, RemoteClientError> {
        self.get_authed("/v1/agent-memory/mutations").await
    }

    pub async fn create_agent_memory_mutation(
        &self,
        request: &CreateAgentMemoryMutationRequest,
    ) -> Result<AgentMemoryMutation, RemoteClientError> {
        self.post_authed("/v1/agent-memory/mutations", Some(request))
            .await
    }

    pub async fn agent_memory_mutation_inbox(
        &self,
        target_host_id: Uuid,
        target_agent: AgentMemoryKind,
        target_scope_key: &str,
        scope: AgentMemoryScope,
        scope_key: Option<&str>,
        include_applied_guards: bool,
    ) -> Result<AgentMemoryMutationInboxResponse, RemoteClientError> {
        let target_agent = enum_query_value(target_agent)?;
        let scope = enum_query_value(scope)?;
        let path = {
            let mut query = url::form_urlencoded::Serializer::new(String::new());
            query.append_pair("target_host_id", &target_host_id.to_string());
            query.append_pair("target_agent", &target_agent);
            query.append_pair("target_scope_key", target_scope_key);
            query.append_pair("scope", &scope);
            query.append_pair(
                "include_applied_guards",
                if include_applied_guards {
                    "true"
                } else {
                    "false"
                },
            );
            if let Some(scope_key) = scope_key {
                query.append_pair("scope_key", scope_key);
            }
            format!("/v1/agent-memory/mutation-inbox?{}", query.finish())
        };
        self.get_authed(&path).await
    }

    pub async fn record_agent_memory_mutation_receipt(
        &self,
        request: &RecordAgentMemoryMutationReceiptRequest,
    ) -> Result<(), RemoteClientError> {
        self.send(
            reqwest::Method::POST,
            "/v1/agent-memory/mutation-receipts",
            true,
            Some(request),
        )
        .await?;
        Ok(())
    }

    pub async fn register_agent_memory_sync_target(
        &self,
        request: &RegisterAgentMemorySyncTargetRequest,
    ) -> Result<AgentMemorySyncTarget, RemoteClientError> {
        let response = self
            .send(
                reqwest::Method::PUT,
                "/v1/agent-memory/sync-targets",
                true,
                Some(request),
            )
            .await?;
        response
            .json()
            .await
            .map_err(|error| RemoteClientError::Serde(error.to_string()))
    }

    pub async fn create_agent_memory_sync_session(
        &self,
        request: &CreateAgentMemorySyncSessionRequest,
    ) -> Result<AgentMemorySyncSession, RemoteClientError> {
        self.post_authed("/v1/agent-memory/sync-sessions", Some(request))
            .await
    }

    pub async fn latest_agent_memory_sync_session(
        &self,
    ) -> Result<Option<AgentMemorySyncSession>, RemoteClientError> {
        self.get_authed("/v1/agent-memory/sync-sessions").await
    }

    pub async fn agent_memory_sync_session_targets(
        &self,
        session_id: Uuid,
    ) -> Result<Vec<AgentMemorySyncSessionTarget>, RemoteClientError> {
        self.get_authed(&format!(
            "/v1/agent-memory/sync-session-targets?session_id={session_id}"
        ))
        .await
    }

    pub async fn claim_agent_memory_sync_job(
        &self,
        host_id: Uuid,
    ) -> Result<Option<AgentMemorySyncJob>, RemoteClientError> {
        self.get_authed(&format!("/v1/agent-memory/sync-jobs?host_id={host_id}"))
            .await
    }

    pub async fn report_agent_memory_sync_job(
        &self,
        request: &ReportAgentMemorySyncJobRequest,
    ) -> Result<AgentMemorySyncSession, RemoteClientError> {
        self.post_authed("/v1/agent-memory/sync-jobs/report", Some(request))
            .await
    }

    /// Deletes a workspace on the remote server by its local workspace ID.
    pub async fn delete_workspace(
        &self,
        local_workspace_id: Uuid,
    ) -> Result<(), RemoteClientError> {
        let host_id = self.current_host_id().await?;
        self.delete_authed_with_body(
            "/v1/workspaces",
            &DeleteWorkspaceRequest {
                local_workspace_id,
                host_id,
            },
        )
        .await
    }

    /// Gets a workspace from the remote server by its local workspace ID.
    pub async fn get_workspace_by_local_id(
        &self,
        local_workspace_id: Uuid,
    ) -> Result<Workspace, RemoteClientError> {
        let host_id = self.current_host_id().await?;
        self.get_authed(&format!(
            "/v1/workspaces/by-local-id/{local_workspace_id}?host_id={host_id}"
        ))
        .await
    }

    /// Checks if a workspace exists on the remote server.
    pub async fn workspace_exists(
        &self,
        local_workspace_id: Uuid,
    ) -> Result<bool, RemoteClientError> {
        let host_id = self.current_host_id().await?;
        match self
            .send(
                reqwest::Method::HEAD,
                &format!("/v1/workspaces/exists/{local_workspace_id}?host_id={host_id}"),
                true,
                None::<&()>,
            )
            .await
        {
            Ok(_) => Ok(true),
            Err(RemoteClientError::Http { status: 404, .. }) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Updates a workspace on the remote server.
    pub async fn update_workspace(
        &self,
        local_workspace_id: Uuid,
        name: Option<Option<String>>,
        archived: Option<bool>,
        files_changed: Option<i32>,
        lines_added: Option<i32>,
        lines_removed: Option<i32>,
    ) -> Result<(), RemoteClientError> {
        let host_id = self.current_host_id().await?;
        self.send(
            reqwest::Method::PATCH,
            "/v1/workspaces",
            true,
            Some(&UpdateWorkspaceRequest {
                local_workspace_id,
                host_id,
                name,
                archived,
                files_changed: files_changed.map(Some),
                lines_added: lines_added.map(Some),
                lines_removed: lines_removed.map(Some),
            }),
        )
        .await?;
        Ok(())
    }

    /// Triggers issue-status sync for a workspace that was merged locally without a PR.
    pub async fn sync_issue_status_from_local_workspace_merge(
        &self,
        local_workspace_id: Uuid,
    ) -> Result<(), RemoteClientError> {
        let host_id = self.current_host_id().await?;
        self.send(
            reqwest::Method::POST,
            &format!("/v1/workspaces/{local_workspace_id}/sync_issue_status_from_local_merge?host_id={host_id}"),
            true,
            None::<&()>,
        )
        .await?;
        Ok(())
    }

    /// Returns true if the workspace's linked issue carries the "vibe" tag and should be auto-merged on completion.
    pub async fn auto_merge_check(
        &self,
        local_workspace_id: Uuid,
    ) -> Result<bool, RemoteClientError> {
        let host_id = self.current_host_id().await?;
        #[derive(serde::Deserialize)]
        struct Resp {
            should_auto_merge: bool,
        }
        let resp: Resp = self
            .get_authed(&format!(
                "/v1/workspaces/{local_workspace_id}/auto_merge_check?host_id={host_id}"
            ))
            .await?;
        Ok(resp.should_auto_merge)
    }

    /// Forces the workspace's linked issue into "In review" — used when auto-merge fails.
    pub async fn mark_workspace_issue_for_review(
        &self,
        local_workspace_id: Uuid,
    ) -> Result<(), RemoteClientError> {
        let host_id = self.current_host_id().await?;
        self.send(
            reqwest::Method::POST,
            &format!("/v1/workspaces/{local_workspace_id}/mark_for_review?host_id={host_id}"),
            true,
            None::<&()>,
        )
        .await?;
        Ok(())
    }

    /// Forces an issue into "In review" by issue id. Used when a review-mode
    /// workspace is created, so the move does not depend on the workspace already
    /// being registered on the remote.
    pub async fn mark_issue_for_review(&self, issue_id: Uuid) -> Result<(), RemoteClientError> {
        self.send(
            reqwest::Method::POST,
            &format!("/v1/issues/{issue_id}/mark_for_review"),
            true,
            None::<&()>,
        )
        .await?;
        Ok(())
    }

    /// Creates a workspace on the remote server, linking it to a local workspace and an issue.
    pub async fn create_workspace(
        &self,
        request: CreateWorkspaceRequest,
    ) -> Result<(), RemoteClientError> {
        self.send(
            reqwest::Method::POST,
            "/v1/workspaces",
            true,
            Some(&request),
        )
        .await?;
        Ok(())
    }

    // ── Issues ──────────────────────────────────────────────────────────

    /// Lists issues for a project.
    pub async fn list_issues(
        &self,
        project_id: Uuid,
    ) -> Result<ListIssuesResponse, RemoteClientError> {
        self.get_authed(&format!("/v1/issues?project_id={project_id}"))
            .await
    }

    /// Searches issues for a project using the canonical JSON request shape.
    pub async fn search_issues(
        &self,
        request: &SearchIssuesRequest,
    ) -> Result<ListIssuesResponse, RemoteClientError> {
        self.post_authed("/v1/issues/search", Some(request)).await
    }

    /// Gets a single issue by ID.
    pub async fn get_issue(&self, issue_id: Uuid) -> Result<Issue, RemoteClientError> {
        self.get_authed(&format!("/v1/issues/{issue_id}")).await
    }

    /// Creates a new issue.
    pub async fn create_issue(
        &self,
        request: &CreateIssueRequest,
    ) -> Result<MutationResponse<Issue>, RemoteClientError> {
        self.post_authed("/v1/issues", Some(request)).await
    }

    /// Updates an existing issue.
    pub async fn update_issue(
        &self,
        issue_id: Uuid,
        request: &UpdateIssueRequest,
    ) -> Result<MutationResponse<Issue>, RemoteClientError> {
        self.patch_authed(&format!("/v1/issues/{issue_id}"), request)
            .await
    }

    /// Deletes an issue.
    pub async fn delete_issue(&self, issue_id: Uuid) -> Result<DeleteResponse, RemoteClientError> {
        let res = self
            .send(
                reqwest::Method::DELETE,
                &format!("/v1/issues/{issue_id}"),
                true,
                None::<&()>,
            )
            .await?;
        res.json::<DeleteResponse>()
            .await
            .map_err(|e| RemoteClientError::Serde(e.to_string()))
    }

    // ── Issue Assignees ────────────────────────────────────────────────

    /// Lists assignees for an issue.
    pub async fn list_issue_assignees(
        &self,
        issue_id: Uuid,
    ) -> Result<ListIssueAssigneesResponse, RemoteClientError> {
        self.get_authed(&format!("/v1/issue_assignees?issue_id={issue_id}"))
            .await
    }

    /// Gets a single issue assignee by ID.
    pub async fn get_issue_assignee(
        &self,
        issue_assignee_id: Uuid,
    ) -> Result<IssueAssignee, RemoteClientError> {
        self.get_authed(&format!("/v1/issue_assignees/{issue_assignee_id}"))
            .await
    }

    /// Creates a new issue assignee.
    pub async fn create_issue_assignee(
        &self,
        request: &CreateIssueAssigneeRequest,
    ) -> Result<MutationResponse<IssueAssignee>, RemoteClientError> {
        self.post_authed("/v1/issue_assignees", Some(request)).await
    }

    /// Deletes an issue assignee.
    pub async fn delete_issue_assignee(
        &self,
        issue_assignee_id: Uuid,
    ) -> Result<DeleteResponse, RemoteClientError> {
        let res = self
            .send(
                reqwest::Method::DELETE,
                &format!("/v1/issue_assignees/{issue_assignee_id}"),
                true,
                None::<&()>,
            )
            .await?;
        res.json::<DeleteResponse>()
            .await
            .map_err(|e| RemoteClientError::Serde(e.to_string()))
    }

    // ── Tags ───────────────────────────────────────────────────────────

    /// Lists tags for a project.
    pub async fn list_tags(&self, project_id: Uuid) -> Result<ListTagsResponse, RemoteClientError> {
        self.get_authed(&format!("/v1/tags?project_id={project_id}"))
            .await
    }

    /// Gets a single tag by ID.
    pub async fn get_tag(&self, tag_id: Uuid) -> Result<Tag, RemoteClientError> {
        self.get_authed(&format!("/v1/tags/{tag_id}")).await
    }

    /// Creates a new tag in a project.
    pub async fn create_tag(
        &self,
        request: &CreateTagRequest,
    ) -> Result<MutationResponse<Tag>, RemoteClientError> {
        self.post_authed("/v1/tags", Some(request)).await
    }

    // ── Issue Tags ─────────────────────────────────────────────────────

    /// Lists tags attached to an issue.
    pub async fn list_issue_tags(
        &self,
        issue_id: Uuid,
    ) -> Result<ListIssueTagsResponse, RemoteClientError> {
        self.get_authed(&format!("/v1/issue_tags?issue_id={issue_id}"))
            .await
    }

    /// Gets a single issue-tag relation by ID.
    pub async fn get_issue_tag(&self, issue_tag_id: Uuid) -> Result<IssueTag, RemoteClientError> {
        self.get_authed(&format!("/v1/issue_tags/{issue_tag_id}"))
            .await
    }

    /// Attaches a tag to an issue.
    pub async fn create_issue_tag(
        &self,
        request: &CreateIssueTagRequest,
    ) -> Result<MutationResponse<IssueTag>, RemoteClientError> {
        self.post_authed("/v1/issue_tags", Some(request)).await
    }

    /// Removes a tag from an issue.
    pub async fn delete_issue_tag(
        &self,
        issue_tag_id: Uuid,
    ) -> Result<DeleteResponse, RemoteClientError> {
        let res = self
            .send(
                reqwest::Method::DELETE,
                &format!("/v1/issue_tags/{issue_tag_id}"),
                true,
                None::<&()>,
            )
            .await?;
        res.json::<DeleteResponse>()
            .await
            .map_err(|e| RemoteClientError::Serde(e.to_string()))
    }

    // ── Issue Relationships ────────────────────────────────────────────

    /// Lists relationships for an issue (outgoing; `issue_id = $1`).
    pub async fn list_issue_relationships(
        &self,
        issue_id: Uuid,
    ) -> Result<ListIssueRelationshipsResponse, RemoteClientError> {
        self.get_authed(&format!("/v1/issue_relationships?issue_id={issue_id}"))
            .await
    }

    /// Lists relationships that target the given issue (`related_issue_id = $1`).
    /// Used to discover the blockers of an issue.
    pub async fn list_issue_relationships_incoming(
        &self,
        issue_id: Uuid,
    ) -> Result<ListIssueRelationshipsResponse, RemoteClientError> {
        self.get_authed(&format!(
            "/v1/issue_relationships?issue_id={issue_id}&direction=incoming"
        ))
        .await
    }

    /// Creates a new issue relationship.
    pub async fn create_issue_relationship(
        &self,
        request: &CreateIssueRelationshipRequest,
    ) -> Result<MutationResponse<IssueRelationship>, RemoteClientError> {
        self.post_authed("/v1/issue_relationships", Some(request))
            .await
    }

    /// Deletes an issue relationship.
    pub async fn delete_issue_relationship(
        &self,
        relationship_id: Uuid,
    ) -> Result<(), RemoteClientError> {
        self.delete_authed(&format!("/v1/issue_relationships/{relationship_id}"))
            .await
    }

    // ── Remote Projects ─────────────────────────────────────────────────

    /// Gets a single remote project by ID.
    pub async fn get_remote_project(
        &self,
        project_id: Uuid,
    ) -> Result<api_types::Project, RemoteClientError> {
        self.get_authed(&format!("/v1/projects/{project_id}")).await
    }

    /// Lists projects for an organization.
    pub async fn list_remote_projects(
        &self,
        organization_id: Uuid,
    ) -> Result<ListProjectsResponse, RemoteClientError> {
        self.get_authed(&format!("/v1/projects?organization_id={organization_id}"))
            .await
    }

    // ── Project Statuses ────────────────────────────────────────────────

    /// Lists project statuses for a project (used for status name ↔ UUID mapping).
    pub async fn list_project_statuses(
        &self,
        project_id: Uuid,
    ) -> Result<ListProjectStatusesResponse, RemoteClientError> {
        self.get_authed(&format!("/v1/project_statuses?project_id={project_id}"))
            .await
    }

    // ── Pull Requests ───────────────────────────────────────────────────

    /// Upserts a pull request on the remote server.
    /// Creates if not exists, updates if exists.
    pub async fn upsert_pull_request(
        &self,
        mut request: UpsertPullRequestRequest,
    ) -> Result<(), RemoteClientError> {
        request.host_id = Some(self.current_host_id().await?);
        self.send(
            reqwest::Method::PUT,
            "/v1/pull_requests",
            true,
            Some(&request),
        )
        .await?;
        Ok(())
    }

    /// Updates a pull request status on the remote server.
    pub async fn update_pull_request(
        &self,
        request: UpdatePullRequestApiRequest,
    ) -> Result<PullRequest, RemoteClientError> {
        let response: MutationResponse<PullRequest> =
            self.patch_authed("/v1/pull_requests", &request).await?;
        Ok(response.data)
    }

    /// Lists pull requests linked to an issue.
    pub async fn list_pull_requests(
        &self,
        issue_id: Uuid,
    ) -> Result<ListPullRequestsResponse, RemoteClientError> {
        self.get_authed(&format!("/v1/pull_requests?issue_id={issue_id}"))
            .await
    }

    /// Lists attachments for an issue on the remote server.
    pub async fn list_issue_attachments(
        &self,
        issue_id: Uuid,
    ) -> Result<ListAttachmentsResponse, RemoteClientError> {
        self.get_authed(&format!("/v1/issues/{issue_id}/attachments"))
            .await
    }

    /// Used for fetching from presigned Azure SAS URLs.
    pub async fn download_from_url(&self, url: &str) -> Result<Vec<u8>, RemoteClientError> {
        let res = self.http.get(url).send().await.map_err(map_reqwest_error)?;
        if !res.status().is_success() {
            return Err(RemoteClientError::Http {
                status: res.status().as_u16(),
                body: res.text().await.unwrap_or_default(),
            });
        }
        let bytes = res
            .bytes()
            .await
            .map_err(|e| RemoteClientError::Transport(e.to_string()))?;
        Ok(bytes.to_vec())
    }
}

fn map_reqwest_error(e: reqwest::Error) -> RemoteClientError {
    if e.is_timeout() {
        RemoteClientError::Timeout
    } else {
        RemoteClientError::Transport(e.to_string())
    }
}

fn enum_query_value(value: impl Serialize) -> Result<String, RemoteClientError> {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(|| RemoteClientError::Serde("invalid enum query value".to_string()))
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use axum::{Json, Router, http::StatusCode, response::IntoResponse, routing::post};
    use tokio::sync::{Notify, RwLock};

    use super::*;
    use crate::services::oauth_credentials::OAuthCredentials;

    // exp = 2100-01-01; the client only decodes claims, not the signature.
    const NEW_ACCESS: &str = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjQxMDI0NDQ4MDB9.sig";

    fn rotated() -> axum::response::Response {
        Json(TokenRefreshResponse {
            access_token: NEW_ACCESS.into(),
            refresh_token: "rotated".into(),
        })
        .into_response()
    }

    /// A client whose saved session needs a refresh, against `router`.
    async fn client_needing_refresh(router: Router) -> (RemoteClient, tempfile::TempDir) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

        let dir = tempfile::tempdir().unwrap();
        let auth = AuthContext::new(
            Arc::new(OAuthCredentials::new(dir.path().join("credentials.json"))),
            Arc::new(RwLock::new(None)),
        );
        auth.save_credentials(&Credentials {
            access_token: None,
            refresh_token: "old".into(),
            expires_at: None,
        })
        .await
        .unwrap();
        let client = RemoteClient::new(&format!("http://{address}"), auth, "test".into()).unwrap();
        (client, dir)
    }

    fn spawn_access_token(
        client: &RemoteClient,
    ) -> tokio::task::JoinHandle<Result<String, RemoteClientError>> {
        let client = client.clone();
        tokio::spawn(async move { client.access_token().await })
    }

    // Regression: a caller dropped mid-refresh used to lose the rotated token;
    // the next refresh resent the old one and the server revoked the session.
    #[tokio::test]
    async fn refresh_survives_dropped_caller() {
        let received = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let calls = Arc::new(AtomicUsize::new(0));
        let (handler_received, handler_release, handler_calls) =
            (received.clone(), release.clone(), calls.clone());
        let router = Router::new().route(
            "/v1/tokens/refresh",
            post(move |Json(request): Json<TokenRefreshRequest>| async move {
                assert_eq!(request.refresh_token, "old");
                // Like the cloud: the rotation is committed before replying, so
                // a second "old" is reuse.
                if handler_calls.fetch_add(1, Ordering::SeqCst) > 0 {
                    return (
                        StatusCode::UNAUTHORIZED,
                        Json(serde_json::json!({ "error": "token_reuse_detected" })),
                    )
                        .into_response();
                }
                handler_received.notify_one();
                handler_release.notified().await;
                rotated()
            }),
        );
        let (client, dir) = client_needing_refresh(router).await;

        let dropped = spawn_access_token(&client);
        received.notified().await;
        dropped.abort();
        assert!(dropped.await.unwrap_err().is_cancelled());

        // A concurrent caller joins the refresh still in flight instead of
        // sending "old" again.
        let waiting = spawn_access_token(&client);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!waiting.is_finished());
        release.notify_one();
        assert_eq!(waiting.await.unwrap().unwrap(), NEW_ACCESS);

        assert_eq!(client.access_token().await.unwrap(), NEW_ACCESS);
        let saved = client.auth_context.get_credentials().await.unwrap();
        assert_eq!(saved.refresh_token, "rotated");
        let on_disk = std::fs::read_to_string(dir.path().join("credentials.json")).unwrap();
        assert!(on_disk.contains("rotated"));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    // Callers in the same flight share its failure instead of each retrying;
    // a finished flight is never reused by later callers.
    #[tokio::test]
    async fn failed_refresh_is_shared_then_retried_fresh() {
        let release = Arc::new(Notify::new());
        let calls = Arc::new(AtomicUsize::new(0));
        let (handler_release, handler_calls) = (release.clone(), calls.clone());
        let router = Router::new().route(
            "/v1/tokens/refresh",
            post(move || async move {
                if handler_calls.fetch_add(1, Ordering::SeqCst) > 0 {
                    return rotated();
                }
                handler_release.notified().await;
                (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "error": "temporary" })),
                )
                    .into_response()
            }),
        );
        let (client, _dir) = client_needing_refresh(router).await;

        let first = spawn_access_token(&client);
        let second = spawn_access_token(&client);
        tokio::time::sleep(Duration::from_millis(50)).await;
        release.notify_one();
        for caller in [first, second] {
            let error = caller.await.unwrap().unwrap_err();
            assert!(matches!(error, RemoteClientError::Api(_)), "{error:?}");
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // A non-definitive failure keeps the session.
        assert!(client.auth_context.get_credentials().await.is_some());

        assert_eq!(client.access_token().await.unwrap(), NEW_ACCESS);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}
