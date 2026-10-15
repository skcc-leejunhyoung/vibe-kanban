use axum::{
    Router,
    extract::{Path, Request, State, ws::rejection::WebSocketUpgradeRejection},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::any,
};
use deployment::Deployment;
use ws_bridge::{bridge_axum_ws, connect_upstream_ws};

use crate::{DeploymentImpl, middleware::signed_ws::SignedWsUpgrade};

pub(super) fn api_router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/preview/{target_port}", any(proxy_preview_request_no_tail))
        .route("/preview/{target_port}/{*tail}", any(proxy_preview_request))
}

pub fn subdomain_router(deployment: DeploymentImpl) -> Router {
    Router::new()
        .fallback(subdomain_proxy_request)
        .layer(axum::middleware::from_fn_with_state(
            deployment.clone(),
            crate::middleware::relay_request_signature::guard_account_host,
        ))
        .with_state(deployment)
}

async fn proxy_preview_request_no_tail(
    State(deployment): State<DeploymentImpl>,
    Path(target_port): Path<u16>,
    ws_upgrade: Result<SignedWsUpgrade, WebSocketUpgradeRejection>,
    request: Request,
) -> Response {
    if !account_port_allowed(
        &deployment,
        target_port,
        request.headers().contains_key(relay_client::RELAY_HEADER),
    )
    .await
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    match ws_upgrade {
        Ok(ws) => forward_preview_ws(ws, target_port, String::new(), request).await,
        Err(rejection) => {
            preview_proxy::api::proxy_api_request(
                deployment.preview_proxy(),
                target_port,
                String::new(),
                Err(rejection),
                request,
            )
            .await
        }
    }
}

async fn proxy_preview_request(
    State(deployment): State<DeploymentImpl>,
    Path((target_port, tail)): Path<(u16, String)>,
    ws_upgrade: Result<SignedWsUpgrade, WebSocketUpgradeRejection>,
    request: Request,
) -> Response {
    if !account_port_allowed(
        &deployment,
        target_port,
        request.headers().contains_key(relay_client::RELAY_HEADER),
    )
    .await
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    match ws_upgrade {
        Ok(ws) => forward_preview_ws(ws, target_port, tail, request).await,
        Err(rejection) => {
            preview_proxy::api::proxy_api_request(
                deployment.preview_proxy(),
                target_port,
                tail,
                Err(rejection),
                request,
            )
            .await
        }
    }
}

async fn forward_preview_ws(
    ws: SignedWsUpgrade,
    target_port: u16,
    tail: String,
    request: Request,
) -> Response {
    let query = request.uri().query().unwrap_or_default();
    let normalized = tail.trim_start_matches('/');
    let ws_url = if normalized.is_empty() {
        format!("ws://localhost:{target_port}/?{query}")
    } else if query.is_empty() {
        format!("ws://localhost:{target_port}/{normalized}")
    } else {
        format!("ws://localhost:{target_port}/{normalized}?{query}")
    };

    let protocols = request
        .headers()
        .get("sec-websocket-protocol")
        .and_then(|v| v.to_str().ok())
        .map(ToOwned::to_owned);

    let (upstream_ws, selected_protocol) =
        match connect_upstream_ws(ws_url, protocols.as_deref()).await {
            Ok(value) => value,
            Err(error) => {
                tracing::warn!(?error, "Failed to connect preview upstream WebSocket");
                return (StatusCode::BAD_GATEWAY, "Preview WebSocket unavailable").into_response();
            }
        };

    let ws = if let Some(protocol) = selected_protocol {
        ws.protocols([protocol])
    } else {
        ws
    };

    ws.on_upgrade(move |client| async move {
        if let Err(error) = bridge_axum_ws(client, upstream_ws).await {
            tracing::debug!(?error, "Preview WS bridge closed with error");
        }
    })
    .into_response()
}

pub async fn subdomain_proxy_request(
    State(deployment): State<DeploymentImpl>,
    request: Request,
) -> Response {
    if deployment.relay_signing().account_mode()
        && request.headers().contains_key(relay_client::RELAY_HEADER)
    {
        let port = request
            .headers()
            .get("host")
            .and_then(|v| v.to_str().ok())
            .and_then(|host| host.split('.').next())
            .and_then(|label| label.parse::<u16>().ok());
        if let Some(port) = port {
            if !account_port_allowed(
                &deployment,
                port,
                request.headers().contains_key(relay_client::RELAY_HEADER),
            )
            .await
            {
                return StatusCode::FORBIDDEN.into_response();
            }
        } else {
            return StatusCode::FORBIDDEN.into_response();
        }
    }
    let Some(server_addr) = deployment.client_info().get_server_addr() else {
        return (
            StatusCode::BAD_REQUEST,
            "Local server address is not available",
        )
            .into_response();
    };

    let Some(proxy_port) = deployment.client_info().get_preview_proxy_port() else {
        return (
            StatusCode::BAD_REQUEST,
            "Preview proxy port is not available",
        )
            .into_response();
    };

    preview_proxy::proxy_subdomain_request(
        deployment.preview_proxy(),
        server_addr,
        proxy_port,
        request,
    )
    .await
}

async fn account_port_allowed(deployment: &DeploymentImpl, port: u16, relayed: bool) -> bool {
    if !deployment.relay_signing().account_mode() || !relayed {
        return true;
    }
    crate::runtime::host_accounts::preview_ports(deployment)
        .await
        .is_ok_and(|ports| ports.contains(&i32::from(port)))
}
