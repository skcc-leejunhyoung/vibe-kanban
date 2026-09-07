use api_types::{
    AuthMethodsResponse, GitHubCredentialStatus, HandoffInitRequest, HandoffInitResponse,
    HandoffRedeemRequest, LocalLoginRequest, ProfileResponse, StatusResponse,
};
use axum::{
    Router,
    extract::{Json, Query, State},
    http::{Response, StatusCode},
    response::Json as ResponseJson,
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use deployment::Deployment;
use git_host::github::GhCliError;
use local_deployment::PendingHandoff;
use rand::{Rng, distributions::Alphanumeric};
use serde::{Deserialize, Serialize};
use services::services::{
    auth::AuthContext,
    github_host_credential::{self, GitHubHostCredentialError},
    oauth_credentials::Credentials,
    remote_client::RemoteClient,
    remote_sync,
};
use sha2::{Digest, Sha256};
use ts_rs::TS;
use utils::{
    jwt::{extract_expiration, extract_subject},
    response::ApiResponse,
};
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError, runtime::relay_registration};

/// Base64-encoded 32x32 app icon (from `crates/tauri-app/icons/32x32.png`).
const APP_ICON_BASE64: &str = "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";

/// Shared CSS styles for standalone OAuth HTML pages (success & error).
/// Colors and typography match the app's design system (light mode defaults
/// from `packages/web-core/src/app/styles/new/index.css`).
const AUTH_PAGE_STYLES: &str = r#"<style>
  /* No web-font @import: this standalone page must not phone a third party
     (e.g. fonts.googleapis.com). Use a locally-installed Pretendard if present,
     otherwise the OS system font. */
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Pretendard Variable', 'Pretendard', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f2f2f2;
    color: #333;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .container {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 24px;
    padding: 24px;
  }
  .logo { width: 40px; height: 40px; }
  .content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }
  .title {
    font-size: 13px;
    font-weight: 500;
    color: #0d0d0d;
  }
  .subtitle {
    font-size: 12px;
    color: #636363;
  }
</style>"#;

/// Response from GET /api/auth/token - returns the current access token
#[derive(Debug, Serialize, TS)]
pub struct TokenResponse {
    pub access_token: String,
    pub expires_at: Option<DateTime<Utc>>,
}

/// Response from GET /api/auth/user - returns the current user ID
#[derive(Debug, Serialize, TS)]
pub struct CurrentUserResponse {
    pub user_id: String,
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/auth/methods", get(auth_methods))
        .route("/auth/handoff/init", post(handoff_init))
        .route("/auth/handoff/cancel", post(handoff_cancel))
        .route("/auth/github-credential/sync", post(github_credential_sync))
        .route("/auth/handoff/complete", get(handoff_complete))
        .route("/auth/handoff/status", get(handoff_status))
        .route("/auth/local/login", post(local_login))
        .route("/auth/logout", post(logout))
        .route("/auth/status", get(status))
        .route("/auth/token", get(get_token))
        .route("/auth/user", get(get_current_user))
}

async fn auth_methods(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<AuthMethodsResponse>>, ApiError> {
    let client = deployment.remote_client()?;
    let methods = client.auth_methods().await?;
    Ok(ResponseJson(ApiResponse::success(methods)))
}

#[derive(Debug, Deserialize)]
struct HandoffInitPayload {
    provider: String,
    return_to: String,
    #[serde(default)]
    reauthenticate: bool,
}

#[derive(Debug, Serialize)]
struct HandoffInitResponseBody {
    handoff_id: Uuid,
    authorize_url: String,
}

async fn handoff_init(
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<HandoffInitPayload>,
) -> Result<ResponseJson<ApiResponse<HandoffInitResponseBody>>, ApiError> {
    let client = deployment.remote_client()?;
    let (response, handoff) =
        initiate_local_handoff(&client, deployment.auth_context(), payload).await?;
    deployment
        .store_oauth_handoff(response.handoff_id, handoff)
        .await;
    Ok(ResponseJson(ApiResponse::success(
        HandoffInitResponseBody {
            handoff_id: response.handoff_id,
            authorize_url: response.authorize_url,
        },
    )))
}

async fn initiate_local_handoff(
    client: &RemoteClient,
    auth: &AuthContext,
    payload: HandoffInitPayload,
) -> Result<(HandoffInitResponse, PendingHandoff), ApiError> {
    let app_verifier = generate_secret();
    let app_challenge = hash_sha256_hex(&app_verifier);

    let request = HandoffInitRequest {
        provider: payload.provider.clone(),
        return_to: payload.return_to.clone(),
        app_challenge,
    };

    // Read the stored refresh credential directly: ordinary access-token refresh
    // can fail precisely because the GitHub credential needs reconnecting.
    let (reconnect_credentials, reconnect_guard) = if payload.reauthenticate {
        // Protect atomically with reading the credential, BEFORE the init HTTP
        // request: a background refresh may already be awaiting its response.
        let (creds, guard) = auth.begin_reconnect().await.ok_or(ApiError::Unauthorized)?;
        (Some(creds), Some(guard))
    } else {
        (None, None)
    };
    let reconnect_user_id = reconnect_credentials
        .as_ref()
        .map(|creds| extract_subject(&creds.refresh_token).map_err(|_| ApiError::Unauthorized))
        .transpose()?;
    let response = client
        .handoff_init(
            &request,
            reconnect_credentials
                .as_ref()
                .map(|creds| creds.refresh_token.as_str()),
        )
        .await?;

    Ok((
        response,
        PendingHandoff {
            provider: payload.provider,
            app_verifier,
            reconnect_user_id,
            reconnect_guard,
        },
    ))
}

#[derive(Debug, Deserialize)]
struct HandoffCompleteQuery {
    handoff_id: Uuid,
    #[serde(default)]
    app_code: Option<String>,
    #[serde(default)]
    error: Option<String>,
    /// When set to "desktop", the callback page will not auto-close so the user
    /// can see the success message (e.g. when opened from the Tauri desktop app).
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    reauthenticate: bool,
}

#[derive(Debug, Deserialize)]
struct HandoffStatusQuery {
    handoff_id: Uuid,
}

#[derive(Debug, Serialize)]
struct HandoffStatusResponse {
    completed: bool,
}

async fn handoff_complete(
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<HandoffCompleteQuery>,
) -> Result<Response<String>, ApiError> {
    // Taking the handoff here also releases reconnect protection on provider
    // errors or malformed callbacks, not just successful redemptions.
    let handoff = deployment.take_oauth_handoff(&query.handoff_id).await;
    if let Some(error) = query.error {
        return Ok(simple_html_response(
            StatusCode::BAD_REQUEST,
            format!("OAuth authorization failed: {error}"),
        ));
    }

    let Some(app_code) = query.app_code.clone() else {
        return Ok(simple_html_response(
            StatusCode::BAD_REQUEST,
            "Missing app_code in callback".to_string(),
        ));
    };

    let handoff = match handoff {
        Some(state) => state,
        None => {
            tracing::warn!(
                handoff_id = %query.handoff_id,
                "received callback for unknown handoff"
            );
            return Ok(simple_html_response(
                StatusCode::BAD_REQUEST,
                "OAuth handoff not found or already completed".to_string(),
            ));
        }
    };

    // Use server-side handoff state, never the callback's query flag, as the
    // authority for reconnect. Reject account changes before redeeming too.
    if let Some(user_id) = handoff.reconnect_user_id {
        let current = deployment.auth_context().get_credentials().await;
        if current
            .as_ref()
            .and_then(|creds| extract_subject(&creds.refresh_token).ok())
            != Some(user_id)
        {
            return Err(ApiError::Conflict(
                "Account changed during GitHub reconnect. Please start again.".into(),
            ));
        }
    }

    let client = deployment.remote_client()?;

    let redeem_request = HandoffRedeemRequest {
        handoff_id: query.handoff_id,
        app_code,
        app_verifier: handoff.app_verifier,
    };

    let redeem = client.handoff_redeem(&redeem_request).await?;

    finalize_login(
        &deployment,
        Credentials {
            access_token: Some(redeem.access_token.clone()),
            refresh_token: redeem.refresh_token.clone(),
            expires_at: None,
        },
        handoff.reconnect_user_id,
    )
    .await?;

    if handoff.reconnect_user_id.is_some() || query.reauthenticate {
        deployment
            .mark_oauth_handoff_completed(query.handoff_id)
            .await;
    }

    let is_desktop = query.source.as_deref() == Some("desktop");
    Ok(close_window_response(
        format!(
            "Signed in with {}. You can return to the app.",
            handoff.provider
        ),
        is_desktop,
    ))
}

async fn handoff_cancel(
    State(deployment): State<DeploymentImpl>,
    Json(query): Json<HandoffStatusQuery>,
) -> StatusCode {
    deployment.take_oauth_handoff(&query.handoff_id).await;
    StatusCode::NO_CONTENT
}

/// Upload this host's `gh` login as the account's central GitHub credential.
async fn github_credential_sync(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<GitHubCredentialStatus>>, ApiError> {
    let client = deployment.remote_client()?;
    let status = github_host_credential::sync(&client)
        .await
        .map_err(|error| match error {
            GitHubHostCredentialError::Gh(GhCliError::NotAvailable) => {
                ApiError::BadRequest("GitHub CLI (gh) is not installed on this host.".to_string())
            }
            GitHubHostCredentialError::Gh(GhCliError::AuthFailed(_)) => ApiError::BadRequest(
                "GitHub CLI is not signed in on this host. Run `gh auth login` first.".to_string(),
            ),
            GitHubHostCredentialError::Gh(error) => ApiError::BadRequest(error.to_string()),
            GitHubHostCredentialError::Remote(error) => ApiError::RemoteClient(error),
        })?;
    Ok(ResponseJson(ApiResponse::success(status)))
}

async fn handoff_status(
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<HandoffStatusQuery>,
) -> ResponseJson<ApiResponse<HandoffStatusResponse>> {
    let completed = deployment
        .take_completed_oauth_handoff(&query.handoff_id)
        .await;
    ResponseJson(ApiResponse::success(HandoffStatusResponse { completed }))
}

async fn local_login(
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<LocalLoginRequest>,
) -> Result<ResponseJson<ApiResponse<ProfileResponse>>, ApiError> {
    let client = deployment.remote_client()?;
    let response = client.local_login(&payload).await?;
    let profile = finalize_login(
        &deployment,
        Credentials {
            access_token: Some(response.access_token),
            refresh_token: response.refresh_token,
            expires_at: None,
        },
        None,
    )
    .await?;

    Ok(ResponseJson(ApiResponse::success(profile)))
}

async fn logout(State(deployment): State<DeploymentImpl>) -> Result<StatusCode, ApiError> {
    let auth_context = deployment.auth_context();

    if let Ok(client) = deployment.remote_client() {
        let _ = client.logout().await;
    }

    auth_context.clear_credentials().await.map_err(|e| {
        tracing::error!(?e, "failed to clear credentials");
        ApiError::Io(e)
    })?;

    auth_context.clear_profile().await;

    relay_registration::stop_relay(&deployment).await;

    Ok(StatusCode::NO_CONTENT)
}

async fn status(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<StatusResponse>>, ApiError> {
    use api_types::LoginStatus;

    let login_status = deployment.get_login_status().await;
    let degraded = deployment
        .auth_context()
        .remote_auth_degraded_slug()
        .await
        .map(|_| true);

    match login_status {
        LoginStatus::LoggedOut => Ok(ResponseJson(ApiResponse::success(StatusResponse {
            logged_in: false,
            profile: None,
            degraded,
        }))),
        LoginStatus::LoggedIn { profile } => {
            Ok(ResponseJson(ApiResponse::success(StatusResponse {
                logged_in: true,
                profile,
                degraded,
            })))
        }
    }
}

/// Returns the current access token (auto-refreshes if needed)
async fn get_token(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<TokenResponse>>, ApiError> {
    let remote_client = deployment.remote_client()?;

    // This will auto-refresh the token if expired
    let access_token = remote_client.access_token().await.map_err(ApiError::from)?;

    let creds = deployment.auth_context().get_credentials().await;
    let expires_at = creds.and_then(|c| c.expires_at);

    Ok(ResponseJson(ApiResponse::success(TokenResponse {
        access_token,
        expires_at,
    })))
}

async fn get_current_user(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<CurrentUserResponse>>, ApiError> {
    let remote_client = deployment.remote_client()?;

    // Get the access token from remote client
    let access_token = remote_client.access_token().await.map_err(ApiError::from)?;

    // Extract user ID from the JWT token's 'sub' claim
    let user_id = utils::jwt::extract_subject(&access_token)
        .map_err(|e| {
            tracing::error!("Failed to extract user ID from token: {}", e);
            ApiError::Unauthorized
        })?
        .to_string();

    Ok(ResponseJson(ApiResponse::success(CurrentUserResponse {
        user_id,
    })))
}

fn generate_secret() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(64)
        .map(char::from)
        .collect()
}

async fn finalize_login(
    deployment: &DeploymentImpl,
    mut credentials: Credentials,
    reconnect_user_id: Option<Uuid>,
) -> Result<ProfileResponse, ApiError> {
    let access_token = credentials
        .access_token
        .as_ref()
        .ok_or_else(|| ApiError::BadRequest("Missing access token".to_string()))?;
    let expires_at = extract_expiration(access_token)
        .map_err(|err| ApiError::BadRequest(format!("Invalid access token: {err}")))?;
    credentials.expires_at = Some(expires_at);

    let auth = deployment.auth_context();
    if let Some(user_id) = reconnect_user_id {
        if !auth
            .save_reconnected_credentials(&credentials, user_id)
            .await?
        {
            return Err(ApiError::Conflict(
                "Account changed during GitHub reconnect. Your current account has not changed."
                    .into(),
            ));
        }
    } else {
        auth.save_credentials(&credentials).await?;
    }
    auth.clear_profile().await;

    let profile = match deployment.get_login_status().await {
        api_types::LoginStatus::LoggedIn {
            profile: Some(profile),
        } => profile,
        api_types::LoginStatus::LoggedIn { profile: None } | api_types::LoginStatus::LoggedOut => {
            return Err(ApiError::Unauthorized);
        }
    };

    if let Ok(client) = deployment.remote_client() {
        let pool = deployment.db().pool.clone();
        let git = deployment.git().clone();
        tokio::spawn(async move {
            remote_sync::sync_all_linked_workspaces(&client, &pool, &git).await;
        });
    }

    deployment.trigger_pr_sync();

    let relay_deployment = deployment.clone();
    tokio::spawn(async move {
        relay_registration::spawn_relay(&relay_deployment).await;
    });

    if let Ok(client) = deployment.remote_client() {
        tokio::spawn(github_host_credential::sync_in_background(
            client,
            std::time::Duration::ZERO,
        ));
    }

    Ok(profile)
}

fn hash_sha256_hex(input: &str) -> String {
    let mut output = String::with_capacity(64);
    let digest = Sha256::digest(input.as_bytes());
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(output, "{:02x}", byte);
    }
    output
}

fn simple_html_response(status: StatusCode, message: String) -> Response<String> {
    let body = format!(
        r#"<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>OAuth Error</title>
    {AUTH_PAGE_STYLES}
  </head>
  <body>
    <div class="container">
      <img class="logo" src="data:image/png;base64,{APP_ICON_BASE64}" alt="Vibe Kanban">
      <div class="content">
        <p class="title">{message}</p>
        <p class="subtitle">Please close this tab and try again.</p>
      </div>
    </div>
  </body>
</html>"#
    );
    Response::builder()
        .status(status)
        .header("content-type", "text/html; charset=utf-8")
        .body(body)
        .unwrap()
}

fn close_window_response(message: String, skip_auto_close: bool) -> Response<String> {
    let script = if skip_auto_close {
        "" // Desktop app: leave the tab open so the user sees the message
    } else {
        "<script>\
           window.addEventListener('load', () => {\
             try { window.close(); } catch (err) {}\
             setTimeout(() => { window.close(); }, 150);\
           });\
         </script>"
    };
    let body = format!(
        r#"<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Authentication Complete</title>
    {script}
    {AUTH_PAGE_STYLES}
  </head>
  <body>
    <div class="container">
      <img class="logo" src="data:image/png;base64,{APP_ICON_BASE64}" alt="Vibe Kanban">
      <div class="content">
        <p class="title">{message}</p>
        <p class="subtitle">You can close this tab and return to the app.</p>
      </div>
    </div>
  </body>
</html>"#
    );

    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/html; charset=utf-8")
        .body(body)
        .unwrap()
}

#[cfg(test)]
#[path = "oauth_tests.rs"]
mod tests;
