//! How a spawned coding agent reaches this server and finds the `vk` CLI.
//!
//! The server records its own URL once the listener is bound; the container
//! service copies it into every agent's environment together with a `PATH`
//! that starts with a directory holding only `vk` (linked to the binary
//! shipped next to the server executable, which itself stays off `PATH`).

use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
};

/// Environment variable the `vk` CLI and the MCP server read first.
pub const BACKEND_URL_ENV: &str = "VIBE_BACKEND_URL";
/// Environment variables identifying the agent run for access auditing.
pub const SESSION_ID_ENV: &str = "VK_SESSION_ID";
pub const EXECUTION_ID_ENV: &str = "VK_EXECUTION_ID";

static BACKEND_URL: OnceLock<String> = OnceLock::new();
static VK_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Record the URL agents use for this server. Later calls are ignored.
pub fn set_backend_url(url: String) {
    let _ = BACKEND_URL.set(url);
}

pub fn backend_url() -> Option<&'static str> {
    BACKEND_URL.get().map(String::as_str)
}

/// Directory to put on an agent's `PATH`, holding only `vk`; `None` when no
/// `vk` ships next to this executable.
pub fn vk_binary_dir() -> Option<PathBuf> {
    VK_DIR
        .get_or_init(|| {
            let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
            if !exe_dir.join(vk_binary_name()).is_file() {
                return None;
            }
            link_vk(&exe_dir, &crate::assets::asset_dir().join("agent-bin"))
                .inspect_err(|error| tracing::warn!(%error, "vk CLI not linked for agents"))
                .ok()
        })
        .clone()
}

/// Link (copy, on Windows) `exe_dir/vk` into `bin_dir`. The server binary
/// and its siblings stay off `PATH`: running `vibe-kanban` there by mistake
/// would start a second server against the same database.
fn link_vk(exe_dir: &Path, bin_dir: &Path) -> std::io::Result<PathBuf> {
    let source = exe_dir.join(vk_binary_name());
    let target = bin_dir.join(vk_binary_name());
    std::fs::create_dir_all(bin_dir)?;
    let _ = std::fs::remove_file(&target);
    #[cfg(unix)]
    std::os::unix::fs::symlink(&source, &target)?;
    #[cfg(not(unix))]
    std::fs::copy(&source, &target)?;
    Ok(bin_dir.to_path_buf())
}

pub fn vk_binary_name() -> &'static str {
    if cfg!(windows) { "vk.exe" } else { "vk" }
}

/// `PATH` for a spawned agent with the `vk` directory in front, or `None`
/// when no `vk` binary ships with this server.
pub fn path_with_vk(current: Option<&str>) -> Option<String> {
    prepend_path(vk_binary_dir()?, current)
}

fn prepend_path(dir: PathBuf, current: Option<&str>) -> Option<String> {
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

    #[test]
    fn agent_path_exposes_vk_but_not_the_server_binary() {
        let exe_dir = tempfile::tempdir().unwrap();
        std::fs::write(exe_dir.path().join(vk_binary_name()), b"vk").unwrap();
        std::fs::write(exe_dir.path().join("vibe-kanban"), b"server").unwrap();
        let bin = exe_dir.path().join("agent-bin");

        let dir = link_vk(exe_dir.path(), &bin).unwrap();
        // Relinking (a restart) replaces the old link.
        let dir = link_vk(exe_dir.path(), &dir).unwrap();
        let names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from(vk_binary_name())]);
        assert_eq!(std::fs::read(dir.join(vk_binary_name())).unwrap(), b"vk");

        let path = prepend_path(dir.clone(), Some("/usr/bin")).unwrap();
        let mut parts = std::env::split_paths(&path);
        assert_eq!(parts.next().unwrap(), dir);
        assert_eq!(parts.next().unwrap(), PathBuf::from("/usr/bin"));
    }
}
