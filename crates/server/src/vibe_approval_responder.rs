//! Rule 2 of the automated `vibe` workflow: auto-respond to pending approvals
//! for vibe-tagged sessions so the run never blocks on a human.
//!
//! vibe sessions are spawned with `permission_policy = Auto` (tool/plan
//! approvals are bypassed at spawn), so in practice the only approvals that
//! reach here are `AskUserQuestion` prompts. This watcher is the safety net:
//! it approves any tool/plan approval and answers any question with an
//! instruction to proceed with the agent's own recommendation — covering every
//! permission policy.

use std::{collections::HashSet, time::Duration};

use db::models::{execution_process::ExecutionProcess, session::Session, workspace::Workspace};
use deployment::Deployment;
use tokio::time::sleep;
use utils::approvals::{ApprovalOutcome, ApprovalResponse, QuestionAnswer};
use uuid::Uuid;

use crate::DeploymentImpl;

const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Free-text answer fed back to an `AskUserQuestion` prompt — "proceed with
/// your recommendation".
const RECOMMEND_ANSWER: &str = "추천하는 방향으로 진행해줘.";

/// Spawns the responder loop. Returns immediately; runs for the process lifetime.
pub fn spawn(deployment: DeploymentImpl) {
    tokio::spawn(async move {
        // Cache workspaces confirmed vibe to avoid a remote round-trip on every
        // poll. Only positives are cached (see `tick`); a negative stays
        // re-checkable so a late tag / transient failure can't disable us.
        let mut vibe_workspaces: HashSet<Uuid> = HashSet::new();
        loop {
            sleep(POLL_INTERVAL).await;
            if let Err(e) = tick(&deployment, &mut vibe_workspaces).await {
                tracing::warn!("vibe_approval_responder tick failed: {}", e);
            }
        }
    });
}

async fn tick(
    deployment: &DeploymentImpl,
    vibe_workspaces: &mut HashSet<Uuid>,
) -> anyhow::Result<()> {
    let pending = deployment.approvals().pending_infos();
    if pending.is_empty() {
        return Ok(());
    }

    let pool = &deployment.db().pool;
    let client = match deployment.remote_client() {
        Ok(c) => c,
        Err(_) => return Ok(()),
    };

    for info in pending {
        let Some(ep) = ExecutionProcess::find_by_id(pool, info.execution_process_id).await? else {
            continue;
        };
        let Some(session) = Session::find_by_id(pool, ep.session_id).await? else {
            continue;
        };
        let Some(workspace) = Workspace::find_by_id(pool, session.workspace_id).await? else {
            continue;
        };
        if workspace.task_id.is_none() {
            continue;
        }

        // Only positive results are cached: a transient `auto_merge_check`
        // failure (or an approval that races ahead of the vibe tag) must NOT
        // permanently disable the responder for this workspace, so a negative
        // result is re-checked on the next poll instead of being remembered.
        let is_vibe = if vibe_workspaces.contains(&workspace.id) {
            true
        } else if matches!(client.auto_merge_check(workspace.id).await, Ok(true)) {
            vibe_workspaces.insert(workspace.id);
            true
        } else {
            false
        };
        if !is_vibe {
            continue;
        }

        let response = auto_outcome(info.execution_process_id, info.is_question);
        match deployment
            .approvals()
            .respond(&info.approval_id, response)
            .await
        {
            Ok(_) => tracing::info!(
                "vibe: auto-responded approval {} (question={})",
                info.approval_id,
                info.is_question
            ),
            Err(e) => tracing::debug!(
                "vibe: approval {} no longer respondable: {}",
                info.approval_id,
                e
            ),
        }
    }

    Ok(())
}

/// Build the auto-response: approve a tool/plan request, or answer a question
/// with the "proceed with your recommendation" instruction. Pure.
fn auto_outcome(execution_process_id: Uuid, is_question: bool) -> ApprovalResponse {
    let status = if is_question {
        ApprovalOutcome::Answered {
            answers: vec![QuestionAnswer {
                question: String::new(),
                answer: vec![RECOMMEND_ANSWER.to_string()],
            }],
        }
    } else {
        ApprovalOutcome::Approved
    };
    ApprovalResponse {
        execution_process_id,
        status,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_approval_is_approved() {
        let id = Uuid::new_v4();
        let r = auto_outcome(id, false);
        assert_eq!(r.execution_process_id, id);
        assert!(matches!(r.status, ApprovalOutcome::Approved));
    }

    #[test]
    fn question_is_answered_with_recommendation() {
        let id = Uuid::new_v4();
        let r = auto_outcome(id, true);
        match r.status {
            ApprovalOutcome::Answered { answers } => {
                assert_eq!(answers.len(), 1);
                assert_eq!(answers[0].answer, vec![RECOMMEND_ANSWER.to_string()]);
            }
            other => panic!("expected Answered, got {other:?}"),
        }
    }
}
