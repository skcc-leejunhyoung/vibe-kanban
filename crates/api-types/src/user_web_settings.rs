use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Account-scoped remote-web settings, exposed as the "Remote" device in the
/// settings host picker. `settings` is an opaque, full `Config` blob owned by
/// the account and shared across every remote-web session; it is interpreted
/// client-side (the remote server never reads its shape). `config_revision`
/// mirrors the optimistic-concurrency handshake used by the local config API.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct UserWebSettings {
    /// The stored Config blob, or `null` when the account has never saved
    /// remote-web settings (the client then falls back to its defaults).
    pub settings: Option<serde_json::Value>,
    pub config_revision: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct UpdateUserWebSettingsRequest {
    pub settings: serde_json::Value,
    /// Revision the client last observed. Reserved for optimistic concurrency;
    /// the current server applies last-write-wins and always returns the new
    /// revision.
    #[serde(default)]
    pub config_revision: Option<String>,
}
