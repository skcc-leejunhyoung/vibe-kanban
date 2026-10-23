use std::time::{Duration, Instant};

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
use tokio::sync::Mutex;
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/relay-auth/client/pair", post(pair_relay_host))
        .route("/relay-auth/client/hosts", get(list_relay_paired_hosts))
        .route("/relay-auth/client/self-host", get(get_self_relay_host))
        .route(
            "/relay-auth/client/reachable-hosts",
            get(list_reachable_hosts),
        )
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

/// Other hosts `/api/host/{id}` can reach, for the agent CLI/MCP. Unlike
/// `/hosts` (pairings saved here) this lists account hosts by their real name.
pub async fn list_reachable_hosts(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<Vec<relay_hosts::ReachableHost>>>, ApiError> {
    let mut hosts = deployment.relay_hosts()?.reachable_hosts().await;
    if let Some(self_id) = self_relay_host_id(&deployment).await {
        hosts.retain(|host| host.host_id != self_id);
    }
    Ok(ResponseJson(ApiResponse::success(hosts)))
}

/// Cloud relay host id of this machine itself, so the local web app can route
/// self-owned workspaces directly (`/api`) instead of relay-proxying to
/// ourselves — self is never in the pairing store, so that would 400 with
/// "No paired relay credentials". Any failure resolves to `None` so callers
/// simply fall back to the route host.
pub async fn get_self_relay_host(
    State(deployment): State<DeploymentImpl>,
) -> ResponseJson<ApiResponse<SelfRelayHostResponse>> {
    let host_id = self_relay_host_id(&deployment).await;
    ResponseJson(ApiResponse::success(SelfRelayHostResponse { host_id }))
}

/// Process-wide cache of this machine's own relay host id: hits live for the
/// web app's own polling interval, misses briefly so an unreachable relay is
/// not re-queried per request. Holding the lock across the lookup makes
/// concurrent callers share one relay request.
static SELF_RELAY_HOST: Mutex<Option<(Instant, Option<Uuid>)>> = Mutex::const_new(None);
const SELF_RELAY_HOST_TTL: Duration = Duration::from_secs(5 * 60);
const SELF_RELAY_HOST_MISS_TTL: Duration = Duration::from_secs(30);

pub(crate) async fn self_relay_host_id(deployment: &DeploymentImpl) -> Option<Uuid> {
    if let Ok(Some(state)) =
        relay_control::account_registration::read(&utils::assets::account_host_registration_path())
    {
        return state.registration.map(|registration| registration.host_id);
    }
    let mut cache = SELF_RELAY_HOST.lock().await;
    let last_known = cache.and_then(|(_, host_id)| host_id);
    if let Some((refreshed_at, host_id)) = *cache {
        let ttl = if host_id.is_some() {
            SELF_RELAY_HOST_TTL
        } else {
            SELF_RELAY_HOST_MISS_TTL
        };
        if refreshed_at.elapsed() < ttl {
            return host_id;
        }
    }
    // A machine's own host id does not change while it runs, so keep the last
    // known one when the relay cannot be reached.
    let host_id = resolve_self_relay_host_id(deployment).await.or(last_known);
    *cache = Some((Instant::now(), host_id));
    host_id
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
