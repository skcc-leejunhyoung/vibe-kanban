//! Journal events for git and pull-request operations.
//!
//! `git.operation_failed` carries what the UI dialog would have shown
//! (category, remote-only/local-only commit counts, conflicted files, the
//! message) and the choices it would have offered, each as a `vk` command with
//! a `destructive` flag; `git.operation_succeeded` closes the loop after a
//! remedy; `pr.created` follows a successful `create_pr`. One middleware over
//! the `/git` and `/pull-requests` routers reads the `ApiResponse` envelope,
//! so every handler, present and future, is covered without touching it.

use axum::{
    Extension,
    body::{Body, to_bytes},
    extract::{OriginalUri, Request, State},
    http::{Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use db::models::{session::Session, workspace::Workspace};
use deployment::Deployment;
use serde_json::{Value, json};
use services::services::agent_journal;
use sqlx::SqlitePool;
use utils::git_ops::{self, Op, Target};
use uuid::Uuid;

use super::pr::PrDraft;
use crate::DeploymentImpl;

/// Git/PR request bodies are a few ids and strings; a PR body is the largest.
const MAX_REQUEST_BYTES: usize = 2 * 1024 * 1024;
/// Keep an event well under the cloud push's 64 KiB data cap.
const MAX_MESSAGE_CHARS: usize = 1000;
const MAX_FILES: usize = 50;

/// Publish the outcome of every mutating `/git/...` and `/pull-requests`
/// request as a journal event (reads pass through untouched).
pub async fn observe(
    State(deployment): State<DeploymentImpl>,
    Extension(workspace): Extension<Workspace>,
    OriginalUri(uri): OriginalUri,
    request: Request,
    next: Next,
) -> Response {
    if !matches!(*request.method(), Method::POST | Method::PUT) {
        return next.run(request).await;
    }
    let method = request.method().clone();
    let by_autopilot = by_autopilot(&deployment.db().pool, request.headers()).await;
    let (parts, body) = request.into_parts();
    let Ok(bytes) = to_bytes(body, MAX_REQUEST_BYTES).await else {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    };
    let input: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let force = input.get("force").and_then(Value::as_bool).unwrap_or(false);
    let request = Request::from_parts(parts, Body::from(bytes));
    let Some(op) = git_ops::op_for_route(method.as_str(), uri.path(), force) else {
        return next.run(request).await;
    };
    let response = next.run(request).await;
    let (parts, body) = response.into_parts();
    let bytes = match to_bytes(body, usize::MAX).await {
        Ok(bytes) => bytes,
        Err(error) => {
            tracing::warn!(op = op.id, %error, "Could not read the git operation response");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let envelope: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    record(
        Some(&deployment.db().pool),
        workspace.id,
        &workspace.branch,
        op,
        parts.status.as_u16(),
        &input,
        &envelope,
        by_autopilot,
    )
    .await;
    Response::from_parts(parts, Body::from(bytes))
}

/// Whether the request came from the host's Autopilot (its CLI carries its
/// session id). The resulting event is its own doing: it already has the
/// answer in hand, so automation must not wake it with it again.
async fn by_autopilot(pool: &SqlitePool, headers: &axum::http::HeaderMap) -> bool {
    let Some(session_id) = headers
        .get(crate::middleware::agent_access::AGENT_SESSION_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<Uuid>().ok())
    else {
        return false;
    };
    let Ok(Some(session)) = Session::find_by_id(pool, session_id).await else {
        return false;
    };
    matches!(
        Workspace::find_by_id(pool, session.workspace_id).await,
        Ok(Some(workspace)) if workspace.autopilot
    )
}

/// Turn one request/response pair into its journal event. A failed
/// `create_pr` also keeps the request's title and body as the workspace's PR
/// draft, so `vk pr create --from-draft` can repeat it. `by_autopilot` marks
/// an event the Autopilot caused itself (the cloud push tags it like its own
/// workspace's events, so the event connector drops it).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn record(
    pool: Option<&SqlitePool>,
    workspace_id: Uuid,
    branch: &str,
    op: &Op,
    status: u16,
    input: &Value,
    envelope: &Value,
    by_autopilot: bool,
) {
    let repo_id = input
        .get("repo_id")
        .and_then(Value::as_str)
        .and_then(|id| id.parse::<Uuid>().ok());
    let workspace = workspace_id.to_string();
    let repo = repo_id.map(|id| id.to_string());
    let retry_args = git_ops::retry_args(op, input);
    let target = Target {
        workspace: &workspace,
        repo: repo.as_deref(),
        retry_args: &retry_args,
    };
    let Some(mut failure) = git_ops::classify(op, status, envelope, &target) else {
        // `pr.created` already tells the story of a successful create_pr.
        if op.id != "create_pr" {
            let mut data = json!({
                "op": op.id,
                "repo_id": repo_id,
                "branch": branch,
                "result": envelope.get("data").cloned().unwrap_or(Value::Null),
            });
            if by_autopilot {
                data["by_autopilot"] = json!(true);
            }
            agent_journal::publish(
                "git.operation_succeeded",
                Some(workspace_id),
                None,
                None,
                data,
            );
        }
        return;
    };
    if op.id == "create_pr"
        && let (Some(pool), Some(repo_id)) = (pool, repo_id)
    {
        keep_draft(pool, workspace_id, repo_id, input).await;
    }
    if failure.message.chars().count() > MAX_MESSAGE_CHARS {
        failure.message = failure.message.chars().take(MAX_MESSAGE_CHARS).collect();
    }
    failure.conflicted_files.truncate(MAX_FILES);
    let mut data = serde_json::to_value(&failure).unwrap_or_else(|_| json!({}));
    if let Value::Object(map) = &mut data {
        map.insert("repo_id".into(), json!(repo_id));
        map.insert("branch".into(), json!(branch));
        map.insert("status".into(), json!(status));
        map.insert("request".into(), request_summary(op, input));
        if by_autopilot {
            map.insert("by_autopilot".into(), json!(true));
        }
    }
    agent_journal::publish("git.operation_failed", Some(workspace_id), None, None, data);
}

/// The request minus a PR body (its draft is kept server-side instead).
fn request_summary(op: &Op, input: &Value) -> Value {
    let mut summary = input.clone();
    if op.id == "create_pr"
        && let Value::Object(map) = &mut summary
        && let Some(body) = map.remove("body")
    {
        map.insert(
            "body_chars".into(),
            json!(body.as_str().map(|b| b.chars().count()).unwrap_or(0)),
        );
    }
    summary
}

async fn keep_draft(pool: &SqlitePool, workspace_id: Uuid, repo_id: Uuid, input: &Value) {
    let Some(title) = input.get("title").and_then(Value::as_str) else {
        return;
    };
    let draft = PrDraft {
        repo_id,
        title: title.to_string(),
        body: input
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    };
    if let Err(error) = super::pr::save_pr_draft(pool, workspace_id, &draft).await {
        tracing::warn!(%workspace_id, %repo_id, %error, "Could not keep the failed PR's draft");
    }
}

/// A pull request was opened for the workspace.
pub fn pr_created(
    workspace_id: Uuid,
    repo_id: Uuid,
    number: i64,
    url: &str,
    head: &str,
    base: &str,
    draft: bool,
) {
    agent_journal::publish(
        "pr.created",
        Some(workspace_id),
        None,
        None,
        json!({
            "repo_id": repo_id,
            "number": number,
            "url": url,
            "head": head,
            "base": base,
            "draft": draft,
        }),
    );
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path};

    use axum::response::IntoResponse;
    use git::{GitCli, GitService, GitServiceError};
    use services::services::agent_journal::{JournalEvent, list};
    use tempfile::TempDir;
    use utils::response::ApiResponse;

    use super::*;
    use crate::{
        error::ApiError,
        routes::workspaces::git::{PullWorkspaceResponse, PushError},
    };

    fn events_for(workspace_id: Uuid, since: u64) -> Vec<JournalEvent> {
        list(since, &["git.".to_string(), "pr.".to_string()], 1000)
            .events
            .into_iter()
            .filter(|event| event.workspace_id == Some(workspace_id))
            .collect()
    }

    fn choice_ids(event: &JournalEvent) -> Vec<String> {
        event.data["choices"]
            .as_array()
            .unwrap()
            .iter()
            .map(|choice| choice["id"].as_str().unwrap().to_string())
            .collect()
    }

    async fn body_of(response: Response) -> (u16, Value) {
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    #[tokio::test]
    async fn a_rejected_push_publishes_the_dialog_and_its_choices() {
        let workspace_id = Uuid::new_v4();
        let repo_id = Uuid::new_v4();
        let since = list(0, &[], 1).cursor;
        let envelope = serde_json::to_value(ApiResponse::<(), PushError>::error_with_data(
            PushError::Diverged {
                ahead: 3,
                behind: 122,
            },
        ))
        .unwrap();
        record(
            None,
            workspace_id,
            "vk/feature",
            git_ops::op_by_id("push").unwrap(),
            200,
            &json!({ "repo_id": repo_id }),
            &envelope,
            false,
        )
        .await;
        let events = events_for(workspace_id, since);
        assert_eq!(events.len(), 1);
        let event = &events[0];
        assert_eq!(event.kind, "git.operation_failed");
        assert_eq!(event.data["op"], "push");
        assert!(event.data.get("by_autopilot").is_none());
        assert_eq!(event.data["category"], "diverged");
        assert_eq!(event.data["behind"], 122);
        assert_eq!(event.data["ahead"], 3);
        assert_eq!(event.data["repo_id"], json!(repo_id));
        assert_eq!(
            choice_ids(event),
            [
                "pull_and_push",
                "merge_remote",
                "retry",
                "force_push",
                "cancel"
            ]
        );
        let choices = event.data["choices"].as_array().unwrap();
        assert_eq!(
            choices[0]["command"],
            format!("vk git pull-and-push {workspace_id} --repo {repo_id}")
        );
        assert_eq!(choices[3]["destructive"], true);
        assert_eq!(choices[0]["destructive"], false);
    }

    /// A pull that finds the branch diverged answers 200 with a `diverged`
    /// outcome; the UI shows the reconcile dialog, so the journal gets the
    /// failure with its two choices rather than a success.
    #[tokio::test]
    async fn a_diverged_pull_is_a_dialog_not_a_success() {
        let workspace_id = Uuid::new_v4();
        let repo_id = Uuid::new_v4();
        let since = list(0, &[], 1).cursor;
        let envelope = serde_json::to_value(ApiResponse::<PullWorkspaceResponse>::success(
            PullWorkspaceResponse::Diverged {
                ahead: 1,
                behind: 4,
            },
        ))
        .unwrap();
        record(
            None,
            workspace_id,
            "vk/feature",
            git_ops::op_by_id("pull").unwrap(),
            200,
            &json!({ "repo_id": repo_id }),
            &envelope,
            false,
        )
        .await;
        let events = events_for(workspace_id, since);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "git.operation_failed");
        assert_eq!(events[0].data["category"], "diverged");
        assert_eq!(events[0].data["behind"], 4);
        assert_eq!(
            choice_ids(&events[0]),
            ["merge_remote", "reset_to_remote", "cancel"]
        );
    }

    #[tokio::test]
    async fn a_successful_remedy_closes_the_loop() {
        let workspace_id = Uuid::new_v4();
        let since = list(0, &[], 1).cursor;
        let envelope = serde_json::to_value(ApiResponse::<()>::success(())).unwrap();
        record(
            None,
            workspace_id,
            "vk/feature",
            git_ops::op_by_id("pull_and_push").unwrap(),
            200,
            &json!({ "repo_id": Uuid::new_v4() }),
            &envelope,
            false,
        )
        .await;
        let events = events_for(workspace_id, since);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "git.operation_succeeded");
        assert_eq!(events[0].data["op"], "pull_and_push");
    }

    /// What the Autopilot does with `vk` must not come back to wake it.
    #[tokio::test]
    async fn the_autopilots_own_operations_are_tagged() {
        let workspace_id = Uuid::new_v4();
        let since = list(0, &[], 1).cursor;
        let failed = serde_json::to_value(ApiResponse::<(), PushError>::error_with_data(
            PushError::ForcePushRequired,
        ))
        .unwrap();
        record(
            None,
            workspace_id,
            "vk/feature",
            git_ops::op_by_id("push").unwrap(),
            200,
            &json!({ "repo_id": Uuid::new_v4() }),
            &failed,
            true,
        )
        .await;
        let ok = serde_json::to_value(ApiResponse::<()>::success(())).unwrap();
        record(
            None,
            workspace_id,
            "vk/feature",
            git_ops::op_by_id("pull_and_push").unwrap(),
            200,
            &json!({ "repo_id": Uuid::new_v4() }),
            &ok,
            true,
        )
        .await;
        let events = events_for(workspace_id, since);
        assert_eq!(events.len(), 2);
        assert!(events.iter().all(|e| e.data["by_autopilot"] == true));
    }

    fn git(cli: &GitCli, path: &Path, args: &[&str]) -> String {
        let mut full = vec![
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "-c",
            "commit.gpgsign=false",
        ];
        full.extend_from_slice(args);
        cli.git(path, full)
            .unwrap_or_else(|e| panic!("git {args:?}: {e}"))
    }

    fn commit_file(cli: &GitCli, path: &Path, name: &str, content: &str) {
        fs::write(path.join(name), content).unwrap();
        git(cli, path, &["add", name]);
        git(cli, path, &["commit", "-m", &format!("add {name}")]);
    }

    /// The reported scenario end to end at the git level: the remote work
    /// branch is ahead, "Create PR" pushes and is rejected (one
    /// `git.operation_failed` with the pull-first choice), the choice's
    /// operation pulls and pushes without a dialog, and the PR is recorded.
    #[tokio::test]
    async fn create_pr_on_a_branch_the_remote_overtook_is_recoverable_by_its_choices() {
        let temp = TempDir::new().unwrap();
        let cli = GitCli::new();
        let service = GitService::new();
        let remote = temp.path().join("remote.git");
        git(
            &cli,
            temp.path(),
            &["init", "--bare", "-b", "main", "remote.git"],
        );
        let remote_url = remote.to_str().unwrap();

        // Our worktree: main + a pushed work branch.
        let local = temp.path().join("local");
        git(&cli, temp.path(), &["init", "-b", "main", "local"]);
        commit_file(&cli, &local, "README.md", "hello\n");
        git(&cli, &local, &["remote", "add", "origin", remote_url]);
        git(&cli, &local, &["push", "-u", "origin", "main"]);
        git(&cli, &local, &["checkout", "-b", "feature"]);
        commit_file(&cli, &local, "feature.txt", "one\n");
        git(&cli, &local, &["push", "-u", "origin", "feature"]);

        // Someone else moves the remote work branch forward by two commits.
        let other = temp.path().join("other");
        git(
            &cli,
            temp.path(),
            &["clone", "-b", "feature", remote_url, "other"],
        );
        commit_file(&cli, &other, "remote-a.txt", "a\n");
        commit_file(&cli, &other, "remote-b.txt", "b\n");
        git(&cli, &other, &["push", "origin", "feature"]);

        // We add our own commit and try to create the PR: the push is rejected.
        commit_file(&cli, &local, "feature.txt", "two\n");
        let workspace_id = Uuid::new_v4();
        let repo_id = Uuid::new_v4();
        let since = list(0, &[], 1).cursor;
        let error = service
            .push_to_remote(&local, "feature", false, false)
            .expect_err("the remote is ahead");
        assert!(matches!(
            error,
            GitServiceError::PushDiverged {
                ahead: 1,
                behind: 2
            }
        ));
        let (status, envelope) = body_of(ApiError::GitService(error).into_response()).await;
        let create_pr = git_ops::op_by_id("create_pr").unwrap();
        let request = json!({
            "repo_id": repo_id, "title": "feat: x", "body": "why", "target_branch": "main", "draft": false
        });
        record(
            None,
            workspace_id,
            "feature",
            create_pr,
            status,
            &request,
            &envelope,
            false,
        )
        .await;

        let failed = events_for(workspace_id, since);
        assert_eq!(failed.len(), 1);
        let event = &failed[0];
        assert_eq!(event.kind, "git.operation_failed");
        assert_eq!(event.data["op"], "create_pr");
        assert_eq!(event.data["category"], "diverged");
        assert_eq!(event.data["behind"], 2);
        assert_eq!(event.data["ahead"], 1);
        assert_eq!(event.data["request"]["body_chars"], 3);
        assert!(event.data["request"].get("body").is_none());
        assert_eq!(
            choice_ids(event),
            [
                "pull_and_push",
                "merge_remote",
                "retry",
                "force_push",
                "cancel"
            ]
        );
        let choices = event.data["choices"].as_array().unwrap();
        assert_eq!(
            choices[0]["command"],
            format!("vk git pull-and-push {workspace_id} --repo {repo_id}")
        );
        assert_eq!(
            choices[2]["command"],
            format!("vk pr create {workspace_id} --repo {repo_id} --from-draft --base main")
        );

        // The `pull_and_push` choice: what the route does, no dialog involved.
        service
            .merge_remote_into_workspace_branch(&local, "feature")
            .expect("merge the remote commits");
        service
            .push_to_remote(&local, "feature", false, false)
            .expect("fast-forward push after the merge");
        let envelope = serde_json::to_value(ApiResponse::<()>::success(())).unwrap();
        record(
            None,
            workspace_id,
            "feature",
            git_ops::op_by_id("pull_and_push").unwrap(),
            200,
            &json!({ "repo_id": repo_id }),
            &envelope,
            false,
        )
        .await;
        let remote_tip = git(&cli, &other, &["ls-remote", "origin", "refs/heads/feature"]);
        let local_tip = git(&cli, &local, &["rev-parse", "feature"]);
        assert!(
            remote_tip.starts_with(local_tip.trim()),
            "remote carries the merge"
        );
        for name in ["remote-a.txt", "remote-b.txt", "feature.txt"] {
            assert!(local.join(name).exists(), "{name} kept");
        }

        // The retried create_pr succeeds (the host call itself is gh's job).
        pr_created(
            workspace_id,
            repo_id,
            7,
            "https://github.com/acme/widgets/pull/7",
            "feature",
            "main",
            false,
        );
        let kinds: Vec<String> = events_for(workspace_id, since)
            .into_iter()
            .map(|event| event.kind)
            .collect();
        assert_eq!(
            kinds,
            [
                "git.operation_failed",
                "git.operation_succeeded",
                "pr.created"
            ]
        );
        let created = events_for(workspace_id, since).pop().unwrap();
        assert_eq!(created.data["number"], 7);
        assert_eq!(created.data["head"], "feature");
        assert_eq!(created.data["base"], "main");
    }
}
