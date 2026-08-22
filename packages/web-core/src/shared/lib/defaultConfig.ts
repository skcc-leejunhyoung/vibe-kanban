import {
  BaseCodingAgent,
  EditorType,
  SoundFile,
  ThemeMode,
  type Config,
} from 'shared/types';

/**
 * A complete, defaults-only `Config`, mirroring the Rust `Config::default()`
 * (crates/services/src/services/config/versions/v9.rs).
 *
 * Used as the baseline for the account-scoped "Remote" settings blob: the
 * stored config (which may be partial, or null on first load) is merged over
 * this so every field is always present for the settings sections.
 *
 * Typed as `Config`, so any field added to the Rust struct — and therefore to
 * the generated `Config` type — makes `pnpm run check` fail here until it is
 * added, keeping this default from silently drifting out of sync.
 */
export const DEFAULT_CONFIG: Config = {
  config_version: 'v9',
  theme: ThemeMode.SYSTEM,
  executor_profile: { executor: BaseCodingAgent.CLAUDE_CODE, variant: null },
  disclaimer_acknowledged: false,
  onboarding_acknowledged: false,
  remote_onboarding_acknowledged: false,
  notifications: {
    sound_enabled: true,
    push_enabled: true,
    sound_file: SoundFile.COW_MOOING,
  },
  editor: {
    editor_type: EditorType.VS_CODE,
    custom_command: null,
    remote_ssh_host: null,
    remote_ssh_user: null,
    remote_ssh_only_in_remote_web: false,
    remote_tunnel_enabled: false,
    remote_tunnel_name: null,
    auto_install_extension: true,
  },
  github: {
    pat: null,
    oauth_token: null,
    username: null,
    primary_email: null,
    default_pr_base: 'main',
  },
  workspace_dir: null,
  last_app_version: null,
  show_release_notes: false,
  language: 'BROWSER',
  git_branch_prefix: 'vk',
  git_branch_name_template: '{issueNumber}-{issueTitle}',
  git_target_branch_prefix: 'feature',
  git_target_branch_name_template: '{issueNumber}-{issueTitle}',
  git_push_no_verify: false,
  showcases: { seen_features: [] },
  pr_auto_description_enabled: true,
  pr_auto_description_prompt: null,
  commit_reminder_enabled: true,
  commit_reminder_prompt: null,
  send_message_shortcut: 'ModifierEnter',
  relay_enabled: true,
  host_nickname: null,
  primary_color: '#d9772d',
  disabled_executors: [],
  keyboard_shortcuts: {},
  theme_variant: 'default',
  theme_presets: [],
  diff_view: { mode: 'unified', ignoreWhitespace: true, wrapText: false },
  quick_chat_favorites: [],
  kanban_project_views: {},
  pull_request_default_filters: {},
  quick_chat_open_in_new_pane: false,
  agent_memory_sync: {
    enabled: false,
    daily_local_time: '03:00',
    agents: ['claude_code', 'codex'],
  },
};

/**
 * Build a full `Config` from a stored (possibly null / partial) remote settings
 * blob by layering it over {@link DEFAULT_CONFIG}. Nested objects are replaced
 * wholesale (matching the backend's whole-config replacement model), except we
 * fall back to defaults for any missing top-level field.
 */
export function mergeRemoteConfig(stored: unknown): Config {
  if (!stored || typeof stored !== 'object') {
    return { ...DEFAULT_CONFIG };
  }
  return { ...DEFAULT_CONFIG, ...(stored as Partial<Config>) };
}
