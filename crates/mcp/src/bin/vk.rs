//! `vk` — the Vibe Kanban command line for coding agents (and humans).
//!
//! Every command is one HTTP call to the local server (or a paired host via
//! `--host`), described in [`COMMANDS`]; a handful of workflows that need more
//! than one call (listing workspaces with status, sending prompts, syncing
//! branches, waiting for events, ...) share their implementation with the MCP
//! server through [`mcp::client::VkClient`]. Output is a readable table or
//! list by default and raw JSON with `--json`.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::ExitCode,
    time::Duration,
};

use clap::{Arg, ArgAction, ArgMatches, Command};
use db::models::requests::AutopilotWorkspaceResponse;
use mcp::client::{
    CreateIssueInput, ReviewWorkspaceInput, SendPromptOptions, StartWorkspaceInput,
    UpdateIssueInput, VkClient, VkError, WorkspaceFilter, discover_base_url,
};
use serde_json::{Map, Value, json};
use uuid::Uuid;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const SKILL_MD: &str = include_str!("../../skills/vibe-kanban-cli/SKILL.md");

// ---------------------------------------------------------------------------
// Command table
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Where {
    /// Fills a `{name}` placeholder in the route.
    Path,
    /// Query string parameter.
    Query,
    /// JSON body field.
    Body,
    /// `--body '{...}'`: JSON object merged into the body (or sent as is).
    Raw,
    /// Only the special handler reads it.
    Local,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Str,
    Bool,
    Int,
    Json,
    /// Boolean switch without a value.
    Flag,
    /// Comma-separated list → JSON array of strings.
    List,
    /// Repeatable `k=v` pairs (query passthrough).
    Pairs,
}

#[derive(Clone, Copy)]
struct ArgSpec {
    name: &'static str,
    help: &'static str,
    at: Where,
    kind: Kind,
    required: bool,
    positional: bool,
    short: Option<char>,
    /// Body/query key when it differs from `name`.
    key: Option<&'static str>,
}

const fn pos(name: &'static str, help: &'static str, at: Where) -> ArgSpec {
    ArgSpec {
        name,
        help,
        at,
        kind: Kind::Str,
        required: true,
        positional: true,
        short: None,
        key: None,
    }
}

const fn opt(name: &'static str, help: &'static str, at: Where, kind: Kind) -> ArgSpec {
    ArgSpec {
        name,
        help,
        at,
        kind,
        required: false,
        positional: false,
        short: None,
        key: None,
    }
}

const fn req(name: &'static str, help: &'static str, at: Where, kind: Kind) -> ArgSpec {
    ArgSpec {
        required: true,
        ..opt(name, help, at, kind)
    }
}

const fn keyed(spec: ArgSpec, key: &'static str) -> ArgSpec {
    ArgSpec {
        key: Some(key),
        ..spec
    }
}

const fn short(spec: ArgSpec, c: char) -> ArgSpec {
    ArgSpec {
        short: Some(c),
        ..spec
    }
}

const WS: ArgSpec = pos(
    "ws",
    "Workspace id, its name, or '.' for the workspace this shell runs in",
    Where::Path,
);
const SESSION: ArgSpec = pos(
    "session",
    "Session id, or '.' for the session this shell runs in",
    Where::Path,
);
const EXEC: ArgSpec = pos("exec", "Execution process id", Where::Path);
const ISSUE: ArgSpec = pos("issue", "Issue id (UUID)", Where::Path);
const REPO_BODY: ArgSpec = keyed(
    opt(
        "repo",
        "Repository id (optional for single-repo workspaces)",
        Where::Body,
        Kind::Str,
    ),
    "repo_id",
);
const REPO_QUERY: ArgSpec = keyed(
    opt(
        "repo",
        "Repository id (optional for single-repo workspaces)",
        Where::Query,
        Kind::Str,
    ),
    "repo_id",
);
const BODY: ArgSpec = opt(
    "body",
    "Raw JSON object merged into the request body",
    Where::Raw,
    Kind::Json,
);
const QUERY: ArgSpec = opt(
    "query",
    "Extra query parameter k=v (repeatable)",
    Where::Query,
    Kind::Pairs,
);
const EXECUTOR: ArgSpec = opt(
    "executor",
    "Coding agent: CLAUDE_CODE, CODEX, GEMINI, AMP, OPENCODE, CURSOR_AGENT, QWEN_CODE, COPILOT, DROID",
    Where::Local,
    Kind::Str,
);
const MODEL_OPTS: [ArgSpec; 4] = [
    opt("model", "Model override", Where::Local, Kind::Str),
    opt(
        "reasoning",
        "Reasoning effort override (e.g. high)",
        Where::Local,
        Kind::Str,
    ),
    opt(
        "permission",
        "Permission policy: AUTO, DONT_ASK, SUPERVISED, PLAN",
        Where::Local,
        Kind::Str,
    ),
    opt(
        "variant",
        "Executor variant/preset",
        Where::Local,
        Kind::Str,
    ),
];

struct Cmd {
    path: &'static [&'static str],
    about: &'static str,
    method: &'static str,
    route: &'static str,
    /// Stays on this machine even with `--host` (cloud data, relay, config).
    local: bool,
    args: &'static [ArgSpec],
    /// Handled in `run_special` instead of the generic request builder.
    special: Option<&'static str>,
}

const fn cmd(
    path: &'static [&'static str],
    about: &'static str,
    method: &'static str,
    route: &'static str,
    args: &'static [ArgSpec],
) -> Cmd {
    Cmd {
        path,
        about,
        method,
        route,
        local: false,
        args,
        special: None,
    }
}

const fn local(c: Cmd) -> Cmd {
    Cmd { local: true, ..c }
}

const fn special(
    path: &'static [&'static str],
    about: &'static str,
    key: &'static str,
    args: &'static [ArgSpec],
) -> Cmd {
    Cmd {
        path,
        about,
        method: "GET",
        route: "",
        local: false,
        args,
        special: Some(key),
    }
}

const GROUPS: &[(&str, &str)] = &[
    (
        "ws",
        "Workspaces: list with live status, create, quick chat, git state, attachments, links",
    ),
    (
        "session",
        "Sessions and turns: send/queue/steer prompts, logs, artifacts, approvals, resumes",
    ),
    (
        "git",
        "Git operations on a workspace branch: commit, push, pull, rebase, merge, target branch",
    ),
    (
        "pr",
        "Pull requests: create, attach, comments, tracked PRs, cloud PR data",
    ),
    (
        "issue",
        "Cloud issues: CRUD, comments, tags, assignees, relations, milestones, statuses, projects",
    ),
    (
        "notify",
        "User notifications: send one, list, mark seen, preferences",
    ),
    (
        "drawer",
        "The Drawer: notes the Autopilot writes for the user (create, update, archive, comment)",
    ),
    (
        "config",
        "Host settings, executor profiles, model discovery, MCP servers, host info",
    ),
    (
        "repo",
        "Registered repositories, branches, remotes, filesystem and file search",
    ),
    (
        "automation",
        "Automation worker routines/connectors/logs and agent memory sync",
    ),
    (
        "events",
        "Event journal: list and wait (process ends, approvals, status notes, vibe phases, ...)",
    ),
    ("hosts", "Paired hosts reachable through the relay"),
    ("skill", "Install or print the vibe-kanban-cli agent skill"),
];

const COMMANDS: &[Cmd] = &[
    // ---- ws -----------------------------------------------------------------
    special(
        &["ws", "list"],
        "List workspaces with status note, running state, approvals and PR state",
        "ws.list",
        &[
            opt(
                "archived",
                "true|false (default: both)",
                Where::Local,
                Kind::Bool,
            ),
            opt("pinned", "true|false", Where::Local, Kind::Bool),
            opt(
                "running",
                "true|false: only workspaces with/without a running turn",
                Where::Local,
                Kind::Bool,
            ),
            opt("branch", "Exact branch name", Where::Local, Kind::Str),
            opt(
                "name",
                "Substring of the workspace name",
                Where::Local,
                Kind::Str,
            ),
            opt("limit", "Max rows (default 50)", Where::Local, Kind::Int),
            opt("offset", "Rows to skip", Where::Local, Kind::Int),
        ],
    ),
    cmd(
        &["ws", "get"],
        "Show one workspace",
        "GET",
        "/workspaces/{ws}",
        &[WS],
    ),
    cmd(
        &["ws", "autopilot"],
        "This host's Autopilot workspace, its single session and executor config (404 when none or paused)",
        "GET",
        "/workspaces/autopilot",
        &[],
    ),
    special(
        &["ws", "create"],
        "Create a workspace without starting a session",
        "ws.create",
        &[
            req(
                "repo",
                "Repository id (repeat --repo for several)",
                Where::Local,
                Kind::Pairs,
            ),
            opt(
                "branch",
                "Target (base) branch; defaults to the repo's",
                Where::Local,
                Kind::Str,
            ),
            opt("name", "Workspace name", Where::Local, Kind::Str),
            opt("issue", "Issue id to link", Where::Local, Kind::Str),
            opt(
                "working-branch",
                "Existing branch to check out instead of a new vk/ branch",
                Where::Local,
                Kind::Str,
            ),
        ],
    ),
    special(
        &["ws", "start"],
        "Create a workspace and start its first agent turn",
        "ws.start",
        &[
            req(
                "repo",
                "Repository id (repeat --repo for several)",
                Where::Local,
                Kind::Pairs,
            ),
            req("branch", "Target (base) branch", Where::Local, Kind::Str),
            req("name", "Workspace name", Where::Local, Kind::Str),
            EXECUTOR,
            short(
                opt(
                    "message",
                    "Prompt for the first turn (defaults to the linked issue text)",
                    Where::Local,
                    Kind::Str,
                ),
                'm',
            ),
            opt("issue", "Issue id to link", Where::Local, Kind::Str),
            opt(
                "variant",
                "Executor variant/preset",
                Where::Local,
                Kind::Str,
            ),
        ],
    ),
    special(
        &["ws", "review"],
        "Create and start the PR review workspace of a review-tagged issue, as the UI does (PR head checked out, <remote>/<base> as target, PR and issue linked, issue moved to In review). Fails instead of falling back to a normal branch. Retry = rerun the same command: an open review workspace for the issue and PR (selected host first, then any reachable host) is returned as 'reused' without a second turn",
        "ws.review",
        &[
            req("issue", "Review-tagged issue id", Where::Local, Kind::Str),
            opt(
                "pr",
                "URL or number of the linked PR to review (needed when several are open)",
                Where::Local,
                Kind::Str,
            ),
            opt(
                "repo",
                "Repository id (default: the registered repo whose remote hosts the PR)",
                Where::Local,
                Kind::Str,
            ),
            EXECUTOR,
            short(
                opt(
                    "message",
                    "Prompt (default: the issue's title and description); 'Review the checked-out PR.' is appended",
                    Where::Local,
                    Kind::Str,
                ),
                'm',
            ),
            opt(
                "name",
                "Workspace name (default: the issue title)",
                Where::Local,
                Kind::Str,
            ),
            opt(
                "create-only",
                "Create and check out only (the UI's create button): no first turn, no In review move; start later with `vk session create <ws>` + `vk session send`",
                Where::Local,
                Kind::Flag,
            ),
            opt(
                "dry-run",
                "Resolve issue, PR, repo and any existing review workspace without writing",
                Where::Local,
                Kind::Flag,
            ),
            MODEL_OPTS[0],
            MODEL_OPTS[1],
            MODEL_OPTS[2],
            MODEL_OPTS[3],
        ],
    ),
    special(
        &["ws", "quick-chat"],
        "Run an agent directly in an existing checkout (no worktree)",
        "ws.quick-chat",
        &[
            pos(
                "repo",
                "Repository id, name, or checkout path",
                Where::Local,
            ),
            short(req("message", "Prompt", Where::Local, Kind::Str), 'm'),
            EXECUTOR,
            opt(
                "name",
                "Workspace name (defaults to the prompt's first line)",
                Where::Local,
                Kind::Str,
            ),
            opt(
                "autopilot",
                "Create this host's Autopilot instead: pinned, single session, addressed by automation as target 'autopilot'",
                Where::Local,
                Kind::Flag,
            ),
            MODEL_OPTS[0],
            MODEL_OPTS[1],
            MODEL_OPTS[2],
            MODEL_OPTS[3],
        ],
    ),
    cmd(
        &["ws", "update"],
        "Archive/pin/rename a workspace",
        "PUT",
        "/workspaces/{ws}",
        &[
            WS,
            keyed(
                opt("archive", "true|false", Where::Body, Kind::Bool),
                "archived",
            ),
            keyed(opt("pin", "true|false", Where::Body, Kind::Bool), "pinned"),
            opt(
                "name",
                "New name (empty string clears)",
                Where::Body,
                Kind::Str,
            ),
        ],
    ),
    cmd(
        &["ws", "delete"],
        "Delete a workspace (gated by agent_access.delete_workspaces)",
        "DELETE",
        "/workspaces/{ws}",
        &[
            WS,
            keyed(
                opt(
                    "delete-remote",
                    "Also delete the cloud workspace row",
                    Where::Query,
                    Kind::Flag,
                ),
                "delete_remote",
            ),
            keyed(
                opt(
                    "delete-branches",
                    "Also delete the workspace branches",
                    Where::Query,
                    Kind::Flag,
                ),
                "delete_branches",
            ),
        ],
    ),
    cmd(
        &["ws", "repos"],
        "Repositories of a workspace",
        "GET",
        "/workspaces/{ws}/repos",
        &[WS],
    ),
    cmd(
        &["ws", "add-repo"],
        "Add a repository to a workspace",
        "POST",
        "/workspaces/{ws}/repos",
        &[
            WS,
            keyed(
                req("repo", "Repository id", Where::Body, Kind::Str),
                "repo_id",
            ),
            keyed(
                req("branch", "Target branch", Where::Body, Kind::Str),
                "target_branch",
            ),
        ],
    ),
    cmd(
        &["ws", "seen"],
        "Mark the workspace's turns as seen",
        "PUT",
        "/workspaces/{ws}/seen",
        &[WS],
    ),
    special(
        &["ws", "summary"],
        "Summary row: diff stats, latest process, PRs, todo progress",
        "ws.summary",
        &[WS],
    ),
    cmd(
        &["ws", "status"],
        "Branch status per repo: ahead/behind, dirty, conflicts, merges",
        "GET",
        "/workspaces/{ws}/git/status",
        &[WS],
    ),
    cmd(
        &["ws", "commits"],
        "Commits on the work branch",
        "GET",
        "/workspaces/{ws}/git/commits",
        &[WS, QUERY],
    ),
    cmd(
        &["ws", "commit-diff"],
        "Diff of one commit",
        "GET",
        "/workspaces/{ws}/git/commit-diff",
        &[WS, pos("sha", "Commit sha", Where::Query), REPO_QUERY],
    ),
    special(
        &["ws", "diff"],
        "Current uncommitted diff (first snapshot of the diff stream)",
        "ws.diff",
        &[
            WS,
            opt(
                "stats",
                "Only per-file stats, no hunks",
                Where::Local,
                Kind::Flag,
            ),
        ],
    ),
    cmd(
        &["ws", "dev-servers"],
        "Dev server processes of the workspace (stop one with `vk session stop <id>`)",
        "GET",
        "/workspaces/{ws}/execution/dev-servers",
        &[WS],
    ),
    cmd(
        &["ws", "dev-server", "start"],
        "Start the repo's dev server script",
        "POST",
        "/workspaces/{ws}/execution/dev-server/start",
        &[WS, BODY],
    ),
    cmd(
        &["ws", "stop"],
        "Stop the workspace's running agent turns and scripts and clear their queues (dev servers keep running)",
        "POST",
        "/workspaces/{ws}/execution/stop",
        &[
            WS,
            keyed(
                opt(
                    "session",
                    "Only this session's processes",
                    Where::Query,
                    Kind::Str,
                ),
                "session_id",
            ),
        ],
    ),
    cmd(
        &["ws", "cleanup"],
        "Run the cleanup script",
        "POST",
        "/workspaces/{ws}/execution/cleanup",
        &[WS],
    ),
    cmd(
        &["ws", "archive-script"],
        "Run the archive script",
        "POST",
        "/workspaces/{ws}/execution/archive",
        &[WS],
    ),
    cmd(
        &["ws", "attachments", "list"],
        "Attachments uploaded to the workspace",
        "GET",
        "/workspaces/{ws}/attachments",
        &[WS],
    ),
    cmd(
        &["ws", "attachments", "meta"],
        "Metadata of a file in the worktree",
        "GET",
        "/workspaces/{ws}/attachments/metadata",
        &[
            WS,
            req(
                "path",
                "Path relative to the worktree root",
                Where::Query,
                Kind::Str,
            ),
            keyed(
                req("session", "Session id", Where::Query, Kind::Str),
                "session_id",
            ),
        ],
    ),
    special(
        &["ws", "attachments", "upload"],
        "Upload a file as a workspace attachment",
        "ws.attachments.upload",
        &[
            WS,
            pos("file", "Local file path", Where::Local),
            opt(
                "session",
                "Session whose turns will see it (default: '.', the session this shell runs in)",
                Where::Local,
                Kind::Str,
            ),
        ],
    ),
    cmd(
        &["ws", "attachments", "associate"],
        "Attach already-uploaded files to the workspace",
        "POST",
        "/workspaces/{ws}/attachments/associate",
        &[
            WS,
            keyed(
                req(
                    "ids",
                    "Attachment ids, comma-separated",
                    Where::Body,
                    Kind::List,
                ),
                "attachment_ids",
            ),
        ],
    ),
    cmd(
        &["ws", "attachments", "import-issue"],
        "Copy an issue's attachments into the workspace",
        "POST",
        "/workspaces/{ws}/attachments/import-issue-attachments",
        &[
            WS,
            keyed(req("issue", "Issue id", Where::Body, Kind::Str), "issue_id"),
        ],
    ),
    special(
        &["ws", "link"],
        "Link a workspace to a cloud issue",
        "ws.link",
        &[WS, ISSUE],
    ),
    cmd(
        &["ws", "unlink"],
        "Remove the workspace's cloud issue link",
        "DELETE",
        "/workspaces/{ws}/links",
        &[WS],
    ),
    cmd(
        &["ws", "project"],
        "Cloud project id the workspace is linked to",
        "GET",
        "/workspaces/{ws}/project",
        &[WS],
    ),
    cmd(
        &["ws", "first-message"],
        "First user prompt of the workspace",
        "GET",
        "/workspaces/{ws}/messages/first",
        &[WS],
    ),
    // ---- session ------------------------------------------------------------
    cmd(
        &["session", "list"],
        "Sessions of a workspace",
        "GET",
        "/sessions",
        &[keyed(
            pos("ws", "Workspace id, name or '.'", Where::Query),
            "workspace_id",
        )],
    ),
    cmd(
        &["session", "get"],
        "Show one session",
        "GET",
        "/sessions/{session}",
        &[SESSION],
    ),
    cmd(
        &["session", "create"],
        "Create a session in a workspace",
        "POST",
        "/sessions",
        &[
            keyed(
                pos("ws", "Workspace id, name or '.'", Where::Body),
                "workspace_id",
            ),
            opt("executor", "Executor to pin", Where::Body, Kind::Str),
            opt("variant", "Executor variant", Where::Body, Kind::Str),
            opt("name", "Session name", Where::Body, Kind::Str),
        ],
    ),
    cmd(
        &["session", "rename"],
        "Rename a session",
        "PUT",
        "/sessions/{session}",
        &[SESSION, req("name", "New name", Where::Body, Kind::Str)],
    ),
    cmd(
        &["session", "delete"],
        "Delete a session",
        "DELETE",
        "/sessions/{session}",
        &[SESSION],
    ),
    special(
        &["session", "send"],
        "Send a prompt: run now, --queue behind the running turn, or --steer to interrupt",
        "session.send",
        &[
            SESSION,
            short(req("message", "Prompt text", Where::Local, Kind::Str), 'm'),
            opt(
                "queue",
                "Append to the queue when busy",
                Where::Local,
                Kind::Flag,
            ),
            opt(
                "steer",
                "Interrupt the running turn and run this next",
                Where::Local,
                Kind::Flag,
            ),
            EXECUTOR,
            MODEL_OPTS[0],
            MODEL_OPTS[1],
            MODEL_OPTS[2],
            MODEL_OPTS[3],
        ],
    ),
    cmd(
        &["session", "queue", "list"],
        "Queued messages of a session",
        "GET",
        "/sessions/{session}/queue",
        &[SESSION],
    ),
    cmd(
        &["session", "queue", "update"],
        "Edit a queued message",
        "POST",
        "/sessions/{session}/queue/update",
        &[
            SESSION,
            keyed(
                req("message-id", "Queued message id", Where::Body, Kind::Str),
                "message_id",
            ),
            short(req("message", "New text", Where::Body, Kind::Str), 'm'),
            keyed(
                req(
                    "executor-config",
                    "Executor config JSON (the message's current one is in `vk session queue list <session> --json`)",
                    Where::Body,
                    Kind::Json,
                ),
                "executor_config",
            ),
        ],
    ),
    cmd(
        &["session", "queue", "cancel"],
        "Cancel one queued message, or the whole queue",
        "DELETE",
        "/sessions/{session}/queue",
        &[
            SESSION,
            keyed(
                opt(
                    "message-id",
                    "Queued message id (omit to clear all)",
                    Where::Query,
                    Kind::Str,
                ),
                "message_id",
            ),
        ],
    ),
    cmd(
        &["session", "queue", "reorder"],
        "Reorder the queue",
        "POST",
        "/sessions/{session}/queue/reorder",
        &[
            SESSION,
            keyed(
                req(
                    "ids",
                    "Message ids in the new order, comma-separated",
                    Where::Body,
                    Kind::List,
                ),
                "message_ids",
            ),
        ],
    ),
    cmd(
        &["session", "stop"],
        "Stop a running execution process",
        "POST",
        "/execution-processes/{exec}/stop",
        &[EXEC],
    ),
    cmd(
        &["session", "reset"],
        "Reset the session history to just before a process",
        "POST",
        "/sessions/{session}/reset",
        &[
            SESSION,
            keyed(
                req("to", "Process id to reset to", Where::Body, Kind::Str),
                "process_id",
            ),
            keyed(
                opt(
                    "force-when-dirty",
                    "Proceed with uncommitted changes",
                    Where::Body,
                    Kind::Flag,
                ),
                "force_when_dirty",
            ),
            keyed(
                opt(
                    "git-reset",
                    "Also reset the worktree",
                    Where::Body,
                    Kind::Flag,
                ),
                "perform_git_reset",
            ),
        ],
    ),
    special(
        &["session", "handoff"],
        "Hand the session to another executor with a prompt",
        "session.handoff",
        &[
            SESSION,
            short(req("message", "Prompt", Where::Local, Kind::Str), 'm'),
            req("executor", "Target executor", Where::Local, Kind::Str),
            MODEL_OPTS[0],
            MODEL_OPTS[1],
            MODEL_OPTS[2],
            MODEL_OPTS[3],
        ],
    ),
    cmd(
        &["session", "auto-resume", "get"],
        "Usage-limit auto-resume state",
        "GET",
        "/sessions/{session}/auto-resume",
        &[SESSION],
    ),
    cmd(
        &["session", "auto-resume", "set"],
        "Enable/disable usage-limit auto-resume",
        "POST",
        "/sessions/{session}/auto-resume",
        &[
            SESSION,
            req("enabled", "true|false", Where::Body, Kind::Bool),
        ],
    ),
    cmd(
        &["session", "setup"],
        "Run the setup script in the session",
        "POST",
        "/sessions/{session}/setup",
        &[SESSION],
    ),
    special(
        &["session", "review"],
        "Start a code review turn",
        "session.review",
        &[
            SESSION,
            EXECUTOR,
            opt(
                "prompt",
                "Additional review instructions",
                Where::Local,
                Kind::Str,
            ),
            opt(
                "all-commits",
                "Review every workspace commit, not just the last turn",
                Where::Local,
                Kind::Flag,
            ),
            MODEL_OPTS[0],
            MODEL_OPTS[1],
            MODEL_OPTS[3],
        ],
    ),
    cmd(
        &["session", "vibe-review", "start"],
        "Start the automated vibe review for the session",
        "POST",
        "/sessions/{session}/vibe-review",
        &[
            SESSION,
            keyed(
                opt(
                    "executor-config",
                    "Executor config JSON",
                    Where::Body,
                    Kind::Json,
                ),
                "executor_config",
            ),
        ],
    ),
    cmd(
        &["session", "vibe-review", "status"],
        "Phase of the vibe run behind the session",
        "GET",
        "/sessions/{session}/vibe-review/status",
        &[SESSION],
    ),
    cmd(
        &["session", "vibe-review", "retry-merge"],
        "Merge a blocked (or waiting) vibe run again",
        "POST",
        "/sessions/{session}/vibe-review/retry-merge",
        &[SESSION],
    ),
    cmd(
        &["session", "executions"],
        "Execution processes of a session",
        "GET",
        "/execution-processes",
        &[
            keyed(
                pos("session", "Session id or '.'", Where::Query),
                "session_id",
            ),
            keyed(
                opt(
                    "include-dropped",
                    "Include processes removed by a reset",
                    Where::Query,
                    Kind::Flag,
                ),
                "show_soft_deleted",
            ),
        ],
    ),
    special(
        &["session", "log"],
        "Normalized conversation of a process, paged",
        "session.log",
        &[
            EXEC,
            opt(
                "offset",
                "First entry index (default 0)",
                Where::Local,
                Kind::Int,
            ),
            opt(
                "limit",
                "Entries per page (default 100, max 1000)",
                Where::Local,
                Kind::Int,
            ),
            opt(
                "tool-results",
                "Keep tool result payloads",
                Where::Local,
                Kind::Flag,
            ),
            opt(
                "raw",
                "Raw stdout/stderr instead of normalized entries",
                Where::Local,
                Kind::Flag,
            ),
        ],
    ),
    cmd(
        &["session", "artifacts", "list"],
        "Artifacts a process attached",
        "GET",
        "/execution-processes/{exec}/artifacts",
        &[
            EXEC,
            keyed(
                req("ws", "Workspace id", Where::Query, Kind::Str),
                "workspace_id",
            ),
            keyed(
                req("session", "Session id", Where::Query, Kind::Str),
                "session_id",
            ),
        ],
    ),
    cmd(
        &["session", "artifacts", "get"],
        "Content of one artifact",
        "GET",
        "/execution-processes/{exec}/artifacts/content",
        &[
            EXEC,
            keyed(
                req("ws", "Workspace id", Where::Query, Kind::Str),
                "workspace_id",
            ),
            keyed(
                req("session", "Session id", Where::Query, Kind::Str),
                "session_id",
            ),
            req("id", "Artifact id", Where::Query, Kind::Str),
            opt("hash", "Content hash", Where::Query, Kind::Str),
        ],
    ),
    cmd(
        &["session", "subagent", "transcript"],
        "Transcript of a subagent (Codex thread / Claude task)",
        "POST",
        "/execution-processes/{exec}/subagent/transcript",
        &[
            EXEC,
            keyed(
                req(
                    "target",
                    "Target JSON, e.g. {\"executor\":\"codex\",\"thread_id\":\"...\"} or {\"executor\":\"claude_code\",\"task_id\":\"...\"}",
                    Where::Raw,
                    Kind::Json,
                ),
                "target",
            ),
        ],
    ),
    cmd(
        &["session", "subagent", "stop"],
        "Stop one subagent",
        "POST",
        "/execution-processes/{exec}/subagent/stop",
        &[
            EXEC,
            keyed(
                req("target", "Target JSON", Where::Raw, Kind::Json),
                "target",
            ),
        ],
    ),
    cmd(
        &["session", "repo-states"],
        "Repo heads before/after a process",
        "GET",
        "/execution-processes/{exec}/repo-states",
        &[EXEC],
    ),
    cmd(
        &["session", "search"],
        "Search past conversations",
        "GET",
        "/sessions/search",
        &[
            short(opt("q", "Substring to find", Where::Query, Kind::Str), 'q'),
            keyed(
                opt(
                    "repo",
                    "Only workspaces containing this repo",
                    Where::Query,
                    Kind::Str,
                ),
                "repo_id",
            ),
            keyed(
                opt("session", "Only this session", Where::Query, Kind::Str),
                "session_id",
            ),
            keyed(
                opt(
                    "types",
                    "Entry types, comma-separated (user_message, assistant_message, tool_use, ...)",
                    Where::Query,
                    Kind::Str,
                ),
                "entry_types",
            ),
            opt(
                "limit",
                "Max hits (default 20, max 100)",
                Where::Query,
                Kind::Int,
            ),
        ],
    ),
    cmd(
        &["session", "slice"],
        "Conversation around a search hit",
        "GET",
        "/sessions/{session}/message-slice",
        &[
            SESSION,
            keyed(
                req(
                    "execution",
                    "Execution id of the hit",
                    Where::Query,
                    Kind::Str,
                ),
                "execution_id",
            ),
            keyed(
                req("index", "Entry index of the hit", Where::Query, Kind::Int),
                "entry_index",
            ),
            opt(
                "radius",
                "Entries of context each side (default 5)",
                Where::Query,
                Kind::Int,
            ),
        ],
    ),
    cmd(
        &["session", "approvals", "list"],
        "Tool approvals and agent questions waiting for an answer",
        "GET",
        "/approvals/pending",
        &[],
    ),
    special(
        &["session", "approvals", "respond"],
        "Answer a pending approval (gated by agent_access.respond_approvals)",
        "session.approvals.respond",
        &[
            pos("id", "Approval id", Where::Local),
            req(
                "exec",
                "Execution process id of the approval",
                Where::Local,
                Kind::Str,
            ),
            opt("approve", "Approve the tool call", Where::Local, Kind::Flag),
            opt("deny", "Deny the tool call", Where::Local, Kind::Flag),
            opt("reason", "Denial reason", Where::Local, Kind::Str),
            opt(
                "answers",
                "Answers JSON for a question: [{\"question\":\"...\",\"answer\":[\"...\"]}]",
                Where::Local,
                Kind::Json,
            ),
        ],
    ),
    cmd(
        &["session", "resumes", "list"],
        "Scheduled wakeups the agent registered",
        "GET",
        "/sessions/{session}/resumes",
        &[SESSION],
    ),
    cmd(
        &["session", "resumes", "cancel"],
        "Cancel the session's scheduled wakeups",
        "POST",
        "/sessions/{session}/resumes/cancel",
        &[SESSION],
    ),
    cmd(
        &["session", "queue", "steer"],
        "Interrupt the running turn with a message already in the queue",
        "POST",
        "/sessions/{session}/queue/steer-queued",
        &[
            SESSION,
            keyed(
                req(
                    "message-id",
                    "Queued message id to run next",
                    Where::Body,
                    Kind::Str,
                ),
                "message_id",
            ),
        ],
    ),
    // ---- git ----------------------------------------------------------------
    cmd(
        &["git", "commit"],
        "Commit the worktree changes",
        "POST",
        "/workspaces/{ws}/git/commit",
        &[WS, REPO_BODY],
    ),
    cmd(
        &["git", "push"],
        "Push the work branch",
        "POST",
        "/workspaces/{ws}/git/push",
        &[WS, REPO_BODY],
    ),
    cmd(
        &["git", "pull"],
        "Fast-forward the work branch from its remote",
        "POST",
        "/workspaces/{ws}/git/pull",
        &[WS, REPO_BODY],
    ),
    cmd(
        &["git", "pull-and-push"],
        "Pull then push the work branch",
        "POST",
        "/workspaces/{ws}/git/pull-and-push",
        &[WS, REPO_BODY],
    ),
    cmd(
        &["git", "update-from-base"],
        "Merge or rebase the base branch into the work branch",
        "POST",
        "/workspaces/{ws}/git/update-from-base",
        &[
            WS,
            REPO_BODY,
            req("strategy", "merge|rebase", Where::Body, Kind::Str),
        ],
    ),
    cmd(
        &["git", "rebase"],
        "Rebase the work branch (optionally onto a new base)",
        "POST",
        "/workspaces/{ws}/git/rebase",
        &[
            WS,
            REPO_BODY,
            keyed(
                opt("old-base", "Previous base branch", Where::Body, Kind::Str),
                "old_base_branch",
            ),
            keyed(
                opt("new-base", "New base branch", Where::Body, Kind::Str),
                "new_base_branch",
            ),
        ],
    ),
    cmd(
        &["git", "rebase-continue"],
        "Continue a rebase after resolving conflicts",
        "POST",
        "/workspaces/{ws}/git/rebase/continue",
        &[WS, REPO_BODY],
    ),
    cmd(
        &["git", "abort"],
        "Abort the in-progress merge/rebase",
        "POST",
        "/workspaces/{ws}/git/conflicts/abort",
        &[WS, REPO_BODY],
    ),
    cmd(
        &["git", "merge"],
        "Merge the work branch into its base (gated by agent_access.git_merge)",
        "POST",
        "/workspaces/{ws}/git/merge",
        &[WS, REPO_BODY],
    ),
    cmd(
        &["git", "merge-remote"],
        "Merge the remote work branch into the local one",
        "POST",
        "/workspaces/{ws}/git/merge-remote",
        &[WS, REPO_BODY],
    ),
    cmd(
        &["git", "rename-branch"],
        "Rename the work branch",
        "PUT",
        "/workspaces/{ws}/git/branch",
        &[
            WS,
            keyed(
                req("name", "New branch name", Where::Body, Kind::Str),
                "new_branch_name",
            ),
        ],
    ),
    cmd(
        &["git", "target", "set"],
        "Change the target (base) branch",
        "PUT",
        "/workspaces/{ws}/git/target-branch",
        &[
            WS,
            REPO_BODY,
            keyed(
                req("branch", "New target branch", Where::Body, Kind::Str),
                "new_target_branch",
            ),
        ],
    ),
    cmd(
        &["git", "target", "fetch"],
        "Fetch the target branch",
        "POST",
        "/workspaces/{ws}/git/target-branch/fetch",
        &[WS, REPO_BODY],
    ),
    cmd(
        &["git", "target", "pull"],
        "Pull the target branch",
        "POST",
        "/workspaces/{ws}/git/target-branch/pull",
        &[WS, REPO_BODY],
    ),
    cmd(
        &["git", "target", "push"],
        "Push the target branch",
        "POST",
        "/workspaces/{ws}/git/target-branch/push",
        &[WS, REPO_BODY],
    ),
    cmd(
        &["git", "target", "remote-status"],
        "Ahead/behind of the target branch vs its remote",
        "GET",
        "/workspaces/{ws}/git/target-branch/remote-status",
        &[WS, REPO_QUERY],
    ),
    cmd(
        &["git", "target", "update-from-base"],
        "Update the target branch from a base branch",
        "POST",
        "/workspaces/{ws}/git/target-branch/update-from-base",
        &[
            WS,
            REPO_BODY,
            keyed(
                req("base", "Base branch", Where::Body, Kind::Str),
                "base_branch",
            ),
        ],
    ),
    cmd(
        &["git", "target", "pull-and-push"],
        "Pull then push the target branch",
        "POST",
        "/workspaces/{ws}/git/target-branch/pull-and-push",
        &[WS, REPO_BODY],
    ),
    cmd(
        &["git", "target", "merge-remote"],
        "Merge the remote target branch",
        "POST",
        "/workspaces/{ws}/git/target-branch/merge-remote",
        &[WS, REPO_BODY],
    ),
    // ---- pr -----------------------------------------------------------------
    cmd(
        &["pr", "create"],
        "Open a pull request for the work branch",
        "POST",
        "/workspaces/{ws}/pull-requests",
        &[
            WS,
            REPO_BODY,
            req("title", "PR title", Where::Body, Kind::Str),
            opt("body", "PR body", Where::Body, Kind::Str),
            keyed(
                opt(
                    "base",
                    "Target branch (defaults to the repo's)",
                    Where::Body,
                    Kind::Str,
                ),
                "target_branch",
            ),
            keyed(
                opt(
                    "head",
                    "Head branch (defaults to the work branch)",
                    Where::Body,
                    Kind::Str,
                ),
                "head_branch",
            ),
            opt("draft", "Open as draft", Where::Body, Kind::Flag),
        ],
    ),
    cmd(
        &["pr", "generate"],
        "Generate a PR title and description with an agent",
        "POST",
        "/workspaces/{ws}/pull-requests/generate",
        &[
            WS,
            REPO_BODY,
            keyed(
                opt("base", "Target branch", Where::Body, Kind::Str),
                "target_branch",
            ),
            keyed(
                opt("head", "Head branch", Where::Body, Kind::Str),
                "head_branch",
            ),
        ],
    ),
    cmd(
        &["pr", "attachable"],
        "PRs on the remote that could be attached to this workspace",
        "GET",
        "/workspaces/{ws}/pull-requests/attach",
        &[
            WS,
            REPO_QUERY,
            keyed(
                opt("head", "Head branch", Where::Query, Kind::Str),
                "head_branch",
            ),
        ],
    ),
    cmd(
        &["pr", "attach"],
        "Attach an existing PR to the workspace",
        "POST",
        "/workspaces/{ws}/pull-requests/attach",
        &[
            WS,
            REPO_BODY,
            keyed(
                opt("head", "Head branch", Where::Body, Kind::Str),
                "head_branch",
            ),
            keyed(opt("url", "PR URL", Where::Body, Kind::Str), "pr_url"),
        ],
    ),
    cmd(
        &["pr", "unlink"],
        "Stop tracking a PR for the workspace",
        "POST",
        "/workspaces/{ws}/pull-requests/unlink",
        &[
            WS,
            REPO_BODY,
            keyed(
                opt("url", "PR URL (omit to unlink all)", Where::Body, Kind::Str),
                "pr_url",
            ),
        ],
    ),
    cmd(
        &["pr", "comments"],
        "Review comments of the workspace's PR",
        "GET",
        "/workspaces/{ws}/pull-requests/comments",
        &[
            WS,
            REPO_QUERY,
            keyed(
                opt("number", "PR number", Where::Query, Kind::Int),
                "pr_number",
            ),
        ],
    ),
    cmd(
        &["pr", "resolve"],
        "Resolve or unresolve a review thread",
        "POST",
        "/workspaces/{ws}/pull-requests/comments/resolve",
        &[
            WS,
            REPO_BODY,
            keyed(
                req("number", "PR number", Where::Body, Kind::Int),
                "pr_number",
            ),
            keyed(
                req("thread", "Review thread id", Where::Body, Kind::Str),
                "thread_id",
            ),
            keyed(
                opt(
                    "unresolve",
                    "Mark unresolved instead",
                    Where::Local,
                    Kind::Flag,
                ),
                "resolved",
            ),
        ],
    ),
    cmd(
        &["pr", "info"],
        "PR details by URL",
        "GET",
        "/repos/pr-info",
        &[req("url", "PR URL", Where::Query, Kind::Str)],
    ),
    local(cmd(
        &["pr", "link-issue"],
        "Track a PR for an issue (cloud)",
        "POST",
        "/remote/pull-requests/link",
        &[
            keyed(req("url", "PR URL", Where::Body, Kind::Str), "pr_url"),
            keyed(
                req("number", "PR number", Where::Body, Kind::Int),
                "pr_number",
            ),
            keyed(
                req("base", "Base branch", Where::Body, Kind::Str),
                "base_branch",
            ),
        ],
    )),
    local(cmd(
        &["pr", "tracked"],
        "PRs tracked for an issue (cloud)",
        "GET",
        "/remote/pull-requests",
        &[keyed(pos("issue", "Issue id", Where::Query), "issue_id")],
    )),
    cmd(
        &["pr", "checkout-status"],
        "Progress of a from-PR workspace checkout",
        "GET",
        "/workspaces/from-pr/status",
        &[keyed(
            pos("ws", "Workspace id", Where::Query),
            "workspace_id",
        )],
    ),
    local(cmd(
        &["pr", "cloud", "list"],
        "GitHub PRs via the cloud (repository owner/name)",
        "GET",
        "/remote/cloud/github/pull-requests",
        &[
            req("repository", "owner/name", Where::Query, Kind::Str),
            keyed(
                opt(
                    "involved",
                    "Only PRs I am involved in",
                    Where::Query,
                    Kind::Flag,
                ),
                "involves_me",
            ),
            opt("refresh", "Bypass the cache", Where::Query, Kind::Flag),
        ],
    )),
    local(cmd(
        &["pr", "cloud", "get"],
        "One GitHub PR via the cloud",
        "GET",
        "/remote/cloud/github/pull-requests/detail",
        &[req("url", "PR URL", Where::Query, Kind::Str)],
    )),
    local(cmd(
        &["pr", "cloud", "comments"],
        "GitHub PR comments via the cloud",
        "GET",
        "/remote/cloud/github/pull-requests/comments",
        &[req("url", "PR URL", Where::Query, Kind::Str), QUERY],
    )),
    local(cmd(
        &["pr", "cloud", "sync"],
        "Refresh the cloud's tracked PR states",
        "POST",
        "/remote/cloud/github/pull-requests/tracked/sync",
        &[BODY],
    )),
    special(
        &["pr", "list"],
        "PRs of a repository: open ones, or --involved for those involving me",
        "pr.list",
        &[
            req("repo", "Repository id", Where::Local, Kind::Str),
            opt(
                "involved",
                "PRs I am involved in instead of all open PRs",
                Where::Local,
                Kind::Flag,
            ),
            opt(
                "refresh",
                "Bypass the cache (with --involved)",
                Where::Local,
                Kind::Flag,
            ),
            opt(
                "remote",
                "Remote name (without --involved)",
                Where::Local,
                Kind::Str,
            ),
        ],
    ),
    cmd(
        &["pr", "comments-url"],
        "Review comments of any PR by URL",
        "GET",
        "/repos/pr-comments",
        &[
            req("url", "Repository or PR URL", Where::Query, Kind::Str),
            keyed(
                req("number", "PR number", Where::Query, Kind::Int),
                "pr_number",
            ),
        ],
    ),
    cmd(
        &["pr", "resolve-url"],
        "Resolve or unresolve a review thread of any PR by URL",
        "POST",
        "/repos/pr-comments/resolve",
        &[
            req("url", "Repository or PR URL", Where::Body, Kind::Str),
            keyed(
                req("number", "PR number", Where::Body, Kind::Int),
                "pr_number",
            ),
            keyed(
                req("thread", "Review thread id", Where::Body, Kind::Str),
                "thread_id",
            ),
            keyed(
                opt(
                    "unresolve",
                    "Mark unresolved instead",
                    Where::Local,
                    Kind::Flag,
                ),
                "resolved",
            ),
        ],
    ),
    // ---- issue --------------------------------------------------------------
    special(
        &["issue", "list"],
        "Issues of a project (status names resolved)",
        "issue.list",
        &[
            req("project", "Project id", Where::Local, Kind::Str),
            opt("status", "Status name or id", Where::Local, Kind::Str),
            opt(
                "priority",
                "urgent|high|medium|low",
                Where::Local,
                Kind::Str,
            ),
            opt(
                "search",
                "Substring of title/description",
                Where::Local,
                Kind::Str,
            ),
            opt("parent", "Parent issue id", Where::Local, Kind::Str),
            opt("assignee", "Assignee user id", Where::Local, Kind::Str),
            opt("tag", "Tag id", Where::Local, Kind::Str),
            opt(
                "simple-id",
                "Simple id, e.g. ABC-123",
                Where::Local,
                Kind::Str,
            ),
            opt(
                "sort",
                "sort_order|priority|created_at|updated_at|title",
                Where::Local,
                Kind::Str,
            ),
            opt("dir", "asc|desc", Where::Local, Kind::Str),
            opt("limit", "Max rows (default 50)", Where::Local, Kind::Int),
            opt("offset", "Rows to skip", Where::Local, Kind::Int),
        ],
    ),
    local(cmd(
        &["issue", "get"],
        "One issue",
        "GET",
        "/remote/issues/{issue}",
        &[ISSUE],
    )),
    special(
        &["issue", "create"],
        "Create an issue",
        "issue.create",
        &[
            req("project", "Project id", Where::Local, Kind::Str),
            req("title", "Title", Where::Local, Kind::Str),
            opt(
                "description",
                "Description (supports @tag expansion)",
                Where::Local,
                Kind::Str,
            ),
            opt(
                "priority",
                "urgent|high|medium|low",
                Where::Local,
                Kind::Str,
            ),
            opt("parent", "Parent issue id", Where::Local, Kind::Str),
            opt(
                "status",
                "Status name (default: the project's first status)",
                Where::Local,
                Kind::Str,
            ),
        ],
    ),
    special(
        &["issue", "update"],
        "Update title/description/status/priority/parent",
        "issue.update",
        &[
            ISSUE,
            opt("title", "New title", Where::Local, Kind::Str),
            opt("description", "New description", Where::Local, Kind::Str),
            opt("status", "Status name or id", Where::Local, Kind::Str),
            opt(
                "priority",
                "urgent|high|medium|low",
                Where::Local,
                Kind::Str,
            ),
            opt(
                "parent",
                "Parent issue id, or 'none' to un-nest",
                Where::Local,
                Kind::Str,
            ),
        ],
    ),
    local(cmd(
        &["issue", "delete"],
        "Delete an issue",
        "DELETE",
        "/remote/issues/{issue}",
        &[ISSUE],
    )),
    local(cmd(
        &["issue", "search"],
        "Full search request body against /remote/issues/search",
        "POST",
        "/remote/issues/search",
        &[
            keyed(
                req("project", "Project id", Where::Body, Kind::Str),
                "project_id",
            ),
            opt("search", "Substring", Where::Body, Kind::Str),
            BODY,
        ],
    )),
    local(cmd(
        &["issue", "bulk"],
        "Bulk-update issues (cloud)",
        "POST",
        "/remote/cloud/issues/bulk",
        &[req("body", "Bulk request JSON", Where::Raw, Kind::Json)],
    )),
    local(cmd(
        &["issue", "review-request"],
        "Mark an issue ready for review (cloud)",
        "POST",
        "/remote/cloud/issues/{issue}/mark_for_review",
        &[ISSUE],
    )),
    local(cmd(
        &["issue", "comments", "list"],
        "Comments of an issue",
        "GET",
        "/remote/cloud/issue_comments",
        &[keyed(pos("issue", "Issue id", Where::Query), "issue_id")],
    )),
    local(cmd(
        &["issue", "comments", "add"],
        "Add a comment",
        "POST",
        "/remote/cloud/issue_comments",
        &[
            keyed(pos("issue", "Issue id", Where::Body), "issue_id"),
            short(
                req("message", "Comment text (markdown)", Where::Body, Kind::Str),
                'm',
            ),
            keyed(
                opt(
                    "parent",
                    "Parent comment id (reply)",
                    Where::Body,
                    Kind::Str,
                ),
                "parent_id",
            ),
        ],
    )),
    local(cmd(
        &["issue", "comments", "edit"],
        "Edit a comment",
        "PATCH",
        "/remote/cloud/issue_comments/{comment}",
        &[
            pos("comment", "Comment id", Where::Path),
            short(req("message", "New text", Where::Body, Kind::Str), 'm'),
        ],
    )),
    local(cmd(
        &["issue", "comments", "delete"],
        "Delete a comment",
        "DELETE",
        "/remote/cloud/issue_comments/{comment}",
        &[pos("comment", "Comment id", Where::Path)],
    )),
    local(cmd(
        &["issue", "react"],
        "React to a comment",
        "POST",
        "/remote/cloud/issue_comment_reactions",
        &[
            keyed(pos("comment", "Comment id", Where::Body), "comment_id"),
            req("emoji", "Emoji", Where::Body, Kind::Str),
        ],
    )),
    local(cmd(
        &["issue", "follow"],
        "Follow an issue",
        "POST",
        "/remote/cloud/issue_followers",
        &[
            keyed(pos("issue", "Issue id", Where::Body), "issue_id"),
            keyed(req("user", "User id", Where::Body, Kind::Str), "user_id"),
        ],
    )),
    local(cmd(
        &["issue", "unfollow"],
        "Remove a follower row",
        "DELETE",
        "/remote/cloud/issue_followers/{follower}",
        &[pos("follower", "Issue follower row id", Where::Path)],
    )),
    local(cmd(
        &["issue", "milestones", "list"],
        "Milestones of a project",
        "GET",
        "/remote/cloud/project_milestones",
        &[keyed(
            req("project", "Project id", Where::Query, Kind::Str),
            "project_id",
        )],
    )),
    local(cmd(
        &["issue", "milestones", "create"],
        "Create a milestone",
        "POST",
        "/remote/cloud/project_milestones",
        &[
            keyed(
                req("project", "Project id", Where::Body, Kind::Str),
                "project_id",
            ),
            req("name", "Name", Where::Body, Kind::Str),
            BODY,
        ],
    )),
    local(cmd(
        &["issue", "milestones", "set"],
        "Put an issue in a milestone",
        "POST",
        "/remote/cloud/issue_milestones",
        &[
            keyed(pos("issue", "Issue id", Where::Body), "issue_id"),
            keyed(
                req("milestone", "Milestone id", Where::Body, Kind::Str),
                "milestone_id",
            ),
        ],
    )),
    local(cmd(
        &["issue", "attachments", "list"],
        "Attachments of an issue",
        "GET",
        "/remote/cloud/issues/{issue}/attachments",
        &[ISSUE],
    )),
    local(cmd(
        &["issue", "assignees", "add"],
        "Assign a user",
        "POST",
        "/remote/issue-assignees",
        &[
            keyed(pos("issue", "Issue id", Where::Body), "issue_id"),
            keyed(req("user", "User id", Where::Body, Kind::Str), "user_id"),
        ],
    )),
    local(cmd(
        &["issue", "assignees", "remove"],
        "Remove an assignee row",
        "DELETE",
        "/remote/issue-assignees/{assignee}",
        &[pos("assignee", "Issue assignee row id", Where::Path)],
    )),
    local(cmd(
        &["issue", "assignees", "list"],
        "Assignees of an issue",
        "GET",
        "/remote/issue-assignees",
        &[keyed(pos("issue", "Issue id", Where::Query), "issue_id")],
    )),
    local(cmd(
        &["issue", "tags", "list"],
        "Tags on an issue",
        "GET",
        "/remote/issue-tags",
        &[keyed(pos("issue", "Issue id", Where::Query), "issue_id")],
    )),
    local(cmd(
        &["issue", "tags", "add"],
        "Attach a tag",
        "POST",
        "/remote/issue-tags",
        &[
            keyed(pos("issue", "Issue id", Where::Body), "issue_id"),
            keyed(req("tag", "Tag id", Where::Body, Kind::Str), "tag_id"),
        ],
    )),
    local(cmd(
        &["issue", "tags", "remove"],
        "Detach a tag row",
        "DELETE",
        "/remote/issue-tags/{issue_tag}",
        &[pos("issue_tag", "Issue-tag row id", Where::Path)],
    )),
    local(cmd(
        &["issue", "relations", "list"],
        "Relationships of an issue",
        "GET",
        "/remote/issue-relationships",
        &[keyed(pos("issue", "Issue id", Where::Query), "issue_id")],
    )),
    local(cmd(
        &["issue", "relations", "add"],
        "Relate two issues",
        "POST",
        "/remote/issue-relationships",
        &[
            keyed(pos("issue", "Issue id", Where::Body), "issue_id"),
            keyed(
                req("related", "Related issue id", Where::Body, Kind::Str),
                "related_issue_id",
            ),
            keyed(
                req(
                    "type",
                    "blocking|related|has_duplicate",
                    Where::Body,
                    Kind::Str,
                ),
                "relationship_type",
            ),
        ],
    )),
    local(cmd(
        &["issue", "relations", "remove"],
        "Delete a relationship",
        "DELETE",
        "/remote/issue-relationships/{relationship}",
        &[pos("relationship", "Relationship id", Where::Path)],
    )),
    local(cmd(
        &["issue", "statuses", "list"],
        "Statuses of a project",
        "GET",
        "/remote/project-statuses",
        &[keyed(
            req("project", "Project id", Where::Query, Kind::Str),
            "project_id",
        )],
    )),
    local(cmd(
        &["issue", "statuses", "create"],
        "Create a status",
        "POST",
        "/remote/cloud/project_statuses",
        &[
            keyed(
                req("project", "Project id", Where::Body, Kind::Str),
                "project_id",
            ),
            req("name", "Name", Where::Body, Kind::Str),
            req("color", "Color", Where::Body, Kind::Str),
            keyed(
                req("sort-order", "Sort order", Where::Body, Kind::Int),
                "sort_order",
            ),
            req("hidden", "Hide the status column", Where::Body, Kind::Bool),
        ],
    )),
    local(cmd(
        &["issue", "statuses", "update"],
        "Update a status",
        "PATCH",
        "/remote/cloud/project_statuses/{status}",
        &[
            pos("status", "Status id", Where::Path),
            opt("name", "Name", Where::Body, Kind::Str),
            opt("color", "Color", Where::Body, Kind::Str),
            keyed(
                opt("sort-order", "Sort order", Where::Body, Kind::Int),
                "sort_order",
            ),
            opt("hidden", "true|false", Where::Body, Kind::Bool),
        ],
    )),
    local(cmd(
        &["issue", "project", "get"],
        "One project",
        "GET",
        "/remote/projects/{project}",
        &[pos("project", "Project id", Where::Path)],
    )),
    local(cmd(
        &["issue", "project", "update"],
        "Update a project",
        "PATCH",
        "/remote/cloud/projects/{project}",
        &[
            pos("project", "Project id", Where::Path),
            opt("name", "Name", Where::Body, Kind::Str),
            opt("color", "Color", Where::Body, Kind::Str),
            BODY,
        ],
    )),
    local(cmd(
        &["issue", "tag", "list"],
        "Tags of a project",
        "GET",
        "/remote/tags",
        &[keyed(
            req("project", "Project id", Where::Query, Kind::Str),
            "project_id",
        )],
    )),
    local(cmd(
        &["issue", "tag", "create"],
        "Create a tag",
        "POST",
        "/remote/cloud/tags",
        &[
            keyed(
                req("project", "Project id", Where::Body, Kind::Str),
                "project_id",
            ),
            req("name", "Name", Where::Body, Kind::Str),
            req("color", "Color", Where::Body, Kind::Str),
        ],
    )),
    local(cmd(
        &["issue", "tag", "update"],
        "Update a tag",
        "PATCH",
        "/remote/cloud/tags/{tag}",
        &[
            pos("tag", "Tag id", Where::Path),
            opt("name", "Name", Where::Body, Kind::Str),
            opt("color", "Color", Where::Body, Kind::Str),
        ],
    )),
    local(cmd(
        &["issue", "tag", "delete"],
        "Delete a tag",
        "DELETE",
        "/remote/cloud/tags/{tag}",
        &[pos("tag", "Tag id", Where::Path)],
    )),
    local(cmd(
        &["issue", "org", "list"],
        "Organizations I belong to",
        "GET",
        "/organizations",
        &[],
    )),
    local(cmd(
        &["issue", "org", "get"],
        "One organization",
        "GET",
        "/organizations/{org}",
        &[pos("org", "Organization id", Where::Path)],
    )),
    local(cmd(
        &["issue", "org", "update"],
        "Rename an organization",
        "PATCH",
        "/organizations/{org}",
        &[
            pos("org", "Organization id", Where::Path),
            req("name", "New name", Where::Body, Kind::Str),
        ],
    )),
    local(cmd(
        &["issue", "org", "members"],
        "Members of an organization",
        "GET",
        "/organizations/{org}/members",
        &[pos("org", "Organization id", Where::Path)],
    )),
    special(
        &["issue", "priorities"],
        "Allowed priority values",
        "issue.priorities",
        &[],
    ),
    local(cmd(
        &["issue", "projects"],
        "Projects of an organization",
        "GET",
        "/remote/projects",
        &[keyed(
            req("org", "Organization id", Where::Query, Kind::Str),
            "organization_id",
        )],
    )),
    special(
        &["issue", "attachments", "upload"],
        "Upload a local file as an issue attachment",
        "issue.attachments.upload",
        &[ISSUE, pos("file", "Local file path", Where::Local)],
    ),
    // ---- notify -------------------------------------------------------------
    special(
        &["notify", "send"],
        "Send the user a notification",
        "notify.send",
        &[
            short(req("title", "Title", Where::Local, Kind::Str), 't'),
            short(req("message", "Body", Where::Local, Kind::Str), 'm'),
            opt(
                "ws",
                "Workspace to open when clicked",
                Where::Local,
                Kind::Str,
            ),
            opt(
                "local-only",
                "Only this host, not cloud web push",
                Where::Local,
                Kind::Flag,
            ),
        ],
    ),
    local(cmd(
        &["notify", "get"],
        "Read my notification in full (external text is untrusted data)",
        "GET",
        "/remote/cloud/notifications/{id}",
        &[pos("id", "Notification id", Where::Path)],
    )),
    local(cmd(
        &["notify", "list"],
        "My cloud notifications",
        "GET",
        "/remote/cloud/notifications",
        &[keyed(
            opt("dismissed", "Include dismissed", Where::Query, Kind::Flag),
            "include_dismissed",
        )],
    )),
    special(
        &["notify", "mark"],
        "Mark a notification seen or dismissed",
        "notify.mark",
        &[
            pos("id", "Notification id", Where::Local),
            opt("seen", "Mark seen", Where::Local, Kind::Flag),
            opt("dismiss", "Dismiss (archive)", Where::Local, Kind::Flag),
        ],
    ),
    local(cmd(
        &["notify", "prefs", "get"],
        "Notification preferences",
        "GET",
        "/remote/cloud/user-notification-preferences",
        &[],
    )),
    local(cmd(
        &["notify", "prefs", "set"],
        "Update notification preferences",
        "PUT",
        "/remote/cloud/user-notification-preferences",
        &[req("body", "Preferences JSON", Where::Raw, Kind::Json)],
    )),
    // ---- drawer -------------------------------------------------------------
    special(
        &["drawer", "list"],
        "Drawer notes (inbox by default)",
        "drawer.list",
        &[
            opt("archived", "Archived notes only", Where::Local, Kind::Flag),
            opt("all", "Inbox and archive", Where::Local, Kind::Flag),
        ],
    ),
    special(
        &["drawer", "get"],
        "One note with its comments",
        "drawer.get",
        &[pos("id", "Note id", Where::Local)],
    ),
    special(
        &["drawer", "create"],
        "Write a note (title + markdown body); artifacts: a `[Title](path \"vibe-artifact\")` line",
        "drawer.create",
        &[
            short(req("title", "Title", Where::Local, Kind::Str), 't'),
            short(
                opt("message", "Markdown body", Where::Local, Kind::Str),
                'm',
            ),
            short(
                opt(
                    "file",
                    "Read the body from a file ('-' = stdin)",
                    Where::Local,
                    Kind::Str,
                ),
                'f',
            ),
            opt(
                "label",
                "Status chip, e.g. '확인 필요' / '진행 중'",
                Where::Local,
                Kind::Str,
            ),
            opt("pin", "Keep at the top", Where::Local, Kind::Flag),
            opt(
                "ws",
                "Workspace the body's artifacts belong to (default: this shell's, else the Autopilot)",
                Where::Local,
                Kind::Str,
            ),
            opt(
                "notify",
                "Also send one notification that opens this note",
                Where::Local,
                Kind::Flag,
            ),
        ],
    ),
    special(
        &["drawer", "update"],
        "Change a note's title, body, label or pin",
        "drawer.update",
        &[
            pos("id", "Note id", Where::Local),
            short(opt("title", "New title", Where::Local, Kind::Str), 't'),
            short(
                opt("message", "New markdown body", Where::Local, Kind::Str),
                'm',
            ),
            short(
                opt(
                    "file",
                    "Read the new body from a file ('-' = stdin)",
                    Where::Local,
                    Kind::Str,
                ),
                'f',
            ),
            opt("label", "Status chip ('' clears)", Where::Local, Kind::Str),
            opt("pin", "Keep at the top", Where::Local, Kind::Flag),
            opt("unpin", "Stop keeping at the top", Where::Local, Kind::Flag),
            opt(
                "ws",
                "Workspace the body's artifacts belong to",
                Where::Local,
                Kind::Str,
            ),
        ],
    ),
    special(
        &["drawer", "archive"],
        "Move a note to the archive (deleted 90 days later)",
        "drawer.archive",
        &[pos("id", "Note id", Where::Local)],
    ),
    special(
        &["drawer", "unarchive"],
        "Move a note back to the inbox",
        "drawer.unarchive",
        &[pos("id", "Note id", Where::Local)],
    ),
    local(cmd(
        &["drawer", "delete"],
        "Delete a note and its comments",
        "DELETE",
        "/remote/cloud/drawer_notes/{id}",
        &[pos("id", "Note id", Where::Path)],
    )),
    special(
        &["drawer", "comment"],
        "Reply on a note (as the Autopilot)",
        "drawer.comment",
        &[
            pos("id", "Note id", Where::Local),
            short(req("message", "Comment text", Where::Local, Kind::Str), 'm'),
        ],
    ),
    local(cmd(
        &["drawer", "comments"],
        "A note's comments, oldest first",
        "GET",
        "/remote/cloud/drawer_comments",
        &[keyed(pos("id", "Note id", Where::Query), "note_id")],
    )),
    // ---- config -------------------------------------------------------------
    special(
        &["config", "get"],
        "Host configuration (secrets masked)",
        "config.get",
        &[opt(
            "path",
            "Dotted path inside the config, e.g. agent_access.git_write",
            Where::Local,
            Kind::Str,
        )],
    ),
    special(
        &["config", "set"],
        "Set config fields: key=value ... (JSON values; gated by agent_access.update_config)",
        "config.set",
        &[ArgSpec {
            kind: Kind::Pairs,
            ..pos(
                "pairs",
                "key=value ... (dotted keys; value parsed as JSON, else string)",
                Where::Local,
            )
        }],
    ),
    cmd(
        &["config", "profiles", "get"],
        "Executor profiles",
        "GET",
        "/profiles",
        &[],
    ),
    special(
        &["config", "profiles", "set"],
        "Replace executor profiles (JSON) with revision check",
        "config.profiles.set",
        &[req("body", "Profiles JSON", Where::Local, Kind::Json)],
    ),
    cmd(
        &["config", "recent-models"],
        "Record recently used models for an executor",
        "PATCH",
        "/profiles/recent-models",
        &[req(
            "body",
            "{executor, recently_used_models, revision}",
            Where::Raw,
            Kind::Json,
        )],
    ),
    special(
        &["config", "models"],
        "Models, agents and providers an executor can use",
        "config.models",
        &[
            pos("executor", "Executor, e.g. CLAUDE_CODE", Where::Local),
            opt("variant", "Variant/preset", Where::Local, Kind::Str),
        ],
    ),
    cmd(
        &["config", "presets"],
        "Default options of an executor preset",
        "GET",
        "/agents/preset-options",
        &[
            pos("executor", "Executor", Where::Query),
            opt("variant", "Variant/preset", Where::Query, Kind::Str),
        ],
    ),
    cmd(
        &["config", "availability", "agents"],
        "Is an executor installed",
        "GET",
        "/agents/check-availability",
        &[pos("executor", "Executor", Where::Query)],
    ),
    cmd(
        &["config", "availability", "editors"],
        "Is an editor installed",
        "GET",
        "/editors/check-availability",
        &[keyed(
            pos("editor", "Editor type", Where::Query),
            "editor_type",
        )],
    ),
    cmd(
        &["config", "mcp-servers", "get"],
        "MCP servers configured for an executor",
        "GET",
        "/mcp-config",
        &[pos("executor", "Executor", Where::Query)],
    ),
    cmd(
        &["config", "mcp-servers", "set"],
        "Replace an executor's MCP servers",
        "POST",
        "/mcp-config",
        &[
            pos("executor", "Executor", Where::Query),
            req("servers", "Servers JSON object", Where::Body, Kind::Json),
        ],
    ),
    special(
        &["config", "host", "info"],
        "Version, machine id, login status, environment",
        "config.host.info",
        &[],
    ),
    local(cmd(
        &["config", "host", "self"],
        "This machine's cloud host id",
        "GET",
        "/relay-auth/client/self-host",
        &[],
    )),
    cmd(
        &["config", "host", "appearance"],
        "Host primary color",
        "GET",
        "/host-appearance",
        &[],
    ),
    cmd(
        &["config", "releases"],
        "Release notes",
        "GET",
        "/releases",
        &[],
    ),
    local(cmd(
        &["config", "web-settings", "get"],
        "Cloud web settings",
        "GET",
        "/remote/cloud/user-web-settings",
        &[],
    )),
    local(cmd(
        &["config", "web-settings", "set"],
        "Replace cloud web settings",
        "PUT",
        "/remote/cloud/user-web-settings",
        &[req("body", "Settings JSON", Where::Raw, Kind::Json)],
    )),
    // ---- repo ---------------------------------------------------------------
    cmd(
        &["repo", "list"],
        "Registered repositories",
        "GET",
        "/repos",
        &[],
    ),
    cmd(
        &["repo", "get"],
        "One repository",
        "GET",
        "/repos/{repo}",
        &[pos("repo", "Repository id", Where::Path)],
    ),
    cmd(
        &["repo", "register"],
        "Register an existing checkout",
        "POST",
        "/repos",
        &[
            req("path", "Checkout path", Where::Body, Kind::Str),
            keyed(
                opt("name", "Display name", Where::Body, Kind::Str),
                "display_name",
            ),
        ],
    ),
    cmd(
        &["repo", "init"],
        "Create and register a new repository",
        "POST",
        "/repos/init",
        &[
            keyed(
                req("parent", "Parent directory", Where::Body, Kind::Str),
                "parent_path",
            ),
            keyed(
                req("folder", "Folder name", Where::Body, Kind::Str),
                "folder_name",
            ),
        ],
    ),
    cmd(
        &["repo", "update"],
        "Update repo settings and scripts",
        "PUT",
        "/repos/{repo}",
        &[
            pos("repo", "Repository id", Where::Path),
            keyed(
                opt("name", "Display name", Where::Body, Kind::Str),
                "display_name",
            ),
            keyed(
                opt(
                    "target-branch",
                    "Default target branch",
                    Where::Body,
                    Kind::Str,
                ),
                "default_target_branch",
            ),
            keyed(
                opt("primary-remote", "Primary remote", Where::Body, Kind::Str),
                "primary_remote",
            ),
            keyed(
                opt(
                    "working-dir",
                    "Agent working directory",
                    Where::Body,
                    Kind::Str,
                ),
                "default_working_dir",
            ),
            keyed(
                opt("setup-script", "Setup script", Where::Body, Kind::Str),
                "setup_script",
            ),
            keyed(
                opt("cleanup-script", "Cleanup script", Where::Body, Kind::Str),
                "cleanup_script",
            ),
            keyed(
                opt(
                    "dev-server-script",
                    "Dev server script",
                    Where::Body,
                    Kind::Str,
                ),
                "dev_server_script",
            ),
            keyed(
                opt("archive-script", "Archive script", Where::Body, Kind::Str),
                "archive_script",
            ),
            BODY,
        ],
    ),
    cmd(
        &["repo", "recent"],
        "Recently used repositories",
        "GET",
        "/repos/recent",
        &[],
    ),
    cmd(
        &["repo", "batch"],
        "Several repositories by id",
        "POST",
        "/repos/batch",
        &[req(
            "ids",
            "Repository ids, comma-separated",
            Where::Body,
            Kind::List,
        )],
    ),
    cmd(
        &["repo", "search"],
        "Find files in a repository",
        "GET",
        "/repos/{repo}/search",
        &[
            pos("repo", "Repository id", Where::Path),
            short(req("q", "Query", Where::Query, Kind::Str), 'q'),
            opt(
                "mode",
                "taskform|settings (settings includes ignored files)",
                Where::Query,
                Kind::Str,
            ),
        ],
    ),
    cmd(
        &["repo", "branches"],
        "Branches of a repository",
        "GET",
        "/repos/{repo}/branches",
        &[
            pos("repo", "Repository id", Where::Path),
            opt("fetch", "Fetch first", Where::Query, Kind::Flag),
        ],
    ),
    cmd(
        &["repo", "remotes"],
        "Remotes of a repository",
        "GET",
        "/repos/{repo}/remotes",
        &[pos("repo", "Repository id", Where::Path)],
    ),
    cmd(
        &["repo", "fetch"],
        "Fetch from the primary remote",
        "POST",
        "/repos/{repo}/fetch",
        &[pos("repo", "Repository id", Where::Path)],
    ),
    cmd(
        &["repo", "remote-status"],
        "Checked-out branch vs its remote",
        "GET",
        "/repos/{repo}/remote-status",
        &[pos("repo", "Repository id", Where::Path)],
    ),
    cmd(
        &["repo", "branch-from-remote"],
        "Create a local branch from a remote one",
        "POST",
        "/repos/{repo}/branches/local",
        &[
            pos("repo", "Repository id", Where::Path),
            keyed(
                req(
                    "remote-branch",
                    "e.g. origin/feature",
                    Where::Body,
                    Kind::Str,
                ),
                "remote_branch",
            ),
        ],
    ),
    cmd(
        &["repo", "push"],
        "Push the checked-out branch (no force)",
        "POST",
        "/repos/{repo}/push",
        &[pos("repo", "Repository id", Where::Path)],
    ),
    cmd(
        &["repo", "fs", "ls"],
        "List a directory on the host",
        "GET",
        "/filesystem/directory",
        &[pos("path", "Directory path", Where::Query)],
    ),
    cmd(
        &["repo", "fs", "git-repos"],
        "Git repositories under a directory",
        "GET",
        "/filesystem/git-repos",
        &[pos("path", "Directory path", Where::Query)],
    ),
    special(
        &["repo", "search-files"],
        "Find files across a workspace's repositories",
        "repo.search-files",
        &[
            WS,
            short(req("q", "Query", Where::Local, Kind::Str), 'q'),
            opt(
                "mode",
                "taskform|settings (settings includes ignored files)",
                Where::Local,
                Kind::Str,
            ),
        ],
    ),
    // ---- automation ---------------------------------------------------------
    cmd(
        &["automation", "routines", "upsert"],
        "Create or update a routine",
        "POST",
        "/automation/routines",
        &[req("body", "Routine JSON", Where::Raw, Kind::Json)],
    ),
    cmd(
        &["automation", "routines", "delete"],
        "Delete a routine",
        "DELETE",
        "/automation/routines/{id}",
        &[pos("id", "Routine id", Where::Path)],
    ),
    cmd(
        &["automation", "routines", "run"],
        "Run a routine now",
        "POST",
        "/automation/routines/{id}/run",
        &[pos("id", "Routine id", Where::Path)],
    ),
    cmd(
        &["automation", "connectors", "enable"],
        "Enable/disable a connector",
        "PATCH",
        "/automation/connectors/{id}",
        &[
            pos("id", "Connector id", Where::Path),
            req("enabled", "true|false", Where::Body, Kind::Bool),
        ],
    ),
    cmd(
        &["automation", "connectors", "upsert"],
        "Create or update a connector (e.g. a `vibe_events` journal poller)",
        "POST",
        "/automation/connectors",
        &[req("body", "Connector JSON", Where::Raw, Kind::Json)],
    ),
    cmd(
        &["automation", "connectors", "delete"],
        "Delete a connector",
        "DELETE",
        "/automation/connectors/{id}",
        &[pos("id", "Connector id", Where::Path)],
    ),
    cmd(
        &["automation", "status"],
        "Worker state: routines, connectors, recent runs",
        "GET",
        "/automation/state",
        &[],
    ),
    cmd(
        &["automation", "enable"],
        "Master switch of the worker",
        "PATCH",
        "/automation/settings",
        &[req("enabled", "true|false", Where::Body, Kind::Bool)],
    ),
    cmd(
        &["automation", "logs"],
        "Worker logs",
        "GET",
        "/automation/logs",
        &[QUERY],
    ),
    cmd(
        &["automation", "receipts"],
        "Retry queue (pending actions)",
        "GET",
        "/automation/retry-queue",
        &[],
    ),
    cmd(
        &["automation", "memory-sync", "status"],
        "Agent memory sync status",
        "GET",
        "/agent-memory-sync/status",
        &[],
    ),
    cmd(
        &["automation", "memory-sync", "logs"],
        "Agent memory sync logs",
        "GET",
        "/agent-memory-sync/logs",
        &[opt("limit", "Max rows", Where::Query, Kind::Int)],
    ),
    cmd(
        &["automation", "memory-sync", "pending"],
        "Pending memory sync work",
        "GET",
        "/agent-memory-sync/pending",
        &[],
    ),
    cmd(
        &["automation", "memory-sync", "run"],
        "Run a memory sync now",
        "POST",
        "/agent-memory-sync/run",
        &[],
    ),
    cmd(
        &["automation", "memory-sync", "run-all"],
        "Run memory sync on every host",
        "POST",
        "/agent-memory-sync/run-all",
        &[],
    ),
    cmd(
        &["automation", "memory-sync", "mutations"],
        "Memory mutations (corrections/deletions)",
        "GET",
        "/agent-memory-sync/mutations",
        &[],
    ),
    cmd(
        &["automation", "host-status"],
        "This host's busy state as the worker sees it",
        "GET",
        "/automation-actions/status",
        &[],
    ),
    // ---- events -------------------------------------------------------------
    special(
        &["events", "list"],
        "Events after a cursor",
        "events.list",
        &[
            opt(
                "since",
                "Cursor to start after (default 0 = all buffered; `now` = only new events). With --all-hosts: host=cursor,host=cursor",
                Where::Local,
                Kind::Str,
            ),
            opt(
                "kinds",
                "Kind prefixes, comma-separated (process., approval.pending, workspace.status_note, vibe.phase, ...)",
                Where::Local,
                Kind::Str,
            ),
            opt("limit", "Max events (default 100)", Where::Local, Kind::Int),
            opt(
                "all-hosts",
                "Merge this machine and every other host",
                Where::Local,
                Kind::Flag,
            ),
        ],
    ),
    special(
        &["events", "wait"],
        "Block until a matching event lands (or the timeout passes)",
        "events.wait",
        &[
            req(
                "since",
                "Cursor to wait after (pass the last page's cursor). With --all-hosts: host=cursor,host=cursor",
                Where::Local,
                Kind::Str,
            ),
            opt(
                "kinds",
                "Kind prefixes, comma-separated",
                Where::Local,
                Kind::Str,
            ),
            opt(
                "timeout",
                "Seconds to wait (default 30, max 600)",
                Where::Local,
                Kind::Int,
            ),
            opt("limit", "Max events (default 100)", Where::Local, Kind::Int),
            opt(
                "all-hosts",
                "Watch this machine and every other host",
                Where::Local,
                Kind::Flag,
            ),
        ],
    ),
    // ---- hosts --------------------------------------------------------------
    special(
        &["hosts", "list"],
        "Your other hosts with status (plus this machine's own id)",
        "hosts.list",
        &[],
    ),
    special(
        &["hosts", "info"],
        "A host's version, machine id and environment",
        "hosts.info",
        &[pos("target", "Host id or name", Where::Local)],
    ),
    // ---- skill --------------------------------------------------------------
    special(
        &["skill", "install"],
        "Install the vibe-kanban-cli skill for Claude Code and Codex",
        "skill.install",
        &[
            opt(
                "claude-dir",
                "Claude skills dir (default ~/.claude/skills)",
                Where::Local,
                Kind::Str,
            ),
            opt(
                "codex-dir",
                "Codex skills dir (default ~/.codex/skills)",
                Where::Local,
                Kind::Str,
            ),
        ],
    ),
    special(
        &["skill", "show"],
        "Print the skill text",
        "skill.show",
        &[],
    ),
    special(
        &["skill", "path"],
        "Print where the skill is installed",
        "skill.path",
        &[],
    ),
];

// ---------------------------------------------------------------------------
// clap tree
// ---------------------------------------------------------------------------

fn clap_arg(spec: &ArgSpec) -> Arg {
    let mut arg = Arg::new(spec.name).help(spec.help);
    if spec.positional {
        arg = arg.required(spec.required);
        if spec.kind == Kind::Pairs {
            arg = arg.num_args(1..);
        }
    } else {
        arg = arg.long(spec.name).required(spec.required);
        if let Some(c) = spec.short {
            arg = arg.short(c);
        }
    }
    match spec.kind {
        Kind::Flag => arg.action(ArgAction::SetTrue),
        Kind::Pairs => arg.action(ArgAction::Append).value_name("VALUE"),
        Kind::Json => arg.value_name("JSON"),
        Kind::Bool => arg.value_name("true|false"),
        Kind::Int => arg.value_name("N"),
        Kind::List => arg.value_name("a,b,c"),
        Kind::Str => {
            let name: &'static str = Box::leak(
                spec.name
                    .to_ascii_uppercase()
                    .replace('-', "_")
                    .into_boxed_str(),
            );
            arg.value_name(name)
        }
    }
}

fn leaf(spec: &Cmd) -> Command {
    let mut command = Command::new(spec.path[spec.path.len() - 1]).about(spec.about);
    for arg in spec.args {
        command = command.arg(clap_arg(arg));
    }
    command
}

/// Help lines for the intermediate nodes of the tree (`vk ws attachments ...`).
const SUBGROUPS: &[(&str, &str)] = &[
    ("dev-server", "Start dev server processes"),
    (
        "attachments",
        "Workspace attachments: list, metadata, upload, associate, import",
    ),
    ("queue", "Queued follow-up messages of a session"),
    ("auto-resume", "Usage-limit auto-resume of a session"),
    ("vibe-review", "Automated vibe review of a session"),
    ("artifacts", "Artifacts a process attached"),
    (
        "subagent",
        "Subagents (Codex threads, Claude tasks) of a process",
    ),
    ("approvals", "Tool approvals and agent questions"),
    ("resumes", "Scheduled wakeups of a session"),
    ("target", "The workspace's target (base) branch"),
    ("cloud", "GitHub PR data through the cloud"),
    ("comments", "Issue comments"),
    ("milestones", "Project milestones"),
    ("assignees", "Issue assignees"),
    ("tags", "Tags on an issue"),
    ("relations", "Issue relationships"),
    ("statuses", "Project statuses"),
    ("project", "Cloud project"),
    ("tag", "Project tags"),
    ("org", "Organizations"),
    ("prefs", "Notification preferences"),
    ("profiles", "Executor profiles"),
    ("availability", "Installed agents and editors"),
    ("mcp-servers", "MCP servers configured per executor"),
    ("host", "This host"),
    ("web-settings", "Cloud web settings"),
    ("fs", "Host filesystem"),
    ("routines", "Automation routines"),
    ("connectors", "Automation connectors"),
    ("memory-sync", "Agent memory sync across hosts"),
];

fn attach(parent: Command, rest: &[&'static str], spec: &Cmd) -> Command {
    if rest.len() == 1 {
        return parent.subcommand(leaf(spec));
    }
    let name = rest[0];
    if parent.get_subcommands().any(|s| s.get_name() == name) {
        parent.mut_subcommand(name, |sub| attach(sub, &rest[1..], spec))
    } else {
        let about = SUBGROUPS
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, about)| *about)
            .unwrap_or("");
        let sub = attach(
            Command::new(name)
                .about(about)
                .subcommand_required(true)
                .arg_required_else_help(true),
            &rest[1..],
            spec,
        );
        parent.subcommand(sub)
    }
}

fn build_cli() -> Command {
    let mut root = Command::new("vk")
        .version(VERSION)
        .about("Vibe Kanban from the shell: workspaces, sessions, issues, git, events — on this host or a paired one.")
        .long_about(
            "Vibe Kanban from the shell. Every command talks to the local server (VIBE_BACKEND_URL, \
             BACKEND_PORT, or the port file) and prints a table; add --json for raw JSON. Pass \
             --host <id|name> to act on another of your hosts. Writes are gated by the user's agent-access \
             settings; a denied call explains which toggle is off.",
        )
        .subcommand_required(true)
        .arg_required_else_help(true)
        .arg(
            Arg::new("json")
                .long("json")
                .global(true)
                .action(ArgAction::SetTrue)
                .help("Print raw JSON"),
        )
        .arg(
            Arg::new("host")
                .long("host")
                .global(true)
                .value_name("ID|NAME")
                .help("Paired host to act on (default: this machine)"),
        )
        .arg(
            Arg::new("base-url")
                .long("base-url")
                .global(true)
                .value_name("URL")
                .help("Server URL (default: VIBE_BACKEND_URL / BACKEND_PORT / port file)"),
        )
        .arg(
            Arg::new("timeout")
                .long("timeout")
                .global(true)
                .value_name("SECS")
                .help("Request timeout in seconds (default 120)"),
        );
    for (name, about) in GROUPS {
        root = root.subcommand(
            Command::new(*name)
                .about(*about)
                .subcommand_required(true)
                .arg_required_else_help(true),
        );
    }
    for spec in COMMANDS {
        let group = spec.path[0];
        root = root.mut_subcommand(group, |g| attach(g, &spec.path[1..], spec));
    }
    root
}

/// Walk the matched subcommand chain back to the command spec.
fn resolve(matches: &ArgMatches) -> Option<(&'static Cmd, &ArgMatches)> {
    let mut path: Vec<&str> = Vec::new();
    let mut current = matches;
    while let Some((name, sub)) = current.subcommand() {
        path.push(name);
        current = sub;
    }
    COMMANDS
        .iter()
        .find(|spec| spec.path.iter().copied().eq(path.iter().copied()))
        .map(|spec| (spec, current))
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

struct Ctx {
    client: VkClient,
    json: bool,
    timeout: Duration,
}

type CliResult = Result<Value, VkError>;

fn arg_str(m: &ArgMatches, name: &str) -> Option<String> {
    m.try_get_one::<String>(name).ok().flatten().cloned()
}

fn arg_flag(m: &ArgMatches, name: &str) -> bool {
    m.try_get_one::<bool>(name)
        .ok()
        .flatten()
        .copied()
        .unwrap_or(false)
}

fn arg_many(m: &ArgMatches, name: &str) -> Vec<String> {
    m.try_get_many::<String>(name)
        .ok()
        .flatten()
        .map(|v| v.cloned().collect())
        .unwrap_or_default()
}

fn arg_usize(m: &ArgMatches, name: &str, default: usize) -> Result<usize, VkError> {
    match arg_str(m, name) {
        Some(raw) => raw
            .parse()
            .map_err(|_| VkError::message(format!("--{name} must be a number"))),
        None => Ok(default),
    }
}

fn arg_bool(m: &ArgMatches, name: &str) -> Result<Option<bool>, VkError> {
    match arg_str(m, name) {
        Some(raw) => parse_bool(&raw)
            .map(Some)
            .ok_or_else(|| VkError::message(format!("--{name} must be true or false"))),
        None => Ok(None),
    }
}

fn parse_bool(raw: &str) -> Option<bool> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "true" | "yes" | "on" | "1" => Some(true),
        "false" | "no" | "off" | "0" => Some(false),
        _ => None,
    }
}

fn parse_uuid(raw: &str, what: &str) -> Result<Uuid, VkError> {
    raw.trim()
        .parse()
        .map_err(|_| VkError::message(format!("{what} must be a UUID, got '{raw}'")))
}

/// `-m` text, or `-f` file (`-` = stdin). `None` when neither was given.
fn read_drawer_body(m: &ArgMatches) -> Result<Option<String>, VkError> {
    if let Some(path) = arg_str(m, "file") {
        let text = if path.trim() == "-" {
            let mut buffer = String::new();
            std::io::Read::read_to_string(&mut std::io::stdin(), &mut buffer)
                .map_err(|e| VkError::message(format!("Could not read stdin: {e}")))?;
            buffer
        } else {
            std::fs::read_to_string(&path)
                .map_err(|e| VkError::message(format!("Could not read {path}: {e}")))?
        };
        return Ok(Some(text));
    }
    Ok(arg_str(m, "message"))
}

fn typed_value(spec: &ArgSpec, raw: &str) -> Result<Value, VkError> {
    Ok(match spec.kind {
        Kind::Str | Kind::Flag | Kind::Pairs => Value::String(raw.to_string()),
        Kind::Bool => {
            Value::Bool(parse_bool(raw).ok_or_else(|| {
                VkError::message(format!("--{} must be true or false", spec.name))
            })?)
        }
        Kind::Int => Value::Number(
            raw.trim()
                .parse::<i64>()
                .map_err(|_| VkError::message(format!("--{} must be an integer", spec.name)))?
                .into(),
        ),
        Kind::Json => serde_json::from_str(raw)
            .map_err(|e| VkError::message(format!("--{} is not valid JSON: {e}", spec.name)))?,
        Kind::List => Value::Array(
            raw.split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| Value::String(s.to_string()))
                .collect(),
        ),
    })
}

impl Ctx {
    /// `.`: the workspace this shell runs in; `autopilot`: the host's
    /// Autopilot; a UUID as is; otherwise a workspace whose name matches.
    async fn workspace_id(&self, raw: &str) -> Result<Uuid, VkError> {
        let raw = raw.trim();
        if raw.eq_ignore_ascii_case("autopilot") {
            return Ok(self.autopilot().await?.workspace.id);
        }
        if raw == "." || raw.eq_ignore_ascii_case("current") {
            if let Ok(id) = std::env::var("VK_WORKSPACE_ID")
                && let Ok(id) = id.parse()
            {
                return Ok(id);
            }
            let cwd = std::env::current_dir().map_err(|e| VkError::message(e.to_string()))?;
            let canonical = utils::path::normalize_macos_private_alias(
                cwd.canonicalize().unwrap_or_else(|_| cwd.clone()),
            );
            // The server also matches a directory *above* a worktree; only a
            // shell inside the workspace may stand for it (`vk ws delete .`
            // from $HOME must not pick some worktree below).
            return self
                .client
                .workspace_context(&cwd)
                .await?
                .filter(|ctx| {
                    ctx.workspace.container_ref.as_deref().is_some_and(|root| {
                        canonical.starts_with(utils::path::normalize_macos_private_alias(root))
                    })
                })
                .map(|ctx| ctx.workspace.id)
                .ok_or_else(|| {
                    VkError::message(
                        "No workspace here: pass a workspace id or run inside a workspace worktree",
                    )
                });
        }
        if let Ok(id) = raw.parse() {
            return Ok(id);
        }
        let items = self
            .client
            .list_workspaces(&WorkspaceFilter {
                archived: Some(false),
                ..Default::default()
            })
            .await?;
        let lowered = raw.to_ascii_lowercase();
        let exact: Vec<_> = items
            .iter()
            .filter(|w| {
                w.name
                    .as_deref()
                    .is_some_and(|n| n.eq_ignore_ascii_case(raw))
                    || w.branch.eq_ignore_ascii_case(raw)
            })
            .collect();
        if let [only] = exact.as_slice() {
            return Ok(only.id);
        }
        let mut matches = items.iter().filter(|w| {
            w.name
                .as_deref()
                .is_some_and(|n| n.to_ascii_lowercase().starts_with(&lowered))
                || w.branch.eq_ignore_ascii_case(raw)
                || w.id.to_string().starts_with(&lowered)
        });
        match (matches.next(), matches.next()) {
            (Some(w), None) => Ok(w.id),
            (Some(_), Some(_)) => Err(VkError::message(format!(
                "'{raw}' matches several workspaces; use the id (vk ws list)"
            ))),
            (None, _) => Err(VkError::message(format!(
                "No active workspace matches '{raw}' (archived ones need the id)"
            ))),
        }
    }

    /// Where a Drawer note's artifacts live: this host, the given/current/Autopilot
    /// workspace, and the session and execution this shell runs in. The four go
    /// together (a manifest belongs to one execution), so outside a turn — no
    /// session/execution in the environment — nothing is sent and an updated
    /// note keeps the scope of the turn that last wrote it.
    async fn drawer_scope(&self, ws: Option<&str>) -> Vec<(&'static str, Value)> {
        let mut scope = Vec::new();
        let in_turn = std::env::var(utils::agent_cli::SESSION_ID_ENV).is_ok()
            && std::env::var(utils::agent_cli::EXECUTION_ID_ENV).is_ok();
        if !in_turn {
            return scope;
        }
        if let Some(host_id) = self.client.self_host_id().await {
            scope.push(("host_id", json!(host_id)));
        }
        let workspace = match ws {
            Some(raw) => self.workspace_id(raw).await.ok(),
            None => match std::env::var("VK_WORKSPACE_ID")
                .ok()
                .and_then(|id| id.parse().ok())
            {
                Some(id) => Some(id),
                None => self
                    .client
                    .autopilot()
                    .await
                    .ok()
                    .flatten()
                    .map(|a| a.workspace.id),
            },
        };
        if let Some(id) = workspace {
            scope.push(("workspace_id", json!(id)));
        }
        if let Some(id) = std::env::var(utils::agent_cli::SESSION_ID_ENV)
            .ok()
            .and_then(|id| id.parse::<Uuid>().ok())
        {
            scope.push(("session_id", json!(id)));
        }
        if let Some(id) = std::env::var(utils::agent_cli::EXECUTION_ID_ENV)
            .ok()
            .and_then(|id| id.parse::<Uuid>().ok())
        {
            scope.push(("execution_id", json!(id)));
        }
        scope
    }

    /// Register the body's `vibe-artifact` lines into the execution the note
    /// belongs to, so they render as tiles. Only when the note has a full
    /// scope (written inside a turn) and the body has an attachment line;
    /// returns the server's `{queued, files, missing}`.
    async fn register_drawer_artifacts(&self, note: &Value, body: &str) -> Option<Value> {
        if !body.contains("\"vibe-artifact\"") {
            return None;
        }
        let field = |key: &str| {
            note.get(key)
                .and_then(Value::as_str)
                .and_then(|id| id.parse::<Uuid>().ok())
        };
        let (workspace, session, execution) = (
            field("workspace_id")?,
            field("session_id")?,
            field("execution_id")?,
        );
        match self
            .client
            .exec(
                "POST",
                &format!("/execution-processes/{execution}/artifacts/register"),
                false,
                &[
                    ("workspace_id".to_string(), workspace.to_string()),
                    ("session_id".to_string(), session.to_string()),
                ],
                Some(&json!({ "text": body })),
                Some(self.timeout),
            )
            .await
        {
            Ok(result) => Some(result.get("data").cloned().unwrap_or(result)),
            Err(error) => Some(json!({ "error": error.to_string() })),
        }
    }

    /// The host's active Autopilot, or a clear error when there is none.
    async fn autopilot(&self) -> Result<AutopilotWorkspaceResponse, VkError> {
        self.client.autopilot().await?.ok_or_else(|| {
            VkError::message(
                "This host has no active Autopilot (create one from the Quick chat dialog's Autopilot tab or `vk ws quick-chat <path> --autopilot -m ...`; a paused one is archived)",
            )
        })
    }

    /// `session_id` plus the `autopilot` alias (the Autopilot's single session).
    async fn session_arg(&self, raw: &str) -> Result<Uuid, VkError> {
        if raw.trim().eq_ignore_ascii_case("autopilot") {
            return self
                .autopilot()
                .await?
                .session
                .map(|session| session.id)
                .ok_or_else(|| VkError::message("The Autopilot has no session yet"));
        }
        Self::session_id(raw)
    }

    fn session_id(raw: &str) -> Result<Uuid, VkError> {
        let raw = raw.trim();
        if raw == "." || raw.eq_ignore_ascii_case("current") {
            return std::env::var(utils::agent_cli::SESSION_ID_ENV)
                .ok()
                .and_then(|id| id.parse().ok())
                .ok_or_else(|| {
                    VkError::message(
                        "No current session: VK_SESSION_ID is not set in this shell; pass a session id",
                    )
                });
        }
        parse_uuid(raw, "session")
    }

    /// Resolve a path/query/body argument that names an id.
    async fn resolve_id_arg(&self, spec: &ArgSpec, raw: &str) -> Result<String, VkError> {
        Ok(match spec.name {
            "ws" => self.workspace_id(raw).await?.to_string(),
            "session" => self.session_arg(raw).await?.to_string(),
            _ => raw.trim().to_string(),
        })
    }

    async fn run_generic(&self, spec: &Cmd, m: &ArgMatches) -> CliResult {
        let mut route = spec.route.to_string();
        let mut query: Vec<(String, String)> = Vec::new();
        let mut body = Map::new();
        let mut raw_body: Option<Value> = None;
        let mut ws_for_repo: Option<Uuid> = None;
        for arg in spec.args {
            let key = arg.key.unwrap_or(arg.name).to_string();
            match arg.kind {
                Kind::Flag => {
                    let set = arg_flag(m, arg.name);
                    match arg.at {
                        Where::Query if set => query.push((key, "true".to_string())),
                        Where::Body => {
                            // `--unresolve` style inverted flags carry `resolved`.
                            let value = if arg.name == "unresolve" { !set } else { set };
                            if set || arg.name == "unresolve" {
                                body.insert(key, Value::Bool(value));
                            }
                        }
                        Where::Local if arg.name == "unresolve" => {
                            body.insert("resolved".to_string(), Value::Bool(!set));
                        }
                        _ => {}
                    }
                }
                Kind::Pairs => {
                    for pair in arg_many(m, arg.name) {
                        if let Some((k, v)) = pair.split_once('=') {
                            query.push((k.trim().to_string(), v.trim().to_string()));
                        } else {
                            return Err(VkError::message(format!(
                                "--{} expects key=value, got '{pair}'",
                                arg.name
                            )));
                        }
                    }
                }
                _ => {
                    let Some(raw) = arg_str(m, arg.name) else {
                        continue;
                    };
                    match arg.at {
                        Where::Path => {
                            let id = self.resolve_id_arg(arg, &raw).await?;
                            if arg.name == "ws" {
                                ws_for_repo = id.parse().ok();
                            }
                            route = route.replace(&format!("{{{}}}", arg.name), &id);
                        }
                        Where::Query => {
                            let mut value = self.resolve_id_arg(arg, &raw).await?;
                            // The server takes `CLAUDE_CODE`, not `claude-code`.
                            if arg.name == "executor" {
                                value = value.trim().replace('-', "_").to_ascii_uppercase();
                            }
                            query.push((key, value));
                        }
                        Where::Body => {
                            let value = if matches!(arg.kind, Kind::Str) {
                                Value::String(self.resolve_id_arg(arg, &raw).await?)
                            } else {
                                typed_value(arg, &raw)?
                            };
                            body.insert(key, value);
                        }
                        Where::Raw => {
                            let value = typed_value(arg, &raw)?;
                            // A keyed raw arg is the whole body (subagent
                            // targets); `--body` merges into it.
                            match (arg.key, value) {
                                (Some(_), value) => raw_body = Some(value),
                                (None, Value::Object(map)) => body.extend(map),
                                (None, value) => raw_body = Some(value),
                            }
                        }
                        Where::Local => {}
                    }
                }
            }
        }
        // Single-repo workspaces: fill `repo_id` when the command wants one.
        let wants_repo = spec
            .args
            .iter()
            .any(|a| a.name == "repo" && a.key == Some("repo_id"));
        if wants_repo && let Some(ws) = ws_for_repo {
            let in_body = spec
                .args
                .iter()
                .any(|a| a.name == "repo" && a.at == Where::Body);
            let present = if in_body {
                body.contains_key("repo_id")
            } else {
                query.iter().any(|(k, _)| k == "repo_id")
            };
            if !present {
                let repo_id = self.client.resolve_repo_id(ws, None).await?.to_string();
                if in_body {
                    body.insert("repo_id".to_string(), Value::String(repo_id));
                } else {
                    query.push(("repo_id".to_string(), repo_id));
                }
            }
        }
        let is_write = !matches!(spec.method, "GET" | "HEAD");
        let payload = raw_body.or_else(|| {
            if is_write {
                Some(Value::Object(body))
            } else {
                None
            }
        });
        self.client
            .exec(
                spec.method,
                &route,
                spec.local,
                &query,
                payload.as_ref(),
                Some(self.timeout),
            )
            .await
    }

    fn send_options(m: &ArgMatches) -> SendPromptOptions {
        SendPromptOptions {
            queue: arg_flag(m, "queue"),
            steer: arg_flag(m, "steer"),
            executor: arg_str(m, "executor"),
            variant: arg_str(m, "variant"),
            model_id: arg_str(m, "model"),
            agent_id: None,
            reasoning_id: arg_str(m, "reasoning"),
            permission_policy: arg_str(m, "permission"),
        }
    }

    fn executor_config(m: &ArgMatches, executor: &str) -> Value {
        let mut config = json!({ "executor": executor });
        for (flag, key) in [
            ("variant", "variant"),
            ("model", "model_id"),
            ("reasoning", "reasoning_id"),
        ] {
            if let Some(value) = arg_str(m, flag) {
                config[key] = json!(value);
            }
        }
        if let Some(policy) = arg_str(m, "permission") {
            config["permission_policy"] =
                json!(policy.trim().replace('-', "_").to_ascii_uppercase());
        }
        config
    }

    async fn run_special(&self, key: &str, m: &ArgMatches) -> CliResult {
        match key {
            "ws.list" => {
                let filter = WorkspaceFilter {
                    archived: arg_bool(m, "archived")?,
                    pinned: arg_bool(m, "pinned")?,
                    running: arg_bool(m, "running")?,
                    branch: arg_str(m, "branch"),
                    name_search: arg_str(m, "name"),
                };
                let items = self.client.list_workspaces(&filter).await?;
                let offset = arg_usize(m, "offset", 0)?;
                let limit = arg_usize(m, "limit", 50)?;
                let page: Vec<_> = items.into_iter().skip(offset).take(limit).collect();
                Ok(serde_json::to_value(page).unwrap_or_default())
            }
            "ws.summary" => {
                let ws = self
                    .workspace_id(&arg_str(m, "ws").unwrap_or_default())
                    .await?;
                let value = self
                    .client
                    .exec(
                        "POST",
                        "/workspaces/summaries",
                        false,
                        &[],
                        Some(&json!({ "archived": null, "include_latest_prompt": true })),
                        Some(self.timeout),
                    )
                    .await?;
                let row = value
                    .get("summaries")
                    .and_then(Value::as_array)
                    .and_then(|rows| {
                        rows.iter()
                            .find(|r| {
                                r.get("workspace_id").and_then(Value::as_str)
                                    == Some(&ws.to_string())
                            })
                            .cloned()
                    })
                    .ok_or_else(|| VkError::message(format!("No summary for workspace {ws}")))?;
                Ok(row)
            }
            "ws.create" | "ws.start" => {
                let repos: Vec<String> = arg_many(m, "repo");
                let branch = arg_str(m, "branch");
                let mut repo_inputs = Vec::new();
                for repo in &repos {
                    let repo_id = parse_uuid(repo, "--repo")?;
                    let target_branch = match &branch {
                        Some(branch) => branch.clone(),
                        None => {
                            let repo_row: Value = self
                                .client
                                .exec(
                                    "GET",
                                    &format!("/repos/{repo_id}"),
                                    false,
                                    &[],
                                    None,
                                    Some(self.timeout),
                                )
                                .await?;
                            repo_row
                                .get("default_target_branch")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                                .ok_or_else(|| {
                                    VkError::message(
                                        "Pass --branch: the repo has no default target branch",
                                    )
                                })?
                        }
                    };
                    repo_inputs.push((repo_id, target_branch));
                }
                if key == "ws.start" {
                    let id = self
                        .client
                        .start_workspace(StartWorkspaceInput {
                            name: arg_str(m, "name").unwrap_or_default(),
                            prompt: arg_str(m, "message"),
                            executor: arg_str(m, "executor")
                                .unwrap_or_else(|| "CLAUDE_CODE".to_string()),
                            variant: arg_str(m, "variant"),
                            repositories: repo_inputs,
                            issue_id: arg_str(m, "issue")
                                .map(|i| parse_uuid(&i, "--issue"))
                                .transpose()?,
                        })
                        .await?;
                    return Ok(json!({ "workspace_id": id }));
                }
                let issue_id = arg_str(m, "issue")
                    .map(|i| parse_uuid(&i, "--issue"))
                    .transpose()?;
                let linked_issue = match issue_id {
                    Some(issue_id) => {
                        let issue = self.client.issue(issue_id).await?;
                        Some(json!({ "remote_project_id": issue.project_id, "issue_id": issue_id }))
                    }
                    None => None,
                };
                let working_branch = match arg_str(m, "working-branch") {
                    Some(branch) => json!({ "mode": "existing", "name": branch }),
                    None => json!({ "mode": "auto" }),
                };
                let payload = json!({
                    "name": arg_str(m, "name"),
                    "repos": repo_inputs.iter().map(|(id, branch)| json!({
                        "repo_id": id, "target_branch": branch, "create_target_branch": false, "github_linked_branch": null
                    })).collect::<Vec<_>>(),
                    "linked_issue": linked_issue,
                    "attachment_ids": null,
                    "pr_review": null,
                    "working_branch": working_branch,
                });
                let created = self
                    .client
                    .exec(
                        "POST",
                        "/workspaces/create",
                        false,
                        &[],
                        Some(&payload),
                        Some(self.timeout),
                    )
                    .await?;
                if let Some(issue_id) = issue_id
                    && let Some(ws) = created
                        .pointer("/workspace/id")
                        .and_then(Value::as_str)
                        .and_then(|s| s.parse().ok())
                {
                    self.client.link_workspace_to_issue(ws, issue_id).await?;
                }
                Ok(created)
            }
            "ws.review" => {
                let executor = arg_str(m, "executor").unwrap_or_else(|| "CLAUDE_CODE".to_string());
                let executor_config = serde_json::from_value(Self::executor_config(
                    m,
                    &executor.replace('-', "_").to_ascii_uppercase(),
                ))
                .map_err(|error| VkError::message(format!("Invalid executor options: {error}")))?;
                let outcome = self
                    .client
                    .review_workspace(ReviewWorkspaceInput {
                        issue_id: parse_uuid(&arg_str(m, "issue").unwrap_or_default(), "--issue")?,
                        pr: arg_str(m, "pr"),
                        repo_id: arg_str(m, "repo")
                            .map(|r| parse_uuid(&r, "--repo"))
                            .transpose()?,
                        name: arg_str(m, "name"),
                        prompt: arg_str(m, "message"),
                        executor_config,
                        create_only: arg_flag(m, "create-only"),
                        dry_run: arg_flag(m, "dry-run"),
                    })
                    .await?;
                Ok(serde_json::to_value(outcome).unwrap_or_default())
            }
            "ws.quick-chat" => {
                let repo_raw = arg_str(m, "repo").unwrap_or_default();
                let repo_id = match repo_raw.parse::<Uuid>() {
                    Ok(id) => id,
                    Err(_) => {
                        let repos: Vec<Value> = serde_json::from_value(
                            self.client
                                .exec("GET", "/repos", false, &[], None, Some(self.timeout))
                                .await?,
                        )
                        .unwrap_or_default();
                        let wanted = Path::new(&repo_raw)
                            .canonicalize()
                            .map(|p| p.to_string_lossy().into_owned())
                            .unwrap_or_else(|_| repo_raw.clone());
                        let found = repos.iter().find(|r| {
                            let path = r.get("path").and_then(Value::as_str).unwrap_or("");
                            let name = r.get("name").and_then(Value::as_str).unwrap_or("");
                            let display =
                                r.get("display_name").and_then(Value::as_str).unwrap_or("");
                            path == wanted
                                || path.trim_end_matches('/') == repo_raw.trim_end_matches('/')
                                || name.eq_ignore_ascii_case(&repo_raw)
                                || display.eq_ignore_ascii_case(&repo_raw)
                        });
                        found
                            .and_then(|r| r.get("id").and_then(Value::as_str))
                            .and_then(|s| s.parse().ok())
                            .ok_or_else(|| {
                                VkError::message(format!(
                                    "No registered repository matches '{repo_raw}' (vk repo list)"
                                ))
                            })?
                    }
                };
                let executor = arg_str(m, "executor").unwrap_or_else(|| "CLAUDE_CODE".to_string());
                let payload = json!({
                    "repo_id": repo_id,
                    "executor_config": Self::executor_config(m, &executor.replace('-', "_").to_ascii_uppercase()),
                    "prompt": arg_str(m, "message").unwrap_or_default(),
                    "name": arg_str(m, "name"),
                    "attachment_ids": null,
                    "autopilot": arg_flag(m, "autopilot"),
                });
                self.client
                    .exec(
                        "POST",
                        "/workspaces/quick-chat",
                        false,
                        &[],
                        Some(&payload),
                        Some(self.timeout),
                    )
                    .await
            }
            "ws.diff" => {
                let ws = self
                    .workspace_id(&arg_str(m, "ws").unwrap_or_default())
                    .await?;
                let stats = arg_flag(m, "stats");
                let url = format!(
                    "{}?stats_only={stats}",
                    self.client
                        .api_url(&format!("/workspaces/{ws}/git/diff/sse"))
                );
                let events = self
                    .read_sse(
                        &url,
                        |event, _| event == "ready" || event == "finished",
                        Duration::from_secs(3),
                    )
                    .await?;
                let mut entries: BTreeMap<String, Value> = BTreeMap::new();
                for (event, data) in events {
                    if event != "json_patch" {
                        continue;
                    }
                    let Ok(patch) = serde_json::from_str::<Vec<Value>>(&data) else {
                        continue;
                    };
                    for op in patch {
                        let path = op.get("path").and_then(Value::as_str).unwrap_or("");
                        let Some(rest) = path.strip_prefix("/entries/") else {
                            continue;
                        };
                        let path_key = rest.replace("~1", "/").replace("~0", "~");
                        match op.get("op").and_then(Value::as_str) {
                            Some("remove") => {
                                entries.remove(&path_key);
                            }
                            _ => {
                                if let Some(value) = op.get("value") {
                                    // A whole-repo replace carries a map of files.
                                    if let Some(map) = value.as_object()
                                        && !rest.contains('/')
                                        && map.values().all(|v| v.get("type").is_some())
                                    {
                                        for (file, diff) in map {
                                            entries
                                                .insert(format!("{path_key}/{file}"), diff.clone());
                                        }
                                    } else {
                                        entries.insert(path_key, value.clone());
                                    }
                                }
                            }
                        }
                    }
                }
                Ok(json!({ "workspace_id": ws, "files": entries }))
            }
            "ws.link" => {
                let ws = self
                    .workspace_id(&arg_str(m, "ws").unwrap_or_default())
                    .await?;
                let issue = parse_uuid(&arg_str(m, "issue").unwrap_or_default(), "issue")?;
                self.client.link_workspace_to_issue(ws, issue).await?;
                Ok(json!({ "success": true, "workspace_id": ws, "issue_id": issue }))
            }
            "ws.attachments.upload" => {
                let ws = self
                    .workspace_id(&arg_str(m, "ws").unwrap_or_default())
                    .await?;
                let file = PathBuf::from(arg_str(m, "file").unwrap_or_default());
                let bytes = std::fs::read(&file).map_err(|e| {
                    VkError::message(format!("Cannot read {}: {e}", file.display()))
                })?;
                let name = file
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "upload".to_string());
                let session = self
                    .session_arg(&arg_str(m, "session").unwrap_or_else(|| ".".to_string()))
                    .await?;
                let part = reqwest::multipart::Part::bytes(bytes).file_name(name);
                let form = reqwest::multipart::Form::new().part("image", part);
                let request = self
                    .client
                    .request(
                        reqwest::Method::POST,
                        self.client
                            .api_url(&format!("/workspaces/{ws}/attachments/upload")),
                    )
                    .query(&[("session_id", session.to_string())])
                    .multipart(form)
                    .timeout(self.timeout);
                self.client.send_value(request).await
            }
            "session.send" => {
                let session = self
                    .session_arg(&arg_str(m, "session").unwrap_or_default())
                    .await?;
                let outcome = self
                    .client
                    .send_prompt(
                        session,
                        &arg_str(m, "message").unwrap_or_default(),
                        &Self::send_options(m),
                    )
                    .await?;
                Ok(serde_json::to_value(outcome).unwrap_or_default())
            }
            "session.handoff" => {
                let session = self
                    .session_arg(&arg_str(m, "session").unwrap_or_default())
                    .await?;
                let executor = arg_str(m, "executor")
                    .unwrap_or_default()
                    .replace('-', "_")
                    .to_ascii_uppercase();
                let payload = json!({
                    "prompt": arg_str(m, "message").unwrap_or_default(),
                    "executor_config": Self::executor_config(m, &executor),
                });
                self.client
                    .exec(
                        "POST",
                        &format!("/sessions/{session}/handoff"),
                        false,
                        &[],
                        Some(&payload),
                        Some(self.timeout),
                    )
                    .await
            }
            "session.review" => {
                let session = self
                    .session_arg(&arg_str(m, "session").unwrap_or_default())
                    .await?;
                let row = self.client.session(session).await?;
                let executor = mcp::client::executor_name(arg_str(m, "executor").as_deref(), &row)?;
                let payload = json!({
                    "executor_config": Self::executor_config(m, &executor),
                    "additional_prompt": arg_str(m, "prompt"),
                    "use_all_workspace_commits": arg_flag(m, "all-commits"),
                });
                self.client
                    .exec(
                        "POST",
                        &format!("/sessions/{session}/review"),
                        false,
                        &[],
                        Some(&payload),
                        Some(self.timeout),
                    )
                    .await
            }
            "session.log" => {
                let exec = parse_uuid(&arg_str(m, "exec").unwrap_or_default(), "exec")?;
                if arg_flag(m, "raw") {
                    let url = self
                        .client
                        .api_url(&format!("/execution-processes/{exec}/raw-logs/sse"));
                    let events = self
                        .read_sse(&url, |event, _| event == "finished", Duration::from_secs(5))
                        .await?;
                    // Each `json_patch` event adds `{type: STDOUT|STDERR, content}` entries.
                    let lines: Vec<Value> = events
                        .into_iter()
                        .filter(|(event, _)| event == "json_patch")
                        .filter_map(|(_, data)| serde_json::from_str::<Vec<Value>>(&data).ok())
                        .flatten()
                        .filter_map(|op| {
                            let value = op.get("value")?;
                            let stream = match value.get("type")?.as_str()? {
                                "STDOUT" => "stdout",
                                "STDERR" => "stderr",
                                _ => return None,
                            };
                            Some(json!({ "stream": stream, "text": value.get("content")? }))
                        })
                        .collect();
                    return Ok(json!({ "execution_id": exec, "lines": lines }));
                }
                self.client
                    .normalized_logs(
                        exec,
                        arg_usize(m, "offset", 0)?,
                        arg_usize(m, "limit", 100)?,
                        arg_flag(m, "tool-results"),
                    )
                    .await
            }
            "session.approvals.respond" => {
                let id = arg_str(m, "id").unwrap_or_default();
                let exec = parse_uuid(&arg_str(m, "exec").unwrap_or_default(), "--exec")?;
                let status = if let Some(answers) = arg_str(m, "answers") {
                    let answers: Value = serde_json::from_str(&answers).map_err(|e| {
                        VkError::message(format!("--answers is not valid JSON: {e}"))
                    })?;
                    json!({ "status": "answered", "answers": answers })
                } else if arg_flag(m, "deny") {
                    json!({ "status": "denied", "reason": arg_str(m, "reason") })
                } else if arg_flag(m, "approve") {
                    json!({ "status": "approved" })
                } else {
                    return Err(VkError::message(
                        "Pass --approve, --deny [--reason] or --answers <json>",
                    ));
                };
                let payload = json!({ "execution_process_id": exec, "status": status });
                self.client
                    .exec(
                        "POST",
                        &format!("/approvals/{id}/respond"),
                        false,
                        &[],
                        Some(&payload),
                        Some(self.timeout),
                    )
                    .await
            }
            "issue.list" => {
                let project = parse_uuid(&arg_str(m, "project").unwrap_or_default(), "--project")?;
                let status_id = match arg_str(m, "status") {
                    Some(status) => Some(self.client.resolve_status_id(project, &status).await?),
                    None => None,
                };
                let priority = arg_str(m, "priority")
                    .map(|p| mcp::client::parse_issue_priority(&p))
                    .transpose()?;
                let payload = json!({
                    "project_id": project,
                    "status_id": status_id,
                    "priority": priority,
                    "parent_issue_id": arg_str(m, "parent"),
                    "search": arg_str(m, "search"),
                    "simple_id": arg_str(m, "simple-id"),
                    "assignee_user_id": arg_str(m, "assignee"),
                    "tag_id": arg_str(m, "tag"),
                    "sort_field": arg_str(m, "sort"),
                    "sort_direction": arg_str(m, "dir"),
                    "limit": arg_usize(m, "limit", 50)?,
                    "offset": arg_usize(m, "offset", 0)?,
                });
                let mut response = self
                    .client
                    .exec(
                        "POST",
                        "/remote/issues/search",
                        true,
                        &[],
                        Some(&payload),
                        Some(self.timeout),
                    )
                    .await?;
                // Status names next to the ids, so the table reads at a glance.
                if let Ok(statuses) = self.client.project_statuses(project).await
                    && let Some(issues) = response.get_mut("issues").and_then(Value::as_array_mut)
                {
                    for issue in issues {
                        let name = issue
                            .get("status_id")
                            .and_then(Value::as_str)
                            .and_then(|id| statuses.iter().find(|s| s.id.to_string() == id))
                            .map(|s| s.name.clone());
                        if let (Some(name), Some(obj)) = (name, issue.as_object_mut()) {
                            obj.insert("status".to_string(), Value::String(name));
                        }
                    }
                }
                Ok(response)
            }
            "issue.create" => {
                let issue = self
                    .client
                    .create_issue(CreateIssueInput {
                        project_id: parse_uuid(
                            &arg_str(m, "project").unwrap_or_default(),
                            "--project",
                        )?,
                        title: arg_str(m, "title").unwrap_or_default(),
                        description: arg_str(m, "description"),
                        priority: arg_str(m, "priority"),
                        parent_issue_id: arg_str(m, "parent")
                            .map(|p| parse_uuid(&p, "--parent"))
                            .transpose()?,
                        status: arg_str(m, "status"),
                    })
                    .await?;
                Ok(serde_json::to_value(issue).unwrap_or_default())
            }
            "issue.update" => {
                let issue_id = parse_uuid(&arg_str(m, "issue").unwrap_or_default(), "issue")?;
                let parent = match arg_str(m, "parent") {
                    Some(p) if p.eq_ignore_ascii_case("none") || p.eq_ignore_ascii_case("null") => {
                        Some(None)
                    }
                    Some(p) => Some(Some(parse_uuid(&p, "--parent")?)),
                    None => None,
                };
                let issue = self
                    .client
                    .update_issue(
                        issue_id,
                        UpdateIssueInput {
                            title: arg_str(m, "title"),
                            description: arg_str(m, "description"),
                            status: arg_str(m, "status"),
                            priority: arg_str(m, "priority"),
                            parent_issue_id: parent,
                        },
                    )
                    .await?;
                Ok(serde_json::to_value(issue).unwrap_or_default())
            }
            "issue.priorities" => Ok(json!(["urgent", "high", "medium", "low"])),
            "drawer.list" => {
                let mut query = Vec::new();
                if !arg_flag(m, "all") {
                    query.push(("archived".to_string(), arg_flag(m, "archived").to_string()));
                }
                let page = self
                    .client
                    .exec(
                        "GET",
                        "/remote/cloud/drawer_notes",
                        true,
                        &query,
                        None,
                        Some(self.timeout),
                    )
                    .await?;
                Ok(page.get("drawer_notes").cloned().unwrap_or(page))
            }
            "drawer.get" => {
                let id = parse_uuid(&arg_str(m, "id").unwrap_or_default(), "note")?;
                let note = self
                    .client
                    .exec(
                        "GET",
                        &format!("/remote/cloud/drawer_notes/{id}"),
                        true,
                        &[],
                        None,
                        Some(self.timeout),
                    )
                    .await?;
                let comments = self
                    .client
                    .exec(
                        "GET",
                        "/remote/cloud/drawer_comments",
                        true,
                        &[("note_id".to_string(), id.to_string())],
                        None,
                        Some(self.timeout),
                    )
                    .await?;
                Ok(json!({
                    "note": note,
                    "comments": comments.get("drawer_comments").cloned().unwrap_or(Value::Array(vec![])),
                }))
            }
            "drawer.create" => {
                let body = read_drawer_body(m)?.unwrap_or_default();
                let mut request = Map::new();
                request.insert(
                    "title".into(),
                    Value::String(arg_str(m, "title").unwrap_or_default()),
                );
                request.insert("body".into(), Value::String(body.clone()));
                if let Some(label) = arg_str(m, "label").filter(|l| !l.trim().is_empty()) {
                    request.insert("label".into(), Value::String(label));
                }
                if arg_flag(m, "pin") {
                    request.insert("pinned".into(), Value::Bool(true));
                }
                for (key, value) in self.drawer_scope(arg_str(m, "ws").as_deref()).await {
                    request.insert(key.into(), value);
                }
                let created = self
                    .client
                    .exec(
                        "POST",
                        "/remote/cloud/drawer_notes",
                        true,
                        &[],
                        Some(&Value::Object(request)),
                        Some(self.timeout),
                    )
                    .await?;
                let mut note = created.get("data").cloned().unwrap_or(created);
                if let Some(result) = self.register_drawer_artifacts(&note, &body).await
                    && let Value::Object(map) = &mut note
                {
                    map.insert("artifacts".into(), result);
                }
                if arg_flag(m, "notify")
                    && let Some(note_id) = note
                        .get("id")
                        .and_then(Value::as_str)
                        .and_then(|id| id.parse::<Uuid>().ok())
                {
                    let excerpt = body
                        .lines()
                        .map(str::trim)
                        .find(|line| !line.is_empty() && !line.starts_with('#'))
                        .unwrap_or("Drawer에 새 노트가 있습니다")
                        .chars()
                        .take(200)
                        .collect::<String>();
                    // Through the host's own notification path: it tags the
                    // cloud copy and fires the local sound/OS alert too.
                    let workspace = note
                        .get("workspace_id")
                        .and_then(Value::as_str)
                        .and_then(|id| id.parse::<Uuid>().ok());
                    self.client
                        .notify(
                            &arg_str(m, "title").unwrap_or_default(),
                            &excerpt,
                            workspace,
                            false,
                            Some(note_id),
                        )
                        .await?;
                }
                Ok(note)
            }
            "drawer.update" => {
                let id = parse_uuid(&arg_str(m, "id").unwrap_or_default(), "note")?;
                let mut request = Map::new();
                if let Some(title) = arg_str(m, "title") {
                    request.insert("title".into(), Value::String(title));
                }
                if let Some(body) = read_drawer_body(m)? {
                    request.insert("body".into(), Value::String(body));
                    // A new body comes from this turn: its artifacts live here.
                    for (key, value) in self.drawer_scope(arg_str(m, "ws").as_deref()).await {
                        request.insert(key.into(), value);
                    }
                }
                if let Some(label) = arg_str(m, "label") {
                    let label = label.trim().to_string();
                    request.insert(
                        "label".into(),
                        if label.is_empty() {
                            Value::Null
                        } else {
                            Value::String(label)
                        },
                    );
                }
                if arg_flag(m, "pin") {
                    request.insert("pinned".into(), Value::Bool(true));
                } else if arg_flag(m, "unpin") {
                    request.insert("pinned".into(), Value::Bool(false));
                }
                if request.is_empty() {
                    return Err(VkError::message(
                        "Nothing to change: pass -t, -m/-f, --label, --pin or --unpin",
                    ));
                }
                let body = request
                    .get("body")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let updated = self
                    .client
                    .exec(
                        "PATCH",
                        &format!("/remote/cloud/drawer_notes/{id}"),
                        true,
                        &[],
                        Some(&Value::Object(request)),
                        Some(self.timeout),
                    )
                    .await?;
                let mut note = updated.get("data").cloned().unwrap_or(updated);
                if let Some(body) = body
                    && let Some(result) = self.register_drawer_artifacts(&note, &body).await
                    && let Value::Object(map) = &mut note
                {
                    map.insert("artifacts".into(), result);
                }
                Ok(note)
            }
            "drawer.archive" | "drawer.unarchive" => {
                let id = parse_uuid(&arg_str(m, "id").unwrap_or_default(), "note")?;
                self.client
                    .exec(
                        "PATCH",
                        &format!("/remote/cloud/drawer_notes/{id}"),
                        true,
                        &[],
                        Some(&json!({ "archived": key == "drawer.archive" })),
                        Some(self.timeout),
                    )
                    .await
            }
            "drawer.comment" => {
                let id = parse_uuid(&arg_str(m, "id").unwrap_or_default(), "note")?;
                self.client
                    .exec(
                        "POST",
                        "/remote/cloud/drawer_comments",
                        true,
                        &[],
                        Some(&json!({
                            "note_id": id,
                            "body": arg_str(m, "message").unwrap_or_default(),
                            "author": "autopilot",
                        })),
                        Some(self.timeout),
                    )
                    .await
            }
            "notify.send" => {
                let ws = match arg_str(m, "ws") {
                    Some(ws) => Some(self.workspace_id(&ws).await?),
                    None => None,
                };
                self.client
                    .notify(
                        &arg_str(m, "title").unwrap_or_default(),
                        &arg_str(m, "message").unwrap_or_default(),
                        ws,
                        arg_flag(m, "local-only"),
                        None,
                    )
                    .await?;
                Ok(json!({ "success": true }))
            }
            "notify.mark" => {
                let id = arg_str(m, "id").unwrap_or_default();
                let mut body = Map::new();
                if arg_flag(m, "seen") {
                    body.insert("seen".to_string(), Value::Bool(true));
                }
                if arg_flag(m, "dismiss") {
                    body.insert("archived".to_string(), Value::Bool(true));
                }
                if body.is_empty() {
                    return Err(VkError::message("Pass --seen and/or --dismiss"));
                }
                self.client
                    .exec(
                        "PATCH",
                        &format!("/remote/cloud/notifications/{id}"),
                        true,
                        &[],
                        Some(&Value::Object(body)),
                        Some(self.timeout),
                    )
                    .await
            }
            "config.get" => {
                let info = self.client.system_info().await?;
                let config = info.get("config").cloned().unwrap_or(Value::Null);
                match arg_str(m, "path") {
                    Some(path) => {
                        let pointer = format!("/{}", path.trim().replace('.', "/"));
                        config
                            .pointer(&pointer)
                            .cloned()
                            .ok_or_else(|| VkError::message(format!("No config field at '{path}'")))
                    }
                    None => Ok(config),
                }
            }
            "config.set" => {
                let info = self.client.system_info().await?;
                let mut config = info.get("config").cloned().unwrap_or(Value::Null);
                let revision = info.get("config_revision").cloned().unwrap_or(Value::Null);
                let pairs = arg_many(m, "pairs");
                if pairs.is_empty() {
                    return Err(VkError::message("Pass at least one key=value"));
                }
                for pair in pairs {
                    let Some((k, v)) = pair.split_once('=') else {
                        return Err(VkError::message(format!(
                            "Expected key=value, got '{pair}'"
                        )));
                    };
                    let value = serde_json::from_str(v.trim())
                        .unwrap_or_else(|_| Value::String(v.trim().to_string()));
                    let pointer = format!("/{}", k.trim().replace('.', "/"));
                    match config.pointer_mut(&pointer) {
                        Some(slot) => *slot = value,
                        None => return Err(VkError::message(format!("No config field at '{k}'"))),
                    }
                }
                let payload = json!({ "config": config, "revision": revision });
                self.client
                    .exec(
                        "PUT",
                        "/config",
                        false,
                        &[],
                        Some(&payload),
                        Some(self.timeout),
                    )
                    .await
            }
            "config.profiles.set" => {
                let content: Value = serde_json::from_str(&arg_str(m, "body").unwrap_or_default())
                    .map_err(|e| VkError::message(format!("--body is not valid JSON: {e}")))?;
                let info = self.client.system_info().await?;
                let revision = info
                    .get("profiles_revision")
                    .cloned()
                    .unwrap_or(Value::Null);
                let payload = json!({ "content": content.to_string(), "revision": revision });
                self.client
                    .exec(
                        "PUT",
                        "/profiles",
                        false,
                        &[],
                        Some(&payload),
                        Some(self.timeout),
                    )
                    .await
            }
            "config.models" => {
                let executor = arg_str(m, "executor")
                    .unwrap_or_default()
                    .replace('-', "_")
                    .to_ascii_uppercase();
                let mut url = format!(
                    "{}?executor={executor}",
                    self.client.api_url("/agents/discovered-options/sse")
                );
                if let Some(variant) = arg_str(m, "variant") {
                    url.push_str(&format!("&variant={variant}"));
                }
                let events = self
                    .read_sse(
                        &url,
                        |event, data| {
                            event == "finished" || data.contains("\"/slash_commands_loaded\"")
                        },
                        Duration::from_secs(4),
                    )
                    .await?;
                let mut state = Map::new();
                for (event, data) in events {
                    if event != "json_patch" {
                        continue;
                    }
                    let Ok(patch) = serde_json::from_str::<Vec<Value>>(&data) else {
                        continue;
                    };
                    for op in patch {
                        if let (Some(path), Some(value)) =
                            (op.get("path").and_then(Value::as_str), op.get("value"))
                        {
                            state.insert(path.trim_start_matches('/').to_string(), value.clone());
                        }
                    }
                }
                Ok(Value::Object(state))
            }
            "config.host.info" => {
                let mut info = self.client.system_info().await?;
                if let Some(obj) = info.as_object_mut() {
                    obj.remove("config");
                    obj.remove("executors");
                    obj.remove("capabilities");
                }
                Ok(info)
            }
            "events.list" | "events.wait" => self.run_events(key == "events.wait", m).await,
            "pr.list" => {
                let repo = parse_uuid(&arg_str(m, "repo").unwrap_or_default(), "--repo")?;
                let mut query = Vec::new();
                let path = if arg_flag(m, "involved") {
                    query.push(("involves_me".to_string(), "true".to_string()));
                    if arg_flag(m, "refresh") {
                        query.push(("refresh".to_string(), "true".to_string()));
                    }
                    format!("/repos/{repo}/pull-requests")
                } else {
                    if let Some(remote) = arg_str(m, "remote") {
                        query.push(("remote".to_string(), remote));
                    }
                    format!("/repos/{repo}/prs")
                };
                self.client
                    .exec("GET", &path, false, &query, None, Some(self.timeout))
                    .await
            }
            "repo.search-files" => {
                let ws = self
                    .workspace_id(&arg_str(m, "ws").unwrap_or_default())
                    .await?;
                let repo_ids = self
                    .client
                    .workspace_repos(ws)
                    .await?
                    .iter()
                    .map(|r| r.id.to_string())
                    .collect::<Vec<_>>()
                    .join(",");
                let mut query = vec![
                    ("q".to_string(), arg_str(m, "q").unwrap_or_default()),
                    ("repo_ids".to_string(), repo_ids),
                ];
                if let Some(mode) = arg_str(m, "mode") {
                    query.push(("mode".to_string(), mode));
                }
                self.client
                    .exec("GET", "/search", false, &query, None, Some(self.timeout))
                    .await
            }
            "issue.attachments.upload" => {
                let issue = parse_uuid(&arg_str(m, "issue").unwrap_or_default(), "issue")?;
                let file = PathBuf::from(arg_str(m, "file").unwrap_or_default());
                self.client.upload_issue_attachment(issue, &file).await
            }
            "hosts.list" => {
                let mut hosts: Vec<Value> = self
                    .client
                    .list_hosts()
                    .await?
                    .into_iter()
                    .map(|h| {
                        json!({
                            "host_id": h.host_id,
                            "name": h.host_name,
                            "status": h.status,
                            "auth_mode": h.auth_mode,
                            "self": false,
                        })
                    })
                    .collect();
                if let Some(self_id) = self.client.self_host_id().await {
                    hosts.insert(
                        0,
                        json!({ "host_id": self_id, "name": "(this machine)", "self": true }),
                    );
                }
                Ok(Value::Array(hosts))
            }
            "hosts.info" => {
                let host = self
                    .client
                    .resolve_host(&arg_str(m, "target").unwrap_or_default())
                    .await?;
                let mut info = self.client.host(host).system_info().await?;
                if let Some(obj) = info.as_object_mut() {
                    obj.remove("config");
                    obj.remove("executors");
                    obj.remove("capabilities");
                }
                Ok(info)
            }
            "skill.show" => Ok(Value::String(SKILL_MD.to_string())),
            "skill.path" => Ok(json!({
                "claude": skill_dir(arg_str(m, "claude-dir"), ".claude").display().to_string(),
                "codex": skill_dir(arg_str(m, "codex-dir"), ".codex").display().to_string(),
            })),
            "skill.install" => install_skill(arg_str(m, "claude-dir"), arg_str(m, "codex-dir")),
            other => Err(VkError::message(format!("Unhandled command '{other}'"))),
        }
    }

    async fn run_events(&self, wait: bool, m: &ArgMatches) -> CliResult {
        let kinds: Vec<String> = arg_str(m, "kinds")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|k| !k.is_empty())
            .map(str::to_string)
            .collect();
        let limit = arg_usize(m, "limit", 100)?;
        let timeout = Duration::from_secs(arg_usize(m, "timeout", 30)?.clamp(1, 600) as u64);
        let since = arg_str(m, "since").unwrap_or_else(|| "0".to_string());
        // `now`: skip the backlog and start at each journal's latest cursor.
        let now = since.trim() == "now";
        if arg_flag(m, "all-hosts") {
            // An empty cursor makes every host start at its latest.
            let since = if now { String::new() } else { since };
            let page = if wait {
                self.client
                    .events_wait_all_hosts(&since, &kinds, limit, timeout)
                    .await?
            } else {
                self.client
                    .events_list_all_hosts(&since, &kinds, limit)
                    .await?
            };
            return Ok(serde_json::to_value(page).unwrap_or_default());
        }
        // Past every cursor the journal answers with its latest one, no events.
        let since: u64 = if now {
            self.client.events_list(u64::MAX, &kinds, 1).await?.cursor
        } else {
            since.trim().parse().map_err(|_| {
                VkError::message(
                    "--since must be a cursor number or `now` (host=cursor pairs need --all-hosts)",
                )
            })?
        };
        let page = if wait {
            self.client
                .events_wait(since, &kinds, limit, timeout)
                .await?
        } else {
            self.client.events_list(since, &kinds, limit).await?
        };
        Ok(serde_json::to_value(page).unwrap_or_default())
    }

    /// Minimal SSE reader: collects `(event, data)` until `stop` matches or no
    /// event arrives for `idle`.
    async fn read_sse(
        &self,
        url: &str,
        stop: impl Fn(&str, &str) -> bool,
        idle: Duration,
    ) -> Result<Vec<(String, String)>, VkError> {
        let response = self
            .client
            .request(reqwest::Method::GET, url.to_string())
            .header("accept", "text/event-stream")
            .send()
            .await
            .map_err(|e| VkError::Connect(e.to_string()))?;
        if !response.status().is_success() {
            return Err(VkError::Api {
                status: response.status().as_u16(),
                message: response.text().await.unwrap_or_default(),
            });
        }
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut events = Vec::new();
        let mut current_event = String::from("message");
        let mut current_data = String::new();
        use futures::StreamExt;
        loop {
            let chunk = tokio::time::timeout(idle, stream.next()).await;
            let chunk = match chunk {
                Ok(Some(Ok(bytes))) => bytes,
                Ok(Some(Err(e))) => return Err(VkError::Connect(e.to_string())),
                Ok(None) | Err(_) => break,
            };
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(pos) = buffer.find('\n') {
                let line = buffer[..pos].trim_end_matches('\r').to_string();
                buffer.drain(..=pos);
                if line.is_empty() {
                    if !current_data.is_empty() || current_event != "message" {
                        let done = stop(&current_event, &current_data);
                        events.push((current_event.clone(), std::mem::take(&mut current_data)));
                        current_event = "message".to_string();
                        if done {
                            return Ok(events);
                        }
                    }
                } else if let Some(name) = line.strip_prefix("event:") {
                    current_event = name.trim().to_string();
                } else if let Some(data) = line.strip_prefix("data:") {
                    if !current_data.is_empty() {
                        current_data.push('\n');
                    }
                    current_data.push_str(data.trim_start());
                }
            }
        }
        Ok(events)
    }
}

// ---------------------------------------------------------------------------
// Skill installation
// ---------------------------------------------------------------------------

fn skill_dir(explicit: Option<String>, home_sub: &str) -> PathBuf {
    match explicit {
        Some(dir) => PathBuf::from(dir),
        None => dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(home_sub)
            .join("skills"),
    }
    .join("vibe-kanban-cli")
}

fn install_skill(claude_dir: Option<String>, codex_dir: Option<String>) -> CliResult {
    let claude = skill_dir(claude_dir, ".claude");
    std::fs::create_dir_all(&claude)
        .map_err(|e| VkError::message(format!("Cannot create {}: {e}", claude.display())))?;
    let skill_file = claude.join("SKILL.md");
    std::fs::write(&skill_file, SKILL_MD)
        .map_err(|e| VkError::message(format!("Cannot write {}: {e}", skill_file.display())))?;
    let codex = skill_dir(codex_dir, ".codex");
    let codex_result = link_codex_skill(&claude, &codex);
    Ok(json!({
        "claude": skill_file.display().to_string(),
        "codex": codex.display().to_string(),
        "codex_linked": codex_result.is_ok(),
        "codex_error": codex_result.err(),
    }))
}

/// Codex reads `~/.codex/skills`, not Claude's directory: link the installed
/// skill there (a copy on platforms without symlinks).
fn link_codex_skill(claude: &Path, codex: &Path) -> Result<(), String> {
    if let Some(parent) = codex.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Replace only what an earlier install left: a link, or a lone SKILL.md
    // copy. Anything else there is the user's.
    match std::fs::symlink_metadata(codex) {
        Ok(meta) if meta.file_type().is_symlink() => {
            std::fs::remove_file(codex).map_err(|e| e.to_string())?;
        }
        Ok(meta)
            if meta.is_dir()
                && std::fs::read_dir(codex).is_ok_and(|entries| {
                    entries
                        .filter_map(Result::ok)
                        .all(|entry| entry.file_name() == "SKILL.md")
                }) =>
        {
            std::fs::remove_dir_all(codex).map_err(|e| e.to_string())?;
        }
        Ok(_) => {
            return Err(format!(
                "{} already exists and was not installed by vk; leaving it alone",
                codex.display()
            ));
        }
        Err(_) => {}
    }
    #[cfg(unix)]
    {
        let claude = claude.canonicalize().map_err(|e| e.to_string())?;
        std::os::unix::fs::symlink(claude, codex).map_err(|e| e.to_string())
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(codex).map_err(|e| e.to_string())?;
        std::fs::copy(claude.join("SKILL.md"), codex.join("SKILL.md"))
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

fn cell(value: &Value, width: usize) -> String {
    let text = match value {
        Value::Null => "-".to_string(),
        Value::String(s) => s.replace(['\n', '\t'], " "),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        other => other.to_string(),
    };
    let count = text.chars().count();
    if count > width {
        let cut: String = text.chars().take(width.saturating_sub(1)).collect();
        format!("{cut}…")
    } else {
        text
    }
}

fn is_scalar(value: &Value) -> bool {
    !matches!(value, Value::Array(_) | Value::Object(_))
}

const PREFERRED_COLUMNS: &[&str] = &[
    "id",
    "host_id",
    "simple_id",
    "name",
    "title",
    "kind",
    "status",
    "phase",
    "branch",
    "is_running",
    "latest_process_status",
    "has_pending_approval",
    "executor",
    "cursor",
    "at",
    "session_id",
    "workspace_id",
    "execution_id",
    "status_note",
    "autopilot",
    "message",
    "url",
    "created_at",
];

fn print_table(rows: &[Value]) {
    let first = rows.iter().find_map(|r| r.as_object());
    let Some(first) = first else {
        for row in rows {
            println!("{}", cell(row, 200));
        }
        return;
    };
    let mut columns: Vec<String> = PREFERRED_COLUMNS
        .iter()
        .filter(|c| first.get(**c).is_some_and(is_scalar))
        .map(|c| c.to_string())
        .collect();
    for (key, value) in first {
        if columns.len() >= 8 {
            break;
        }
        if is_scalar(value) && !columns.contains(key) {
            columns.push(key.clone());
        }
    }
    columns.truncate(8);
    let width = |column: &str| -> usize {
        if column == "id" || column.ends_with("_id") {
            36
        } else if column == "status_note" || column == "message" || column == "title" {
            60
        } else {
            28
        }
    };
    let widths: Vec<usize> = columns
        .iter()
        .map(|c| {
            let max = rows
                .iter()
                .filter_map(|r| r.get(c))
                .map(|v| cell(v, width(c)).chars().count())
                .max()
                .unwrap_or(0);
            max.max(c.chars().count()).min(width(c))
        })
        .collect();
    let header: Vec<String> = columns
        .iter()
        .zip(&widths)
        .map(|(c, w)| format!("{:<w$}", c, w = *w))
        .collect();
    println!("{}", header.join("  ").trim_end());
    for row in rows {
        let line: Vec<String> = columns
            .iter()
            .zip(&widths)
            .map(|(c, w)| {
                format!(
                    "{:<w$}",
                    cell(row.get(c).unwrap_or(&Value::Null), *w),
                    w = *w
                )
            })
            .collect();
        println!("{}", line.join("  ").trim_end());
    }
    if rows.len() > 1 {
        println!("({} rows)", rows.len());
    }
}

fn print_human(value: &Value) {
    match value {
        Value::Null => println!("ok"),
        Value::String(s) => println!("{s}"),
        Value::Bool(_) | Value::Number(_) => println!("{value}"),
        Value::Array(rows) => {
            if rows.is_empty() {
                println!("(empty)");
            } else {
                print_table(rows);
            }
        }
        Value::Object(map) => {
            // A single list wrapped in {items, cursor}-style metadata: show the
            // list as a table and the rest as fields.
            let list_key = [
                "events",
                "workspaces",
                "issues",
                "sessions",
                "entries",
                "summaries",
                "hosts",
                "repos",
                "notifications",
                "lines",
                "hits",
            ]
            .into_iter()
            .find(|k| map.get(*k).is_some_and(|v| v.is_array()));
            for (key, value) in map {
                if Some(key.as_str()) == list_key {
                    continue;
                }
                println!("{key}: {}", cell(value, 160));
            }
            if let Some(key) = list_key
                && let Some(rows) = map.get(key).and_then(Value::as_array)
            {
                println!("{key}:");
                if rows.is_empty() {
                    println!("  (empty)");
                } else {
                    print_table(rows);
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() -> ExitCode {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let matches = build_cli().get_matches();
    let json = matches.get_flag("json");
    let Some((spec, leaf_matches)) = resolve(&matches) else {
        eprintln!("error: unknown command");
        return ExitCode::from(2);
    };
    let timeout = Duration::from_secs(
        matches
            .get_one::<String>("timeout")
            .and_then(|t| t.parse().ok())
            .unwrap_or(120),
    );
    let base_url = match matches.get_one::<String>("base-url") {
        Some(url) => url.trim_end_matches('/').to_string(),
        None => match discover_base_url().await {
            Ok(url) => url,
            Err(error) => {
                eprintln!("error: {error:#}");
                return ExitCode::from(3);
            }
        },
    };
    let mut client = VkClient::new(&base_url, &format!("vk-cli/{VERSION}"));
    if let Some(host) = matches.get_one::<String>("host") {
        match client.resolve_host(host).await {
            Ok(host_id) => client = client.host(host_id),
            Err(error) => {
                eprintln!("error: {error}");
                return ExitCode::from(1);
            }
        }
    }
    let client = client.with_command(&spec.path.join(" "));
    let ctx = Ctx {
        client,
        json,
        timeout,
    };
    let result = match spec.special {
        Some(key) => ctx.run_special(key, leaf_matches).await,
        None => ctx.run_generic(spec, leaf_matches).await,
    };
    match result {
        Ok(value) => {
            if ctx.json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&value).unwrap_or_default()
                );
            } else {
                print_human(&value);
            }
            ExitCode::SUCCESS
        }
        Err(error) => {
            if json {
                let body = json!({ "success": false, "error": error.to_string(), "status": error.status() });
                println!(
                    "{}",
                    serde_json::to_string_pretty(&body).unwrap_or_default()
                );
            } else {
                eprintln!("error: {error}");
            }
            match error {
                VkError::Connect(_) => ExitCode::from(3),
                VkError::Api { status: 403, .. } => ExitCode::from(4),
                _ => ExitCode::from(1),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_tree_is_well_formed() {
        build_cli().debug_assert();
        // A leaf that is also a group would demand its own args before the
        // nested command's (`vk session vibe-review status` never parsed).
        for spec in COMMANDS {
            for other in COMMANDS {
                assert!(
                    other.path.len() <= spec.path.len()
                        || other.path[..spec.path.len()] != *spec.path,
                    "'{}' is both a command and a group",
                    spec.path.join(" ")
                );
            }
        }
    }

    #[test]
    fn every_group_in_the_issue_table_exists() {
        let cli = build_cli();
        for group in [
            "ws",
            "session",
            "git",
            "pr",
            "issue",
            "notify",
            "drawer",
            "config",
            "repo",
            "automation",
            "events",
            "hosts",
        ] {
            assert!(
                cli.get_subcommands().any(|s| s.get_name() == group),
                "{group}"
            );
        }
    }

    #[test]
    fn every_spec_resolves_from_its_own_path() {
        for spec in COMMANDS {
            let mut argv = vec!["vk"];
            argv.extend(spec.path);
            // Required args make a bare invocation fail to parse; use --help
            // style resolution through try_get_matches with the path only when
            // nothing is required.
            if spec.args.iter().any(|a| a.required) {
                continue;
            }
            let matches = build_cli()
                .try_get_matches_from(argv)
                .unwrap_or_else(|error| panic!("{}: {error}", spec.path.join(" ")));
            let (found, _) = resolve(&matches).expect("resolves");
            assert_eq!(found.path, spec.path);
        }
    }

    #[test]
    fn commands_cover_the_issue_table() {
        let paths: Vec<String> = COMMANDS.iter().map(|c| c.path.join(" ")).collect();
        for required in [
            "ws list",
            "ws quick-chat",
            "ws delete",
            "ws diff",
            "ws attachments upload",
            "session send",
            "session queue reorder",
            "session log",
            "session approvals respond",
            "session resumes cancel",
            "git merge",
            "git target update-from-base",
            "pr create",
            "pr cloud sync",
            "issue bulk",
            "issue milestones set",
            "issue statuses update",
            "issue org update",
            "issue priorities",
            "notify send",
            "notify get",
            "notify prefs set",
            "drawer list",
            "drawer get",
            "drawer create",
            "drawer update",
            "drawer archive",
            "drawer unarchive",
            "drawer delete",
            "drawer comment",
            "drawer comments",
            "config set",
            "config models",
            "config web-settings set",
            "repo fs git-repos",
            "repo search-files",
            "automation memory-sync mutations",
            "events wait",
            "hosts info",
            "skill install",
            "ws project",
            "ws first-message",
            "ws review",
            "session queue steer",
            "pr comments-url",
            "pr resolve-url",
            "issue attachments upload",
            "automation host-status",
        ] {
            assert!(paths.iter().any(|p| p == required), "missing {required}");
        }
    }

    #[test]
    fn bool_and_typed_values_parse() {
        assert_eq!(parse_bool("Yes"), Some(true));
        assert_eq!(parse_bool("0"), Some(false));
        assert_eq!(parse_bool("maybe"), None);
        let list = typed_value(&req("ids", "", Where::Body, Kind::List), "a, b,,c").unwrap();
        assert_eq!(list, json!(["a", "b", "c"]));
        assert!(typed_value(&req("n", "", Where::Body, Kind::Int), "x").is_err());
    }
}
