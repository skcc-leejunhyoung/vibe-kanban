//! Git and pull-request operations as the UI dialogs see them, shared by the
//! server (which publishes `git.operation_failed` / `git.operation_succeeded`
//! journal events) and the `vk` CLI (which prints the same classification and
//! next steps under `--json`).
//!
//! One table maps each `/workspaces/{id}/git/...` and `/pull-requests` route to
//! its `vk` command; [`classify`] reads the `ApiResponse` envelope a route
//! answered with and names the failure the way the dialog would; [`GitFailure::choices`]
//! lists the dialog's buttons as `vk` commands. A choice id is stable: the
//! event names it, the CLI runs it.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One git/PR route under `/workspaces/{id}` and the `vk` command behind it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Op {
    pub id: &'static str,
    pub method: &'static str,
    /// Path under `/workspaces/{id}`.
    pub route: &'static str,
    /// `vk` words after the binary, before the workspace argument.
    pub cli: &'static str,
    /// Rewrites or discards history (force push, reset, abort, rebase), so an
    /// automated caller must not run it without a person's decision.
    pub destructive: bool,
}

const fn op(
    id: &'static str,
    method: &'static str,
    route: &'static str,
    cli: &'static str,
    destructive: bool,
) -> Op {
    Op {
        id,
        method,
        route,
        cli,
        destructive,
    }
}

pub const OPS: &[Op] = &[
    op("commit", "POST", "/git/commit", "git commit", false),
    op("push", "POST", "/git/push", "git push", false),
    op(
        "force_push",
        "POST",
        "/git/push/force",
        "git force-push",
        true,
    ),
    op("pull", "POST", "/git/pull", "git pull", false),
    op(
        "pull_and_push",
        "POST",
        "/git/pull-and-push",
        "git pull-and-push",
        false,
    ),
    op(
        "merge_remote",
        "POST",
        "/git/merge-remote",
        "git merge-remote",
        false,
    ),
    op(
        "reset_to_remote",
        "POST",
        "/git/reset-to-remote",
        "git reset-to-remote",
        true,
    ),
    op(
        "update_from_base",
        "POST",
        "/git/update-from-base",
        "git update-from-base",
        false,
    ),
    op("rebase", "POST", "/git/rebase", "git rebase", true),
    op(
        "rebase_continue",
        "POST",
        "/git/rebase/continue",
        "git rebase-continue",
        false,
    ),
    op("abort", "POST", "/git/conflicts/abort", "git abort", true),
    op("merge", "POST", "/git/merge", "git merge", false),
    op(
        "rename_branch",
        "PUT",
        "/git/branch",
        "git rename-branch",
        false,
    ),
    op(
        "target_set",
        "PUT",
        "/git/target-branch",
        "git target set",
        false,
    ),
    op(
        "target_fetch",
        "POST",
        "/git/target-branch/fetch",
        "git target fetch",
        false,
    ),
    op(
        "target_push",
        "POST",
        "/git/target-branch/push",
        "git target push",
        false,
    ),
    // Same route as `target_push` with `force: true` in the body.
    op(
        "target_force_push",
        "POST",
        "/git/target-branch/push",
        "git target push",
        true,
    ),
    op(
        "target_pull",
        "POST",
        "/git/target-branch/pull",
        "git target pull",
        false,
    ),
    op(
        "target_pull_and_push",
        "POST",
        "/git/target-branch/pull-and-push",
        "git target pull-and-push",
        false,
    ),
    op(
        "target_merge_remote",
        "POST",
        "/git/target-branch/merge-remote",
        "git target merge-remote",
        false,
    ),
    op(
        "target_reset_to_remote",
        "POST",
        "/git/target-branch/reset-to-remote",
        "git target reset-to-remote",
        true,
    ),
    op(
        "target_update_from_base",
        "POST",
        "/git/target-branch/update-from-base",
        "git target update-from-base",
        false,
    ),
    op("create_pr", "POST", "/pull-requests", "pr create", false),
];

/// A coding-agent turn that ended with the worktree in conflict: not a route,
/// but the same dialog as a conflicting merge.
pub const AGENT_TURN: Op = op("agent_turn", "", "", "", false);

pub fn op_by_id(id: &str) -> Option<&'static Op> {
    OPS.iter().find(|op| op.id == id)
}

/// The operation behind a request to a `/git/...` or `/pull-requests` route.
/// `path` may be the full request path or the part under the nested router;
/// `force` is the body's `force` flag (target-branch push).
pub fn op_for_route(method: &str, path: &str, force: bool) -> Option<&'static Op> {
    let path = path.trim_end_matches('/');
    let route = match path.rfind("/git/") {
        Some(start) => &path[start..],
        None if path.ends_with("/pull-requests") => "/pull-requests",
        None => return None,
    };
    let mut candidates = OPS
        .iter()
        .filter(|op| op.method.eq_ignore_ascii_case(method) && op.route == route);
    if route == "/git/target-branch/push" {
        return candidates.find(|op| (op.id == "target_force_push") == force);
    }
    candidates.next()
}

/// The operation behind a `vk` command path (`["git", "push"]`), `force` being
/// its `--force` flag.
pub fn op_for_cli(words: &[&str], force: bool) -> Option<&'static Op> {
    let cli = words.join(" ");
    let mut candidates = OPS.iter().filter(|op| op.cli == cli);
    if cli == "git target push" {
        return candidates.find(|op| (op.id == "target_force_push") == force);
    }
    candidates.next()
}

/// Ids the choice commands are rendered with.
#[derive(Debug, Clone, Copy, Default)]
pub struct Target<'a> {
    pub workspace: &'a str,
    pub repo: Option<&'a str>,
    /// Options that reproduce the failed request (see [`retry_args`]).
    pub retry_args: &'a str,
}

/// Options that make `vk <op.cli> <ws>` repeat the request in `body`.
pub fn retry_args(op: &Op, body: &Value) -> String {
    let opt = |flag: &str, key: &str| {
        body.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|value| format!("--{flag} {}", quote(value)))
    };
    let flag = |name: &str, key: &str| {
        (body.get(key).and_then(Value::as_bool) == Some(true)).then(|| format!("--{name}"))
    };
    let args: Vec<Option<String>> = match op.id {
        "create_pr" => vec![
            Some("--from-draft".to_string()),
            opt("base", "target_branch"),
            opt("head", "head_branch"),
            flag("draft", "draft"),
        ],
        "update_from_base" => vec![opt("strategy", "strategy")],
        "rebase" => vec![
            opt("old-base", "old_base_branch"),
            opt("new-base", "new_base_branch"),
        ],
        "rename_branch" => vec![opt("name", "new_branch_name")],
        "target_set" => vec![opt("branch", "new_target_branch")],
        "target_update_from_base" => vec![opt("base", "base_branch")],
        "target_force_push" => vec![Some("--force".to_string())],
        "reset_to_remote" | "target_reset_to_remote" => vec![Some("--confirm".to_string())],
        _ => Vec::new(),
    };
    args.into_iter().flatten().collect::<Vec<_>>().join(" ")
}

fn quote(value: &str) -> String {
    shlex::try_quote(value)
        .map(|q| q.into_owned())
        .unwrap_or_else(|_| format!("'{}'", value.replace('\'', "'\\''")))
}

/// `vk <words> <ws> [--repo <id>] [<extra>]`.
pub fn command(words: &str, target: &Target, extra: &str) -> String {
    let mut text = format!("vk {words} {}", target.workspace);
    if let Some(repo) = target.repo {
        text.push_str(" --repo ");
        text.push_str(repo);
    }
    if !extra.is_empty() {
        text.push(' ');
        text.push_str(extra);
    }
    text
}

/// One button of the dialog, as a `vk` command.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Choice {
    pub id: String,
    /// Absent for `cancel` (leave things as they are).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// Rewrites or discards history; automation must not run it unasked.
    pub destructive: bool,
}

impl Choice {
    fn new(id: &str, command: String, destructive: bool) -> Self {
        Self {
            id: id.to_string(),
            command: Some(command),
            destructive,
        }
    }
}

/// A failed operation named the way the dialog would, plus its buttons.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitFailure {
    pub op: String,
    /// `diverged`, `force_push_required`, `conflict`, `rebase_in_progress`,
    /// `dirty`, `base_diverged`, `auth`, `cli_missing`, `provider_rejected`,
    /// `invalid`, `forbidden` or `other`.
    pub category: String,
    pub message: String,
    /// Commits only the local branch has.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ahead: Option<u64>,
    /// Commits only the remote branch has.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub behind: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conflicted_files: Vec<String>,
    pub choices: Vec<Choice>,
}

/// Read the `ApiResponse` envelope (`{success, data, error_data, message}`)
/// a route answered `status` with. `None` means the operation succeeded.
pub fn classify(op: &Op, status: u16, envelope: &Value, target: &Target) -> Option<GitFailure> {
    let success = envelope
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(status < 400);
    if success && status < 400 {
        // A fast-forward pull that could not happen is a successful `diverged`
        // outcome; the UI answers it with the reconcile dialog.
        let data = envelope.get("data");
        if matches!(op.id, "pull" | "target_pull")
            && data.and_then(|d| d.get("type")).and_then(Value::as_str) == Some("diverged")
        {
            let count = |key: &str| data.and_then(|d| d.get(key)).and_then(Value::as_u64);
            let (ahead, behind) = (count("ahead"), count("behind"));
            return Some(GitFailure {
                op: op.id.to_string(),
                category: "diverged".to_string(),
                message: format!(
                    "The branch diverged from its remote: {} remote-only commit(s), {} local-only. Merge the remote in or reset to it.",
                    behind.unwrap_or(0),
                    ahead.unwrap_or(0)
                ),
                ahead,
                behind,
                conflicted_files: Vec::new(),
                choices: choices(op, "diverged", target),
            });
        }
        return None;
    }
    let error = envelope.get("error_data").filter(|v| !v.is_null());
    let kind = error
        .and_then(|e| e.get("type"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let message = envelope
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| error.and_then(|e| e.get("message")).and_then(Value::as_str))
        .map(str::to_string)
        .unwrap_or_else(|| {
            if kind.is_empty() {
                format!("HTTP {status}")
            } else {
                kind.replace('_', " ")
            }
        });
    let lower = message.to_ascii_lowercase();
    let count = |key: &str| error.and_then(|e| e.get(key)).and_then(Value::as_u64);
    let files = || {
        error
            .and_then(|e| e.get("conflicted_files"))
            .and_then(Value::as_array)
            .map(|files| {
                files
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    };
    let (category, ahead, behind, conflicted_files) = match kind {
        "diverged" => ("diverged", count("ahead"), count("behind"), Vec::new()),
        "force_push_required" => ("force_push_required", None, None, Vec::new()),
        "merge_conflicts" => ("conflict", None, None, files()),
        "rebase_in_progress" => ("rebase_in_progress", None, None, Vec::new()),
        "git_cli_not_logged_in" | "cli_not_logged_in" => ("auth", None, None, Vec::new()),
        "git_cli_not_installed" | "cli_not_installed" => ("cli_missing", None, None, Vec::new()),
        "target_branch_not_found" | "same_head_and_base_branch" | "unsupported_provider" => {
            ("invalid", None, None, Vec::new())
        }
        _ if status == 403 => ("forbidden", None, None, Vec::new()),
        // `GitServiceError::PushDiverged` rendered as a plain error (create_pr).
        _ if lower.contains("push rejected: the remote branch has") => {
            let (ahead, behind) = parse_diverged(&lower);
            ("diverged", ahead, behind, Vec::new())
        }
        _ if lower.contains("rebase") && lower.contains("in progress") => {
            ("rebase_in_progress", None, None, Vec::new())
        }
        _ if lower.contains("conflict") => ("conflict", None, None, Vec::new()),
        _ if lower.contains("uncommitted changes") || lower.contains("commit tracked changes") => {
            ("dirty", None, None, Vec::new())
        }
        _ if lower.contains("cannot fast-forward merge") || lower.contains("branches diverged") => {
            ("base_diverged", None, None, Vec::new())
        }
        _ if lower.contains("authentication failed")
            || lower.contains("not logged in")
            || lower.contains("credentials") =>
        {
            ("auth", None, None, Vec::new())
        }
        _ if lower.contains("not installed")
            || lower.contains("executable not found")
            || lower.contains("not available in path") =>
        {
            ("cli_missing", None, None, Vec::new())
        }
        // The host's own rejection (a PR for this head already exists, ...).
        _ if op.id == "create_pr" && status < 400 => ("provider_rejected", None, None, Vec::new()),
        _ => ("other", None, None, Vec::new()),
    };
    let mut failure = GitFailure {
        op: op.id.to_string(),
        category: category.to_string(),
        message,
        ahead,
        behind,
        conflicted_files,
        choices: Vec::new(),
    };
    failure.choices = choices(op, category, target);
    Some(failure)
}

/// The conflict dialog for a turn of the coding agent that left
/// `conflicted_files` (or a rebase) behind in the worktree; published as
/// `git.operation_failed` with op `agent_turn`.
pub fn agent_turn_conflicts(
    target: &Target,
    conflicted_files: Vec<String>,
    rebase_in_progress: bool,
) -> GitFailure {
    let category = if conflicted_files.is_empty() {
        "rebase_in_progress"
    } else {
        "conflict"
    };
    let message = match (conflicted_files.len(), rebase_in_progress) {
        (0, _) => "The agent's turn ended with a rebase still in progress.".to_string(),
        (n, true) => {
            format!("The agent's turn ended with {n} conflicted file(s) and a rebase in progress.")
        }
        (n, false) => format!("The agent's turn ended with {n} conflicted file(s)."),
    };
    GitFailure {
        op: AGENT_TURN.id.to_string(),
        category: category.to_string(),
        message,
        ahead: None,
        behind: None,
        conflicted_files,
        choices: choices(&AGENT_TURN, category, target),
    }
}

/// `... the remote branch has {behind} commit(s) the local branch is missing
/// (local is {ahead} ahead) ...`
fn parse_diverged(lower: &str) -> (Option<u64>, Option<u64>) {
    let after = |marker: &str| {
        lower.find(marker).and_then(|at| {
            lower[at + marker.len()..]
                .trim_start()
                .split(|c: char| !c.is_ascii_digit())
                .next()
                .and_then(|digits| digits.parse().ok())
        })
    };
    (after("(local is"), after("remote branch has"))
}

/// The dialog's buttons for a failure, cancel last. Empty but for `cancel`
/// when only a person can act (credentials, missing CLI, invalid request).
fn choices(op: &Op, category: &str, target: &Target) -> Vec<Choice> {
    let on_target = op.id.starts_with("target_");
    let by = |id: &str| op_by_id(id).expect("known op");
    let of = |id: &str, run: &Op, extra: &str, destructive: bool| {
        Choice::new(id, command(run.cli, target, extra), destructive)
    };
    let retry = Choice::new(
        "retry",
        command(op.cli, target, target.retry_args),
        op.destructive,
    );
    let mut list = match category {
        // A pull found the branch diverged: merge the remote in, or make the
        // remote authoritative (the reconcile dialog).
        "diverged" if matches!(op.id, "pull" | "target_pull") => vec![
            of(
                "merge_remote",
                by(if on_target {
                    "target_merge_remote"
                } else {
                    "merge_remote"
                }),
                "",
                false,
            ),
            of(
                "reset_to_remote",
                by(if on_target {
                    "target_reset_to_remote"
                } else {
                    "reset_to_remote"
                }),
                "--confirm",
                true,
            ),
        ],
        "diverged" if on_target => vec![
            of("pull_and_push", by("target_pull_and_push"), "", false),
            of("merge_remote", by("target_merge_remote"), "", false),
            retry,
            of("force_push", by("target_force_push"), "--force", true),
        ],
        "diverged" => vec![
            of("pull_and_push", by("pull_and_push"), "", false),
            of("merge_remote", by("merge_remote"), "", false),
            retry,
            of("force_push", by("force_push"), "", true),
        ],
        "force_push_required" if on_target => {
            vec![of("force_push", by("target_force_push"), "--force", true)]
        }
        "force_push_required" => vec![of("force_push", by("force_push"), "", true)],
        // The server aborts a conflicting merge in the target checkout itself.
        "conflict" if on_target => vec![retry],
        "conflict" => {
            let mut list = vec![Choice::new(
                "resolve_with_agent",
                command("git resolve-conflicts", target, ""),
                false,
            )];
            if matches!(op.id, "rebase" | "update_from_base") {
                list.push(of("rebase_continue", by("rebase_continue"), "", false));
            }
            list.push(of("abort", by("abort"), "", true));
            list
        }
        "rebase_in_progress" => vec![
            of("rebase_continue", by("rebase_continue"), "", false),
            of("abort", by("abort"), "", true),
        ],
        "dirty" => vec![of("commit", by("commit"), "", false), retry],
        "base_diverged" => vec![
            of(
                "update_from_base",
                by("update_from_base"),
                "--strategy merge",
                false,
            ),
            of("rebase", by("update_from_base"), "--strategy rebase", true),
            retry,
        ],
        "provider_rejected" if op.id == "create_pr" => vec![
            Choice::new(
                "attach_existing_pr",
                command("pr attach", target, ""),
                false,
            ),
            retry,
        ],
        "other" => vec![retry],
        _ => Vec::new(),
    };
    list.push(Choice {
        id: "cancel".to_string(),
        command: None,
        destructive: false,
    });
    list
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const TARGET: Target<'static> = Target {
        workspace: "ws-1",
        repo: Some("repo-1"),
        retry_args: "",
    };

    fn ids(failure: &GitFailure) -> Vec<&str> {
        failure.choices.iter().map(|c| c.id.as_str()).collect()
    }

    #[test]
    fn routes_and_cli_words_name_the_same_op() {
        for op in OPS {
            let force = op.id == "target_force_push";
            let full = format!("/api/workspaces/abc{}", op.route);
            assert_eq!(
                op_for_route(op.method, &full, force).map(|o| o.id),
                Some(op.id)
            );
            let relayed = format!("/api/host/h1/workspaces/abc{}/", op.route);
            assert_eq!(
                op_for_route(op.method, &relayed, force).map(|o| o.id),
                Some(op.id)
            );
            let words: Vec<&str> = op.cli.split(' ').collect();
            assert_eq!(op_for_cli(&words, force).map(|o| o.id), Some(op.id));
        }
        assert!(op_for_route("GET", "/api/workspaces/abc/git/status", false).is_none());
        assert!(op_for_route("PUT", "/api/workspaces/abc/pull-requests/draft", false).is_none());
        assert!(
            op_for_route("POST", "/api/workspaces/abc/git/target-branch/push", true)
                .is_some_and(|op| op.destructive)
        );
    }

    #[test]
    fn a_diverged_push_offers_pull_first_and_marks_force_push_destructive() {
        let envelope = json!({
            "success": false, "data": null, "message": null,
            "error_data": { "type": "diverged", "ahead": 3, "behind": 122 }
        });
        let failure = classify(op_by_id("push").unwrap(), 200, &envelope, &TARGET).unwrap();
        assert_eq!(failure.category, "diverged");
        assert_eq!((failure.ahead, failure.behind), (Some(3), Some(122)));
        assert_eq!(
            ids(&failure),
            [
                "pull_and_push",
                "merge_remote",
                "retry",
                "force_push",
                "cancel"
            ]
        );
        assert_eq!(
            failure.choices[0].command.as_deref(),
            Some("vk git pull-and-push ws-1 --repo repo-1")
        );
        assert_eq!(
            failure.choices[2].command.as_deref(),
            Some("vk git push ws-1 --repo repo-1")
        );
        let force = &failure.choices[3];
        assert!(force.destructive);
        assert_eq!(
            force.command.as_deref(),
            Some("vk git force-push ws-1 --repo repo-1")
        );
        assert_eq!(failure.choices[4].command, None);
    }

    #[test]
    fn create_pr_push_rejection_is_read_from_the_plain_error_message() {
        let envelope = json!({
            "success": false, "data": null, "error_data": null,
            "message": "Git operation failed: Push rejected: the remote branch has 122 commit(s) the local branch is missing (local is 3 ahead). Pull first."
        });
        let body =
            json!({ "repo_id": "repo-1", "title": "t", "target_branch": "develop", "draft": true });
        let op = op_by_id("create_pr").unwrap();
        let retry = retry_args(op, &body);
        let target = Target {
            retry_args: &retry,
            ..TARGET
        };
        let failure = classify(op, 500, &envelope, &target).unwrap();
        assert_eq!(failure.category, "diverged");
        assert_eq!((failure.ahead, failure.behind), (Some(3), Some(122)));
        assert_eq!(
            ids(&failure),
            [
                "pull_and_push",
                "merge_remote",
                "retry",
                "force_push",
                "cancel"
            ]
        );
        assert_eq!(
            failure.choices[2].command.as_deref(),
            Some("vk pr create ws-1 --repo repo-1 --from-draft --base develop --draft")
        );
    }

    #[test]
    fn conflicts_route_to_the_agent_and_abort_stays_destructive() {
        let envelope = json!({
            "success": false,
            "error_data": { "type": "merge_conflicts", "message": "Merge encountered conflicts", "op": "merge", "conflicted_files": ["a.rs", "b.rs"], "target_branch": "feature" }
        });
        let failure =
            classify(op_by_id("pull_and_push").unwrap(), 200, &envelope, &TARGET).unwrap();
        assert_eq!(failure.category, "conflict");
        assert_eq!(failure.conflicted_files, ["a.rs", "b.rs"]);
        assert_eq!(ids(&failure), ["resolve_with_agent", "abort", "cancel"]);
        assert_eq!(
            failure.choices[0].command.as_deref(),
            Some("vk git resolve-conflicts ws-1 --repo repo-1")
        );
        assert!(failure.choices[1].destructive);

        let rebase = classify(op_by_id("rebase").unwrap(), 200, &envelope, &TARGET).unwrap();
        assert_eq!(
            ids(&rebase),
            ["resolve_with_agent", "rebase_continue", "abort", "cancel"]
        );
    }

    #[test]
    fn plain_server_errors_are_classified_by_their_text() {
        let failure = |op: &str, status: u16, message: &str| {
            classify(
                op_by_id(op).unwrap(),
                status,
                &json!({ "success": false, "message": message, "error_data": null }),
                &TARGET,
            )
            .unwrap()
        };
        let rebase = failure(
            "push",
            409,
            "A rebase is already in progress. Resolve conflicts or abort the rebase, then retry.",
        );
        assert_eq!(rebase.category, "rebase_in_progress");
        assert_eq!(ids(&rebase), ["rebase_continue", "abort", "cancel"]);
        let dirty = failure(
            "merge",
            409,
            "Branch 'x' has uncommitted changes (a.rs). Commit or revert them before retrying.",
        );
        assert_eq!(dirty.category, "dirty");
        assert_eq!(ids(&dirty), ["commit", "retry", "cancel"]);
        let base = failure(
            "merge",
            409,
            "Cannot fast-forward merge: base branch 'main' is 2 commits ahead of task branch 'x'. Rebase onto the target branch first, then retry the merge.",
        );
        assert_eq!(base.category, "base_diverged");
        assert_eq!(
            ids(&base),
            ["update_from_base", "rebase", "retry", "cancel"]
        );
        assert!(base.choices[1].destructive);
        let auth = failure(
            "push",
            401,
            "authentication failed: x. Check your git credentials or SSH keys and try again.",
        );
        assert_eq!(auth.category, "auth");
        assert_eq!(ids(&auth), ["cancel"]);
        let forbidden = failure("force_push", 403, "Forbidden");
        assert_eq!(forbidden.category, "forbidden");
        let rejected = failure(
            "create_pr",
            200,
            "a pull request for branch \"x\" already exists",
        );
        assert_eq!(rejected.category, "provider_rejected");
        assert_eq!(ids(&rejected), ["attach_existing_pr", "retry", "cancel"]);
        let other = failure(
            "pull_and_push",
            500,
            "Git operation failed: Merge failed: fatal: refusing to merge unrelated histories",
        );
        assert_eq!(other.category, "other");
        assert_eq!(ids(&other), ["retry", "cancel"]);
    }

    #[test]
    fn success_and_target_branch_choices() {
        assert!(
            classify(
                op_by_id("push").unwrap(),
                200,
                &json!({ "success": true, "data": null }),
                &TARGET
            )
            .is_none()
        );
        let envelope = json!({ "success": false, "error_data": { "type": "diverged", "ahead": 1, "behind": 2 } });
        let target = classify(op_by_id("target_push").unwrap(), 200, &envelope, &TARGET).unwrap();
        assert_eq!(
            ids(&target),
            [
                "pull_and_push",
                "merge_remote",
                "retry",
                "force_push",
                "cancel"
            ]
        );
        assert_eq!(
            target.choices[0].command.as_deref(),
            Some("vk git target pull-and-push ws-1 --repo repo-1")
        );
        assert_eq!(
            target.choices[3].command.as_deref(),
            Some("vk git target push ws-1 --repo repo-1 --force")
        );
    }

    #[test]
    fn a_diverged_pull_offers_merge_or_reset() {
        let envelope =
            json!({ "success": true, "data": { "type": "diverged", "ahead": 1, "behind": 4 } });
        let pull = classify(op_by_id("pull").unwrap(), 200, &envelope, &TARGET).unwrap();
        assert_eq!(pull.category, "diverged");
        assert_eq!((pull.ahead, pull.behind), (Some(1), Some(4)));
        assert_eq!(ids(&pull), ["merge_remote", "reset_to_remote", "cancel"]);
        assert_eq!(
            pull.choices[0].command.as_deref(),
            Some("vk git merge-remote ws-1 --repo repo-1")
        );
        assert!(pull.choices[1].destructive);
        assert_eq!(
            pull.choices[1].command.as_deref(),
            Some("vk git reset-to-remote ws-1 --repo repo-1 --confirm")
        );
        let target = classify(op_by_id("target_pull").unwrap(), 200, &envelope, &TARGET).unwrap();
        assert_eq!(
            target.choices[1].command.as_deref(),
            Some("vk git target reset-to-remote ws-1 --repo repo-1 --confirm")
        );
        // A fast-forward or an up-to-date pull is a plain success.
        let done = json!({ "success": true, "data": { "type": "fast_forwarded", "commits": 2 } });
        assert!(classify(op_by_id("pull").unwrap(), 200, &done, &TARGET).is_none());
    }

    #[test]
    fn an_agent_turn_that_left_conflicts_gets_the_conflict_dialog() {
        let failure = agent_turn_conflicts(&TARGET, vec!["a.rs".to_string()], false);
        assert_eq!(failure.op, "agent_turn");
        assert_eq!(failure.category, "conflict");
        assert_eq!(ids(&failure), ["resolve_with_agent", "abort", "cancel"]);
        assert_eq!(
            failure.choices[0].command.as_deref(),
            Some("vk git resolve-conflicts ws-1 --repo repo-1")
        );
        let rebase = agent_turn_conflicts(&TARGET, Vec::new(), true);
        assert_eq!(rebase.category, "rebase_in_progress");
        assert_eq!(ids(&rebase), ["rebase_continue", "abort", "cancel"]);
    }

    #[test]
    fn retry_args_quote_branch_names() {
        let op = op_by_id("rebase").unwrap();
        assert_eq!(
            retry_args(
                op,
                &json!({ "new_base_branch": "feat/a b", "old_base_branch": "" })
            ),
            "--new-base 'feat/a b'"
        );
        assert_eq!(
            retry_args(op_by_id("reset_to_remote").unwrap(), &json!({})),
            "--confirm"
        );
        assert_eq!(retry_args(op_by_id("push").unwrap(), &json!({})), "");
    }
}
