use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

pub const ACCOUNT_PROTOCOL: &str = "account-v1";
pub const ACCOUNT_GRANT_TTL_SECS: i64 = 300;
pub const ACCOUNT_LEASE_SECS: u64 = 60;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct CreateHostPreviewRequest {
    pub port: u16,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct CreateHostPreviewResponse {
    pub exchange_url: String,
    pub code: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ReportPreviewPortsRequest {
    pub ports: Vec<i32>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AuthorizeHostPreviewRequest {
    pub preview_id: Uuid,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AccountHostStatus {
    pub account_mode: bool,
    pub api_base: Option<String>,
    pub registration: Option<AccountHostRegistration>,
}

#[derive(Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct RegisterAccountHostRequest {
    pub request_id: Uuid,
    /// Explicit owner-approved credential recovery. None never replaces a registration.
    #[serde(default)]
    pub expected_generation: Option<i32>,
    pub machine_id: String,
    pub name: String,
    /// Generated and durably saved by the installation before sending. The
    /// server stores only its hash; retrying never needs plaintext at rest there.
    pub credential: String,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AccountHostRegistration {
    pub host_id: Uuid,
    pub owner_user_id: Uuid,
    pub generation: i32,
    pub transition_request_id: Uuid,
    pub auth_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ActivateAccountHostRequest {
    pub transition_request_id: Uuid,
    pub generation: i32,
    pub capabilities: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct RotateHostCredentialRequest {
    pub request_id: Uuid,
    pub credential: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct OpenHostConnectionRequest {
    pub public_key_b64: String,
    pub connection_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct HostConnectionApproval {
    pub connection_id: Uuid,
    pub grant: String,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostGrantClaims {
    pub issuer: String,
    pub kind: String,
    pub audience: Uuid,
    pub user_id: Uuid,
    pub auth_session_id: Uuid,
    pub host_generation: i32,
    pub grant_version: i32,
    pub public_key_b64: String,
    pub public_key_thumbprint: String,
    pub issued_at: i64,
    pub expires_at: i64,
    pub jti: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct HostGrantKey {
    pub kid: String,
    pub algorithm: String,
    pub public_key_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct HostGrantKeys {
    pub issuer: String,
    pub keys: Vec<HostGrantKey>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct StartAccountSessionRequest {
    pub grant: String,
    pub proof_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct StartAccountSessionResponse {
    pub signing_session_id: Uuid,
    pub server_public_key_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct RenewHostConnectionsRequest {
    pub connections: Vec<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct HostConnectionLease {
    pub connection_id: Uuid,
    pub public_key_b64: String,
    pub user_id: Uuid,
    pub auth_session_id: Uuid,
    pub host_generation: i32,
    pub grant_version: i32,
    pub remaining_seconds: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct RenewHostConnectionsResponse {
    pub leases: Vec<HostConnectionLease>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ChangeHostStateRequest {
    pub expected_generation: i32,
    pub remote_access_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow, TS)]
pub struct HostConnectionInfo {
    pub id: Uuid,
    pub user_id: Uuid,
    pub auth_session_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow, TS)]
pub struct AccountSessionInfo {
    pub id: Uuid,
    pub device_label: Option<String>,
    pub created_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub current: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow, TS)]
pub struct HostAccessAuditEntry {
    pub id: Uuid,
    pub actor_id: Option<Uuid>,
    pub target_id: Option<Uuid>,
    pub action: String,
    pub result: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow, TS)]
pub struct HostAccountProfile {
    pub id: Uuid,
    pub username: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
}
