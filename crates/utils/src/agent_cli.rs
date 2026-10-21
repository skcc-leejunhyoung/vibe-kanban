//! How a spawned coding agent reaches this server and finds the `vk` CLI.
//!
//! The server records its own URL once the listener is bound; the container
//! service copies it into every agent's environment together with a `PATH`
//! that starts with the directory holding the `vk` binary shipped next to the
//! server executable.

use std::{
    path::PathBuf,
    sync::{OnceLock, RwLock},
};

/// Environment variable the `vk` CLI and the MCP server read first.
pub const BACKEND_URL_ENV: &str = "VIBE_BACKEND_URL";
/// Environment variables identifying the agent run for access auditing.
pub const SESSION_ID_ENV: &str = "VK_SESSION_ID";
pub const EXECUTION_ID_ENV: &str = "VK_EXECUTION_ID";

static BACKEND_URL: OnceLock<String> = OnceLock::new();
static VK_DIR_OVERRIDE: RwLock<Option<PathBuf>> = RwLock::new(None);

/// Record the URL agents use for this server. Later calls are ignored.
pub fn set_backend_url(url: String) {
    let _ = BACKEND_URL.set(url);
}

pub fn backend_url() -> Option<&'static str> {
    BACKEND_URL.get().map(String::as_str)
}

/// Point `vk_binary_dir` somewhere else (tests, unusual layouts).
pub fn set_vk_binary_dir(dir: Option<PathBuf>) {
    *VK_DIR_OVERRIDE
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = dir;
}

/// Directory holding the `vk` binary shipped next to this executable, when it
/// is present.
pub fn vk_binary_dir() -> Option<PathBuf> {
    if let Some(dir) = VK_DIR_OVERRIDE
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
    {
        return dir.join(vk_binary_name()).is_file().then_some(dir);
    }
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    dir.join(vk_binary_name()).is_file().then_some(dir)
}

pub fn vk_binary_name() -> &'static str {
    if cfg!(windows) { "vk.exe" } else { "vk" }
}

/// `PATH` for a spawned agent with the `vk` directory in front, or `None`
/// when no `vk` binary ships with this server.
pub fn path_with_vk(current: Option<&str>) -> Option<String> {
    let dir = vk_binary_dir()?;
    let mut paths = vec![dir];
    if let Some(current) = current {
        paths.extend(std::env::split_paths(current));
    }
    std::env::join_paths(paths)
        .ok()
        .map(|joined| joined.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One test: the override is process-global, so two tests would race.
    #[test]
    fn path_starts_with_the_vk_directory_only_when_the_binary_exists() {
        let with = tempfile::tempdir().unwrap();
        std::fs::write(with.path().join(vk_binary_name()), b"").unwrap();
        set_vk_binary_dir(Some(with.path().to_path_buf()));
        let path = path_with_vk(Some("/usr/bin")).unwrap();
        let mut parts = std::env::split_paths(&path);
        assert_eq!(parts.next().unwrap(), with.path());
        assert_eq!(parts.next().unwrap(), PathBuf::from("/usr/bin"));

        let without = tempfile::tempdir().unwrap();
        set_vk_binary_dir(Some(without.path().to_path_buf()));
        assert!(path_with_vk(Some("/usr/bin")).is_none());
        set_vk_binary_dir(None);
    }
}
