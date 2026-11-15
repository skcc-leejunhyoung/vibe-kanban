use std::{
    future::Future,
    io,
    pin::Pin,
    sync::{Arc, Mutex as StdMutex},
    task::{Context, Poll},
};

use axum::{
    body::Body,
    extract::{Request, ws::WebSocket},
    http::{StatusCode, Uri},
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use hyper::{body::Body as _, client::conn::http1 as client_http1, upgrade};
use hyper_util::rt::TokioIo;
use relay_control::signing::NONCE_HEADER;
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    sync::Mutex,
};
use tokio_util::sync::CancellationToken;
use tokio_yamux::{Control, Session, StreamHandle};
use ws_bridge::axum_ws_stream_io;

use crate::yamux_config;

pub type SharedControl = Arc<Mutex<Control>>;

/// Stops both directions of an upgraded stream and unbounded response bodies.
#[derive(Clone)]
pub struct RelayCancellation(pub CancellationToken);

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
        // The host consumes a signed request's nonce on delivery and the relay
        // holds no key to re-sign, so a resend is always a replay rejection.
        let signed = parts.headers.contains_key(NONCE_HEADER);
        (safe_method && !is_upgrade && empty_body && !signed).then(|| Self {
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
    let cancellation = request
        .extensions()
        .get::<RelayCancellation>()
        .cloned()
        .unwrap_or_else(|| RelayCancellation(CancellationToken::new()))
        .0;
    let stream = {
        let opened = tokio::select! {
            _=cancellation.cancelled()=>return StatusCode::FORBIDDEN.into_response(),
            result=async { control.lock().await.open_stream().await }=>result,
        };
        match opened {
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

    let mut stream_id = stream.id();
    let result = tokio::select! {
        _=cancellation.cancelled()=>return StatusCode::FORBIDDEN.into_response(),
        result=send_request_over_stream(stream, outbound, &request_path)=>result,
    };
    let mut response = match result {
        Ok(response) => response,
        Err(error) => {
            if error.is_parse()
                && let Some(replayable) = replayable
            {
                tracing::warn!(?error, path = %request_path, "relay response parse failed; retrying once");
                let retry_stream = {
                    let opened = tokio::select! {
                        _=cancellation.cancelled()=>return StatusCode::FORBIDDEN.into_response(),
                        result=async { control.lock().await.open_stream().await }=>result,
                    };
                    match opened {
                        Ok(stream) => stream,
                        Err(retry_error) => {
                            tracing::warn!(?retry_error, path = %request_path, "failed to open relay retry stream");
                            return (StatusCode::BAD_GATEWAY, "Relay connection lost")
                                .into_response();
                        }
                    }
                };
                stream_id = retry_stream.id();
                let retry_result = tokio::select! {
                    _=cancellation.cancelled()=>return StatusCode::FORBIDDEN.into_response(),
                    result=send_request_over_stream(retry_stream, replayable.into_request(), &request_path)=>result,
                };
                match retry_result {
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
        let cancellation = cancellation.clone();
        tokio::spawn(async move {
            tokio::select! {
                _=cancellation.cancelled()=>{},
                _=async {
                    let Ok(from_client)=request_upgrade.await else {return;};
                    let Ok(to_local)=response_upgrade.await else {return;};
                    let mut from_client=TokioIo::new(from_client);
                    let mut to_local=TokioIo::new(to_local);
                    let _=tokio::io::copy_bidirectional(&mut from_client,&mut to_local).await;
                }=>{}
            }
        });
    }

    let (parts, body) = response.into_parts();
    let mut bytes_relayed = 0u64;
    let stream = Body::new(body)
        .into_data_stream()
        .inspect(move |chunk| match chunk {
            Ok(chunk) => bytes_relayed += chunk.len() as u64,
            Err(error) => tracing::warn!(
                ?error,
                path = %request_path,
                stream_id,
                bytes_relayed,
                "relay response body interrupted"
            ),
        })
        .take_until(cancellation.cancelled_owned());
    Response::from_parts(parts, Body::from_stream(stream))
}

async fn send_request_over_stream(
    stream: StreamHandle,
    request: Request,
    path: &str,
) -> Result<hyper::Response<hyper::body::Incoming>, hyper::Error> {
    let stream_id = stream.id();
    let head = Arc::<StdMutex<Vec<u8>>>::default();
    let io = HeadRecorder {
        inner: stream,
        head: head.clone(),
    };
    let (mut sender, connection) = client_http1::Builder::new()
        .handshake(TokioIo::new(io))
        .await?;
    tokio::spawn(async move {
        if let Err(error) = connection.with_upgrades().await {
            tracing::debug!(?error, "relay stream connection closed");
        }
    });
    let result = sender.send_request(request).await;
    if let Err(error) = &result
        && error.is_parse()
    {
        tracing::warn!(
            ?error,
            path = %path,
            stream_id,
            response_head = %head.lock().unwrap().escape_ascii(),
            "relay stream returned a malformed HTTP response"
        );
    }
    result
}

/// Enough to tell an HTTP head from JSON, SSE, or a yamux frame, but too short
/// to hold a whole token from a misrouted body.
const RESPONSE_HEAD_LOG_BYTES: usize = 16;

/// Keeps the first bytes read from a relay stream for the malformed-response log.
struct HeadRecorder {
    inner: StreamHandle,
    head: Arc<StdMutex<Vec<u8>>>,
}

impl AsyncRead for HeadRecorder {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let start = buf.filled().len();
        let poll = Pin::new(&mut self.inner).poll_read(cx, buf);
        let mut head = self.head.lock().unwrap();
        let room = RESPONSE_HEAD_LOG_BYTES.saturating_sub(head.len());
        let read = &buf.filled()[start..];
        head.extend_from_slice(&read[..read.len().min(room)]);
        poll
    }
}

impl AsyncWrite for HeadRecorder {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
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
        assert!(!replayable(
            Request::builder()
                .uri("/api/workspaces?archived=false")
                .header(relay_control::signing::NONCE_HEADER, "fixture-nonce")
                .body(Body::empty())
                .unwrap()
        ));
    }
}
