//! A host that answers with non-HTTP bytes must not receive the request twice:
//! it was already delivered, and a signed resend would carry a consumed nonce
//! that the host rejects as a replay.
use std::{
    sync::{
        Arc,
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
use relay_tunnel_core::server::{SharedControl, proxy_request_over_control, run_control_channel};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::Mutex,
};
use tokio_yamux::{Config, Session};
use ws_bridge::tungstenite_ws_stream_io;

/// relay_control::signing::NONCE_HEADER (not a dependency of this crate).
const NONCE_HEADER: &str = "x-vk-sig-nonce";

type ControlSlot = Arc<Mutex<Option<SharedControl>>>;

async fn connect(State(slot): State<ControlSlot>, upgrade: WebSocketUpgrade) -> Response {
    upgrade.on_upgrade(move |socket| async move {
        let _ = run_control_channel(socket, move |control| async move {
            *slot.lock().await = Some(control);
        })
        .await;
    })
}

#[tokio::test]
async fn malformed_response_is_never_resent() {
    tokio::time::timeout(Duration::from_secs(20), run())
        .await
        .expect("malformed response test timed out");
}

async fn run() {
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
        while let Some(Ok(mut stream)) = session.next().await {
            host_delivered.fetch_add(1, Ordering::SeqCst);
            tokio::spawn(async move {
                let mut request = [0u8; 4096];
                let _ = stream.read(&mut request).await;
                let _ = stream.write_all(b"{\"not\":\"http\"}\r\n\r\n").await;
                let _ = stream.shutdown().await;
            });
        }
    });

    let control = loop {
        if let Some(control) = slot.lock().await.clone() {
            break control;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    };

    let signed = Request::builder()
        .uri("/api/workspaces?archived=false")
        .header(NONCE_HEADER, "fixture-nonce")
        .body(Body::empty())
        .unwrap();
    let response = proxy_request_over_control(&control, signed, "").await;
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    assert_eq!(delivered.swap(0, Ordering::SeqCst), 1);

    let unsigned = Request::builder()
        .uri("/preview/index.html")
        .body(Body::empty())
        .unwrap();
    let response = proxy_request_over_control(&control, unsigned, "").await;
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    assert_eq!(delivered.load(Ordering::SeqCst), 1);
}
