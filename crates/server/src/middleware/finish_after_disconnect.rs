use axum::{
    extract::Request,
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};
use deployment::{ACCOUNT_HOST_REQUEST, account_host_request};
use tracing::Instrument;

/// Run the handler to completion even if the client goes away. Axum drops a
/// handler's future when its connection closes: a send cut off between creating
/// the turn's row and spawning its agent left the turn "running" with nothing
/// behind it, one cut off earlier lost the message, and a stop cut off midway
/// marked the turn killed without killing it. For routes that start or stop
/// processes.
pub async fn finish_after_disconnect(request: Request, next: Next) -> Response {
    // A spawned task inherits neither task-locals nor the span: carry over the
    // account-host gate on the host's cloud session and the request's span.
    let account_host = account_host_request();
    let handler = async move {
        match account_host {
            Some(scope) => ACCOUNT_HOST_REQUEST.scope(scope, next.run(request)).await,
            None => next.run(request).await,
        }
    };
    match tokio::spawn(handler.in_current_span()).await {
        Ok(response) => response,
        Err(error) => {
            tracing::error!(%error, "Request handler task failed");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
        time::Duration,
    };

    use axum::{
        Router,
        extract::Request,
        middleware::{Next, from_fn},
        routing::post,
    };
    use deployment::AccountHostRequest;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpStream,
    };

    use super::{ACCOUNT_HOST_REQUEST, finish_after_disconnect};

    #[tokio::test]
    async fn handler_keeps_the_account_host_gate() {
        let route = post(|| async {
            ACCOUNT_HOST_REQUEST
                .try_with(|active| active.host_owner.to_string())
                .unwrap_or_default()
        })
        .layer(from_fn(finish_after_disconnect));
        let app = Router::new()
            .route("/", route)
            .layer(from_fn(|request: Request, next: Next| {
                ACCOUNT_HOST_REQUEST
                    .scope(AccountHostRequest { host_owner: true }, next.run(request))
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(axum::serve(listener, app).into_future());

        let mut client = TcpStream::connect(addr).await.unwrap();
        client
            .write_all(
                b"POST / HTTP/1.1\r\nhost: test\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
            )
            .await
            .unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).await.unwrap();
        assert!(response.ends_with("\r\n\r\ntrue"), "{response}");
    }

    /// Whether a slow handler still finished after its client hung up.
    async fn finished_after_client_left(detached: bool) -> bool {
        let finished = Arc::new(AtomicBool::new(false));
        let flag = finished.clone();
        let route = post(move || async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            flag.store(true, Ordering::SeqCst);
        });
        let route = if detached {
            route.layer(from_fn(finish_after_disconnect))
        } else {
            route
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(axum::serve(listener, Router::new().route("/", route)).into_future());

        let mut client = TcpStream::connect(addr).await.unwrap();
        client
            .write_all(b"POST / HTTP/1.1\r\nhost: test\r\ncontent-length: 0\r\n\r\n")
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        drop(client);
        tokio::time::sleep(Duration::from_millis(400)).await;
        finished.load(Ordering::SeqCst)
    }

    #[tokio::test]
    async fn handler_finishes_after_the_client_disconnects() {
        // Without the layer axum drops the handler with the connection.
        assert!(!finished_after_client_left(false).await);
        assert!(finished_after_client_left(true).await);
    }
}
