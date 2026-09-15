use std::{
    collections::HashMap,
    fs, io,
    path::Path,
    sync::{Arc, Mutex as StdMutex, Once},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand::rngs::OsRng;
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Request signing — used by local proxy and tunnel to sign outbound requests
// ---------------------------------------------------------------------------

pub const SIGNING_SESSION_HEADER: &str = "x-vk-sig-session";
pub const TIMESTAMP_HEADER: &str = "x-vk-sig-ts";
pub const NONCE_HEADER: &str = "x-vk-sig-nonce";
pub const REQUEST_SIGNATURE_HEADER: &str = "x-vk-sig-signature";

#[derive(Debug, Clone)]
pub struct RequestSignature {
    pub signing_session_id: Uuid,
    pub timestamp: i64,
    pub nonce: Uuid,
    pub signature_b64: String,
}

fn build_request_signing_message(
    sig: &RequestSignature,
    method: &str,
    path_and_query: &str,
    body: &[u8],
) -> String {
    let body_hash = BASE64_STANDARD.encode(Sha256::digest(body));
    format!(
        "v1|{}|{method}|{path_and_query}|{}|{}|{body_hash}",
        sig.timestamp, sig.signing_session_id, sig.nonce
    )
}

fn build_request_signature(
    signing_key: &SigningKey,
    signing_session_id: Uuid,
    method: &str,
    path_and_query: &str,
    body: &[u8],
) -> RequestSignature {
    let mut sig = RequestSignature {
        signing_session_id,
        timestamp: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64,
        nonce: Uuid::new_v4(),
        signature_b64: String::new(),
    };
    let message = build_request_signing_message(&sig, method, path_and_query, body);
    sig.signature_b64 = BASE64_STANDARD.encode(signing_key.sign(message.as_bytes()).to_bytes());
    sig
}

// ---------------------------------------------------------------------------
// Response signing — used by relay_request_signature middleware
// ---------------------------------------------------------------------------

pub const RESPONSE_TIMESTAMP_HEADER: &str = "x-vk-resp-ts";
pub const RESPONSE_NONCE_HEADER: &str = "x-vk-resp-nonce";
pub const RESPONSE_SIGNATURE_HEADER: &str = "x-vk-resp-signature";

/// Build the canonical signing message for an HTTP response.
pub fn build_response_signing_message(
    timestamp: i64,
    status: u16,
    path_and_query: &str,
    signing_session_id: Uuid,
    request_nonce: Uuid,
    response_nonce: Uuid,
    body: &[u8],
) -> String {
    let body_hash = BASE64_STANDARD.encode(Sha256::digest(body));
    format!(
        "v1|{timestamp}|{status}|{path_and_query}|{signing_session_id}|{request_nonce}|{response_nonce}|{body_hash}"
    )
}

// ---------------------------------------------------------------------------
// Session management — server-side verification of signed requests
// ---------------------------------------------------------------------------

struct RelaySigningSession {
    peer_public_key: VerifyingKey,
    created_at: Instant,
    last_used_at: StdMutex<Instant>,
    seen_nonces: Mutex<HashMap<Uuid, Instant>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelaySignatureValidationError {
    TimestampOutOfDrift,
    MissingSigningSession,
    InvalidNonce,
    ReplayNonce,
    InvalidSignature,
    NonceCapacityExceeded,
}

impl RelaySignatureValidationError {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TimestampOutOfDrift => "timestamp outside drift window",
            Self::MissingSigningSession => "missing or expired signing session",
            Self::InvalidNonce => "invalid nonce",
            Self::ReplayNonce => "replayed nonce",
            Self::InvalidSignature => "invalid signature",
            Self::NonceCapacityExceeded => "signing session nonce capacity exceeded",
        }
    }
}

const RELAY_SIGNATURE_MAX_TIMESTAMP_DRIFT_SECS: i64 = 30;
// Self-hosted deployment. The original 60-min absolute / 15-min idle TTLs
// caused frequent "missing or expired signing session" 401s whenever the PWA
// was idle (the session lived only in host memory and the client's auto-refresh
// did not always re-register in time over the relay path). For a self-hosted,
// trusted setup these short windows buy little, so sessions are now persisted
// to disk (see read/write_persisted_sessions) AND given long TTLs (7-day idle /
// 30-day absolute) — a paired client survives host restarts and normal idle
// without re-pairing, while still expiring eventually. seen_nonces (the replay
// window) stays in-memory and short-lived.
const RELAY_SIGNING_SESSION_TTL: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const RELAY_SIGNING_SESSION_IDLE_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const RELAY_NONCE_TTL: Duration = Duration::from_secs(2 * 60);
const CLEANUP_INTERVAL: Duration = Duration::from_secs(30);
const MAX_SESSION_NONCES: usize = 65_536;

type SessionMap = RwLock<HashMap<Uuid, Arc<RelaySigningSession>>>;

#[derive(Clone)]
pub struct RelaySigningService {
    sessions: Arc<SessionMap>,
    cleanup_started: Arc<Once>,
    server_signing_key: Arc<SigningKey>,
    /// When set, registered sessions are persisted here so they survive a host
    /// restart. `None` for client-side / in-memory-only instances.
    persist_path: Option<Arc<std::path::PathBuf>>,
}

impl RelaySigningService {
    pub fn new(server_signing_key: SigningKey) -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            cleanup_started: Arc::new(Once::new()),
            server_signing_key: Arc::new(server_signing_key),
            persist_path: None,
        }
    }

    pub fn load_or_generate(key_path: &Path) -> io::Result<Self> {
        let key = if let Ok(bytes) = fs::read(key_path) {
            let arr: [u8; 32] = bytes.try_into().map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "server signing key file has invalid length (expected 32 bytes)",
                )
            })?;
            SigningKey::from_bytes(&arr)
        } else {
            let key = SigningKey::generate(&mut OsRng);

            if let Some(parent) = key_path.parent() {
                fs::create_dir_all(parent)?;
            }

            let tmp = key_path.with_extension("tmp");
            fs::write(&tmp, key.to_bytes())?;

            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
            }

            fs::rename(&tmp, key_path)?;
            key
        };

        // Persist signing sessions alongside the server key so paired clients
        // survive a host restart (sessions otherwise live only in memory).
        let persist_path = key_path.with_file_name("relay_signing_sessions");
        let sessions = read_persisted_sessions(&persist_path);

        Ok(Self {
            sessions: Arc::new(RwLock::new(sessions)),
            cleanup_started: Arc::new(Once::new()),
            server_signing_key: Arc::new(key),
            persist_path: Some(Arc::new(persist_path)),
        })
    }

    pub fn server_public_key(&self) -> VerifyingKey {
        self.server_signing_key.verifying_key()
    }

    pub fn signing_key(&self) -> &SigningKey {
        &self.server_signing_key
    }

    /// Sign an HTTP request for relay proxy authentication.
    pub fn sign_request(
        &self,
        signing_session_id: Uuid,
        method: &str,
        path_and_query: &str,
        body: &[u8],
    ) -> RequestSignature {
        build_request_signature(
            &self.server_signing_key,
            signing_session_id,
            method,
            path_and_query,
            body,
        )
    }

    /// Raw Ed25519 signature over arbitrary bytes.
    pub fn sign_bytes(&self, message: &[u8]) -> Signature {
        self.server_signing_key.sign(message)
    }

    pub async fn create_session(&self, peer_public_key: VerifyingKey) -> Uuid {
        let signing_session_id = Uuid::new_v4();
        self.register_session(signing_session_id, peer_public_key)
            .await;
        signing_session_id
    }

    /// Return the active session for this peer, creating one only when needed.
    /// Refresh requests use this path so concurrent callers converge on one
    /// session ID instead of repeatedly invalidating each other.
    pub async fn get_or_create_session(&self, peer_public_key: VerifyingKey) -> Uuid {
        self.start_cleanup();
        let now = Instant::now();
        let mut sessions = self.sessions.write().await;
        let previous_len = sessions.len();
        let existing_id = sessions
            .iter()
            .filter(|(_, session)| {
                is_session_active(session, now)
                    && session.peer_public_key.as_bytes() == peer_public_key.as_bytes()
            })
            .max_by_key(|(_, session)| *session.last_used_at.lock().unwrap())
            .map(|(id, _)| *id);

        sessions.retain(|id, session| {
            is_session_active(session, now)
                && (session.peer_public_key.as_bytes() != peer_public_key.as_bytes()
                    || Some(*id) == existing_id)
        });

        let signing_session_id = existing_id.unwrap_or_else(Uuid::new_v4);
        if let Some(session) = sessions.get_mut(&signing_session_id) {
            *session.last_used_at.lock().unwrap() = now;
        } else {
            sessions.insert(
                signing_session_id,
                Arc::new(RelaySigningSession::new(peer_public_key, now)),
            );
        }

        let sessions_changed = sessions.len() != previous_len || existing_id.is_none();
        drop(sessions);
        if sessions_changed {
            self.persist_sessions().await;
        }
        signing_session_id
    }

    /// Register a signing session with a known peer public key.
    /// On the server this is called via `create_session`; on the client
    /// it is called after receiving a session ID from the server.
    pub async fn register_session(&self, signing_session_id: Uuid, peer_public_key: VerifyingKey) {
        self.start_cleanup();
        let now = Instant::now();
        let mut sessions = self.sessions.write().await;
        sessions.retain(|id, session| {
            *id == signing_session_id
                || (is_session_active(session, now)
                    && session.peer_public_key.as_bytes() != peer_public_key.as_bytes())
        });
        if let Some(session) = sessions.get(&signing_session_id)
            && session.peer_public_key == peer_public_key
            && is_session_active(session, now)
        {
            *session.last_used_at.lock().unwrap() = now;
        } else {
            sessions.insert(
                signing_session_id,
                Arc::new(RelaySigningSession::new(peer_public_key, now)),
            );
        }
        drop(sessions);
        self.persist_sessions().await;
    }

    /// Snapshot the current sessions (id + peer public key) to disk so they
    /// survive a host restart. No-op for in-memory-only (client) instances.
    async fn persist_sessions(&self) {
        let Some(path) = self.persist_path.clone() else {
            return;
        };
        let snapshot: Vec<(Uuid, [u8; 32])> = {
            let mut sessions = self.sessions.write().await;
            let now = Instant::now();
            sessions.retain(|_, session| is_session_active(session, now));
            sessions
                .iter()
                .map(|(id, session)| (*id, *session.peer_public_key.as_bytes()))
                .collect()
        };
        let _ = tokio::task::spawn_blocking(move || {
            write_persisted_sessions(&path, &snapshot);
        })
        .await;
    }

    /// Verify an HTTP request signature against a signing session.
    pub async fn verify_request(
        &self,
        request_signature: &RequestSignature,
        method: &str,
        path_and_query: &str,
        body: &[u8],
    ) -> Result<(), RelaySignatureValidationError> {
        validate_timestamp(request_signature.timestamp)?;

        let signature = parse_signature_b64(&request_signature.signature_b64)?;
        let session = self
            .get_valid_session(request_signature.signing_session_id)
            .await?;

        // Hashing and Ed25519 verification hold neither the map nor nonce lock.
        let message =
            build_request_signing_message(request_signature, method, path_and_query, body);
        session
            .peer_public_key
            .verify(message.as_bytes(), &signature)
            .map_err(|_| RelaySignatureValidationError::InvalidSignature)?;

        self.consume_nonce(&session, request_signature).await?;

        Ok(())
    }

    async fn consume_nonce(
        &self,
        session: &Arc<RelaySigningSession>,
        signature: &RequestSignature,
    ) -> Result<(), RelaySignatureValidationError> {
        // Wait on this session only. Never wait for its nonce lock while holding
        // the map: an unrelated session must remain usable even during cleanup.
        let mut nonces = session.seen_nonces.lock().await;
        let sessions = self.sessions.read().await;
        // Pin the current registration through check-and-insert. A refresh or
        // replacement during signature verification must not revive an old Arc.
        if !sessions
            .get(&signature.signing_session_id)
            .is_some_and(|current| {
                Arc::ptr_eq(current, session) && is_session_active(current, Instant::now())
            })
        {
            return Err(RelaySignatureValidationError::MissingSigningSession);
        }
        validate_timestamp(signature.timestamp)?;
        if nonces.contains_key(&signature.nonce) {
            return Err(RelaySignatureValidationError::ReplayNonce);
        }
        // Fail closed if the timer is delayed; never evict a live replay nonce.
        if nonces.len() >= MAX_SESSION_NONCES {
            return Err(RelaySignatureValidationError::NonceCapacityExceeded);
        }
        let now = Instant::now();
        nonces.insert(signature.nonce, now);
        *session.last_used_at.lock().unwrap() = now;
        Ok(())
    }

    /// Get the peer's public key for a valid signing session.
    pub async fn get_session_peer_key(&self, signing_session_id: Uuid) -> Option<VerifyingKey> {
        self.get_valid_session(signing_session_id)
            .await
            .ok()
            .map(|session| session.peer_public_key)
    }

    /// Check if any active signing session has the given Ed25519 public key.
    /// Used by the embedded SSH server for public key authentication.
    pub async fn has_active_session_with_key(&self, key_bytes: &[u8; 32]) -> bool {
        self.start_cleanup();
        let sessions = self.sessions.read().await;
        let now = Instant::now();
        sessions.values().any(|session| {
            is_session_active(session, now) && session.peer_public_key.as_bytes() == key_bytes
        })
    }

    async fn get_valid_session(
        &self,
        signing_session_id: Uuid,
    ) -> Result<Arc<RelaySigningSession>, RelaySignatureValidationError> {
        self.start_cleanup();
        self.sessions
            .read()
            .await
            .get(&signing_session_id)
            .filter(|session| is_session_active(session, Instant::now()))
            .cloned()
            .ok_or(RelaySignatureValidationError::MissingSigningSession)
    }

    fn start_cleanup(&self) {
        self.cleanup_started.call_once(|| {
            let sessions = Arc::downgrade(&self.sessions);
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(CLEANUP_INTERVAL).await;
                    let Some(sessions) = sessions.upgrade() else {
                        break;
                    };
                    cleanup_sessions(&sessions).await;
                }
            });
        });
    }
}

impl RelaySigningSession {
    fn new(peer_public_key: VerifyingKey, now: Instant) -> Self {
        Self {
            peer_public_key,
            created_at: now,
            last_used_at: StdMutex::new(now),
            seen_nonces: Mutex::new(HashMap::new()),
        }
    }
}

async fn cleanup_sessions(sessions: &SessionMap) {
    let snapshot: Vec<_> = sessions.read().await.values().cloned().collect();
    for session in snapshot {
        // A busy session can wait until the next tick; its hard cap still holds.
        if let Ok(mut nonces) = session.seen_nonces.try_lock() {
            let now = Instant::now();
            nonces.retain(|_, seen_at| now.duration_since(*seen_at) <= RELAY_NONCE_TTL);
        }
    }
    let mut sessions = sessions.write().await;
    let now = Instant::now();
    sessions.retain(|_, session| is_session_active(session, now));
}

fn is_session_active(session: &RelaySigningSession, now: Instant) -> bool {
    now.duration_since(session.created_at) <= RELAY_SIGNING_SESSION_TTL
        && now.saturating_duration_since(*session.last_used_at.lock().unwrap())
            <= RELAY_SIGNING_SESSION_IDLE_TTL
}

/// Read persisted (session_id, peer_public_key) pairs from disk into a fresh
/// session map. `created_at`/`last_used_at` are reset to now and `seen_nonces`
/// is empty — only the identity binding is persisted, not the replay window.
/// Malformed lines are skipped so a partially-corrupt file degrades gracefully.
fn read_persisted_sessions(path: &Path) -> HashMap<Uuid, Arc<RelaySigningSession>> {
    let mut map = HashMap::new();
    let Ok(content) = fs::read_to_string(path) else {
        return map;
    };
    let now = Instant::now();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((id_str, key_str)) = line.split_once(',') else {
            continue;
        };
        let Ok(id) = Uuid::parse_str(id_str) else {
            continue;
        };
        let Ok(bytes) = BASE64_STANDARD.decode(key_str) else {
            continue;
        };
        let Ok(arr) = <[u8; 32]>::try_from(bytes.as_slice()) else {
            continue;
        };
        let Ok(peer_public_key) = VerifyingKey::from_bytes(&arr) else {
            continue;
        };
        map.insert(id, Arc::new(RelaySigningSession::new(peer_public_key, now)));
    }
    map
}

/// Atomically write the session snapshot to disk (`0600`, via temp + rename).
fn write_persisted_sessions(path: &Path, sessions: &[(Uuid, [u8; 32])]) {
    let mut out = String::from("# vk relay signing sessions v1\n");
    for (id, key) in sessions {
        out.push_str(&format!("{id},{}\n", BASE64_STANDARD.encode(key)));
    }
    let tmp = path.with_extension("tmp");
    if fs::write(&tmp, out).is_err() {
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    let _ = fs::rename(&tmp, path);
}

fn validate_timestamp(timestamp: i64) -> Result<(), RelaySignatureValidationError> {
    let now_secs = i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| RelaySignatureValidationError::TimestampOutOfDrift)?
            .as_secs(),
    )
    .map_err(|_| RelaySignatureValidationError::TimestampOutOfDrift)?;

    let drift_secs = now_secs.saturating_sub(timestamp).abs();
    if drift_secs > RELAY_SIGNATURE_MAX_TIMESTAMP_DRIFT_SECS {
        return Err(RelaySignatureValidationError::TimestampOutOfDrift);
    }
    Ok(())
}

fn parse_signature_b64(signature_b64: &str) -> Result<Signature, RelaySignatureValidationError> {
    let sig_bytes = BASE64_STANDARD
        .decode(signature_b64)
        .map_err(|_| RelaySignatureValidationError::InvalidSignature)?;
    Signature::from_slice(&sig_bytes).map_err(|_| RelaySignatureValidationError::InvalidSignature)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn other_session_is_not_blocked() {
        let service = RelaySigningService::new(SigningKey::generate(&mut OsRng));
        let a = SigningKey::generate(&mut OsRng);
        let b = SigningKey::generate(&mut OsRng);
        let id_a = service.create_session(a.verifying_key()).await;
        let id_b = service.create_session(b.verifying_key()).await;
        let sig = build_request_signature(&b, id_b, "GET", "/", b"");
        let session = service.get_valid_session(id_a).await.unwrap();
        let held = session.seen_nonces.lock().await;
        let started = Instant::now();
        tokio::time::timeout(
            Duration::from_millis(100),
            service.verify_request(&sig, "GET", "/", b""),
        )
        .await
        .expect("session B blocked by session A")
        .unwrap();
        eprintln!(
            "after: session B completed in {:?} while session A was locked",
            started.elapsed()
        );
        drop(held);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_verification_measurement() {
        let service = RelaySigningService::new(SigningKey::generate(&mut OsRng));
        let mut requests = Vec::new();
        for _ in 0..8 {
            let key = SigningKey::generate(&mut OsRng);
            let id = service.create_session(key.verifying_key()).await;
            requests.push(
                (0..128)
                    .map(|_| build_request_signature(&key, id, "GET", "/", b""))
                    .collect::<Vec<_>>(),
            );
        }
        let started = Instant::now();
        let mut tasks = tokio::task::JoinSet::new();
        for signatures in requests {
            let service = service.clone();
            tasks.spawn(async move {
                for sig in signatures {
                    service.verify_request(&sig, "GET", "/", b"").await.unwrap();
                }
            });
        }
        while let Some(result) = tasks.join_next().await {
            result.unwrap();
        }
        eprintln!(
            "1024 verifications / 8 sessions: {:?}, {:.0} requests/s",
            started.elapsed(),
            1024.0 / started.elapsed().as_secs_f64()
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_nonce_is_consumed_once() {
        let service = RelaySigningService::new(SigningKey::generate(&mut OsRng));
        let key = SigningKey::generate(&mut OsRng);
        let id = service.create_session(key.verifying_key()).await;
        let sig = build_request_signature(&key, id, "GET", "/", b"");
        let barrier = Arc::new(tokio::sync::Barrier::new(32));
        let mut tasks = tokio::task::JoinSet::new();
        for _ in 0..32 {
            let (service, sig, barrier) = (service.clone(), sig.clone(), barrier.clone());
            tasks.spawn(async move {
                barrier.wait().await;
                service.verify_request(&sig, "GET", "/", b"").await
            });
        }
        let mut accepted = 0;
        while let Some(result) = tasks.join_next().await {
            match result.unwrap() {
                Ok(()) => accepted += 1,
                Err(error) => assert_eq!(error, RelaySignatureValidationError::ReplayNonce),
            }
        }
        assert_eq!(accepted, 1);
        service.register_session(id, key.verifying_key()).await;
        assert_eq!(
            service.verify_request(&sig, "GET", "/", b"").await,
            Err(RelaySignatureValidationError::ReplayNonce)
        );
    }

    #[tokio::test]
    async fn invalid_signature_and_replaced_session_cannot_consume_nonce() {
        let service = RelaySigningService::new(SigningKey::generate(&mut OsRng));
        let key = SigningKey::generate(&mut OsRng);
        let id = service.create_session(key.verifying_key()).await;
        let sig = build_request_signature(&key, id, "GET", "/", b"");
        assert_eq!(
            service.verify_request(&sig, "POST", "/", b"").await,
            Err(RelaySignatureValidationError::InvalidSignature)
        );
        service.verify_request(&sig, "GET", "/", b"").await.unwrap();
        let old = service.get_valid_session(id).await.unwrap();
        service
            .register_session(id, SigningKey::generate(&mut OsRng).verifying_key())
            .await;
        assert_eq!(
            service.consume_nonce(&old, &sig).await,
            Err(RelaySignatureValidationError::MissingSigningSession)
        );
    }

    #[tokio::test]
    async fn cleanup_expires_nonces_and_sessions_and_capacity_fails_closed() {
        let service = RelaySigningService::new(SigningKey::generate(&mut OsRng));
        let key = SigningKey::generate(&mut OsRng);
        let id = service.create_session(key.verifying_key()).await;
        let session = service.get_valid_session(id).await.unwrap();
        let live = build_request_signature(&key, id, "GET", "/", b"");
        service
            .verify_request(&live, "GET", "/", b"")
            .await
            .unwrap();
        let expired = Instant::now() - RELAY_NONCE_TTL - Duration::from_secs(1);
        {
            let mut nonces = session.seen_nonces.lock().await;
            for _ in 1..MAX_SESSION_NONCES {
                nonces.insert(Uuid::new_v4(), expired);
            }
        }
        let fresh = build_request_signature(&key, id, "GET", "/", b"");
        assert_eq!(
            service.verify_request(&fresh, "GET", "/", b"").await,
            Err(RelaySignatureValidationError::NonceCapacityExceeded)
        );
        cleanup_sessions(&service.sessions).await;
        assert_eq!(session.seen_nonces.lock().await.len(), 1);
        assert_eq!(
            service.verify_request(&live, "GET", "/", b"").await,
            Err(RelaySignatureValidationError::ReplayNonce)
        );
        service
            .verify_request(&fresh, "GET", "/", b"")
            .await
            .unwrap();
        *session.last_used_at.lock().unwrap() =
            Instant::now() - RELAY_SIGNING_SESSION_IDLE_TTL - Duration::from_secs(1);
        assert!(service.get_session_peer_key(id).await.is_none());
        cleanup_sessions(&service.sessions).await;
        assert!(service.sessions.read().await.is_empty());
    }

    #[tokio::test]
    async fn timer_cleans_idle_sessions_without_requests() {
        let service = RelaySigningService::new(SigningKey::generate(&mut OsRng));
        let id = service
            .create_session(SigningKey::generate(&mut OsRng).verifying_key())
            .await;
        let session = service.get_valid_session(id).await.unwrap();
        *session.last_used_at.lock().unwrap() =
            Instant::now() - RELAY_SIGNING_SESSION_IDLE_TTL - Duration::from_secs(1);
        tokio::time::timeout(CLEANUP_INTERVAL + Duration::from_secs(2), async {
            while !service.sessions.read().await.is_empty() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("periodic cleanup did not run");
    }

    fn tmp_path(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("vk-signing-test-{tag}-{}", Uuid::new_v4()))
    }

    #[test]
    fn persisted_sessions_round_trip() {
        let key = SigningKey::generate(&mut OsRng);
        let pubkey = key.verifying_key();
        let id = Uuid::new_v4();
        let path = tmp_path("round-trip");

        write_persisted_sessions(&path, &[(id, *pubkey.as_bytes())]);
        let map = read_persisted_sessions(&path);
        let _ = fs::remove_file(&path);

        assert_eq!(map.len(), 1);
        assert_eq!(
            map.get(&id)
                .expect("session restored")
                .peer_public_key
                .as_bytes(),
            pubkey.as_bytes(),
        );
    }

    #[test]
    fn read_persisted_skips_malformed_and_missing() {
        // Missing file → empty map (no panic).
        assert!(read_persisted_sessions(&tmp_path("missing")).is_empty());

        // Garbage / comment lines are skipped; only the valid line survives.
        let key = SigningKey::generate(&mut OsRng);
        let id = Uuid::new_v4();
        let path = tmp_path("malformed");
        let contents = format!(
            "# header\nnot-a-line\n{id},not-base64\n{id},{}\n",
            BASE64_STANDARD.encode(key.verifying_key().as_bytes())
        );
        fs::write(&path, contents).unwrap();
        let map = read_persisted_sessions(&path);
        let _ = fs::remove_file(&path);

        assert_eq!(map.len(), 1);
        assert!(map.contains_key(&id));
    }

    #[tokio::test]
    async fn registered_session_verifies_after_reload() {
        // A session registered (and persisted) by one service instance must be
        // accepted by a fresh instance that loads the same file — the host-restart
        // path that previously 401'd.
        let path = tmp_path("reload");
        let server_key = SigningKey::generate(&mut OsRng);
        let client_key = SigningKey::generate(&mut OsRng);

        let writer = RelaySigningService {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            cleanup_started: Arc::new(Once::new()),
            server_signing_key: Arc::new(server_key.clone()),
            persist_path: Some(Arc::new(path.clone())),
        };
        let session_id = writer.create_session(client_key.verifying_key()).await;

        // Fresh instance loads persisted sessions from disk.
        let reloaded = RelaySigningService {
            sessions: Arc::new(RwLock::new(read_persisted_sessions(&path))),
            cleanup_started: Arc::new(Once::new()),
            server_signing_key: Arc::new(server_key),
            persist_path: Some(Arc::new(path.clone())),
        };
        let _ = fs::remove_file(&path);

        // Sign a request with the client key and verify against the reloaded service.
        let sig = build_request_signature(&client_key, session_id, "GET", "/api/info", b"");
        assert!(
            reloaded
                .verify_request(&sig, "GET", "/api/info", b"")
                .await
                .is_ok(),
            "session persisted by one instance must verify after reload",
        );
    }

    #[tokio::test]
    async fn creating_new_session_for_same_peer_replaces_old_session() {
        let server_key = SigningKey::generate(&mut OsRng);
        let client_key = SigningKey::generate(&mut OsRng);
        let service = RelaySigningService::new(server_key);

        let old_session_id = service.create_session(client_key.verifying_key()).await;
        let new_session_id = service.create_session(client_key.verifying_key()).await;

        assert_ne!(old_session_id, new_session_id);
        assert_eq!(service.sessions.read().await.len(), 1);
        assert!(service.get_session_peer_key(new_session_id).await.is_some());
        assert!(service.get_session_peer_key(old_session_id).await.is_none());
    }

    #[tokio::test]
    async fn concurrent_refreshes_for_same_peer_reuse_active_session() {
        let server_key = SigningKey::generate(&mut OsRng);
        let client_key = SigningKey::generate(&mut OsRng);
        let service = RelaySigningService::new(server_key);
        let peer_key = client_key.verifying_key();

        let (first, second) = tokio::join!(
            service.get_or_create_session(peer_key),
            service.get_or_create_session(peer_key),
        );

        assert_eq!(first, second);
        assert_eq!(service.sessions.read().await.len(), 1);
    }

    #[tokio::test]
    async fn refresh_compacts_persisted_duplicates_for_same_peer() {
        let path = tmp_path("compact-persisted");
        let server_key = SigningKey::generate(&mut OsRng);
        let client_key = SigningKey::generate(&mut OsRng);
        let peer_key = client_key.verifying_key();
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        write_persisted_sessions(
            &path,
            &[
                (first, *peer_key.as_bytes()),
                (second, *peer_key.as_bytes()),
            ],
        );
        let service = RelaySigningService {
            sessions: Arc::new(RwLock::new(read_persisted_sessions(&path))),
            cleanup_started: Arc::new(Once::new()),
            server_signing_key: Arc::new(server_key),
            persist_path: Some(Arc::new(path.clone())),
        };

        let reused = service.get_or_create_session(peer_key).await;
        let persisted = read_persisted_sessions(&path);
        let _ = fs::remove_file(&path);

        assert!(reused == first || reused == second);
        assert_eq!(service.sessions.read().await.len(), 1);
        assert_eq!(persisted.len(), 1);
        assert!(persisted.contains_key(&reused));
    }

    #[tokio::test]
    async fn persisted_snapshot_replaces_old_session_for_same_peer() {
        let path = tmp_path("replace-persisted");
        let server_key = SigningKey::generate(&mut OsRng);
        let client_key = SigningKey::generate(&mut OsRng);
        let service = RelaySigningService {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            cleanup_started: Arc::new(Once::new()),
            server_signing_key: Arc::new(server_key),
            persist_path: Some(Arc::new(path.clone())),
        };

        let old_session_id = service.create_session(client_key.verifying_key()).await;
        let new_session_id = service.create_session(client_key.verifying_key()).await;

        let map = read_persisted_sessions(&path);
        let _ = fs::remove_file(&path);

        assert!(!map.contains_key(&old_session_id));
        assert!(map.contains_key(&new_session_id));
        assert_eq!(map.len(), 1);
    }
}
