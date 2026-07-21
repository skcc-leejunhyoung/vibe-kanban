use std::{future::Future, sync::Arc};

use axum::{
    body::Body,
    extract::{Request, ws::WebSocket},
    http::{StatusCode, Uri},
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use hyper::{body::Body as _, client::conn::http1 as client_http1, upgrade};
use hyper_util::rt::TokioIo;
use tokio::sync::Mutex;
use tokio_yamux::{Control, Session};
use ws_bridge::axum_ws_stream_io;

use crate::yamux_config;

pub type SharedControl = Arc<Mutex<Control>>;

#[derive(Clone)]
struct ReplayableRequest {
    method: axum::http::Method,
    uri: Uri,
    version: axum::http::Version,
    headers: axum::http::HeaderMap,
}

impl ReplayableRequest {
    fn from_parts(parts: &axum::http::request::Parts, body: &Body) -> Option<Self> {
        let safe_method =
            parts.method == axum::http::Method::GET || parts.method == axum::http::Method::HEAD;
        let is_upgrade = parts.headers.contains_key(axum::http::header::UPGRADE);
        let empty_body = body.size_hint().exact() == Some(0);
        (safe_method && !is_upgrade && empty_body).then(|| Self {
            method: parts.method.clone(),
            uri: parts.uri.clone(),
            version: parts.version,
            headers: parts.headers.clone(),
        })
    }

    fn into_request(self) -> Request {
        let mut request = Request::builder()
            .method(self.method)
            .uri(self.uri)
            .version(self.version)
            .body(Body::empty())
            .expect("replayable relay request must remain valid");
        *request.headers_mut() = self.headers;
        request
    }
}

/// Runs the server-side control channel over an upgraded WebSocket.
///
/// The provided callback is invoked once, after yamux is initialized, with a
/// shared control handle that can be used to proxy requests over new streams.
pub async fn run_control_channel<F, Fut>(socket: WebSocket, on_connected: F) -> anyhow::Result<()>
where
    F: FnOnce(SharedControl) -> Fut,
    Fut: Future<Output = ()>,
{
    let ws_io = axum_ws_stream_io(socket);
    let mut session = Session::new_server(ws_io, yamux_config());
    let control = Arc::new(Mutex::new(session.control()));

    on_connected(control).await;

    while let Some(stream_result) = session.next().await {
        match stream_result {
            Ok(_stream) => {
                // The client side does not currently open server-initiated streams.
            }
            Err(error) => {
                return Err(anyhow::anyhow!("relay session error: {error}"));
            }
        }
    }

    Ok(())
}

/// Proxies one HTTP request over a new yamux stream using the shared control.
pub async fn proxy_request_over_control(
    control: &Mutex<Control>,
    request: Request,
    strip_prefix: &str,
) -> Response {
    let stream = {
        let mut control = control.lock().await;
        match control.open_stream().await {
            Ok(stream) => stream,
            Err(error) => {
                tracing::warn!(?error, "failed to open relay stream");
                return (StatusCode::BAD_GATEWAY, "Relay connection lost").into_response();
            }
        }
    };

    let (mut parts, body) = request.into_parts();
    let path = normalized_relay_path(&parts.uri, strip_prefix);
    parts.uri = match Uri::builder().path_and_query(path).build() {
        Ok(uri) => uri,
        Err(error) => {
            tracing::warn!(?error, "failed to build relay proxy URI");
            return (StatusCode::BAD_REQUEST, "Invalid request URI").into_response();
        }
    };

    let replayable = ReplayableRequest::from_parts(&parts, &body);
    let request_path = parts.uri.path().to_string();
    let mut outbound = axum::http::Request::from_parts(parts, body);
    let request_upgrade = upgrade::on(&mut outbound);

    let mut response = match send_request_over_stream(stream, outbound).await {
        Ok(response) => response,
        Err(error) => {
            if error.is_parse()
                && let Some(replayable) = replayable
            {
                tracing::warn!(?error, path = %request_path, "relay response parse failed; retrying once");
                let retry_stream = {
                    let mut control = control.lock().await;
                    match control.open_stream().await {
                        Ok(stream) => stream,
                        Err(retry_error) => {
                            tracing::warn!(?retry_error, path = %request_path, "failed to open relay retry stream");
                            return (StatusCode::BAD_GATEWAY, "Relay connection lost")
                                .into_response();
                        }
                    }
                };
                match send_request_over_stream(retry_stream, replayable.into_request()).await {
                    Ok(response) => response,
                    Err(retry_error) => {
                        tracing::warn!(?retry_error, path = %request_path, "relay request retry failed");
                        return (StatusCode::BAD_GATEWAY, "Relay request failed").into_response();
                    }
                }
            } else {
                tracing::warn!(?error, path = %request_path, "relay proxy request failed");
                return (StatusCode::BAD_GATEWAY, "Relay request failed").into_response();
            }
        }
    };

    if response.status() == StatusCode::SWITCHING_PROTOCOLS {
        let response_upgrade = upgrade::on(&mut response);
        tokio::spawn(async move {
            let Ok(from_client) = request_upgrade.await else {
                return;
            };
            let Ok(to_local) = response_upgrade.await else {
                return;
            };
            let mut from_client = TokioIo::new(from_client);
            let mut to_local = TokioIo::new(to_local);
            let _ = tokio::io::copy_bidirectional(&mut from_client, &mut to_local).await;
        });
    }

    let (parts, body) = response.into_parts();
    Response::from_parts(parts, Body::new(body))
}

async fn send_request_over_stream(
    stream: tokio_yamux::StreamHandle,
    request: Request,
) -> Result<hyper::Response<hyper::body::Incoming>, hyper::Error> {
    let (mut sender, connection) = client_http1::Builder::new()
        .handshake(TokioIo::new(stream))
        .await?;
    tokio::spawn(async move {
        if let Err(error) = connection.with_upgrades().await {
            tracing::debug!(?error, "relay stream connection closed");
        }
    });
    sender.send_request(request).await
}

fn normalized_relay_path(uri: &axum::http::Uri, strip_prefix: &str) -> String {
    let raw_path = uri.path();
    let path = raw_path.strip_prefix(strip_prefix).unwrap_or(raw_path);
    let path = if path.is_empty() { "/" } else { path };
    let query = uri.query().map(|q| format!("?{q}")).unwrap_or_default();
    format!("{path}{query}")
}

#[cfg(test)]
mod tests {
    use axum::{body::Body, http::Request};

    use super::ReplayableRequest;

    fn replayable(request: Request<Body>) -> bool {
        let (parts, body) = request.into_parts();
        ReplayableRequest::from_parts(&parts, &body).is_some()
    }

    #[test]
    fn only_empty_idempotent_non_upgrade_requests_are_replayable() {
        assert!(replayable(
            Request::builder()
                .uri("/api/workspaces")
                .body(Body::empty())
                .unwrap()
        ));
        assert!(replayable(
            Request::builder()
                .method("HEAD")
                .uri("/api/health")
                .body(Body::empty())
                .unwrap()
        ));
        assert!(!replayable(
            Request::builder()
                .method("POST")
                .uri("/api/workspaces")
                .body(Body::empty())
                .unwrap()
        ));
        assert!(!replayable(
            Request::builder()
                .uri("/api/workspaces")
                .header("upgrade", "websocket")
                .body(Body::empty())
                .unwrap()
        ));
        assert!(!replayable(
            Request::builder()
                .uri("/api/workspaces")
                .body(Body::from("unexpected GET body"))
                .unwrap()
        ));
    }
}
