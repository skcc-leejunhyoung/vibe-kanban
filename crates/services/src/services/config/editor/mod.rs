use std::{path::Path, str::FromStr};

use executors::{command::CommandBuilder, executors::ExecutorError};
use serde::{Deserialize, Serialize};
use strum_macros::{EnumIter, EnumString};
use thiserror::Error;
use ts_rs::TS;

fn default_auto_install_extension() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, Error)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum EditorOpenError {
    #[error("Editor executable '{executable}' not found in PATH")]
    ExecutableNotFound {
        executable: String,
        editor_type: EditorType,
    },
    #[error("Editor command for {editor_type:?} is invalid: {details}")]
    InvalidCommand {
        details: String,
        editor_type: EditorType,
    },
    #[error("Failed to launch '{executable}' for {editor_type:?}: {details}")]
    LaunchFailed {
        executable: String,
        details: String,
        editor_type: EditorType,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct EditorConfig {
    editor_type: EditorType,
    custom_command: Option<String>,
    #[serde(default)]
    remote_ssh_host: Option<String>,
    #[serde(default)]
    remote_ssh_user: Option<String>,
    /// When enabled, the remote SSH host is only used to open the editor from
    /// the remote web app. The local web app ignores it and opens locally.
    #[serde(default)]
    remote_ssh_only_in_remote_web: bool,
    /// When enabled (VS Code only), remote opens go through a VS Code Tunnel via
    /// the browser (`https://vscode.dev/tunnel/<name>`) instead of an SSH URL,
    /// so clients without SSH (e.g. mobile) can connect. This only replaces the
    /// remote SSH URL — local opens are unaffected. Requires `code tunnel` to be
    /// running on this machine under `remote_tunnel_name`.
    #[serde(default)]
    remote_tunnel_enabled: bool,
    /// The machine name from `code tunnel --name`, used to build the
    /// `https://vscode.dev/tunnel/<name>` URL.
    #[serde(default)]
    remote_tunnel_name: Option<String>,
    #[serde(default = "default_auto_install_extension")]
    auto_install_extension: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, EnumString, EnumIter)]
#[ts(use_ts_enum)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[strum(serialize_all = "SCREAMING_SNAKE_CASE")]
pub enum EditorType {
    VsCode,
    VsCodeInsiders,
    Cursor,
    Windsurf,
    IntelliJ,
    Zed,
    Xcode,
    GoogleAntigravity,
    Custom,
}

impl Default for EditorConfig {
    fn default() -> Self {
        Self {
            editor_type: EditorType::VsCode,
            custom_command: None,
            remote_ssh_host: None,
            remote_ssh_user: None,
            remote_ssh_only_in_remote_web: false,
            remote_tunnel_enabled: false,
            remote_tunnel_name: None,
            auto_install_extension: true,
        }
    }
}

impl EditorConfig {
    /// Create a new EditorConfig. This is primarily used by version migrations.
    pub fn new(
        editor_type: EditorType,
        custom_command: Option<String>,
        remote_ssh_host: Option<String>,
        remote_ssh_user: Option<String>,
        auto_install_extension: bool,
    ) -> Self {
        Self {
            editor_type,
            custom_command,
            remote_ssh_host,
            remote_ssh_user,
            // Migration/availability-check helper; defaults to the shared behaviour.
            remote_ssh_only_in_remote_web: false,
            remote_tunnel_enabled: false,
            remote_tunnel_name: None,
            auto_install_extension,
        }
    }

    fn get_command(&self) -> CommandBuilder {
        let base_command = match &self.editor_type {
            EditorType::VsCode => "code",
            EditorType::VsCodeInsiders => "code-insiders",
            EditorType::Cursor => "cursor",
            EditorType::Windsurf => "windsurf",
            EditorType::IntelliJ => "idea",
            EditorType::Zed => "zed",
            EditorType::Xcode => "xed",
            EditorType::GoogleAntigravity => "antigravity",
            EditorType::Custom => {
                // Custom editor - use user-provided command or fallback to VSCode
                self.custom_command.as_deref().unwrap_or("code")
            }
        };
        CommandBuilder::new(base_command)
    }

    /// Resolve the editor command to an executable path and args.
    /// This is shared logic used by both check_availability() and spawn_local().
    async fn resolve_command(&self) -> Result<(std::path::PathBuf, Vec<String>), EditorOpenError> {
        let command_builder = self.get_command();
        let command_parts =
            command_builder
                .build_initial()
                .map_err(|e| EditorOpenError::InvalidCommand {
                    details: e.to_string(),
                    editor_type: self.editor_type.clone(),
                })?;

        let (executable, args) = command_parts.into_resolved().await.map_err(|e| match e {
            ExecutorError::ExecutableNotFound { program } => EditorOpenError::ExecutableNotFound {
                executable: program,
                editor_type: self.editor_type.clone(),
            },
            _ => EditorOpenError::InvalidCommand {
                details: e.to_string(),
                editor_type: self.editor_type.clone(),
            },
        })?;

        Ok((executable, args))
    }

    /// Check if the editor is available on the system.
    /// Uses the same command resolution logic as spawn_local().
    pub async fn check_availability(&self) -> bool {
        self.resolve_command().await.is_ok()
    }

    fn should_auto_install_extension(&self) -> bool {
        self.auto_install_extension
            && matches!(
                self.editor_type,
                EditorType::VsCode | EditorType::VsCodeInsiders | EditorType::Cursor
            )
    }

    async fn try_install_extension(&self) {
        let Ok((executable, args)) = self.resolve_command().await else {
            return;
        };

        use utils::command_ext::NoWindowExt;
        let mut cmd = std::process::Command::new(&executable);
        cmd.args(&args)
            .arg("--install-extension")
            .arg("bloop.vibe-kanban");
        let _ = cmd.no_window().spawn();
    }

    pub async fn open_file(
        &self,
        path: &Path,
        is_remote_web: bool,
    ) -> Result<Option<String>, EditorOpenError> {
        if let Some(url) = self.remote_url(path, is_remote_web) {
            return Ok(Some(url));
        }
        if self.should_auto_install_extension() {
            self.try_install_extension().await;
        }
        self.spawn_local(path).await?;
        Ok(None)
    }

    fn remote_url(&self, path: &Path, is_remote_web: bool) -> Option<String> {
        let remote_host = self.remote_ssh_host.as_ref()?;

        // When this option is enabled, the remote SSH URL is only used by the
        // remote web app. The local web app falls back to opening locally.
        if self.remote_ssh_only_in_remote_web && !is_remote_web {
            return None;
        }

        let path_str = path.to_string_lossy();

        // VS Code Tunnel: open through the browser-based vscode.dev so clients
        // without an SSH stack (e.g. mobile) can connect. Only the VS Code
        // family has vscode.dev tunnels; other editors fall through to SSH.
        // This replaces the remote SSH URL only — the local fallback above
        // already returned for non-remote opens, so local behaviour is intact.
        if self.remote_tunnel_enabled
            && matches!(
                self.editor_type,
                EditorType::VsCode | EditorType::VsCodeInsiders
            )
            && let Some(name) = self
                .remote_tunnel_name
                .as_deref()
                .map(str::trim)
                .filter(|n| !n.is_empty())
        {
            return Some(format!("https://vscode.dev/tunnel/{name}{path_str}"));
        }

        let user_part = self
            .remote_ssh_user
            .as_ref()
            .map(|u| format!("{u}@"))
            .unwrap_or_default();

        let scheme = match self.editor_type {
            EditorType::VsCode => "vscode",
            EditorType::VsCodeInsiders => "vscode-insiders",
            EditorType::Cursor => "cursor",
            EditorType::Windsurf => "windsurf",
            EditorType::GoogleAntigravity => "antigravity",
            EditorType::Zed => {
                return Some(format!("zed://ssh/{user_part}{remote_host}{path_str}"));
            }
            _ => return None,
        };

        // files must contain a line and column number
        let line_col = if path.is_file() { ":1:1" } else { "" };
        Some(format!(
            "{scheme}://vscode-remote/ssh-remote+{user_part}{remote_host}{path_str}{line_col}?windowId=_blank"
        ))
    }

    pub async fn spawn_local(&self, path: &Path) -> Result<(), EditorOpenError> {
        let (executable, args) = self.resolve_command().await?;

        use utils::command_ext::NoWindowExt;
        let mut cmd = std::process::Command::new(&executable);
        cmd.args(&args).arg(path);
        cmd.no_window()
            .spawn()
            .map_err(|e| EditorOpenError::LaunchFailed {
                executable: executable.to_string_lossy().into_owned(),
                details: e.to_string(),
                editor_type: self.editor_type.clone(),
            })?;
        Ok(())
    }

    pub fn with_override(&self, editor_type_str: Option<&str>) -> Self {
        if let Some(editor_type_str) = editor_type_str {
            let editor_type =
                EditorType::from_str(editor_type_str).unwrap_or(self.editor_type.clone());
            EditorConfig {
                editor_type,
                custom_command: self.custom_command.clone(),
                remote_ssh_host: self.remote_ssh_host.clone(),
                remote_ssh_user: self.remote_ssh_user.clone(),
                remote_ssh_only_in_remote_web: self.remote_ssh_only_in_remote_web,
                remote_tunnel_enabled: self.remote_tunnel_enabled,
                remote_tunnel_name: self.remote_tunnel_name.clone(),
                auto_install_extension: self.auto_install_extension,
            }
        } else {
            self.clone()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ssh_config(remote_ssh_only_in_remote_web: bool) -> EditorConfig {
        EditorConfig {
            editor_type: EditorType::VsCode,
            custom_command: None,
            remote_ssh_host: Some("example.com".to_string()),
            remote_ssh_user: Some("user".to_string()),
            remote_ssh_only_in_remote_web,
            remote_tunnel_enabled: false,
            remote_tunnel_name: None,
            auto_install_extension: false,
        }
    }

    fn tunnel_config(remote_ssh_only_in_remote_web: bool) -> EditorConfig {
        EditorConfig {
            remote_tunnel_enabled: true,
            remote_tunnel_name: Some("my-mac".to_string()),
            ..ssh_config(remote_ssh_only_in_remote_web)
        }
    }

    #[test]
    fn remote_url_is_none_without_host() {
        let config = EditorConfig::default();
        let path = Path::new("/tmp/project");
        assert!(config.remote_url(path, true).is_none());
        assert!(config.remote_url(path, false).is_none());
    }

    #[test]
    fn remote_url_shared_behavior_when_toggle_off() {
        let config = ssh_config(false);
        let path = Path::new("/tmp/project");
        // Toggle off: both local and remote web use the SSH URL (legacy behaviour).
        assert!(config.remote_url(path, false).is_some());
        assert!(config.remote_url(path, true).is_some());
    }

    #[test]
    fn remote_url_only_in_remote_web_when_toggle_on() {
        let config = ssh_config(true);
        let path = Path::new("/tmp/project");
        // Remote web keeps using the SSH URL...
        assert!(config.remote_url(path, true).is_some());
        // ...while local web falls back to opening locally.
        assert!(config.remote_url(path, false).is_none());
    }

    #[test]
    fn tunnel_replaces_ssh_url_for_vscode() {
        let config = tunnel_config(false);
        let path = Path::new("/Users/test-user/proj");
        let url = config.remote_url(path, true).unwrap();
        assert_eq!(url, "https://vscode.dev/tunnel/my-mac/Users/test-user/proj");
        assert!(!url.contains("ssh-remote"));
    }

    #[test]
    fn tunnel_does_not_affect_local_open() {
        // only_in_remote_web + local web => None (opens locally); the tunnel
        // branch must not leak into the local path.
        let config = tunnel_config(true);
        let path = Path::new("/Users/test-user/proj");
        assert!(config.remote_url(path, false).is_none());
    }

    #[test]
    fn tunnel_ignored_for_non_vscode_editor() {
        let config = EditorConfig {
            editor_type: EditorType::Zed,
            ..tunnel_config(false)
        };
        let path = Path::new("/Users/test-user/proj");
        // Zed has no vscode.dev tunnel, so it falls back to its SSH URL.
        let url = config.remote_url(path, true).unwrap();
        assert!(url.starts_with("zed://ssh/"));
    }

    #[test]
    fn tunnel_disabled_uses_ssh_url() {
        let config = EditorConfig {
            remote_tunnel_enabled: false,
            ..tunnel_config(false)
        };
        let path = Path::new("/Users/test-user/proj");
        let url = config.remote_url(path, true).unwrap();
        assert!(url.contains("ssh-remote"));
    }

    #[test]
    fn tunnel_with_empty_name_falls_back_to_ssh() {
        let config = EditorConfig {
            remote_tunnel_name: Some("  ".to_string()),
            ..tunnel_config(false)
        };
        let path = Path::new("/Users/test-user/proj");
        let url = config.remote_url(path, true).unwrap();
        assert!(url.contains("ssh-remote"));
    }
}
