//! Access policy for requests made by coding agents (the `vk` CLI and the
//! MCP server), identified by the `x-vibe-agent` header.
//!
//! Reads are always allowed. Each write falls into one `agent_access` toggle
//! of the host configuration, or is off limits to agents altogether
//! (credentials, relay pairing, force pushes, deleting repos, ...). Every
//! agent write is logged under the `agent_access` tracing target; a denial
//! answers 403 with the reason.

use axum::{
    extract::{Request, State},
    http::{HeaderMap, Method},
    middleware::Next,
    response::Response,
};
use deployment::Deployment;
use services::services::config::{AgentAccessConfig, Config};
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

/// Identifies the calling agent client, e.g. `vk-cli/0.1.44`.
pub const AGENT_HEADER: &str = "x-vibe-agent";
/// Session the agent runs in (from `VK_SESSION_ID`), for the audit log.
pub const AGENT_SESSION_HEADER: &str = "x-vibe-agent-session";
/// CLI command or MCP tool behind the call (e.g. `ws delete`), for the audit log.
pub const AGENT_COMMAND_HEADER: &str = "x-vibe-agent-command";

/// Top-level `Config` fields an agent may change through `PUT /api/config`.
/// Everything else (credentials, onboarding state, relay settings, the agent
/// access toggles themselves) is rejected.
pub const AGENT_WRITABLE_CONFIG_FIELDS: &[&str] = &[
    "theme",
    "executor_profile",
    "notifications",
    "editor",
    "language",
    "git_branch_prefix",
    "git_branch_name_template",
    "git_target_branch_prefix",
    "git_target_branch_name_template",
    "git_push_no_verify",
    "pr_auto_description_enabled",
    "pr_auto_description_prompt",
    "commit_reminder_enabled",
    "commit_reminder_prompt",
    "send_message_shortcut",
    "primary_color",
    "disabled_executors",
    "keyboard_shortcuts",
    "theme_variant",
    "theme_presets",
    "diff_view",
    "quick_chat_favorites",
    "kanban_project_views",
    "pull_request_default_filters",
    "quick_chat_open_in_new_pane",
    "terminal_open_in_new_pane",
    "collapse_completed_turn_steps",
    "agent_memory_sync",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Toggle {
    WriteIssues,
    ControlSessions,
    RespondApprovals,
    GitWrite,
    GitMerge,
    DeleteWorkspaces,
    UpdateConfig,
    AutomationWrite,
}

impl Toggle {
    pub fn key(self) -> &'static str {
        match self {
            Toggle::WriteIssues => "write_issues",
            Toggle::ControlSessions => "control_sessions",
            Toggle::RespondApprovals => "respond_approvals",
            Toggle::GitWrite => "git_write",
            Toggle::GitMerge => "git_merge",
            Toggle::DeleteWorkspaces => "delete_workspaces",
            Toggle::UpdateConfig => "update_config",
            Toggle::AutomationWrite => "automation_write",
        }
    }

    pub fn enabled(self, access: &AgentAccessConfig) -> bool {
        match self {
            Toggle::WriteIssues => access.write_issues,
            Toggle::ControlSessions => access.control_sessions,
            Toggle::RespondApprovals => access.respond_approvals,
            Toggle::GitWrite => access.git_write,
            Toggle::GitMerge => access.git_merge,
            Toggle::DeleteWorkspaces => access.delete_workspaces,
            Toggle::UpdateConfig => access.update_config,
            Toggle::AutomationWrite => access.automation_write,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Gated(Toggle),
    Forbidden,
}

/// `/host/{uuid}/rest` → `/rest`: a request bound for a paired host is judged
/// by the same rules (and again by that host).
fn strip_host_prefix(path: &str) -> &str {
    let Some(rest) = path.strip_prefix("/host/") else {
        return path;
    };
    let Some((host, _)) = rest.split_once('/') else {
        return path;
    };
    if host.parse::<Uuid>().is_err() {
        return path;
    }
    &rest[host.len()..]
}

fn segments(path: &str) -> Vec<&str> {
    path.split('/').filter(|s| !s.is_empty()).collect()
}

/// Paths agents never get, read or write: credentials, pairing, terminals,
/// proxies, editors, data export, and the destructive git/repo/org commands.
fn is_forbidden(method: &Method, path: &str) -> bool {
    let read = matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS);
    const ALWAYS: &[&str] = &[
        "/auth/",
        "/oauth/",
        "/tokens",
        "/terminal",
        "/ssh-session",
        "/webrtc/",
        "/preview/",
        "/relay-auth/server/",
        "/relay-auth/account/",
        "/export",
        "/spec/",
    ];
    if ALWAYS.iter().any(|prefix| path.starts_with(prefix)) {
        return true;
    }
    if path.starts_with("/relay-auth/client/") {
        let readable = ["/relay-auth/client/hosts", "/relay-auth/client/self-host"];
        return !(read && readable.contains(&path));
    }
    if read {
        return false;
    }
    if path.starts_with("/web-push/")
        || path.ends_with("/git/push/force")
        || path.contains("/reset-to-remote")
        || path.ends_with("/editor/open")
        || path.ends_with("/open-editor")
        || path.starts_with("/automation/test-event")
        || path.starts_with("/invitations/")
    {
        return true;
    }
    let parts = segments(path);
    match parts.as_slice() {
        ["repos", _] | ["organizations", _] => *method == Method::DELETE,
        ["organizations", _, "members", ..] | ["organizations", _, "invitations", ..] => true,
        _ => false,
    }
}

/// Which toggle a write needs. `None` means the write is harmless (marking a
/// workspace seen, uploading an attachment, sending a notification).
fn toggle_for(method: &Method, path: &str) -> Option<Toggle> {
    let parts = segments(path);
    Some(match parts.as_slice() {
        ["approvals", ..] => Toggle::RespondApprovals,
        ["workspaces", _] if *method == Method::DELETE => Toggle::DeleteWorkspaces,
        ["workspaces", _, "git", "merge"] => Toggle::GitMerge,
        ["workspaces", _, "git", ..] | ["workspaces", _, "pull-requests", ..] => Toggle::GitWrite,
        ["repos", _, "fetch"] | ["repos", _, "push"] | ["repos", _, "branches", ..] => {
            Toggle::GitWrite
        }
        ["repos", "pr-comments", ..] => Toggle::GitWrite,
        ["workspaces", _, "seen"] | ["notifications", ..] | ["attachments", ..] => return None,
        ["workspaces", _, "attachments", ..] | ["workspaces", _, "images", ..] => return None,
        ["config", ..] | ["profiles", ..] | ["mcp-config", ..] | ["agents", ..] => {
            Toggle::UpdateConfig
        }
        ["repos", ..] => Toggle::UpdateConfig,
        ["automation", ..] | ["automation-actions", ..] | ["agent-memory-sync", ..] => {
            Toggle::AutomationWrite
        }
        ["remote", ..] | ["tags", ..] | ["organizations", ..] => Toggle::WriteIssues,
        _ => Toggle::ControlSessions,
    })
}

/// Judge one request by method and full path (`/api/...`). Non-API paths are
/// never gated.
pub fn classify(method: &Method, path: &str) -> Decision {
    let Some(path) = path.strip_prefix("/api") else {
        return Decision::Allow;
    };
    let path = strip_host_prefix(path);
    if is_forbidden(method, path) {
        return Decision::Forbidden;
    }
    if matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS) {
        return Decision::Allow;
    }
    match toggle_for(method, path) {
        Some(toggle) => Decision::Gated(toggle),
        None => Decision::Allow,
    }
}

pub fn is_agent_request(headers: &HeaderMap) -> bool {
    headers.contains_key(AGENT_HEADER)
}

/// Secrets an agent must not read back from `/api/info`.
pub fn mask_secrets(config: &mut Config) {
    const MASK: &str = "***";
    if config.github.pat.is_some() {
        config.github.pat = Some(MASK.to_string());
    }
    if config.github.oauth_token.is_some() {
        config.github.oauth_token = Some(MASK.to_string());
    }
}

/// Top-level config fields an agent tried to change but may not.
pub fn blocked_config_fields(changed: &[String]) -> Vec<String> {
    changed
        .iter()
        .filter(|field| !AGENT_WRITABLE_CONFIG_FIELDS.contains(&field.as_str()))
        .cloned()
        .collect()
}

pub async fn guard_agent_access(
    State(deployment): State<DeploymentImpl>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let Some(agent) = request
        .headers()
        .get(AGENT_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
    else {
        return Ok(next.run(request).await);
    };
    let session = request
        .headers()
        .get(AGENT_SESSION_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("-")
        .to_owned();
    let command = request
        .headers()
        .get(AGENT_COMMAND_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("-")
        .to_owned();
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    // The query string is the argument summary; bodies are not read here.
    let query = request.uri().query().unwrap_or("").to_owned();
    let decision = classify(&method, &path);
    let denial = match decision {
        Decision::Allow => None,
        Decision::Forbidden => Some("this operation is not available to agents".to_string()),
        Decision::Gated(toggle) => {
            let access = deployment.config().read().await.agent_access.clone();
            (!toggle.enabled(&access)).then(|| {
                format!(
                    "agent_access.{} is off; enable it under Settings → Automation → Agent access",
                    toggle.key()
                )
            })
        }
    };
    let is_write = !matches!(method, Method::GET | Method::HEAD | Method::OPTIONS);
    match denial {
        Some(reason) => {
            tracing::warn!(
                target: "agent_access",
                agent, session, command, method = %method, path, query, decision = "deny", reason,
                "agent request denied"
            );
            Err(ApiError::Forbidden(reason))
        }
        None => {
            if is_write {
                tracing::info!(
                    target: "agent_access",
                    agent, session, command, method = %method, path, query, decision = "allow",
                    "agent write"
                );
            } else {
                tracing::debug!(
                    target: "agent_access",
                    agent, session, command, method = %method, path, query, decision = "allow",
                    "agent read"
                );
            }
            Ok(next.run(request).await)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gated(method: Method, path: &str) -> Decision {
        classify(&method, path)
    }

    #[test]
    fn reads_are_allowed_and_writes_are_gated_by_group() {
        assert_eq!(gated(Method::GET, "/api/workspaces"), Decision::Allow);
        assert_eq!(
            gated(Method::DELETE, "/api/workspaces/abc"),
            Decision::Gated(Toggle::DeleteWorkspaces)
        );
        assert_eq!(
            gated(Method::PUT, "/api/workspaces/abc"),
            Decision::Gated(Toggle::ControlSessions)
        );
        assert_eq!(
            gated(Method::POST, "/api/workspaces/abc/git/merge"),
            Decision::Gated(Toggle::GitMerge)
        );
        assert_eq!(
            gated(Method::POST, "/api/workspaces/abc/git/push"),
            Decision::Gated(Toggle::GitWrite)
        );
        assert_eq!(
            gated(Method::POST, "/api/approvals/x/respond"),
            Decision::Gated(Toggle::RespondApprovals)
        );
        assert_eq!(
            gated(Method::PUT, "/api/config"),
            Decision::Gated(Toggle::UpdateConfig)
        );
        assert_eq!(
            gated(Method::POST, "/api/remote/issues"),
            Decision::Gated(Toggle::WriteIssues)
        );
        assert_eq!(
            gated(Method::POST, "/api/automation/routines"),
            Decision::Gated(Toggle::AutomationWrite)
        );
        assert_eq!(
            gated(Method::POST, "/api/sessions/s/follow-up"),
            Decision::Gated(Toggle::ControlSessions)
        );
        assert_eq!(
            gated(Method::POST, "/api/notifications/send"),
            Decision::Allow
        );
    }

    #[test]
    fn paired_host_prefix_is_judged_like_a_local_path() {
        let host = Uuid::new_v4();
        assert_eq!(
            gated(Method::DELETE, &format!("/api/host/{host}/workspaces/abc")),
            Decision::Gated(Toggle::DeleteWorkspaces)
        );
        assert_eq!(
            gated(Method::GET, &format!("/api/host/{host}/workspaces")),
            Decision::Allow
        );
    }

    #[test]
    fn dangerous_paths_are_forbidden_regardless_of_toggles() {
        for (method, path) in [
            (Method::GET, "/api/auth/token"),
            (Method::POST, "/api/relay-auth/client/pair"),
            (Method::POST, "/api/workspaces/abc/git/push/force"),
            (Method::POST, "/api/workspaces/abc/git/reset-to-remote"),
            (Method::DELETE, "/api/repos/abc"),
            (Method::DELETE, "/api/organizations/abc"),
            (Method::DELETE, "/api/organizations/abc/members/u"),
            (Method::POST, "/api/workspaces/abc/integration/editor/open"),
            (Method::GET, "/api/terminal/ws"),
            (Method::GET, "/api/preview/3000/index.html"),
        ] {
            assert_eq!(gated(method, path), Decision::Forbidden, "{path}");
        }
        assert_eq!(
            gated(Method::GET, "/api/relay-auth/client/hosts"),
            Decision::Allow
        );
        assert_eq!(
            gated(Method::GET, "/api/web-push/public-key"),
            Decision::Allow
        );
    }

    #[test]
    fn non_api_paths_are_ignored() {
        assert_eq!(gated(Method::POST, "/some/page"), Decision::Allow);
    }

    #[test]
    fn config_whitelist_blocks_credentials_and_access_toggles() {
        let blocked = blocked_config_fields(&[
            "theme".to_string(),
            "github".to_string(),
            "agent_access".to_string(),
        ]);
        assert_eq!(blocked, vec!["github", "agent_access"]);
    }
}
