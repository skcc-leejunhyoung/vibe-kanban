use std::collections::HashMap;

use anyhow::Error;
use api_types::AgentMemoryKind;
use executors::{executors::BaseCodingAgent, profile::ExecutorProfileId};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
pub use v8::{
    EditorConfig, EditorType, GitHubConfig, NotificationConfig, SendMessageShortcut, ShowcaseState,
    SoundFile, ThemeMode, UiLanguage,
};

use crate::services::config::versions::v8;

fn default_git_branch_prefix() -> String {
    "vk".to_string()
}

/// Default template used to derive a working branch name from a linked issue.
/// Rendered client-side; supports `{issueNumber}` and `{issueTitle}`
/// (sanitized) placeholders.
fn default_git_branch_name_template() -> String {
    "{issueNumber}-{issueTitle}".to_string()
}

/// Default prefix for auto-generated feature (target) branch names.
fn default_git_target_branch_prefix() -> String {
    "feature".to_string()
}

/// Default template used to derive a feature (target) branch name from a linked
/// issue. Rendered client-side; supports the same `{issueNumber}`/`{issueTitle}`
/// placeholders as the working branch template.
fn default_git_target_branch_name_template() -> String {
    "{issueNumber}-{issueTitle}".to_string()
}

fn default_pr_auto_description_enabled() -> bool {
    true
}

fn default_commit_reminder_enabled() -> bool {
    true
}

fn default_relay_enabled() -> bool {
    true
}

fn default_primary_color() -> String {
    "#d9772d".to_string()
}

/// The implicit "no extra skin" theme variant. Mirrors `DEFAULT_THEME_VARIANT`
/// in the web `themePresets.ts`.
fn default_theme_variant() -> String {
    "default".to_string()
}

/// User-added theme presets + overrides of built-in ones. Kept as opaque JSON:
/// the shape (`ThemePreset[]`) is owned and validated by the web
/// `themePresets.ts` (`sanitizePreset`); the backend only round-trips it.
fn default_theme_presets() -> serde_json::Value {
    serde_json::Value::Array(Vec::new())
}

/// Diff viewer preferences. Opaque JSON round-tripped for the web
/// `useDiffViewStore`; keys match the store's persisted shape (camelCase).
fn default_diff_view() -> serde_json::Value {
    serde_json::json!({
        "mode": "unified",
        "ignoreWhitespace": true,
        "wrapText": false,
    })
}

/// Quick-chat folder favorites. Opaque `FolderFavorite[]` (`{ path, name }`),
/// validated client-side by the web `useFolderFavoritesStore`; the backend only
/// round-trips it. Lives in config so favorites persist per host computer
/// instead of per-origin localStorage (shared across the local + remote web).
fn default_quick_chat_favorites() -> serde_json::Value {
    serde_json::Value::Array(Vec::new())
}

fn default_agent_memory_sync_time() -> String {
    "03:00".to_string()
}

fn default_agent_memory_sync_agents() -> Vec<AgentMemoryKind> {
    vec![AgentMemoryKind::ClaudeCode, AgentMemoryKind::Codex]
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct AgentMemorySyncConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_agent_memory_sync_time")]
    pub daily_local_time: String,
    #[serde(default = "default_agent_memory_sync_agents")]
    pub agents: Vec<AgentMemoryKind>,
}

impl Default for AgentMemorySyncConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            daily_local_time: default_agent_memory_sync_time(),
            agents: default_agent_memory_sync_agents(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct Config {
    pub config_version: String,
    pub theme: ThemeMode,
    pub executor_profile: ExecutorProfileId,
    pub disclaimer_acknowledged: bool,
    pub onboarding_acknowledged: bool,
    #[serde(default)]
    pub remote_onboarding_acknowledged: bool,
    pub notifications: NotificationConfig,
    pub editor: EditorConfig,
    pub github: GitHubConfig,
    pub workspace_dir: Option<String>,
    pub last_app_version: Option<String>,
    pub show_release_notes: bool,
    #[serde(default)]
    pub language: UiLanguage,
    #[serde(default = "default_git_branch_prefix")]
    pub git_branch_prefix: String,
    /// Template for deriving a working branch name from a linked issue
    /// (rendered client-side). Empty string disables issue-based naming.
    #[serde(default = "default_git_branch_name_template")]
    pub git_branch_name_template: String,
    /// Prefix for auto-generated feature (target) branch names. Used only when
    /// the create-workspace flow's target-branch mode is "auto".
    #[serde(default = "default_git_target_branch_prefix")]
    pub git_target_branch_prefix: String,
    /// Template for deriving a feature (target) branch name from a linked issue
    /// (rendered client-side). Empty string disables issue-based naming.
    #[serde(default = "default_git_target_branch_name_template")]
    pub git_target_branch_name_template: String,
    /// Pass `--no-verify` to `git push`, skipping the local pre-push hook.
    #[serde(default)]
    pub git_push_no_verify: bool,
    #[serde(default)]
    pub showcases: ShowcaseState,
    #[serde(default = "default_pr_auto_description_enabled")]
    pub pr_auto_description_enabled: bool,
    #[serde(default)]
    pub pr_auto_description_prompt: Option<String>,
    #[serde(default = "default_commit_reminder_enabled")]
    pub commit_reminder_enabled: bool,
    #[serde(default)]
    pub commit_reminder_prompt: Option<String>,
    #[serde(default)]
    pub send_message_shortcut: SendMessageShortcut,
    #[serde(default = "default_relay_enabled")]
    pub relay_enabled: bool,
    #[serde(default)]
    pub host_nickname: Option<String>,
    #[serde(default = "default_primary_color")]
    pub primary_color: String,
    /// Coding agents the user has hidden from agent selection.
    #[serde(default)]
    pub disabled_executors: Vec<BaseCodingAgent>,
    /// User overrides for keyboard shortcuts, keyed by binding id; values use
    /// react-hotkeys-hook syntax. Mirrors the web `useKeyboardShortcutsStore`.
    #[serde(default)]
    pub keyboard_shortcuts: HashMap<String, String>,
    /// Selected theme preset ("skin") id, or "default" for none.
    #[serde(default = "default_theme_variant")]
    pub theme_variant: String,
    /// Opaque `ThemePreset[]`, validated client-side.
    #[serde(default = "default_theme_presets")]
    pub theme_presets: serde_json::Value,
    /// Opaque diff viewer preferences ({ mode, ignoreWhitespace, wrapText }).
    #[serde(default = "default_diff_view")]
    pub diff_view: serde_json::Value,
    /// Opaque quick-chat folder favorites (`FolderFavorite[]`).
    #[serde(default = "default_quick_chat_favorites")]
    pub quick_chat_favorites: serde_json::Value,
    /// Open newly created quick chats in a new workspace pane when supported.
    #[serde(default)]
    pub quick_chat_open_in_new_pane: bool,
    /// Daily agent-owned reconciliation of memory snapshots across this user's hosts.
    #[serde(default)]
    pub agent_memory_sync: AgentMemorySyncConfig,
}

impl Config {
    fn from_v8_config(old_config: v8::Config) -> Self {
        Self {
            config_version: "v9".to_string(),
            theme: old_config.theme,
            executor_profile: old_config.executor_profile,
            disclaimer_acknowledged: old_config.disclaimer_acknowledged,
            onboarding_acknowledged: old_config.onboarding_acknowledged,
            remote_onboarding_acknowledged: old_config.remote_onboarding_acknowledged,
            notifications: old_config.notifications,
            editor: old_config.editor,
            github: old_config.github,
            workspace_dir: old_config.workspace_dir,
            last_app_version: old_config.last_app_version,
            show_release_notes: old_config.show_release_notes,
            language: old_config.language,
            git_branch_prefix: old_config.git_branch_prefix,
            git_branch_name_template: default_git_branch_name_template(),
            git_target_branch_prefix: default_git_target_branch_prefix(),
            git_target_branch_name_template: default_git_target_branch_name_template(),
            git_push_no_verify: false,
            showcases: old_config.showcases,
            pr_auto_description_enabled: old_config.pr_auto_description_enabled,
            pr_auto_description_prompt: old_config.pr_auto_description_prompt,
            commit_reminder_enabled: old_config.commit_reminder_enabled,
            commit_reminder_prompt: old_config.commit_reminder_prompt,
            send_message_shortcut: old_config.send_message_shortcut,
            relay_enabled: old_config.relay_enabled,
            host_nickname: old_config.host_nickname,
            primary_color: old_config.primary_color,
            disabled_executors: old_config.disabled_executors,
            // New in v9 — local UI preferences that now sync via config.
            keyboard_shortcuts: HashMap::new(),
            theme_variant: default_theme_variant(),
            theme_presets: default_theme_presets(),
            diff_view: default_diff_view(),
            quick_chat_favorites: default_quick_chat_favorites(),
            quick_chat_open_in_new_pane: false,
            agent_memory_sync: AgentMemorySyncConfig::default(),
        }
    }

    pub fn from_previous_version(raw_config: &str) -> Result<Self, Error> {
        let old_config = v8::Config::from(raw_config.to_string());
        Ok(Self::from_v8_config(old_config))
    }
}

impl From<String> for Config {
    fn from(raw_config: String) -> Self {
        if let Ok(config) = serde_json::from_str::<Config>(&raw_config)
            && config.config_version == "v9"
        {
            return config;
        }

        match Self::from_previous_version(&raw_config) {
            Ok(config) => {
                tracing::info!("Config upgraded to v9");
                config
            }
            Err(e) => {
                tracing::warn!("Config migration failed: {}, using default", e);
                Self::default()
            }
        }
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            config_version: "v9".to_string(),
            theme: ThemeMode::System,
            executor_profile: ExecutorProfileId::new(BaseCodingAgent::ClaudeCode),
            disclaimer_acknowledged: false,
            onboarding_acknowledged: false,
            remote_onboarding_acknowledged: false,
            notifications: NotificationConfig::default(),
            editor: EditorConfig::default(),
            github: GitHubConfig::default(),
            workspace_dir: None,
            last_app_version: None,
            show_release_notes: false,
            language: UiLanguage::default(),
            git_branch_prefix: default_git_branch_prefix(),
            git_branch_name_template: default_git_branch_name_template(),
            git_target_branch_prefix: default_git_target_branch_prefix(),
            git_target_branch_name_template: default_git_target_branch_name_template(),
            git_push_no_verify: false,
            showcases: ShowcaseState::default(),
            pr_auto_description_enabled: true,
            pr_auto_description_prompt: None,
            commit_reminder_enabled: true,
            commit_reminder_prompt: None,
            send_message_shortcut: SendMessageShortcut::default(),
            relay_enabled: true,
            host_nickname: None,
            primary_color: default_primary_color(),
            disabled_executors: Vec::new(),
            keyboard_shortcuts: HashMap::new(),
            theme_variant: default_theme_variant(),
            theme_presets: default_theme_presets(),
            diff_view: default_diff_view(),
            quick_chat_favorites: default_quick_chat_favorites(),
            quick_chat_open_in_new_pane: false,
            agent_memory_sync: AgentMemorySyncConfig::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Config;
    use crate::services::config::versions::v8;

    #[test]
    fn migrating_v8_preserves_existing_fields() {
        let v8_config = v8::Config {
            primary_color: "#123456".to_string(),
            git_branch_prefix: "custom".to_string(),
            ..Default::default()
        };
        let migrated = Config::from_v8_config(v8_config);
        assert_eq!(migrated.config_version, "v9");
        assert_eq!(migrated.primary_color, "#123456");
        assert_eq!(migrated.git_branch_prefix, "custom");
    }

    #[test]
    fn migrating_v8_defaults_new_ui_preference_fields() {
        let migrated = Config::from_v8_config(v8::Config::default());
        assert!(migrated.keyboard_shortcuts.is_empty());
        assert_eq!(migrated.theme_variant, "default");
        assert_eq!(migrated.theme_presets, serde_json::Value::Array(vec![]));
        assert_eq!(migrated.diff_view["mode"], "unified");
        assert_eq!(migrated.diff_view["ignoreWhitespace"], true);
        assert_eq!(
            migrated.quick_chat_favorites,
            serde_json::Value::Array(vec![])
        );
        assert!(!migrated.quick_chat_open_in_new_pane);
    }

    #[test]
    fn default_config_is_v9_with_empty_ui_prefs() {
        let config = Config::default();
        assert_eq!(config.config_version, "v9");
        assert!(config.keyboard_shortcuts.is_empty());
        assert_eq!(config.theme_variant, "default");
    }

    #[test]
    fn deserializing_v9_without_new_fields_uses_defaults() {
        // A config.json written before the new fields existed must still load.
        let raw = serde_json::to_string(&serde_json::json!({
            "config_version": "v9",
            "theme": "SYSTEM",
            "executor_profile": Config::default().executor_profile,
            "disclaimer_acknowledged": false,
            "onboarding_acknowledged": false,
            "notifications": Config::default().notifications,
            "editor": Config::default().editor,
            "github": Config::default().github,
            "workspace_dir": null,
            "last_app_version": null,
            "show_release_notes": false,
        }))
        .unwrap();
        let config = Config::from(raw);
        assert_eq!(config.config_version, "v9");
        assert!(config.keyboard_shortcuts.is_empty());
        assert_eq!(config.theme_variant, "default");
        assert_eq!(config.diff_view["mode"], "unified");
        assert_eq!(
            config.quick_chat_favorites,
            serde_json::Value::Array(vec![])
        );
        assert!(!config.quick_chat_open_in_new_pane);
    }
}
