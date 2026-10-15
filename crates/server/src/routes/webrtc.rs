use axum::{
    Extension, Json, Router, extract::State, http::StatusCode, response::Json as ResponseJson,
    routing::post,
};
use deployment::Deployment;
use relay_control::account_sessions::AccountSession;
use relay_webrtc::{IceCandidate, SdpAnswer, SdpOffer};
use utils::response::ApiResponse;

use crate::{DeploymentImpl, error::ApiError};

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/webrtc/offer", post(handle_offer))
        .route("/webrtc/candidate", post(handle_candidate))
}

async fn handle_offer(
    State(deployment): State<DeploymentImpl>,
    account: Option<Extension<AccountSession>>,
    Json(mut offer): Json<SdpOffer>,
) -> Result<ResponseJson<ApiResponse<SdpAnswer>>, ApiError> {
    let Some(webrtc_host) = deployment.webrtc_host() else {
        return Err(ApiError::BadRequest(
            "Local server address is not available".to_string(),
        ));
    };

    if deployment.relay_signing().account_mode() && account.is_none() {
        return Err(ApiError::Unauthorized);
    }
    let original_id = offer.session_id.clone();
    if let Some(account) = &account {
        offer.session_id = format!("{}:{}", account.identity.connection_id, original_id);
    }
    let mut answer = webrtc_host
        .handle_authorized_offer(offer, account.map(|account| account.cancelled.clone()))
        .await?;
    answer.session_id = original_id;
    Ok(ResponseJson(ApiResponse::success(answer)))
}

async fn handle_candidate(
    State(deployment): State<DeploymentImpl>,
    account: Option<Extension<AccountSession>>,
    Json(mut candidate): Json<IceCandidate>,
) -> Result<StatusCode, ApiError> {
    let Some(webrtc_host) = deployment.webrtc_host() else {
        return Err(ApiError::BadRequest(
            "Local server address is not available".to_string(),
        ));
    };

    if deployment.relay_signing().account_mode() && account.is_none() {
        return Err(ApiError::Unauthorized);
    }
    if let Some(account) = account {
        candidate.session_id = format!(
            "{}:{}",
            account.identity.connection_id, candidate.session_id
        );
    }
    webrtc_host.add_ice_candidate(candidate).await?;
    Ok(StatusCode::NO_CONTENT)
}
