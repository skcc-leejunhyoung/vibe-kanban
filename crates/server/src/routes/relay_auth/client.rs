use axum::{
    Json, Router,
    extract::{Path, State},
    response::Json as ResponseJson,
    routing::{delete, get, post},
};
use deployment::Deployment;
use relay_types::{
    ListRelayPairedHostsResponse, PairRelayHostRequest, PairRelayHostResponse,
    RemoveRelayPairedHostResponse, SelfRelayHostResponse,
};
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/relay-auth/client/pair", post(pair_relay_host))
        .route("/relay-auth/client/hosts", get(list_relay_paired_hosts))
        .route("/relay-auth/client/self-host", get(get_self_relay_host))
        .route(
            "/relay-auth/client/hosts/{host_id}",
            delete(remove_relay_paired_host),
        )
}

pub async fn pair_relay_host(
    State(deployment): State<DeploymentImpl>,
    Json(req): Json<PairRelayHostRequest>,
) -> Result<Json<ApiResponse<PairRelayHostResponse>>, ApiError> {
    if !cfg!(debug_assertions) {
        let hosts = deployment.remote_client()?.list_relay_hosts().await?;
        let selected_host = hosts
            .into_iter()
            .find(|host| host.id == req.host_id)
            .ok_or_else(|| ApiError::BadRequest("Selected host is not available".to_string()))?;

        if selected_host.machine_id == deployment.user_id() {
            return Err(ApiError::BadRequest(
                "Cannot pair this machine to itself".to_string(),
            ));
        }
    }

    let relay_hosts = deployment.relay_hosts()?;
    relay_hosts.pair_host(&req).await?;
    Ok(Json(ApiResponse::success(PairRelayHostResponse {
        paired: true,
    })))
}

pub async fn list_relay_paired_hosts(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<ListRelayPairedHostsResponse>>, ApiError> {
    let hosts = deployment.relay_hosts()?.list_hosts().await;
    Ok(ResponseJson(ApiResponse::success(
        ListRelayPairedHostsResponse { hosts },
    )))
}

/// Cloud relay host id of this machine itself, so the local web app can route
/// self-owned workspaces directly (`/api`) instead of relay-proxying to
/// ourselves — self is never in the pairing store, so that would 400 with
/// "No paired relay credentials". Any failure resolves to `None` so callers
/// simply fall back to the route host.
pub async fn get_self_relay_host(
    State(deployment): State<DeploymentImpl>,
) -> ResponseJson<ApiResponse<SelfRelayHostResponse>> {
    let host_id = resolve_self_relay_host_id(&deployment).await;
    ResponseJson(ApiResponse::success(SelfRelayHostResponse { host_id }))
}

async fn resolve_self_relay_host_id(deployment: &DeploymentImpl) -> Option<Uuid> {
    let hosts = deployment
        .remote_client()
        .ok()?
        .list_relay_hosts()
        .await
        .ok()?;
    let user_id = deployment.user_id();
    hosts
        .into_iter()
        .find(|host| host.machine_id == user_id)
        .map(|host| host.id)
}

pub async fn remove_relay_paired_host(
    State(deployment): State<DeploymentImpl>,
    Path(host_id): Path<Uuid>,
) -> Result<Json<ApiResponse<RemoveRelayPairedHostResponse>>, ApiError> {
    let relay_hosts = deployment.relay_hosts()?;
    let removed = relay_hosts.remove_host(host_id).await?;
    Ok(Json(ApiResponse::success(RemoveRelayPairedHostResponse {
        removed,
    })))
}
