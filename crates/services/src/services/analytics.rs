use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
};

use serde_json::Value;

#[derive(Debug, Clone)]
pub struct AnalyticsContext {
    pub user_id: String,
    pub analytics_service: AnalyticsService,
}

#[derive(Debug, Clone)]
pub struct AnalyticsConfig;

impl AnalyticsConfig {
    pub fn new() -> Option<Self> {
        None
    }
}

#[derive(Clone, Debug)]
pub struct AnalyticsService;

impl AnalyticsService {
    pub fn new(_config: AnalyticsConfig) -> Self {
        Self
    }

    pub fn track_event(&self, _user_id: &str, _event_name: &str, _properties: Option<Value>) {}
}

/// Generates a consistent, anonymous user ID for npm package telemetry.
/// Returns a hex string prefixed with "npm_user_"
pub fn generate_user_id() -> String {
    let mut hasher = DefaultHasher::new();

    #[cfg(target_os = "macos")]
    {
        // Use ioreg to get hardware UUID
        if let Ok(output) = std::process::Command::new("ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Some(line) = stdout.lines().find(|l| l.contains("IOPlatformUUID")) {
                line.hash(&mut hasher);
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Ok(machine_id) = std::fs::read_to_string("/etc/machine-id") {
            machine_id.trim().hash(&mut hasher);
        }
    }

    #[cfg(target_os = "windows")]
    {
        use utils::command_ext::NoWindowExt;
        // Use PowerShell to get machine GUID from registry
        if let Ok(output) = std::process::Command::new("powershell")
            .args(&[
                "-NoProfile",
                "-Command",
                "(Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid",
            ])
            .no_window()
            .output()
        {
            if output.status.success() {
                output.stdout.hash(&mut hasher);
            }
        }
    }

    // Add username for per-user differentiation
    if let Ok(user) = std::env::var("USER").or_else(|_| std::env::var("USERNAME")) {
        user.hash(&mut hasher);
    }

    // Add home directory for additional entropy
    if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        home.hash(&mut hasher);
    }

    format!("npm_user_{:016x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_user_id_format() {
        let id = generate_user_id();
        assert!(id.starts_with("npm_user_"));
        assert_eq!(id.len(), 25);
    }

    #[test]
    fn test_consistency() {
        let id1 = generate_user_id();
        let id2 = generate_user_id();
        assert_eq!(id1, id2, "ID should be consistent across calls");
    }
}
