//! Relay failure handling over the production yamux transport: a failed
//! exchange is never resent (a signed resend carries a consumed nonce that the
//! host rejects as a replay), and each way a response breaks leaves a warning
//! that names the hop.
use std::{
    io,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use axum::{
    Router,
    body::Body,
    extract::{State, ws::WebSocketUpgrade},
    http::{Request, StatusCode},
    response::Response,
    routing::get,
};
use futures_util::StreamExt;
use relay_tunnel_core::server::{
    RelayCancellation, SharedControl, proxy_request_over_control, run_control_channel,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::Mutex,
};
use tokio_util::sync::CancellationToken;
use tokio_yamux::{Config, Session, StreamHandle};
use tracing::Instrument;
use ws_bridge::tungstenite_ws_stream_io;

/// relay_control::signing::NONCE_HEADER (not a dependency of this crate).
const NONCE_HEADER: &str = "x-vk-sig-nonce";
/// A response head that promises more body than the host sends.
const SHORT_BODY: &[u8] = b"HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\nshort";

type ControlSlot = Arc<Mutex<Option<SharedControl>>>;

#[derive(Clone, Default)]
struct Logs(Arc<StdMutex<Vec<u8>>>);

impl io::Write for Logs {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Logs {
    /// The one log line that carries both `message` and `path`.
    fn line(&self, message: &str, path: &str) -> String {
        let logs = String::from_utf8(self.0.lock().unwrap().clone()).unwrap();
        let path = format!("path={path} ");
        let lines: Vec<&str> = logs
            .lines()
            .filter(|line| line.contains(message) && line.contains(&path))
            .collect();
        assert_eq!(
            lines.len(),
            1,
            "want one `{message}` {path}line in:\n{logs}"
        );
        lines[0].to_owned()
    }
}

async fn connect(State(slot): State<ControlSlot>, upgrade: WebSocketUpgrade) -> Response {
    upgrade.on_upgrade(move |socket| async move {
        let _ = run_control_channel(socket, move |control| async move {
            *slot.lock().await = Some(control);
        })
        .await;
    })
}

/// The target host side: `/truncated` cuts its body short, `/stalled` sends
/// part of it and holds the stream open, anything else gets non-HTTP bytes.
async fn answer(mut stream: StreamHandle) {
    let mut request = [0u8; 4096];
    let read = stream.read(&mut request).await.unwrap_or(0);
    let request = String::from_utf8_lossy(&request[..read]).into_owned();
    match request.split_whitespace().nth(1) {
        Some("/stalled") => {
            let _ = stream.write_all(SHORT_BODY).await;
            std::future::pending::<()>().await;
        }
        Some("/truncated") => {
            let _ = stream.write_all(SHORT_BODY).await;
            let _ = stream.shutdown().await;
        }
        _ => {
            let _ = stream.write_all(b"{\"not\":\"http\"}\r\n\r\n").await;
            let _ = stream.shutdown().await;
        }
    }
}

async fn proxy(control: &SharedControl, request: Request<Body>) -> Response {
    proxy_request_over_control(control, request, "")
        .instrument(tracing::info_span!("relay_proxy", host_id = "fixture-host"))
        .await
}

fn get_request(path: &str) -> Request<Body> {
    Request::builder().uri(path).body(Body::empty()).unwrap()
}

#[tokio::test]
async fn failed_responses_are_never_resent_and_name_the_hop() {
    let logs = Logs::default();
    let writer = logs.clone();
    let _guard = tracing::subscriber::set_default(
        tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(move || writer.clone())
            .finish(),
    );
    tokio::time::timeout(Duration::from_secs(20), run(logs))
        .await
        .expect("relay failure test timed out");
}

async fn run(logs: Logs) {
    let relay = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let relay_addr = relay.local_addr().unwrap();
    let slot = ControlSlot::default();
    let router = Router::new()
        .route("/connect", get(connect))
        .with_state(slot.clone());
    tokio::spawn(async move { axum::serve(relay, router).await.unwrap() });

    let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{relay_addr}/connect"))
        .await
        .unwrap();
    let mut session = Session::new_client(tungstenite_ws_stream_io(ws), Config::default());
    let delivered = Arc::new(AtomicUsize::new(0));
    let host_delivered = delivered.clone();
    tokio::spawn(async move {
        while let Some(Ok(stream)) = session.next().await {
            host_delivered.fetch_add(1, Ordering::SeqCst);
            tokio::spawn(answer(stream));
        }
    });

    let control = loop {
        if let Some(control) = slot.lock().await.clone() {
            break control;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    };

    // Non-HTTP reply: 502, delivered once, logged with the masked byte shape.
    let mut signed = get_request("/api/workspaces?archived=false");
    signed
        .headers_mut()
        .insert(NONCE_HEADER, "fixture-nonce".parse().unwrap());
    let response = proxy(&control, signed).await;
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    assert_eq!(delivered.load(Ordering::SeqCst), 1);
    let line = logs.line("relay proxy request failed", "/api/workspaces");
    assert!(line.contains("Parse(Version)"), "{line}");
    assert!(line.contains("fixture-host"), "{line}");
    assert!(line.contains("stream_id="), "{line}");
    assert!(
        line.contains(r#"response_head={\"xxx\":\"xxxx\"}\r\n"#),
        "{line}"
    );
    assert!(!line.contains("not"), "response text leaked: {line}");

    let response = proxy(&control, get_request("/preview/index.html")).await;
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    assert_eq!(delivered.load(Ordering::SeqCst), 2);

    // Upstream body breaks after 5 bytes.
    let response = proxy(&control, get_request("/truncated")).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .is_err()
    );
    let line = logs.line("relay response body interrupted", "/truncated");
    assert!(line.contains("bytes_sent=5"), "{line}");
    assert!(line.contains("fixture-host"), "{line}");

    // The relay itself cuts the body when access is cancelled.
    let cancel = CancellationToken::new();
    let mut stalled = get_request("/stalled");
    stalled
        .extensions_mut()
        .insert(RelayCancellation(cancel.clone()));
    let response = proxy(&control, stalled).await;
    let mut body = response.into_body().into_data_stream();
    assert_eq!(&body.next().await.unwrap().unwrap()[..], b"short");
    cancel.cancel();
    assert!(body.next().await.is_none());
    let line = logs.line("relay response body cut off", "/stalled");
    assert!(line.contains("bytes_sent=5"), "{line}");
    assert!(line.contains("fixture-host"), "{line}");

    assert_eq!(delivered.load(Ordering::SeqCst), 4, "a request was resent");
}
