use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type, TS)]
#[serde(rename_all = "snake_case")]
#[sqlx(type_name = "text", rename_all = "snake_case")]
pub enum HostAuthMode {
    LegacyPairing,
    Migrating,
    Account,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow, TS)]
pub struct HostAccessGrant {
    pub host_id: Uuid,
    pub user_id: Uuid,
    pub granted_by: Option<Uuid>,
    pub version: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct HostAccessPolicy {
    pub host_id: Uuid,
    pub owner_user_id: Uuid,
    pub auth_mode: HostAuthMode,
    pub auth_generation: i32,
    pub remote_access_enabled: bool,
    /// Includes revoked grants, whose versions are required to grant access again.
    pub grants: Vec<HostAccessGrant>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ChangeHostAccessRequest {
    pub expected_host_generation: i32,
    /// Zero only when this account has never had a grant on this host.
    pub expected_version: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum HostAccessErrorCode {
    HostNotFound,
    AccountNotFound,
    AccountSessionRevoked,
    ReauthenticationRequired,
    OwnerAccessImmutable,
    HostGenerationConflict,
    GrantVersionConflict,
    HostTransitionInProgress,
    InvalidAccessVersion,
    InternalError,
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct HostAccessErrorResponse {
    pub code: HostAccessErrorCode,
    pub error: String,
}
