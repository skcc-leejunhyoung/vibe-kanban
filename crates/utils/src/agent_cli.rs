//! How a spawned coding agent reaches this server and finds the `vk` CLI.
//!
//! The server records its own URL once the listener is bound; the container
//! service copies it into every agent's environment together with a `PATH`
//! that starts with a directory holding only `vk` (a copy of the binary
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
            copy_vk(&exe_dir, &crate::assets::asset_dir().join("agent-bin"))
                .inspect_err(|error| tracing::warn!(%error, "vk CLI not copied for agents"))
                .ok()
        })
        .clone()
}

/// Copy `exe_dir/vk` into `bin_dir`. A copy, not a symlink: `build:npx`
/// recreates `exe_dir` under a running server, which would leave agents with
/// a dangling link until the restart. The server binary and its siblings stay
/// off `PATH`: running `vibe-kanban` there by mistake would start a second
/// server against the same database.
fn copy_vk(exe_dir: &Path, bin_dir: &Path) -> std::io::Result<PathBuf> {
    let source = exe_dir.join(vk_binary_name());
    let target = bin_dir.join(vk_binary_name());
    std::fs::create_dir_all(bin_dir)?;
    // Copy beside the target and rename over it, so a `vk` still running
    // from the old copy keeps its file and no one sees a half-written one.
    let tmp = bin_dir.join(format!(".{}.{}", vk_binary_name(), std::process::id()));
    let copied = std::fs::copy(&source, &tmp).and_then(|_| std::fs::rename(&tmp, &target));
    if copied.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    copied?;
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
        // Hosts upgrading from the old layout have `agent-bin/vk` as a symlink.
        #[cfg(unix)]
        {
            std::fs::create_dir_all(&bin).unwrap();
            let source = exe_dir.path().join(vk_binary_name());
            std::os::unix::fs::symlink(source, bin.join(vk_binary_name())).unwrap();
        }

        let dir = copy_vk(exe_dir.path(), &bin).unwrap();
        let meta = std::fs::symlink_metadata(dir.join(vk_binary_name())).unwrap();
        assert!(meta.file_type().is_file());
        // `build:npx` recreating the server's directory leaves agents' `vk`.
        std::fs::remove_file(exe_dir.path().join(vk_binary_name())).unwrap();
        assert_eq!(std::fs::read(dir.join(vk_binary_name())).unwrap(), b"vk");
        // A restart replaces it with the new build.
        std::fs::write(exe_dir.path().join(vk_binary_name()), b"vk2").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let source = exe_dir.path().join(vk_binary_name());
            std::fs::set_permissions(source, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let dir = copy_vk(exe_dir.path(), &dir).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join(vk_binary_name()))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o755);
        }
        let names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from(vk_binary_name())]);
        assert_eq!(std::fs::read(dir.join(vk_binary_name())).unwrap(), b"vk2");

        let path = prepend_path(dir.clone(), Some("/usr/bin")).unwrap();
        let mut parts = std::env::split_paths(&path);
        assert_eq!(parts.next().unwrap(), dir);
        assert_eq!(parts.next().unwrap(), PathBuf::from("/usr/bin"));
    }
}
