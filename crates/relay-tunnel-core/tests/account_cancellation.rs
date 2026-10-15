//! Exercise actual HTTP and WebSocket traffic through the production yamux
//! transport, without starting or changing any installed Vibe Kanban host.
use std::{convert::Infallible, sync::Arc, time::Duration};

use axum::{
    Router,
    body::Body,
    extract::{Request, State, ws::WebSocketUpgrade},
    response::{IntoResponse, Response},
    routing::{any, get},
};
use futures_util::{SinkExt, StreamExt};
use hyper_util::rt::TokioIo;
use relay_tunnel_core::{
    client::{RelayClientConfig, start_relay_client},
    server::{RelayCancellation, SharedControl, proxy_request_over_control, run_control_channel},
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::Mutex,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Default)]
struct TestRelay {
    control: Arc<Mutex<Option<SharedControl>>>,
    cancel: CancellationToken,
}
async fn connect(State(state): State<TestRelay>, upgrade: WebSocketUpgrade) -> Response {
    upgrade.on_upgrade(move |socket| async move {
        let _ = run_control_channel(socket, move |control| async move {
            *state.control.lock().await = Some(control);
        })
        .await;
    })
}
async fn proxy(State(state): State<TestRelay>, mut request: Request) -> Response {
    let control = state.control.lock().await.clone().unwrap();
    request
        .extensions_mut()
        .insert(RelayCancellation(state.cancel));
    proxy_request_over_control(&control, request, "/proxy").await
}
async fn websocket(upgrade: WebSocketUpgrade) -> Response {
    upgrade.on_upgrade(|mut socket| async move {
        while let Some(Ok(message)) = socket.next().await {
            if socket.send(message).await.is_err() {
                break;
            }
        }
    })
}
async fn sse() -> Response {
    let stream = futures_util::stream::once(async { Ok::<_, Infallible>("data: ready\n\n") })
        .chain(futures_util::stream::pending());
    (
        [("content-type", "text/event-stream")],
        Body::from_stream(stream),
    )
        .into_response()
}
#[tokio::test]
async fn revocation_closes_an_active_sse_body_and_both_directions_of_websocket() {
    tokio::time::timeout(Duration::from_secs(20), run_revocation())
        .await
        .expect("relay cancellation integration timed out");
}
async fn run_revocation() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let backend = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let backend_addr = backend.local_addr().unwrap();
    let backend_task = tokio::spawn(async move {
        axum::serve(
            backend,
            Router::new()
                .route("/sse", get(sse))
                .route("/ws", get(websocket)),
        )
        .await
        .unwrap();
    });
    let relay = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let relay_addr = relay.local_addr().unwrap();
    let state = TestRelay::default();
    let router = Router::new()
        .route("/connect", get(connect))
        .route("/proxy/{*path}", any(proxy))
        .with_state(state.clone());
    let relay_task = tokio::spawn(async move {
        axum::serve(relay, router).await.unwrap();
    });
    let shutdown = CancellationToken::new();
    let client_task = tokio::spawn(start_relay_client(RelayClientConfig {
        ws_url: format!("ws://{relay_addr}/connect"),
        bearer_token: "fixture-only".into(),
        local_addr: backend_addr,
        shutdown: shutdown.clone(),
    }));
    tokio::time::timeout(Duration::from_secs(10), async {
        while state.control.lock().await.is_none() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(
        TcpStream::connect(relay_addr).await.unwrap(),
    ))
    .await
    .unwrap();
    let connection_task = tokio::spawn(connection);
    let response = sender
        .send_request(
            Request::builder()
                .uri("/proxy/sse")
                .header("Host", relay_addr.to_string())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let mut events = Body::new(response.into_body()).into_data_stream();
    assert!(
        tokio::time::timeout(Duration::from_secs(3), events.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .starts_with(b"data: ready")
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{relay_addr}/proxy/ws"))
        .await
        .unwrap();
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        "before-revoke".into(),
    ))
    .await
    .unwrap();
    assert_eq!(
        ws.next().await.unwrap().unwrap().into_text().unwrap(),
        "before-revoke"
    );
    state.cancel.cancel();
    assert!(
        tokio::time::timeout(Duration::from_secs(3), events.next())
            .await
            .unwrap()
            .is_none()
    );
    let closed = tokio::time::timeout(Duration::from_secs(3), ws.next())
        .await
        .expect("revoked websocket remained open");
    assert!(matches!(
        closed,
        None | Some(Err(_)) | Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_)))
    ));
    shutdown.cancel();
    client_task.await.unwrap().unwrap();
    connection_task.abort();
    relay_task.abort();
    backend_task.abort();
}
