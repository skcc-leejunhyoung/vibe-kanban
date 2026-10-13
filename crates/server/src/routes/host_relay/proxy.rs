use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{
        Path, Request, State,
        ws::{WebSocketUpgrade, rejection::WebSocketUpgradeRejection},
    },
    http::{StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::any,
};
use deployment::Deployment;
use relay_hosts::ProxiedResponse;
use utils::http_headers::is_hop_by_hop_header;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError, routes::relay_auth::client::self_relay_host_id};

type MaybeWsUpgrade = Result<WebSocketUpgrade, WebSocketUpgradeRejection>;

pub(super) fn router() -> Router<DeploymentImpl> {
    Router::new().route("/host/{host_id}/{*tail}", any(proxy_host_request))
}

/// Serve `/api/host/{id}/…` directly when `{id}` is this machine's own cloud
/// host id. Self is never in the pairing store (a machine cannot pair with
/// itself), so proxying it always fails with `NotPaired`; treating the self id
/// as an alias of the local API keeps host-scoped URLs valid for every client
/// (notification deep links, bookmarks, split-pane state, older web builds)
/// without each having to know which host it runs on. Must run before routing
/// so the rewritten request lands on the regular handlers, WebSocket upgrades
/// included.
pub(crate) async fn alias_self_host(
    State(deployment): State<DeploymentImpl>,
    mut request: Request,
) -> Request {
    let Some((host_id, tail)) = split_host_path(request.uri().path()) else {
        return request;
    };
    // Paired hosts proxy as usual; only a would-be `NotPaired` id is checked
    // against the relay, so that lookup never delays remote traffic.
    let Ok(relay_hosts) = deployment.relay_hosts() else {
        return request;
    };
    if relay_hosts
        .list_hosts()
        .await
        .iter()
        .any(|host| host.host_id == host_id)
    {
        return request;
    }
    if self_relay_host_id(&deployment).await != Some(host_id) {
        return request;
    }
    let query = request.uri().query().map(str::to_owned);
    if let Ok(uri) = upstream_api_uri(&tail, query.as_deref()) {
        *request.uri_mut() = uri;
    }
    request
}

/// `/api/host/{uuid}/{tail}` → `(uuid, tail)`; anything else is `None`.
fn split_host_path(path: &str) -> Option<(Uuid, String)> {
    let (host_id, tail) = path.strip_prefix("/api/host/")?.split_once('/')?;
    Some((host_id.parse().ok()?, tail.to_owned()))
}

async fn proxy_host_request(
    State(deployment): State<DeploymentImpl>,
    Path((host_id, tail)): Path<(Uuid, String)>,
    ws_upgrade: MaybeWsUpgrade,
    mut request: Request,
) -> Result<Response, ApiError> {
    let query = request.uri().query().map(str::to_owned);
    let upstream_uri = upstream_api_uri(&tail, query.as_deref())?;
    *request.uri_mut() = upstream_uri;

    match ws_upgrade {
        Ok(ws_upgrade) => forward_ws(&deployment, host_id, request, ws_upgrade).await,
        Err(_) => forward_http(&deployment, host_id, request).await,
    }
}

async fn forward_http(
    deployment: &DeploymentImpl,
    host_id: Uuid,
    request: Request,
) -> Result<Response, ApiError> {
    let relay_hosts = deployment.relay_hosts()?;
    let (parts, body) = request.into_parts();
    let method = parts.method;
    let headers = parts.headers;
    let target_path = parts
        .uri
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/")
        .to_string();
    let body_bytes = to_bytes(body, usize::MAX).await.map_err(|error| {
        tracing::warn!(?error, "Failed to read relay proxy request body");
        ApiError::BadRequest("Invalid request body".to_string())
    })?;
    let relay_host = relay_hosts.host(host_id).await?;
    let response = relay_host
        .proxy_http(&method, &target_path, &headers, &body_bytes)
        .await?;

    Ok(relay_http_response(response))
}

async fn forward_ws(
    deployment: &DeploymentImpl,
    host_id: Uuid,
    request: Request,
    ws_upgrade: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let relay_hosts = deployment.relay_hosts()?;
    let target_path = request
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/")
        .to_string();
    let protocols = request
        .headers()
        .get("sec-websocket-protocol")
        .and_then(|v| v.to_str().ok())
        .map(ToOwned::to_owned);
    let relay_host = relay_hosts.host(host_id).await?;

    let connection = relay_host
        .proxy_ws(&target_path, protocols.as_deref())
        .await?;
    let selected_protocol = connection.selected_protocol.clone();

    let mut ws = ws_upgrade;
    if let Some(protocol) = &selected_protocol {
        ws = ws.protocols([protocol.clone()]);
    }
    Ok(ws
        .on_upgrade(|socket| async move {
            if let Err(error) = connection.bridge(socket).await {
                tracing::debug!(?error, "WS bridge closed with error");
            }
        })
        .into_response())
}

#[allow(clippy::result_large_err)]
fn upstream_api_uri(tail: &str, query: Option<&str>) -> Result<Uri, ApiError> {
    let mut uri = String::from("/api/");
    uri.push_str(tail);

    if let Some(query) = query {
        uri.push('?');
        uri.push_str(query);
    }

    uri.parse()
        .map_err(|_| ApiError::BadRequest("Invalid rewritten relay path".to_string()))
}

fn relay_http_response(response: ProxiedResponse) -> Response {
    let mut builder = Response::builder().status(response.status);
    for (name, value) in &response.headers {
        if !is_hop_by_hop_header(name.as_str()) {
            builder = builder.header(name, value);
        }
    }

    builder
        .body(Body::from_stream(response.body))
        .unwrap_or_else(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to build relay proxy response",
            )
                .into_response()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_host_path_only_matches_host_scoped_api_paths() {
        let id = Uuid::nil();
        assert_eq!(
            split_host_path(&format!("/api/host/{id}/workspaces/x/git/diff/ws")),
            Some((id, "workspaces/x/git/diff/ws".to_owned()))
        );
        assert_eq!(split_host_path(&format!("/api/host/{id}")), None);
        assert_eq!(split_host_path("/api/host/not-a-uuid/workspaces"), None);
        assert_eq!(split_host_path("/api/workspaces"), None);
    }

    #[test]
    fn aliased_uri_keeps_tail_and_query() {
        let uri = upstream_api_uri("workspaces/x/git/diff/ws", Some("stats_only=true")).unwrap();
        assert_eq!(
            uri.to_string(),
            "/api/workspaces/x/git/diff/ws?stats_only=true"
        );
    }
}
