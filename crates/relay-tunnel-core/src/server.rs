use std::{
    future::Future,
    io,
    pin::Pin,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicU64, Ordering},
    },
    task::{Context, Poll},
};

use axum::{
    body::Body,
    extract::{Request, ws::WebSocket},
    http::{StatusCode, Uri},
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use hyper::{client::conn::http1 as client_http1, upgrade};
use hyper_util::rt::TokioIo;
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

    let request_path = parts.uri.path().to_string();
    let mut outbound = axum::http::Request::from_parts(parts, body);
    let request_upgrade = upgrade::on(&mut outbound);

    // Never resent: a failed exchange may already have reached the host, which
    // consumes a signed request's nonce on delivery, and the relay cannot re-sign.
    let stream_id = stream.id();
    let result = tokio::select! {
        _=cancellation.cancelled()=>return StatusCode::FORBIDDEN.into_response(),
        result=send_request_over_stream(stream, outbound, &request_path)=>result,
    };
    let Some(mut response) = result else {
        return (StatusCode::BAD_GATEWAY, "Relay request failed").into_response();
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
    // The body streams after this returns; keep the caller's span (host id)
    // on its logs.
    let span = tracing::Span::current();
    let bytes_sent = Arc::new(AtomicU64::new(0));
    let (counted, cut_span, cut_path) = (bytes_sent.clone(), span.clone(), request_path.clone());
    let stream = Body::new(body)
        .into_data_stream()
        .inspect(move |chunk| match chunk {
            Ok(chunk) => {
                counted.fetch_add(chunk.len() as u64, Ordering::Relaxed);
            }
            Err(error) => tracing::warn!(
                parent: &span,
                ?error,
                path = %request_path,
                stream_id,
                bytes_sent = counted.load(Ordering::Relaxed),
                "relay response body interrupted"
            ),
        })
        .take_until(async move {
            cancellation.cancelled_owned().await;
            tracing::warn!(
                parent: &cut_span,
                path = %cut_path,
                stream_id,
                bytes_sent = bytes_sent.load(Ordering::Relaxed),
                "relay response body cut off by access cancellation"
            );
        });
    Response::from_parts(parts, Body::from_stream(stream))
}

async fn send_request_over_stream(
    stream: StreamHandle,
    request: Request,
    path: &str,
) -> Option<hyper::Response<hyper::body::Incoming>> {
    let stream_id = stream.id();
    let head = Arc::<StdMutex<Vec<u8>>>::default();
    let io = HeadRecorder {
        inner: stream,
        head: head.clone(),
    };
    let result = async {
        let (mut sender, connection) = client_http1::Builder::new()
            .handshake(TokioIo::new(io))
            .await?;
        tokio::spawn(async move {
            if let Err(error) = connection.with_upgrades().await {
                tracing::debug!(?error, "relay stream connection closed");
            }
        });
        sender.send_request(request).await
    }
    .await;
    if let Err(error) = &result {
        // A parse error (e.g. `Parse(Version)`) means the stream carried
        // non-HTTP bytes; the head and stream id show what arrived and where.
        tracing::warn!(
            ?error,
            path = %path,
            stream_id,
            response_head = %head.lock().unwrap().escape_ascii(),
            "relay proxy request failed"
        );
    }
    result.ok()
}

/// Enough of the response shape to tell an HTTP head from JSON, SSE, or a
/// binary frame.
const RESPONSE_HEAD_LOG_BYTES: usize = 16;

/// Keeps the shape of the first bytes read from a relay stream for the failure
/// log. Letters and digits are masked (`x`, `0`) so no secret reaches the log;
/// punctuation, control, and binary bytes are kept.
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
        head.extend(read[..read.len().min(room)].iter().map(|&byte| {
            if byte.is_ascii_alphabetic() {
                b'x'
            } else if byte.is_ascii_digit() {
                b'0'
            } else {
                byte
            }
        }));
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
