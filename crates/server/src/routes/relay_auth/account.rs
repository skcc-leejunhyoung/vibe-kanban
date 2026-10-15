use axum::{
    Json, Router,
    extract::{Query, State},
    http::HeaderMap,
    routing::{get, post},
};
use deployment::Deployment;
use relay_control::account_registration;
use relay_types::{AccountHostStatus, StartAccountSessionRequest, StartAccountSessionResponse};
use utils::{assets::account_host_registration_path, response::ApiResponse};

use crate::{
    DeploymentImpl,
    error::ApiError,
    relay_pairing::server::is_relay_request,
    runtime::{host_accounts, relay_registration},
};

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route(
            "/relay-auth/account/registration",
            get(status).post(register),
        )
        .route("/relay-auth/account/session", post(start))
        .route("/relay-auth/account/preview-ports", post(report_ports))
}

async fn status(
    State(deployment): State<DeploymentImpl>,
    headers: HeaderMap,
) -> Result<Json<ApiResponse<AccountHostStatus>>, ApiError> {
    if is_relay_request(&headers) {
        return Err(ApiError::Forbidden(
            "Registration settings require local access".into(),
        ));
    }
    let state = account_registration::read(&account_host_registration_path())?;
    Ok(Json(ApiResponse::success(AccountHostStatus {
        account_mode: deployment.relay_signing().account_mode(),
        api_base: state
            .as_ref()
            .map(|s| s.api_base.clone())
            .or_else(|| deployment.remote_info().get_api_base()),
        registration: state.and_then(|s| s.registration),
    })))
}

async fn register(
    State(deployment): State<DeploymentImpl>,
    headers: HeaderMap,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<ApiResponse<AccountHostStatus>>, ApiError> {
    if is_relay_request(&headers) {
        return Err(ApiError::Forbidden(
            "Host registration requires local access".into(),
        ));
    }
    let registration = host_accounts::register(
        &deployment,
        query.get("replace").is_some_and(|v| v == "true"),
    )
    .await?;
    {
        let mut config = deployment.config().write().await;
        config.relay_enabled = true;
        services::services::config::save_config_to_file(&config, &utils::assets::config_path())
            .await?;
    }
    relay_registration::spawn_relay(&deployment).await;
    Ok(Json(ApiResponse::success(AccountHostStatus {
        account_mode: true,
        api_base: deployment.remote_info().get_api_base(),
        registration: Some(registration),
    })))
}

async fn start(
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<StartAccountSessionRequest>,
) -> Result<Json<ApiResponse<StartAccountSessionResponse>>, ApiError> {
    host_accounts::start_session(&deployment, request)
        .await
        .map(|r| Json(ApiResponse::success(r)))
}

async fn report_ports(
    State(deployment): State<DeploymentImpl>,
) -> Result<Json<ApiResponse<()>>, ApiError> {
    host_accounts::report_preview_ports(&deployment).await?;
    Ok(Json(ApiResponse::success(())))
}
