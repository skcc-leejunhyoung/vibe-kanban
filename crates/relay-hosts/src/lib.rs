use std::{
    collections::HashMap,
    io,
    pin::Pin,
    sync::Arc,
    time::{Duration, Instant},
};

use axum::extract::ws::WebSocket as AxumWebSocket;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use bytes::Bytes;
use chrono::{DateTime, Utc};
use futures_util::{Stream, StreamExt, stream};
use http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header};
pub use relay_client::RelayApiError;
use relay_client::{RelayApiClient, RelayHostIdentity, RelayHostTransport};
use relay_control::signing::{
    NONCE_HEADER, REQUEST_SIGNATURE_HEADER, RelaySigningService, SIGNING_SESSION_HEADER,
    TIMESTAMP_HEADER,
};
use relay_types::{
    OpenHostConnectionRequest, PairRelayHostRequest, RelayAuthState, RelayHost as CloudHost,
    RelayPairedHost, RemoteSession,
};
use relay_webrtc::{DataChannelResponse, DataChannelWsStream, WebRtcClient};
use relay_ws::SignedTungsteniteSocket;
use remote_info::RemoteInfo;
use serde::{Deserialize, Serialize};
use services::services::remote_client::{RemoteClient, RemoteClientError};
use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;
use trusted_key_auth::trusted_keys::parse_public_key_base64;
use utils::{assets::relay_host_credentials_path, response::ApiResponse};
use uuid::Uuid;

mod tunnel_manager;
mod webrtc_cache;
use tunnel_manager::TunnelManager;
use webrtc_cache::WebRtcConnectionCache;
use ws_bridge::{WsBridgeError, bridge_axum_ws, tungstenite_ws_stream_io};

#[derive(Debug, Clone, Default)]
struct RelaySessionCacheEntry {
    remote_session_id: Option<Uuid>,
    signing_session_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RelayHostCredentials {
    pub host_name: Option<String>,
    pub paired_at: Option<String>,
    pub client_id: Option<String>,
    pub server_public_key_b64: Option<String>,
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum RelayHostLookupError {
    #[error("No paired relay credentials for this host")]
    NotPaired,
    #[error("This host pairing is missing required client metadata. Re-pair it.")]
    MissingClientMetadata,
    #[error("This host pairing is missing required signing metadata. Re-pair it.")]
    MissingSigningMetadata,
    #[error("This account has no access to the host, or its remote access is off")]
    AccessDenied,
    #[error("The host is switching to account access; retry shortly")]
    Migrating,
    #[error("Cannot look up the host: {0}")]
    Unavailable(String),
}

#[derive(Debug, thiserror::Error)]
pub enum RelayConnectionError {
    #[error("Remote relay API is not configured")]
    NotConfigured,
    #[error(transparent)]
    RemoteClient(#[from] RemoteClientError),
    #[error(transparent)]
    Relay(#[from] RelayApiError),
}

#[derive(Debug, thiserror::Error)]
enum NegotiateWebRtcError {
    #[error(transparent)]
    WebRtcClient(#[from] relay_webrtc::WebRtcClientError),
    #[error(transparent)]
    Serialize(#[from] serde_json::Error),
    #[error(transparent)]
    Relay(#[from] RelayApiError),
    #[error("WebRTC offer rejected with status {0}")]
    OfferRejected(StatusCode),
    #[error(transparent)]
    AnswerResponse(#[from] reqwest::Error),
}

#[derive(Clone)]
struct RelayHostRepository {
    credentials: Arc<RwLock<HashMap<Uuid, RelayHostCredentials>>>,
}

impl RelayHostRepository {
    async fn load() -> Self {
        Self {
            credentials: Arc::new(RwLock::new(load_relay_host_credentials_map().await)),
        }
    }

    async fn upsert_credentials(
        &self,
        host_id: Uuid,
        host_name: Option<String>,
        paired_at: Option<String>,
        client_id: Option<String>,
        server_public_key_b64: Option<String>,
    ) -> Result<(), RelayPairingClientError> {
        let mut credentials = self.credentials.write().await;
        let existing = credentials.get(&host_id).cloned();
        credentials.insert(
            host_id,
            RelayHostCredentials {
                host_name: host_name
                    .or_else(|| existing.as_ref().and_then(|value| value.host_name.clone())),
                paired_at: paired_at
                    .or_else(|| existing.as_ref().and_then(|value| value.paired_at.clone())),
                client_id: client_id
                    .or_else(|| existing.as_ref().and_then(|value| value.client_id.clone())),
                server_public_key_b64: server_public_key_b64.or_else(|| {
                    existing
                        .as_ref()
                        .and_then(|value| value.server_public_key_b64.clone())
                }),
            },
        );

        persist_relay_host_credentials_map(&credentials).await
    }

    async fn list_hosts(&self) -> Vec<RelayPairedHost> {
        self.credentials
            .read()
            .await
            .iter()
            .map(|(host_id, value)| RelayPairedHost {
                host_id: *host_id,
                host_name: value.host_name.clone(),
                paired_at: value.paired_at.clone(),
            })
            .collect()
    }

    async fn remove_credentials(&self, host_id: Uuid) -> Result<bool, RelayPairingClientError> {
        let mut credentials = self.credentials.write().await;
        let removed = credentials.remove(&host_id).is_some();

        if removed {
            persist_relay_host_credentials_map(&credentials).await?;
        }

        Ok(removed)
    }

    async fn load_identity(
        &self,
        host_id: Uuid,
    ) -> Result<RelayHostIdentity, RelayHostLookupError> {
        let credentials = self
            .credentials
            .read()
            .await
            .get(&host_id)
            .cloned()
            .ok_or(RelayHostLookupError::NotPaired)?;

        let client_id = credentials
            .client_id
            .as_ref()
            .and_then(|value| value.parse::<Uuid>().ok())
            .ok_or(RelayHostLookupError::MissingClientMetadata)?;
        let server_verify_key = credentials
            .server_public_key_b64
            .as_deref()
            .and_then(|key| parse_public_key_base64(key).ok())
            .ok_or(RelayHostLookupError::MissingSigningMetadata)?;

        Ok(RelayHostIdentity {
            host_id,
            client_id,
            server_verify_key,
        })
    }
}

#[derive(Clone, Default)]
struct RelaySessionCache {
    auth_state: Arc<RwLock<HashMap<Uuid, RelaySessionCacheEntry>>>,
}

impl RelaySessionCache {
    async fn load_auth_state(&self, host_id: Uuid) -> Option<RelayAuthState> {
        let sessions = self.auth_state.read().await;
        let entry = sessions.get(&host_id)?;
        let remote_session_id = entry.remote_session_id?;
        let signing_session_id = entry.signing_session_id?;

        Some(RelayAuthState {
            remote_session: RemoteSession {
                host_id,
                id: remote_session_id,
            },
            signing_session_id,
        })
    }

    async fn cache_auth_state(&self, host_id: Uuid, auth_state: &RelayAuthState) {
        let mut sessions = self.auth_state.write().await;
        let entry = sessions.entry(host_id).or_default();
        entry.remote_session_id = Some(auth_state.remote_session.id);
        entry.signing_session_id = Some(auth_state.signing_session_id);
    }

    async fn cache_signing_session_id(&self, host_id: Uuid, session_id: Uuid) {
        self.auth_state
            .write()
            .await
            .entry(host_id)
            .or_default()
            .signing_session_id = Some(session_id);
    }

    async fn clear(&self, host_id: Uuid) {
        self.auth_state.write().await.remove(&host_id);
    }
}

/// Central host list: decides account vs. legacy per host. Holding the lock
/// while fetching makes concurrent lookups share one request.
#[derive(Clone, Default)]
struct CloudHostCache(Arc<Mutex<Option<CachedCloudHosts>>>);

type CachedCloudHosts = (Instant, Vec<CloudHost>);

const CLOUD_HOSTS_TTL: Duration = Duration::from_secs(30);

impl CloudHostCache {
    async fn get(&self, remote_client: &RemoteClient) -> Result<Vec<CloudHost>, RemoteClientError> {
        let mut cache = self.0.lock().await;
        if let Some((fetched_at, hosts)) = cache.as_ref()
            && fetched_at.elapsed() < CLOUD_HOSTS_TTL
        {
            return Ok(hosts.clone());
        }
        let hosts = remote_client.list_relay_hosts().await?;
        *cache = Some((Instant::now(), hosts.clone()));
        Ok(hosts)
    }
}

/// An approved connection to one account host. Its ephemeral key and id are
/// reused on refresh so the host keeps the session.
#[derive(Clone)]
struct AccountConnection {
    /// Cache namespace (token subject), not authorization.
    owner: Option<Uuid>,
    connection_id: Uuid,
    signing: RelaySigningService,
    expires_at: DateTime<Utc>,
}

/// Refresh this long before the central grant expires.
const ACCOUNT_REFRESH_LEEWAY_SECS: i64 = 60;

impl AccountConnection {
    fn is_fresh(&self, now: DateTime<Utc>) -> bool {
        self.expires_at - chrono::Duration::seconds(ACCOUNT_REFRESH_LEEWAY_SECS) > now
    }
}

/// One slot per host; holding a slot while opening makes concurrent callers
/// share one approval.
#[derive(Clone, Default)]
struct AccountConnections(Arc<Mutex<HashMap<Uuid, AccountSlot>>>);

type AccountSlot = Arc<Mutex<Option<AccountConnection>>>;

impl AccountConnections {
    async fn slot(&self, host_id: Uuid) -> AccountSlot {
        self.0.lock().await.entry(host_id).or_default().clone()
    }
}

/// A host listed for `vk hosts list` / MCP `list_workspace_hosts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReachableHost {
    pub host_id: Uuid,
    pub host_name: Option<String>,
    pub status: Option<String>,
    pub auth_mode: Option<String>,
}

pub type ProxiedBodyStream = Pin<Box<dyn Stream<Item = Result<Bytes, io::Error>> + Send>>;

/// Normalized HTTP response returned from relay-hosts, independent of whether
/// the upstream transport was relay or WebRTC.
pub struct ProxiedResponse {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: ProxiedBodyStream,
}

#[derive(Clone)]
pub struct RelayHosts {
    repository: RelayHostRepository,
    sessions: RelaySessionCache,
    runtime: RelayRuntime,
    webrtc: WebRtcConnectionCache,
    cloud_hosts: CloudHostCache,
    accounts: AccountConnections,
}

#[derive(Clone)]
struct RelayRuntime {
    remote_client: RemoteClient,
    remote_info: RemoteInfo,
    relay_signing: RelaySigningService,
    tunnel_manager: TunnelManager,
}

#[derive(Clone)]
pub struct RelayHost {
    host_id: Uuid,
    /// Saved pairing for legacy hosts; `None` for account hosts.
    identity: Option<RelayHostIdentity>,
    sessions: RelaySessionCache,
    runtime: RelayRuntime,
    webrtc: WebRtcConnectionCache,
    accounts: AccountConnections,
}

/// A WebSocket connection proxied upstream (via relay, WebRTC, etc.).
pub struct ProxiedWsConnection {
    pub selected_protocol: Option<String>,
    upstream: UpstreamWs,
}

/// The upstream WebSocket transport, either via the relay or a direct WebRTC
/// data channel.
enum UpstreamWs {
    Relay(Box<SignedTungsteniteSocket>),
    WebRtc(DataChannelWsStream),
}

impl ProxiedWsConnection {
    pub async fn bridge(self, client_socket: AxumWebSocket) -> Result<(), WsBridgeError> {
        match self.upstream {
            UpstreamWs::Relay(socket) => bridge_axum_ws(client_socket, socket).await?,
            UpstreamWs::WebRtc(stream) => bridge_axum_ws(client_socket, stream).await?,
        }

        Ok(())
    }

    pub async fn bridge_tcp(self, mut tcp_stream: tokio::net::TcpStream) -> Result<(), io::Error> {
        match self.upstream {
            UpstreamWs::Relay(socket) => {
                let mut ws_io = tungstenite_ws_stream_io(socket);
                tokio::io::copy_bidirectional(&mut tcp_stream, &mut ws_io).await?;
            }
            UpstreamWs::WebRtc(stream) => {
                let mut ws_io = tungstenite_ws_stream_io(stream);
                tokio::io::copy_bidirectional(&mut tcp_stream, &mut ws_io).await?;
            }
        }

        Ok(())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RelayPairingClientError {
    #[error("Remote relay API is not configured")]
    NotConfigured,
    #[error("Relay host pairing authentication failed: {0}")]
    RemoteClient(#[from] RemoteClientError),
    #[error("Relay host pairing failed: {0}")]
    Pairing(RelayApiError),
    #[error("Failed to serialize relay host credentials: {0}")]
    StoreSerialization(serde_json::Error),
    #[error("Failed to persist relay host credentials: {0}")]
    Store(std::io::Error),
}

impl RelayHosts {
    pub async fn load(
        remote_client: RemoteClient,
        remote_info: RemoteInfo,
        relay_signing: RelaySigningService,
        shutdown: CancellationToken,
    ) -> Self {
        Self {
            repository: RelayHostRepository::load().await,
            sessions: RelaySessionCache::default(),
            runtime: RelayRuntime {
                remote_client,
                remote_info,
                relay_signing,
                tunnel_manager: TunnelManager::new(shutdown.clone()),
            },
            webrtc: WebRtcConnectionCache::new(shutdown),
            cloud_hosts: CloudHostCache::default(),
            accounts: AccountConnections::default(),
        }
    }

    /// Account hosts connect with this backend's account; legacy hosts with
    /// the pairing saved here. Without the central list only a pairing works.
    pub async fn host(&self, host_id: Uuid) -> Result<RelayHost, RelayHostLookupError> {
        let identity = match self.cloud_hosts.get(&self.runtime.remote_client).await {
            Ok(hosts) if is_account_host(&hosts, host_id)? => None,
            Ok(_) => Some(self.repository.load_identity(host_id).await?),
            Err(error) => Some(
                self.repository
                    .load_identity(host_id)
                    .await
                    .map_err(|_| RelayHostLookupError::Unavailable(error.to_string()))?,
            ),
        };
        Ok(RelayHost {
            host_id,
            identity,
            sessions: self.sessions.clone(),
            runtime: self.runtime.clone(),
            webrtc: self.webrtc.clone(),
            accounts: self.accounts.clone(),
        })
    }

    /// Hosts [`Self::host`] can open: the account's cloud hosts under their
    /// real names, minus legacy hosts not paired here. Without the central
    /// list, the saved pairings.
    pub async fn reachable_hosts(&self) -> Vec<ReachableHost> {
        let paired = self.list_hosts().await;
        match self.cloud_hosts.get(&self.runtime.remote_client).await {
            Ok(hosts) => hosts
                .into_iter()
                .filter(|host| {
                    host.auth_mode != "legacy_pairing"
                        || paired.iter().any(|pair| pair.host_id == host.id)
                })
                .map(|host| ReachableHost {
                    host_id: host.id,
                    host_name: Some(host.name),
                    status: Some(host.status),
                    auth_mode: Some(host.auth_mode),
                })
                .collect(),
            Err(error) => {
                tracing::debug!(%error, "central host list unavailable; listing pairings");
                paired
                    .into_iter()
                    .map(|pair| ReachableHost {
                        host_id: pair.host_id,
                        host_name: pair.host_name,
                        status: None,
                        auth_mode: None,
                    })
                    .collect()
            }
        }
    }

    pub async fn pair_host(
        &self,
        req: &PairRelayHostRequest,
    ) -> Result<(), RelayPairingClientError> {
        let remote_client = self.runtime.remote_client.clone();
        let relay_base_url = self
            .runtime
            .remote_info
            .get_relay_api_base()
            .ok_or(RelayPairingClientError::NotConfigured)?;
        let access_token = remote_client.access_token().await?;
        let relay_client = RelayApiClient::new(
            relay_base_url,
            access_token,
            self.runtime.relay_signing.clone(),
        )
        .map_err(RelayPairingClientError::Pairing)?;
        let relay_client::PairRelayHostResult {
            signing_session_id,
            client_id,
            server_public_key_b64,
        } = relay_client
            .pair_host(req)
            .await
            .map_err(RelayPairingClientError::Pairing)?;

        self.repository
            .upsert_credentials(
                req.host_id,
                Some(req.host_name.clone()),
                Some(Utc::now().to_rfc3339()),
                Some(client_id.to_string()),
                Some(server_public_key_b64),
            )
            .await?;
        self.sessions
            .cache_signing_session_id(req.host_id, signing_session_id)
            .await;
        Ok(())
    }

    pub async fn list_hosts(&self) -> Vec<RelayPairedHost> {
        let mut hosts = self.repository.list_hosts().await;
        hosts.sort_by(|a, b| b.paired_at.cmp(&a.paired_at));
        hosts
    }

    pub async fn remove_host(&self, host_id: Uuid) -> Result<bool, RelayPairingClientError> {
        let removed = self.repository.remove_credentials(host_id).await?;
        if removed {
            self.sessions.clear(host_id).await;
            self.webrtc.remove(host_id).await;
            self.runtime.tunnel_manager.cancel_tunnel(host_id).await;
        }
        Ok(removed)
    }
}

impl RelayHost {
    async fn open_relay_transport(&self) -> Result<RelayHostTransport, RelayConnectionError> {
        let Some(identity) = &self.identity else {
            return self.open_account_transport(false).await;
        };
        let remote_client = self.runtime.remote_client.clone();
        let relay_base_url = self
            .runtime
            .remote_info
            .get_relay_api_base()
            .ok_or(RelayConnectionError::NotConfigured)?;
        let access_token = remote_client.access_token().await?;
        let cached_auth_state = self.sessions.load_auth_state(self.host_id).await;
        let relay_client = RelayApiClient::new(
            relay_base_url,
            access_token,
            self.runtime.relay_signing.clone(),
        )?;
        let transport = RelayHostTransport::bootstrap(
            relay_client,
            identity.clone(),
            cached_auth_state
                .as_ref()
                .map(|value| value.remote_session.clone()),
            cached_auth_state.map(|value| value.signing_session_id),
        )
        .await?;

        Ok(transport)
    }

    /// Reuse the cached approval until a minute before it expires; otherwise
    /// approve centrally and prove the key to the host (as the web app does).
    async fn open_account_transport(
        &self,
        refresh: bool,
    ) -> Result<RelayHostTransport, RelayConnectionError> {
        let relay_base_url = self
            .runtime
            .remote_info
            .get_relay_api_base()
            .ok_or(RelayConnectionError::NotConfigured)?;
        let remote_client = &self.runtime.remote_client;
        let access_token = remote_client.access_token().await?;
        let owner = utils::jwt::extract_subject(&access_token).ok();
        let slot = self.accounts.slot(self.host_id).await;
        let mut slot = slot.lock().await;
        let cached = slot.clone().filter(|cached| cached.owner == owner);
        if let Some(cached) = &cached
            && !refresh
            && cached.is_fresh(Utc::now())
        {
            let client = RelayApiClient::new(relay_base_url, access_token, cached.signing.clone())?;
            return Ok(RelayHostTransport::account(
                client,
                self.host_id,
                cached.connection_id,
            ));
        }

        let signing = cached
            .as_ref()
            .map_or_else(RelaySigningService::ephemeral, |cached| {
                cached.signing.clone()
            });
        let public_key_b64 = BASE64_STANDARD.encode(signing.server_public_key().as_bytes());
        let open = |connection_id: Option<Uuid>| {
            let request = OpenHostConnectionRequest {
                public_key_b64: public_key_b64.clone(),
                connection_id,
            };
            async move {
                remote_client
                    .open_host_connection(self.host_id, &request)
                    .await
            }
        };
        let opened = async {
            let approval =
                open_or_replace(cached.as_ref().map(|cached| cached.connection_id), open).await?;
            // Keep the approved id even if the host step fails: a retry then
            // renews it instead of opening yet another connection. Stale
            // until the host accepts it.
            *slot = Some(AccountConnection {
                owner,
                connection_id: approval.connection_id,
                signing: signing.clone(),
                expires_at: Utc::now(),
            });
            let client = RelayApiClient::new(relay_base_url, access_token, signing.clone())?;
            let session = client
                .start_account_session(self.host_id, approval.connection_id, &approval.grant)
                .await?;
            Ok::<_, RelayConnectionError>((approval, client, session.signing_session_id))
        }
        .await;
        match opened {
            Ok((approval, client, session_id)) => {
                if let Some(connection) = slot.as_mut() {
                    connection.expires_at = approval.expires_at;
                }
                Ok(RelayHostTransport::account(
                    client,
                    self.host_id,
                    session_id,
                ))
            }
            Err(error) => {
                // Revoked access drops the key; network failures keep it.
                if is_account_rejection(&error) {
                    *slot = None;
                }
                Err(error)
            }
        }
    }

    async fn send_http_via_relay(
        &self,
        method: &Method,
        target_path: &str,
        headers: &HeaderMap,
        body: &[u8],
    ) -> Result<ProxiedResponse, RelayConnectionError> {
        let mut transport = self.open_relay_transport().await?;
        let mut result = transport
            .send_http(method, target_path, headers, body)
            .await;
        if self.identity.is_none() {
            // The host forgets account sessions on restart. Reopen, but resend
            // only reads: a write whose outcome is unknown is never repeated.
            if result
                .as_ref()
                .is_ok_and(|response| response.status() == StatusCode::UNAUTHORIZED)
            {
                let reopened = self.open_account_transport(true).await;
                if let Ok(mut transport) = reopened
                    && matches!(*method, Method::GET | Method::HEAD)
                {
                    result = transport
                        .send_http(method, target_path, headers, body)
                        .await;
                }
            }
        } else {
            self.persist_auth_state(&transport).await;
            if result.is_ok() {
                self.maybe_start_webrtc(transport).await;
            }
        }
        let response = result.map_err(RelayConnectionError::from)?;
        let status = response.status();
        let headers = response.headers().clone();
        let body = Box::pin(
            response
                .bytes_stream()
                .map(|chunk| chunk.map_err(|e| io::Error::other(e.to_string()))),
        );

        Ok(ProxiedResponse {
            status,
            headers,
            body,
        })
    }

    async fn connect_ws_via_relay(
        &self,
        target_path: &str,
        protocols: Option<&str>,
    ) -> Result<ProxiedWsConnection, RelayConnectionError> {
        // A handshake cannot surface a 401 for a retry, so account hosts
        // reopen first: the host may have restarted and forgotten the session.
        // ponytail: streams outlive the 5-minute grant only via legacy pairing;
        // add a background refresh when a backend stream to an account host
        // must last longer.
        if self.identity.is_none() {
            let mut transport = self.open_account_transport(true).await?;
            let (upstream_socket, selected_protocol) =
                transport.connect_ws(target_path, protocols).await?;
            return Ok(ProxiedWsConnection {
                selected_protocol,
                upstream: UpstreamWs::Relay(Box::new(upstream_socket)),
            });
        }
        let mut transport = self.open_relay_transport().await?;
        let result = transport.connect_ws(target_path, protocols).await;
        self.persist_auth_state(&transport).await;
        if result.is_ok() {
            self.maybe_start_webrtc(transport).await;
        }
        let (upstream_socket, selected_protocol) = result.map_err(RelayConnectionError::from)?;
        Ok(ProxiedWsConnection {
            selected_protocol,
            upstream: UpstreamWs::Relay(Box::new(upstream_socket)),
        })
    }

    async fn persist_auth_state(&self, transport: &RelayHostTransport) {
        self.sessions
            .cache_auth_state(self.host_id, transport.auth_state())
            .await;
    }

    pub async fn proxy_http(
        &self,
        method: &Method,
        target_path: &str,
        headers: &HeaderMap,
        body: &[u8],
    ) -> Result<ProxiedResponse, RelayConnectionError> {
        // Server-Sent Events are an unbounded streaming response, but the WebRTC
        // data channel proxies HTTP as a single buffered request/response
        // (`send_request` waits for the full body). A stream never completes, so
        // the request would hang forever. Force the relay tunnel, which streams
        // the response body incrementally.
        // Account hosts are relay-only, like the web app: a WebRTC channel left
        // from an earlier pairing would sign with a session the host rejects.
        if self.identity.is_some() && !is_event_stream_request(headers) {
            // Try direct WebRTC data channel first.
            if let Some(response) = self
                .try_webrtc_proxy(method, target_path, headers, body)
                .await
            {
                return Ok(response);
            }
        }

        self.send_http_via_relay(method, target_path, headers, body)
            .await
    }

    /// Try to proxy through an active WebRTC data channel. Returns `None`
    /// if there's no active connection or the request fails. On failure the
    /// client marks itself as disconnected so the cache skips it next time.
    async fn try_webrtc_proxy(
        &self,
        method: &Method,
        target_path: &str,
        headers: &HeaderMap,
        body: &[u8],
    ) -> Option<ProxiedResponse> {
        let client = self.webrtc.get(self.host_id).await?;

        // The host re-adds the `x-vk-relayed` marker to WebRTC-forwarded
        // requests (see relay-webrtc peer proxy), so its backend enforces
        // `require_relay_request_signature` on them exactly like relay-tunnel
        // requests. Sign here with the same scheme as `send_http_once`;
        // without a cached signing session we can't sign, so skip WebRTC and
        // let the relay-tunnel fallback establish one.
        let signing_session_id = self
            .sessions
            .load_auth_state(self.host_id)
            .await?
            .signing_session_id;
        let signature = self.runtime.relay_signing.sign_request(
            signing_session_id,
            method.as_str(),
            target_path,
            body,
        );

        let mut header_map: HashMap<String, Vec<String>> = HashMap::new();
        for (key, value) in headers {
            if let Ok(v) = value.to_str() {
                header_map
                    .entry(key.to_string())
                    .or_default()
                    .push(v.to_string());
            }
        }
        header_map.insert(
            SIGNING_SESSION_HEADER.to_string(),
            vec![signature.signing_session_id.to_string()],
        );
        header_map.insert(
            TIMESTAMP_HEADER.to_string(),
            vec![signature.timestamp.to_string()],
        );
        header_map.insert(NONCE_HEADER.to_string(), vec![signature.nonce.to_string()]);
        header_map.insert(
            REQUEST_SIGNATURE_HEADER.to_string(),
            vec![signature.signature_b64.clone()],
        );

        let body_vec = if body.is_empty() {
            None
        } else {
            Some(body.to_vec())
        };

        let response = client
            .send_request(method.as_ref(), target_path, header_map, body_vec)
            .await
            .ok()?;

        decode_webrtc_http_response(response)
    }

    /// Kick off a background WebRTC handshake if we don't already have a
    /// direct connection to this host. Reuses the provided transport so
    /// no extra relay sessions are created.
    async fn maybe_start_webrtc(&self, transport: RelayHostTransport) {
        let host_id = self.host_id;

        if !self.webrtc.start_connecting(host_id).await {
            return;
        }

        let webrtc = self.webrtc.clone();
        let panic_webrtc = webrtc.clone();
        let shutdown = self.webrtc.child_token();

        let handle = tokio::spawn(async move {
            match negotiate_webrtc(transport, shutdown).await {
                Ok(client)
                    if client
                        .wait_until_connected(std::time::Duration::from_secs(5))
                        .await =>
                {
                    webrtc.insert(host_id, Arc::new(client)).await;
                    tracing::debug!(%host_id, "WebRTC direct connection established");
                }
                Ok(client) => {
                    tracing::debug!(
                        %host_id,
                        "WebRTC data channel did not open before timeout"
                    );
                    client.shutdown().await;
                    webrtc.mark_failed(host_id).await;
                }
                Err(e) => {
                    tracing::debug!(?e, %host_id, "WebRTC handshake failed (relay fallback active)");
                    webrtc.mark_failed(host_id).await;
                }
            }
        });

        // If the spawned task panics, ensure the cache transitions out of
        // `Connecting` so future attempts are not permanently blocked.
        tokio::spawn(async move {
            if handle.await.is_err() {
                tracing::warn!(%host_id, "WebRTC negotiation task panicked, marking as failed");
                panic_webrtc.mark_failed(host_id).await;
            }
        });
    }

    pub async fn proxy_ws(
        &self,
        target_path: &str,
        protocols: Option<&str>,
    ) -> Result<ProxiedWsConnection, RelayConnectionError> {
        // Try direct WebRTC data channel first.
        if self.identity.is_some()
            && let Some(conn) = self.try_webrtc_ws(target_path, protocols).await
        {
            return Ok(conn);
        }

        self.connect_ws_via_relay(target_path, protocols).await
    }

    /// Try to open a WebSocket through an active WebRTC data channel.
    async fn try_webrtc_ws(
        &self,
        target_path: &str,
        protocols: Option<&str>,
    ) -> Option<ProxiedWsConnection> {
        let client = self.webrtc.get(self.host_id).await?;
        let ws = match client.open_ws(target_path, protocols).await {
            Ok(Ok(conn)) => conn,
            Ok(Err(reason)) => {
                tracing::debug!(
                    host_id = %self.host_id,
                    %reason,
                    "Remote host WS open failed, falling back to relay"
                );
                return None;
            }
            Err(e) => {
                tracing::debug!(
                    ?e,
                    host_id = %self.host_id,
                    "WebRTC WS transport error, falling back to relay"
                );
                return None;
            }
        };
        let selected_protocol = ws.selected_protocol.clone();
        Some(ProxiedWsConnection {
            selected_protocol,
            upstream: UpstreamWs::WebRtc(ws.into_ws_stream()),
        })
    }

    pub async fn get_or_create_ssh_tunnel(&self) -> std::io::Result<u16> {
        self.runtime
            .tunnel_manager
            .get_or_create_ssh_tunnel(self.clone())
            .await
    }
}

/// Whether the central list puts `host_id` in account mode. Hosts this account
/// cannot see, account hosts with remote access off and hosts mid-migration
/// are refused before any connection is opened.
fn is_account_host(hosts: &[CloudHost], host_id: Uuid) -> Result<bool, RelayHostLookupError> {
    let host = hosts
        .iter()
        .find(|host| host.id == host_id)
        .ok_or(RelayHostLookupError::AccessDenied)?;
    match host.auth_mode.as_str() {
        "account" if host.remote_access_enabled => Ok(true),
        "account" => Err(RelayHostLookupError::AccessDenied),
        "migrating" => Err(RelayHostLookupError::Migrating),
        _ => Ok(false),
    }
}

/// Renew the cached connection, or approve a new one when the center refuses
/// it (HOST_CONNECTION_EXPIRED: a revoked id is never revived).
async fn open_or_replace<F, Fut>(
    cached: Option<Uuid>,
    open: F,
) -> Result<relay_types::HostConnectionApproval, RemoteClientError>
where
    F: Fn(Option<Uuid>) -> Fut,
    Fut: std::future::Future<Output = Result<relay_types::HostConnectionApproval, RemoteClientError>>,
{
    match open(cached).await {
        Err(RemoteClientError::Auth) if cached.is_some() => open(None).await,
        result => result,
    }
}

/// Central or host refusal (revoked access, logged-out account), as opposed to
/// a network failure.
fn is_account_rejection(error: &RelayConnectionError) -> bool {
    match error {
        RelayConnectionError::RemoteClient(RemoteClientError::Auth) => true,
        RelayConnectionError::Relay(RelayApiError::Request(error)) => error
            .status()
            .is_some_and(|status| status.as_u16() == 401 || status.as_u16() == 403),
        _ => false,
    }
}

/// Decode a WebRTC data channel HTTP response into a `ProxiedResponse`.
/// Whether the request asks for a Server-Sent Events stream. Such responses are
/// unbounded and must not go over the buffered WebRTC data-channel path.
fn is_event_stream_request(headers: &HeaderMap) -> bool {
    headers
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("text/event-stream"))
}

fn decode_webrtc_http_response(response: DataChannelResponse) -> Option<ProxiedResponse> {
    let body = if let Some(body_b64) = &response.body_b64 {
        use base64::Engine as _;
        match base64::engine::general_purpose::STANDARD.decode(body_b64) {
            Ok(bytes) => bytes,
            Err(e) => {
                tracing::debug!(
                    ?e,
                    "Invalid WebRTC HTTP response body encoding, falling back to relay"
                );
                return None;
            }
        }
    } else {
        Vec::new()
    };

    let status = StatusCode::from_u16(response.status).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut headers = HeaderMap::new();
    for (name, values) in response.headers {
        let Ok(name) = HeaderName::from_bytes(name.as_bytes()) else {
            continue;
        };
        for v in values {
            let Ok(value) = HeaderValue::from_str(&v) else {
                continue;
            };
            headers.append(name.clone(), value);
        }
    }

    Some(ProxiedResponse {
        status,
        headers,
        body: Box::pin(stream::once(async move { Ok(Bytes::from(body)) })),
    })
}

/// Negotiate a WebRTC data channel with the remote host via the relay.
///
/// Reuses an already-authenticated transport from the caller so no extra
/// relay sessions are created and no shared session cache is touched.
async fn negotiate_webrtc(
    mut transport: RelayHostTransport,
    shutdown: CancellationToken,
) -> Result<WebRtcClient, NegotiateWebRtcError> {
    let session_id = Uuid::new_v4().to_string();
    let webrtc_offer = WebRtcClient::create_offer(session_id).await?;

    let offer_json = serde_json::to_vec(&webrtc_offer.offer)?;
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );

    let response = transport
        .send_http(&Method::POST, "/api/webrtc/offer", &headers, &offer_json)
        .await?;

    if !response.status().is_success() {
        return Err(NegotiateWebRtcError::OfferRejected(response.status()));
    }

    let answer_response: ApiResponse<relay_webrtc::SdpAnswer> = response.json().await?;
    if !answer_response.is_success() {
        let message = answer_response
            .message()
            .unwrap_or("WebRTC offer failed")
            .to_string();
        return Err(NegotiateWebRtcError::Relay(RelayApiError::Other(message)));
    }

    let answer = answer_response.into_data().ok_or_else(|| {
        NegotiateWebRtcError::Relay(RelayApiError::Other(
            "WebRTC offer response missing SDP answer".to_string(),
        ))
    })?;

    let client = WebRtcClient::connect(webrtc_offer, &answer.sdp, shutdown).await?;
    Ok(client)
}

async fn load_relay_host_credentials_map() -> HashMap<Uuid, RelayHostCredentials> {
    let path = relay_host_credentials_path();
    let Ok(raw) = tokio::fs::read_to_string(&path).await else {
        return HashMap::new();
    };

    match serde_json::from_str::<HashMap<Uuid, RelayHostCredentials>>(&raw) {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(
                ?error,
                path = %path.display(),
                "Failed to parse relay host credentials file"
            );
            HashMap::new()
        }
    }
}

async fn persist_relay_host_credentials_map(
    map: &HashMap<Uuid, RelayHostCredentials>,
) -> Result<(), RelayPairingClientError> {
    let path = relay_host_credentials_path();
    let json =
        serde_json::to_string_pretty(map).map_err(RelayPairingClientError::StoreSerialization)?;
    tokio::fs::write(&path, json)
        .await
        .map_err(RelayPairingClientError::Store)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex as StdMutex;

    use relay_types::HostConnectionApproval;

    use super::*;

    fn cloud_host(id: Uuid, auth_mode: &str, remote_access_enabled: bool) -> CloudHost {
        CloudHost {
            id,
            owner_user_id: Uuid::new_v4(),
            machine_id: String::new(),
            name: "i9".into(),
            status: "online".into(),
            last_seen_at: None,
            agent_version: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            access_role: "owner".into(),
            auth_mode: auth_mode.into(),
            auth_generation: 1,
            remote_access_enabled,
            capabilities: Vec::new(),
        }
    }

    #[test]
    fn auth_mode_picks_the_connection_flow() {
        let id = Uuid::new_v4();
        let route = |mode, enabled| is_account_host(&[cloud_host(id, mode, enabled)], id);
        assert!(route("account", true).unwrap());
        assert!(!route("legacy_pairing", true).unwrap());
        assert!(matches!(
            route("account", false),
            Err(RelayHostLookupError::AccessDenied)
        ));
        assert!(matches!(
            route("migrating", true),
            Err(RelayHostLookupError::Migrating)
        ));
        // Another user's host is not in this account's list.
        assert!(matches!(
            is_account_host(&[cloud_host(Uuid::new_v4(), "account", true)], id),
            Err(RelayHostLookupError::AccessDenied)
        ));
    }

    #[test]
    fn refreshes_a_minute_before_the_grant_expires() {
        let now = Utc::now();
        let connection = |secs| AccountConnection {
            owner: None,
            connection_id: Uuid::new_v4(),
            signing: RelaySigningService::ephemeral(),
            expires_at: now + chrono::Duration::seconds(secs),
        };
        assert!(connection(61).is_fresh(now));
        assert!(!connection(60).is_fresh(now));
        assert!(!connection(-1).is_fresh(now));
    }

    fn approval(connection_id: Uuid) -> HostConnectionApproval {
        HostConnectionApproval {
            connection_id,
            grant: "grant".into(),
            expires_at: Utc::now(),
        }
    }

    #[tokio::test]
    async fn expired_connection_is_replaced_by_a_new_one() {
        let cached = Uuid::new_v4();
        let fresh = Uuid::new_v4();
        let calls = StdMutex::new(Vec::new());
        let result = open_or_replace(Some(cached), |id| {
            calls.lock().unwrap().push(id);
            async move {
                match id {
                    Some(_) => Err(RemoteClientError::Auth),
                    None => Ok(approval(fresh)),
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(result.connection_id, fresh);
        assert_eq!(*calls.lock().unwrap(), vec![Some(cached), None]);
    }

    #[tokio::test]
    async fn refused_new_connection_is_not_retried() {
        let calls = StdMutex::new(0);
        let result = open_or_replace(None, |_| {
            *calls.lock().unwrap() += 1;
            async { Err(RemoteClientError::Auth) }
        })
        .await;
        assert!(matches!(result, Err(RemoteClientError::Auth)));
        assert_eq!(*calls.lock().unwrap(), 1);
    }
}
