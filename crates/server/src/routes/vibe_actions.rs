//! The steps of a `vibe` run, for the automation worker.
//!
//! The server records the run (`vibe_runs`), reports what happened to it as
//! `vibe.*` journal events, and takes the steps below when asked. Which step
//! comes next — and where a project's run ends, and when a run has tried long
//! enough — is the worker's `vibe_flow` rule, not the server's.
//!
//! A step names the run state it was decided on: the generation, the phase and
//! the event it answers (`pending_id`). Once the run has moved on it is
//! refused with 409, so a late or repeated event cannot act. With an
//! `idempotency-key` a repeated request answers with the first one's result.
//! Agents may read the runs but never take these steps.

use axum::{
    Json, Router,
    extract::{Path, State},
    http::HeaderMap,
    middleware::from_fn,
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use db::models::{
    execution_process::ExecutionProcess,
    vibe_run::{VibeRun, VibeRunError},
    workspace::Workspace,
};
use deployment::Deployment;
use serde::Deserialize;
use serde_json::{Value, json};
use services::services::{
    container::{ContainerService, VibeStep},
    vibe_orchestrator::{
        self, EVENT_PR_RESULT, EVENT_TURN_ENDED, PR_FOLLOW_UP, PromptKind, VibePhase,
    },
    vibe_pr_bases,
};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::automation::{ActionClaim, claim_action, complete_action};
use crate::{DeploymentImpl, error::ApiError, middleware::finish_after_disconnect};

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/automation-actions/vibe/runs", get(list_runs))
        // A step runs to its end even when the worker stops waiting: half a
        // step (its event taken, nothing done) would leave the run stranded.
        .route(
            "/automation-actions/vibe/{workspace_id}/{action}",
            post(act).layer(from_fn(finish_after_disconnect)),
        )
}

fn run_error(error: VibeRunError) -> ApiError {
    match error {
        VibeRunError::Database(error) => ApiError::Database(error),
    }
}

/// The newest activity of each workspace's agent turns and scripts.
pub(crate) async fn latest_execution_activity(
    pool: &SqlitePool,
) -> Result<std::collections::HashMap<Uuid, DateTime<Utc>>, sqlx::Error> {
    let rows = sqlx::query_as::<_, (Uuid, DateTime<Utc>)>(
        r#"
        SELECT
            s.workspace_id,
            MAX(COALESCE(ep.completed_at, ep.updated_at, ep.started_at))
        FROM execution_processes ep
        JOIN sessions s ON ep.session_id = s.id
        WHERE ep.run_reason IN ('codingagent', 'setupscript', 'cleanupscript')
          AND ep.dropped = FALSE
        GROUP BY s.workspace_id
        "#,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().collect())
}

/// Every run still under way or with an event no step answered yet, for the
/// worker's reconciliation: whether a turn runs in its workspace, whether the
/// workspace is archived, and when anything last happened there.
async fn list_runs(State(deployment): State<DeploymentImpl>) -> Result<Json<Value>, ApiError> {
    let pool = &deployment.db().pool;
    let activity = latest_execution_activity(pool).await?;
    let mut runs = Vec::new();
    for run in VibeRun::find_for_automation(pool)
        .await
        .map_err(run_error)?
    {
        let archived = Workspace::find_by_id(pool, run.workspace_id)
            .await?
            .is_none_or(|workspace| workspace.archived);
        let running = ExecutionProcess::has_running_non_dev_server_processes_for_workspace(
            pool,
            run.workspace_id,
        )
        .await?;
        let last_activity_at = activity
            .get(&run.workspace_id)
            .copied()
            .max(Some(run.updated_at));
        let mut value = serde_json::to_value(&run).unwrap_or(Value::Null);
        value["archived"] = archived.into();
        value["running"] = running.into();
        value["last_activity_at"] = json!(last_activity_at);
        runs.push(value);
    }
    Ok(Json(
        json!({ "hostId": deployment.user_id(), "runs": runs }),
    ))
}

#[derive(Debug, Deserialize)]
struct StepRequest {
    expected_generation: i64,
    expected_phase: String,
    /// The event this step answers; `None` when the run has none waiting.
    #[serde(default)]
    pending_id: Option<String>,
    /// `send-prompt`: which prompt.
    #[serde(default)]
    kind: Option<String>,
    /// `block`: why, for the notification.
    #[serde(default)]
    reason: Option<String>,
    /// `merge`: the run is to end in a pull request, so where it merges must
    /// be where a PR can come from.
    #[serde(default)]
    pr: bool,
}

async fn act(
    State(deployment): State<DeploymentImpl>,
    Path((workspace_id, action)): Path<(Uuid, String)>,
    headers: HeaderMap,
    Json(request): Json<StepRequest>,
) -> Result<Json<Value>, ApiError> {
    let pool = &deployment.db().pool;
    let key = match claim_action::<Value>(pool, &headers, &format!("vibe_{action}")).await? {
        ActionClaim::Execute(key) => key,
        ActionClaim::Replay(response) => return Ok(Json(response)),
    };
    match take_step(&deployment, workspace_id, &action, &request, key.as_deref()).await {
        Ok(response) => {
            complete_action(pool, key.as_deref(), &response).await?;
            Ok(Json(response))
        }
        Err(error) => {
            // Nothing was done: the same request may be made again.
            if let Some(key) = key {
                services::services::automation::abandon_action(pool, &key).await?;
            }
            Err(error)
        }
    }
}

/// What a step request asks for.
#[derive(Debug)]
enum Step {
    /// A step the container takes.
    Run(VibeStep),
    /// Start the push and the PR after the merge.
    PublishPr,
    /// The worker has nothing to do about the event: it waits no more.
    Dismiss,
}

/// What `action` asks of a run in `run`'s state, or why it cannot be asked.
#[allow(clippy::result_large_err)]
fn step_for(action: &str, request: &StepRequest, run: &VibeRun) -> Result<Step, ApiError> {
    let phase = VibePhase::from_db_str(&run.phase);
    let pending = run.pending.as_ref().map(|pending| &pending.0);
    let pending_uuid = |field: &str| {
        pending
            .and_then(|pending| pending.get(field))
            .and_then(Value::as_str)
            .and_then(|id| Uuid::parse_str(id).ok())
    };
    let refuse = |why: &str| Err(ApiError::Conflict(format!("{action}: {why}")));
    Ok(Step::Run(match action {
        "start-review" => {
            if phase != Some(VibePhase::Coding) {
                return refuse("the run is not coding");
            }
            let Some(source_session) = pending_uuid("session_id") else {
                return refuse("no reported turn names the coding session");
            };
            VibeStep::StartReview { source_session }
        }
        "send-prompt" => {
            let Some(kind) = request.kind.as_deref().and_then(PromptKind::parse) else {
                return Err(ApiError::BadRequest(
                    "send-prompt needs a kind: continue, plan_review, review_followup, \
                     resolve_conflict, hand_merge_failure or cleanup_fix"
                        .into(),
                ));
            };
            VibeStep::SendPrompt {
                kind,
                session: pending_uuid("session_id"),
                execution: pending_uuid("execution_id"),
                waited_minutes: pending
                    .and_then(|pending| pending.get("waited_minutes"))
                    .and_then(Value::as_u64)
                    .unwrap_or_default(),
            }
        }
        "merge" => {
            // Outside a merge under way, only the review session's own
            // "approve" opens one: the host does not take a rule's word for it.
            let review_approved = pending.is_some_and(|pending| {
                pending.get("kind").and_then(Value::as_str) == Some(EVENT_TURN_ENDED)
                    && pending.get("role").and_then(Value::as_str) == Some("review")
                    && pending.get("result").and_then(Value::as_str) == Some("approve")
            });
            let approved = run.review_session_id.is_some()
                && match phase {
                    Some(VibePhase::Merging) => true,
                    Some(VibePhase::Review) => review_approved,
                    Some(VibePhase::Blocked) => run.last_error.is_some() && review_approved,
                    _ => false,
                };
            if !approved {
                return refuse("the run has no approved review to merge");
            }
            // A merge already under way spends the same budget; a new approval
            // starts it over.
            let retry = if phase == Some(VibePhase::Merging) {
                run.merge_retries as u32
            } else {
                0
            };
            VibeStep::Merge { retry }
        }
        "block" => VibeStep::Block {
            reason: request
                .reason
                .clone()
                .filter(|reason| !reason.trim().is_empty())
                .unwrap_or_else(|| "stopped by automation".to_string()),
        },
        "publish-pr" | "finish" => {
            if phase != Some(VibePhase::Done) {
                return refuse("the run has not merged");
            }
            if action == "publish-pr" {
                return Ok(Step::PublishPr);
            }
            VibeStep::Finish
        }
        "dismiss" => return Ok(Step::Dismiss),
        _ => {
            return Err(ApiError::BadRequest(format!(
                "unknown vibe step '{action}'"
            )));
        }
    }))
}

async fn take_step(
    deployment: &DeploymentImpl,
    workspace_id: Uuid,
    action: &str,
    request: &StepRequest,
    key: Option<&str>,
) -> Result<Value, ApiError> {
    let pool = &deployment.db().pool;
    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Workspace not found".into()))?;
    let run = VibeRun::find_by_workspace_id(pool, workspace_id)
        .await
        .map_err(run_error)?
        .ok_or_else(|| ApiError::Conflict("the workspace has no vibe run".into()))?;
    if run.generation != request.expected_generation
        || run.phase != request.expected_phase
        || run.pending_id() != request.pending_id.as_deref()
    {
        return Err(ApiError::Conflict(format!(
            "the run moved on: generation {}, phase {}, event {}",
            run.generation,
            run.phase,
            run.pending_id().unwrap_or("none")
        )));
    }
    let step = step_for(action, request, &run)?;
    // Steps that start work need the workspace idle and in use.
    if !matches!(action, "block" | "finish" | "dismiss") {
        if workspace.archived {
            return Err(ApiError::Conflict(format!(
                "{action}: the workspace is archived"
            )));
        }
        if ExecutionProcess::has_running_non_dev_server_processes_for_workspace(pool, workspace_id)
            .await?
        {
            return Err(ApiError::Conflict(format!(
                "{action}: a turn is running in the workspace"
            )));
        }
    } else if action == "block"
        && request.pending_id.is_none()
        // A block that answers no event is the worker's stall block, read from
        // a snapshot: a turn started since then is activity, not a stall.
        && ExecutionProcess::has_running_non_dev_server_processes_for_workspace(pool, workspace_id)
            .await?
    {
        return Err(ApiError::Conflict(
            "block: a turn is running in the workspace".into(),
        ));
    }
    if !VibeRun::take_pending(
        pool,
        workspace_id,
        run.generation,
        &run.phase,
        request.pending_id.as_deref(),
    )
    .await
    .map_err(run_error)?
    {
        return Err(ApiError::Conflict("the run moved on".into()));
    }

    if matches!(step, Step::Run(VibeStep::Merge { .. })) && request.pr && run.pr_bases.is_none() {
        // A workspace that targets the PR base itself (`develop`) would merge
        // into it and then have no PR to open: blocked before the merge. The
        // run becomes a PR run, whose Retry checks this again before merging.
        if let Err(reason) =
            vibe_pr_bases::resolve(pool, deployment.git(), &workspace, None, None, false).await
        {
            let reason = format!(
                "Not merged: this run ends in a pull request, so it was stopped before \
                 its merge. {reason}"
            );
            if VibeRun::block_pr_merge(pool, workspace_id, run.generation, &reason)
                .await
                .map_err(run_error)?
            {
                // Told as a block, not as the merge failure an earlier error
                // on the run would make it look like.
                let snapshot = VibeRun {
                    last_error: None,
                    ..run.clone()
                };
                deployment
                    .container()
                    .vibe_step(
                        &workspace,
                        &snapshot,
                        VibeStep::Block {
                            reason: reason.clone(),
                        },
                    )
                    .await?;
            }
            tracing::info!(
                "vibe: workspace {} blocked before its merge: {}",
                workspace_id,
                reason
            );
            return Ok(json!({
                "ok": true,
                "action": "block",
                "workspace_id": workspace_id,
                "reason": reason,
            }));
        }
    }

    let done = match step {
        Step::Dismiss => Ok(()),
        Step::PublishPr => publish_pr(deployment, &workspace, &run).await,
        // A merge can wait behind another one into the same checkout: answer
        // now, and report its outcome as an event.
        Step::Run(VibeStep::Merge { retry }) => {
            let (deployment, workspace, run) = (deployment.clone(), workspace.clone(), run.clone());
            let (action, key) = (action.to_string(), key.map(str::to_string));
            tokio::spawn(async move {
                let pool = &deployment.db().pool;
                if let Err(e) = deployment
                    .container()
                    .vibe_step(&workspace, &run, VibeStep::Merge { retry })
                    .await
                {
                    tracing::error!("vibe: merge of {} failed: {}", workspace.id, e);
                    // The request already answered "taken": its receipt must
                    // not answer the next try with that.
                    if let Some(key) = key {
                        let _ = services::services::automation::forget_action(pool, &key).await;
                    }
                    restore(pool, &run, &action, &e.to_string()).await;
                }
            });
            Ok(())
        }
        Step::Run(step) => deployment
            .container()
            .vibe_step(&workspace, &run, step)
            .await
            .map_err(ApiError::from),
    };
    if let Err(error) = done {
        restore(pool, &run, action, &error.to_string()).await;
        return Err(error);
    }
    tracing::info!(
        "vibe: workspace {} took step {} (generation {}, phase {})",
        workspace_id,
        action,
        run.generation,
        run.phase
    );
    Ok(json!({ "ok": true, "action": action, "workspace_id": workspace_id }))
}

/// A step that failed puts its event back for the worker's next look, with
/// the failure counted: the worker blocks the run once a step keeps failing
/// (a vanished session, an agent that cannot start).
async fn restore(pool: &SqlitePool, run: &VibeRun, action: &str, error: &str) {
    let Some(pending) = &run.pending else {
        return;
    };
    if let Err(e) =
        VibeRun::restore_pending(pool, run.workspace_id, &failed(&pending.0, action, error)).await
    {
        tracing::warn!(
            "vibe: putting back the event of {} failed: {}",
            run.workspace_id,
            e
        );
    }
}

/// `event` after one more failed `action` step on it.
fn failed(event: &Value, action: &str, error: &str) -> Value {
    let mut event = event.clone();
    let attempts = event["failed_attempts"].as_u64().unwrap_or(0) + 1;
    event["failed_attempts"] = attempts.into();
    event["failed_step"] = action.into();
    event["failure"] = error.chars().take(500).collect::<String>().into();
    event
}

/// Push the merge target and open an AI-drafted draft PR, as "Review and
/// create PR" does after its merge. A run that confirmed its PR bases when its
/// review began keeps them; any other takes the repository default target as
/// the base, with the latest merge target as the head. Its outcome is a
/// `vibe.pr_result` event.
async fn publish_pr(
    deployment: &DeploymentImpl,
    workspace: &Workspace,
    run: &VibeRun,
) -> Result<(), ApiError> {
    let pool = &deployment.db().pool;
    let (bases, failure) = if run.pr_bases.is_some() {
        (None, None)
    } else {
        match vibe_pr_bases::resolve(pool, deployment.git(), workspace, None, None, true).await {
            Ok(bases) => (Some(bases), None),
            Err(reason) => (None, Some(reason)),
        }
    };
    if !VibeRun::begin_follow_up(pool, workspace.id, run.generation, bases.as_deref())
        .await
        .map_err(run_error)?
    {
        return Err(ApiError::Conflict("publish-pr: the run moved on".into()));
    }
    let Some(reason) = failure else {
        PR_FOLLOW_UP.notify_one();
        return Ok(());
    };
    // No base to open the PR against: stopped at the push, where a retry
    // with a chosen base resumes.
    let pushing = VibePhase::Pushing.as_str();
    if VibeRun::block_follow_up(pool, workspace.id, pushing, run.generation, &reason)
        .await
        .map_err(run_error)?
    {
        vibe_orchestrator::emit_event(
            pool,
            workspace.id,
            run.generation,
            EVENT_PR_RESULT,
            run.review_session_id,
            None,
            json!({ "outcome": "failed", "failed_phase": pushing, "error": reason }),
        )
        .await
        .map_err(run_error)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(phase: &str) -> VibeRun {
        VibeRun {
            workspace_id: Uuid::nil(),
            task_id: Uuid::nil(),
            phase: phase.to_string(),
            generation: 3,
            review_session_id: Some(Uuid::nil()),
            coding_turns: 0,
            review_turns: 0,
            merge_retries: 2,
            last_result: None,
            last_error: None,
            merge_wait_since: None,
            merge_wait_attempts: 0,
            merge_retry_at: None,
            pr_requested: false,
            pr_executor_config: None,
            pr_bases: None,
            failed_phase: None,
            pending: None,
            last_prompt: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    fn request(kind: Option<&str>) -> StepRequest {
        StepRequest {
            expected_generation: 3,
            expected_phase: String::new(),
            pending_id: None,
            kind: kind.map(str::to_string),
            reason: None,
            pr: false,
        }
    }

    // A worker that predates the flag asks for a plain merge; a newer one
    // says when the run ends in a PR.
    #[test]
    fn a_merge_is_a_pr_merge_only_when_the_worker_says_so() {
        let body = |extra: &str| {
            serde_json::from_str::<StepRequest>(&format!(
                r#"{{"expected_generation":1,"expected_phase":"review"{extra}}}"#
            ))
            .unwrap()
        };
        assert!(!body("").pr);
        assert!(body(r#","pr":true"#).pr);
    }

    fn refused(result: Result<Step, ApiError>) -> bool {
        matches!(result, Err(ApiError::Conflict(_)))
    }

    // A step only fits the run state it is for: a merge needs an approved
    // review, the PR and the finish a landed merge.
    #[test]
    fn a_step_fits_only_the_run_state_it_is_for() {
        let none = request(None);
        let turn = |phase: &str, kind: &str, role: &str, result: &str| VibeRun {
            pending: Some(sqlx::types::Json(
                json!({ "id": "e", "kind": kind, "role": role, "result": result }),
            )),
            ..run(phase)
        };
        // Only the review session's own "approve" opens a merge.
        assert!(matches!(
            step_for(
                "merge",
                &none,
                &turn("review", EVENT_TURN_ENDED, "review", "approve")
            ),
            Ok(Step::Run(VibeStep::Merge { retry: 0 }))
        ));
        assert!(refused(step_for("merge", &none, &run("review"))));
        for (kind, role, result) in [
            (EVENT_TURN_ENDED, "review", "continue"),
            (EVENT_TURN_ENDED, "coding", "approve"),
            ("vibe.cleanup_failed", "review", "approve"),
        ] {
            let run = turn("review", kind, role, result);
            assert!(
                refused(step_for("merge", &none, &run)),
                "{kind} {role} {result}"
            );
        }
        // A merge under way keeps the retries it spent.
        assert!(matches!(
            step_for("merge", &none, &run("merging")),
            Ok(Step::Run(VibeStep::Merge { retry: 2 }))
        ));
        // A blocked run merges again only on a new approval after a failed merge.
        let approved = turn("blocked", EVENT_TURN_ENDED, "review", "approve");
        assert!(refused(step_for("merge", &none, &approved)));
        let failed = VibeRun {
            last_error: Some("repo: merge conflict".into()),
            ..approved
        };
        assert!(matches!(
            step_for("merge", &none, &failed),
            Ok(Step::Run(VibeStep::Merge { retry: 0 }))
        ));
        let unapproved = VibeRun {
            last_error: Some("repo: merge conflict".into()),
            ..run("blocked")
        };
        assert!(refused(step_for("merge", &none, &unapproved)));
        for phase in ["coding", "done", "pushing"] {
            assert!(refused(step_for("merge", &none, &run(phase))), "{phase}");
        }
        assert!(matches!(
            step_for("publish-pr", &none, &run("done")),
            Ok(Step::PublishPr)
        ));
        for action in ["publish-pr", "finish"] {
            assert!(step_for(action, &none, &run("done")).is_ok());
            assert!(refused(step_for(action, &none, &run("merging"))));
        }
        // A review starts from the coding session the reported turn names.
        assert!(refused(step_for("start-review", &none, &run("coding"))));
        let reported = VibeRun {
            pending: Some(sqlx::types::Json(
                json!({ "id": "e", "session_id": Uuid::nil() }),
            )),
            ..run("coding")
        };
        assert!(matches!(
            step_for("start-review", &none, &reported),
            Ok(Step::Run(VibeStep::StartReview { .. }))
        ));
        assert!(refused(step_for("start-review", &none, &run("review"))));
    }

    // The worker blocks a run on a step that keeps failing: each failure is
    // counted on the event it answered, which keeps its id for the next try.
    #[test]
    fn a_failed_step_is_counted_on_its_event() {
        let event = json!({ "id": "e1", "kind": "vibe.turn_ended" });
        let once = failed(&event, "send-prompt", "no executor profile");
        let twice = failed(&once, "send-prompt", &"x".repeat(900));
        assert_eq!(once["id"], "e1");
        assert_eq!(once["failed_attempts"], 1);
        assert_eq!(once["failed_step"], "send-prompt");
        assert_eq!(once["failure"], "no executor profile");
        assert_eq!(twice["failed_attempts"], 2);
        assert_eq!(twice["failure"].as_str().unwrap().len(), 500);
    }

    #[test]
    fn unknown_steps_and_prompts_are_bad_requests() {
        assert!(matches!(
            step_for("send-prompt", &request(Some("approve")), &run("review")),
            Err(ApiError::BadRequest(_))
        ));
        assert!(matches!(
            step_for("send-prompt", &request(None), &run("review")),
            Err(ApiError::BadRequest(_))
        ));
        assert!(matches!(
            step_for("rebase", &request(None), &run("review")),
            Err(ApiError::BadRequest(_))
        ));
        assert!(matches!(
            step_for(
                "send-prompt",
                &request(Some("review_followup")),
                &run("review")
            ),
            Ok(Step::Run(VibeStep::SendPrompt {
                kind: PromptKind::ReviewFollowup,
                ..
            }))
        ));
    }
}
