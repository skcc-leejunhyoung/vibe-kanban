pub mod config;
pub mod handler;
pub mod sftp;

use std::sync::Arc;

use relay_control::signing::RelaySigningService;
use tokio::io::{AsyncRead, AsyncWrite};

/// Run an SSH server session over the given stream.
///
/// The stream is typically an axum WebSocket wrapped in `AxumWsStreamIo`.
/// Authentication checks the connecting client's Ed25519 public key against
/// active relay signing sessions.
pub async fn run_ssh_session(
    stream: impl AsyncRead + AsyncWrite + Unpin + Send + 'static,
    config: Arc<russh::server::Config>,
    relay_signing: RelaySigningService,
) -> anyhow::Result<()> {
    let handler = handler::SshSessionHandler::new(relay_signing);
    let session = russh::server::run_stream(config, stream, handler).await?;
    session.await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::SigningKey;
    use russh::{
        client,
        keys::{
            PrivateKey, PrivateKeyWithHashAlg, PublicKeyOrCertificate,
            ssh_key::private::{Ed25519PrivateKey, KeypairData},
        },
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    struct Client;
    impl client::Handler for Client {
        type Error = russh::Error;
        async fn check_server_key(
            &mut self,
            _: &PublicKeyOrCertificate,
        ) -> Result<bool, Self::Error> {
            Ok(true)
        }
    }

    #[tokio::test]
    async fn registered_key_opens_sessions_and_only_loopback_forwarding() {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            let host = SigningKey::from_bytes(&[7; 32]);
            let peer = SigningKey::from_bytes(&[8; 32]);
            let signing = RelaySigningService::new(host.clone());
            signing.create_session(peer.verifying_key()).await;
            let (client_io, server_io) = tokio::io::duplex(65_536);
            let server = tokio::spawn(run_ssh_session(
                server_io,
                config::build_config(&host),
                signing,
            ));
            let mut client =
                client::connect_stream(Arc::new(client::Config::default()), client_io, Client)
                    .await
                    .unwrap();
            let key = PrivateKey::new(
                KeypairData::Ed25519(Ed25519PrivateKey::from_bytes(&peer.to_bytes()).into()),
                "",
            )
            .unwrap();
            assert!(
                client
                    .authenticate_publickey("test", PrivateKeyWithHashAlg::new(Arc::new(key), None))
                    .await
                    .unwrap()
                    .success()
            );
            let channel = client.channel_open_session().await.unwrap();
            channel.close().await.unwrap();
            assert!(
                client
                    .channel_open_direct_tcpip("192.0.2.1", 80, "127.0.0.1", 1234)
                    .await
                    .is_err()
            );
            assert!(
                client
                    .channel_open_direct_tcpip("127.0.0.1", 0, "127.0.0.1", 1234)
                    .await
                    .is_err()
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let echo = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut bytes = [0; 4];
                stream.read_exact(&mut bytes).await.unwrap();
                assert_eq!(&bytes, b"ping");
                stream.write_all(b"pong").await.unwrap();
            });
            let channel = client
                .channel_open_direct_tcpip("127.0.0.1", port.into(), "127.0.0.1", 1234)
                .await
                .unwrap();
            let mut stream = channel.into_stream();
            stream.write_all(b"ping").await.unwrap();
            let mut bytes = [0; 4];
            stream.read_exact(&mut bytes).await.unwrap();
            assert_eq!(&bytes, b"pong");
            echo.await.unwrap();
            client
                .disconnect(russh::Disconnect::ByApplication, "done", "en")
                .await
                .unwrap();
            let _ = server.await.unwrap();
        })
        .await
        .unwrap();
    }
}
