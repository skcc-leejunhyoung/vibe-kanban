use std::time::Duration;

use api_types::MutationResponse;
use base64::{Engine, engine::general_purpose::STANDARD};
use deployment::Deployment;
use relay_control::{
    account,
    account_registration::{self as storage, AccountRegistrationFile},
    account_sessions::LeaseRequestTime,
};
use relay_types::*;
use serde::{Serialize, de::DeserializeOwned};
use tokio_util::sync::CancellationToken;
use utils::assets::account_host_registration_path;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

pub fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("account HTTP client")
}

async fn decode<T: DeserializeOwned>(response: reqwest::Response) -> Result<T, ApiError> {
    let status = response.status();
    if !status.is_success() {
        let message = response
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_owned))
            .unwrap_or_else(|| "Central account service unavailable".into());
        return Err(match status.as_u16() {
            401 => ApiError::Unauthorized,
            403 => ApiError::Forbidden(message),
            409 => ApiError::Conflict(message),
            _ => ApiError::BadGateway(message),
        });
    }
    response
        .json()
        .await
        .map_err(|_| ApiError::BadGateway("Invalid central response".into()))
}

pub async fn host_post<T: DeserializeOwned>(
    state: &AccountRegistrationFile,
    path: &str,
    payload: &impl Serialize,
) -> Result<T, ApiError> {
    let response = http()
        .post(format!("{}{path}", state.api_base.trim_end_matches('/')))
        .bearer_auth(&state.request.credential)
        .json(payload)
        .send()
        .await
        .map_err(|_| ApiError::BadGateway("Central account service unavailable".into()))?;
    decode(response).await
}

pub async fn register(
    deployment: &DeploymentImpl,
    replace: bool,
) -> Result<AccountHostRegistration, ApiError> {
    let _guard = deployment.relay_control().account_update_lock.lock().await;
    let path = account_host_registration_path();
    let mut state = if let Some(state) = storage::read(&path)? {
        state
    } else {
        let api_base = deployment
            .remote_info()
            .get_api_base()
            .ok_or("Central server is not configured")?;
        let relay_base = deployment
            .remote_info()
            .get_relay_api_base()
            .ok_or("Relay is not configured")?;
        // Check feature availability before permanently locking legacy access.
        let keys: HostGrantKeys = decode(
            http()
                .get(format!(
                    "{}/v1/host-grant-keys",
                    api_base.trim_end_matches('/')
                ))
                .send()
                .await
                .map_err(|_| ApiError::BadGateway("Central server unavailable".into()))?,
        )
        .await?;
        if keys.issuer.trim_end_matches('/') != api_base.trim_end_matches('/') {
            return Err(ApiError::BadGateway(
                "Central grant issuer does not match the configured server".into(),
            ));
        }
        let name = super::relay_registration::clean_host_nickname(
            &*deployment.config().read().await,
            deployment.user_id(),
        );
        AccountRegistrationFile {
            api_base,
            relay_base,
            request: RegisterAccountHostRequest {
                request_id: Uuid::new_v4(),
                expected_generation: None,
                machine_id: deployment.user_id().into(),
                name,
                credential: account::new_credential(),
                capabilities: vec![ACCOUNT_PROTOCOL.into(), "relay-stream-revocation-v1".into()],
            },
            registration: None,
            rotated_at: chrono::Utc::now().timestamp(),
            pending_rotation: None,
        }
    };
    if replace && let Some(registration) = state.registration.take() {
        state.request.expected_generation = Some(registration.generation);
        state.request.request_id = Uuid::new_v4();
        state.request.credential = account::new_credential();
        state.pending_rotation = None;
        state.rotated_at = chrono::Utc::now().timestamp();
    }
    // Persist lockout before central migration; retries use this exact request.
    storage::write(&path, &state)?;
    deployment.relay_signing().lock_account_mode().await;
    deployment.relay_control().stop().await;
    if let Some(webrtc) = deployment.webrtc_host() {
        webrtc.close_all().await;
    }
    if state.registration.is_none() {
        let token = deployment.remote_client()?.access_token().await?;
        let response = http()
            .post(format!(
                "{}/v1/hosts/register",
                state.api_base.trim_end_matches('/')
            ))
            .bearer_auth(token)
            .json(&state.request)
            .send()
            .await
            .map_err(|_| {
                ApiError::BadGateway("Central server unavailable; retry registration".into())
            })?;
        let result: MutationResponse<AccountHostRegistration> = decode(response).await?;
        state.registration = Some(result.data);
        storage::write(&path, &state)?;
    }
    let registration = activate(&mut state).await?;
    storage::write(&path, &state)?;
    Ok(registration)
}

pub async fn activate(
    state: &mut AccountRegistrationFile,
) -> Result<AccountHostRegistration, ApiError> {
    let registration = state
        .registration
        .as_ref()
        .ok_or("Host registration needs owner login")?;
    let request = ActivateAccountHostRequest {
        transition_request_id: registration.transition_request_id,
        generation: registration.generation,
        capabilities: state.request.capabilities.clone(),
    };
    let result: MutationResponse<AccountHostRegistration> =
        host_post(state, "/v1/host-credentials/activate", &request).await?;
    state.registration = Some(result.data.clone());
    Ok(result.data)
}

pub async fn start_session(
    deployment: &DeploymentImpl,
    request: StartAccountSessionRequest,
) -> Result<StartAccountSessionResponse, ApiError> {
    let state = storage::read(&account_host_registration_path())?.ok_or(ApiError::Unauthorized)?;
    let registration = state.registration.as_ref().ok_or(ApiError::Unauthorized)?;
    let keys: HostGrantKeys = decode(
        http()
            .get(format!(
                "{}/v1/host-grant-keys",
                state.api_base.trim_end_matches('/')
            ))
            .send()
            .await
            .map_err(|_| ApiError::BadGateway("Central server unavailable".into()))?,
    )
    .await?;
    let claims = account::verify_grant(
        &request.grant,
        &keys,
        state.api_base.trim_end_matches('/'),
        registration.host_id,
        registration.generation,
        chrono::Utc::now().timestamp(),
    )
    .map_err(|_| ApiError::Unauthorized)?;
    account::verify_session_proof(&request.grant, &request.proof_b64, &claims)
        .map_err(|_| ApiError::Unauthorized)?;
    let started = LeaseRequestTime::now();
    let renewed: RenewHostConnectionsResponse = host_post(
        &state,
        "/v1/host-connections/renew",
        &RenewHostConnectionsRequest {
            connections: vec![claims.jti],
        },
    )
    .await?;
    let lease = renewed
        .leases
        .into_iter()
        .find(|l| {
            l.connection_id == claims.jti
                && l.user_id == claims.user_id
                && l.auth_session_id == claims.auth_session_id
                && l.public_key_b64 == claims.public_key_b64
                && l.host_generation == claims.host_generation
                && l.grant_version == claims.grant_version
        })
        .ok_or_else(|| ApiError::Forbidden("Host access was revoked".into()))?;
    deployment
        .relay_signing()
        .register_account_session(lease, started)
        .await
        .map_err(|_| ApiError::Unauthorized)?;
    Ok(StartAccountSessionResponse {
        signing_session_id: claims.jti,
        server_public_key_b64: STANDARD
            .encode(deployment.relay_signing().server_public_key().as_bytes()),
    })
}

async fn rotate_if_due(deployment: &DeploymentImpl) -> Result<(), ApiError> {
    let _guard = deployment.relay_control().account_update_lock.lock().await;
    let path = account_host_registration_path();
    let Some(mut state) = storage::read(&path)? else {
        return Ok(());
    };
    if state.pending_rotation.is_none()
        && chrono::Utc::now().timestamp() - state.rotated_at < 30 * 86400
    {
        return Ok(());
    }
    if state.pending_rotation.is_none() {
        state.pending_rotation = Some(RotateHostCredentialRequest {
            request_id: Uuid::new_v4(),
            credential: account::new_credential(),
        });
        storage::write(&path, &state)?;
    }
    let pending = state.pending_rotation.clone().unwrap();
    let result: Result<MutationResponse<Uuid>, _> =
        host_post(&state, "/v1/host-credentials/rotate", &pending).await;
    if result.is_err() {
        // A lost reply may outlive the 2-minute handoff. Probe the durably saved
        // successor, never invent a third secret or fall back to a user token.
        let mut successor = state.clone();
        successor.request.credential = pending.credential.clone();
        let _: RenewHostConnectionsResponse = host_post(
            &successor,
            "/v1/host-connections/renew",
            &RenewHostConnectionsRequest {
                connections: vec![],
            },
        )
        .await?;
    }
    state.request.credential = pending.credential;
    state.pending_rotation = None;
    state.rotated_at = chrono::Utc::now().timestamp();
    storage::write(&path, &state)?;
    Ok(())
}

pub async fn maintain(deployment: DeploymentImpl, shutdown: CancellationToken) {
    let mut last_ports_report = std::time::Instant::now() - Duration::from_secs(20);
    loop {
        if let Ok(Some(state)) = storage::read(&account_host_registration_path()) {
            if last_ports_report.elapsed() >= Duration::from_secs(20)
                && report_preview_ports(&deployment).await.is_ok()
            {
                last_ports_report = std::time::Instant::now();
            }
            let ids = deployment.relay_signing().account_sessions.active_ids();
            let started = LeaseRequestTime::now();
            let result: Result<RenewHostConnectionsResponse, _> = host_post(
                &state,
                "/v1/host-connections/renew",
                &RenewHostConnectionsRequest {
                    connections: ids.clone(),
                },
            )
            .await;
            match result {
                Ok(response) => {
                    for id in ids {
                        if let Some(lease) = response.leases.iter().find(|l| l.connection_id == id)
                        {
                            if !deployment
                                .relay_signing()
                                .account_sessions
                                .approve(lease.clone(), started)
                            {
                                deployment.relay_signing().account_sessions.revoke(id);
                            }
                        } else {
                            deployment.relay_signing().account_sessions.revoke(id);
                        }
                    }
                }
                Err(ApiError::Unauthorized | ApiError::Forbidden(_)) => {
                    deployment.relay_signing().account_sessions.revoke_all()
                }
                Err(_) => {} // Existing monotonic deadlines still expire during outages.
            }
            if let Err(error) = rotate_if_due(&deployment).await {
                tracing::debug!(%error,"Host credential rotation deferred");
            }
        }
        tokio::select! {_=shutdown.cancelled()=>break,_=tokio::time::sleep(Duration::from_secs(2))=>{}}
    }
    deployment.relay_signing().account_sessions.revoke_all();
}

pub async fn preview_ports(deployment: &DeploymentImpl) -> Result<Vec<i32>, ApiError> {
    use db::models::execution_process::{ExecutionProcess, ExecutionProcessRunReason};
    use services::services::container::ContainerService;
    use utils::log_msg::LogMsg;
    let processes = ExecutionProcess::find_running(&deployment.db().pool).await?;
    let mut ports = std::collections::BTreeSet::new();
    let server_port = deployment
        .client_info()
        .get_server_addr()
        .map(|addr| addr.port());
    let preview_port = deployment.client_info().get_preview_proxy_port();
    for process in processes
        .into_iter()
        .filter(|p| p.run_reason == ExecutionProcessRunReason::DevServer)
    {
        if !deployment.container().has_live_child(process.id).await {
            continue;
        }
        if let Some(logs) = deployment
            .container()
            .get_msg_store_by_id(&process.id)
            .await
        {
            for line in logs.get_history() {
                if let LogMsg::Stdout(line) | LogMsg::Stderr(line) = line {
                    for port in ports_in_output(&strip_ansi_escapes::strip_str(line)) {
                        if Some(port) != server_port
                            && Some(port) != preview_port
                            && ![2375, 2376, 5432, 6379, 27017].contains(&port)
                        {
                            ports.insert(i32::from(port));
                        }
                    }
                }
            }
        }
    }
    Ok(ports.into_iter().take(64).collect())
}

fn ports_in_output(output: &str) -> Vec<u16> {
    let mut ports = Vec::new();
    for marker in ["localhost:", "127.0.0.1:", "0.0.0.0:", "[::1]:", "[::]:"] {
        for (_, tail) in output
            .match_indices(marker)
            .map(|(index, _)| (index, &output[index + marker.len()..]))
        {
            let digits = tail
                .chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>();
            if let Ok(port) = digits.parse::<u16>()
                && port >= 1024
            {
                ports.push(port);
            }
        }
    }
    ports
}

pub async fn report_preview_ports(deployment: &DeploymentImpl) -> Result<(), ApiError> {
    let state = storage::read(&account_host_registration_path())?.ok_or(ApiError::Unauthorized)?;
    let ports = preview_ports(deployment).await?;
    let _: MutationResponse<()> = host_post(
        &state,
        "/v1/host-previews/ports",
        &ReportPreviewPortsRequest { ports },
    )
    .await?;
    Ok(())
}

pub async fn authorize_preview(
    deployment: &DeploymentImpl,
    preview_id: Uuid,
    port: u16,
) -> Result<relay_control::account_sessions::AccountSession, ApiError> {
    if !preview_ports(deployment).await?.contains(&i32::from(port)) {
        return Err(ApiError::Forbidden(
            "This port is not a running development server".into(),
        ));
    }
    let state = storage::read(&account_host_registration_path())?.ok_or(ApiError::Unauthorized)?;
    let started = LeaseRequestTime::now();
    let lease: HostConnectionLease = host_post(
        &state,
        "/v1/host-previews/authorize",
        &AuthorizeHostPreviewRequest { preview_id, port },
    )
    .await?;
    let id = lease.connection_id;
    if !deployment
        .relay_signing()
        .account_sessions
        .approve(lease, started)
    {
        return Err(ApiError::Unauthorized);
    }
    deployment
        .relay_signing()
        .account_sessions
        .get(id)
        .ok_or(ApiError::Unauthorized)
}

/// The registered owner may use the host's central session for nested cloud
/// requests, but only while the host is signed in as that same user. Every
/// other account keeps local-only access.
pub async fn is_host_owner(deployment: &DeploymentImpl, actor: Uuid) -> bool {
    let owner = storage::read(&account_host_registration_path())
        .ok()
        .flatten()
        .and_then(|state| state.registration)
        .map(|registration| registration.owner_user_id);
    let host_user = deployment
        .auth_context()
        .get_credentials()
        .await
        .and_then(|creds| utils::jwt::extract_subject(&creds.refresh_token).ok());
    owner_matches(actor, owner, host_user)
}

fn owner_matches(actor: Uuid, owner: Option<Uuid>, host_user: Option<Uuid>) -> bool {
    owner == Some(actor) && host_user == Some(actor)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_owner_signed_in_on_host_counts_as_host_owner() {
        let (owner, other) = (Uuid::new_v4(), Uuid::new_v4());
        assert!(owner_matches(owner, Some(owner), Some(owner)));
        assert!(!owner_matches(other, Some(owner), Some(owner)));
        assert!(!owner_matches(owner, Some(owner), Some(other)));
        assert!(!owner_matches(other, Some(owner), Some(other)));
        assert!(!owner_matches(owner, None, Some(owner)));
        assert!(!owner_matches(owner, Some(owner), None));
    }
    #[test]
    fn dev_server_ports_require_a_local_address_and_valid_unprivileged_port() {
        assert_eq!(
            ports_in_output("Local: http://localhost:5173/path 127.0.0.1:3000 [::1]:8080"),
            vec![5173, 3000, 8080]
        );
        assert!(
            ports_in_output(
                "https://remote.example:5173 localhost:80 localhost:65536 localhost:nope"
            )
            .is_empty()
        );
    }
}
