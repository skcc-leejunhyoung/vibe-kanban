use axum::{
    extract::Request,
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};

/// Run the handler to completion even if the client goes away. Axum drops a
/// handler's future when its connection closes: a send cut off between creating
/// the turn's row and spawning its agent left the turn "running" with nothing
/// behind it, one cut off earlier lost the message, and a stop cut off midway
/// marked the turn killed without killing it. For routes that start or stop
/// processes.
pub async fn finish_after_disconnect(request: Request, next: Next) -> Response {
    match tokio::spawn(next.run(request)).await {
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

    use axum::{Router, middleware::from_fn, routing::post};
    use tokio::{io::AsyncWriteExt, net::TcpStream};

    use super::finish_after_disconnect;

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
