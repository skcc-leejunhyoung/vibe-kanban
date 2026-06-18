use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use tokio_util::sync::CancellationToken;
use workspace_utils::approvals::{ApprovalStatus, QuestionStatus};

use super::types::PermissionMode;
use crate::{
    approvals::{ExecutorApprovalError, ExecutorApprovalService},
    env::RepoContext,
    executors::{
        ExecutorError,
        claude::{
            ClaudeJson,
            types::{
                PermissionResult, PermissionUpdate, PermissionUpdateDestination,
                PermissionUpdateType,
            },
        },
        codex::client::LogWriter,
    },
};

const EXIT_PLAN_MODE_NAME: &str = "ExitPlanMode";
const ASK_USER_QUESTION_NAME: &str = "AskUserQuestion";
pub const AUTO_APPROVE_CALLBACK_ID: &str = "AUTO_APPROVE_CALLBACK_ID";
pub const STOP_GIT_CHECK_CALLBACK_ID: &str = "STOP_GIT_CHECK_CALLBACK_ID";
// Prefix for denial messages from the user, mirrors claude code CLI behavior
const TOOL_DENY_PREFIX: &str = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said: ";

/// Returns `(id, command-or-description)` for every background task that the
/// Stop hook input reports as still running.
fn running_background_tasks(input: &serde_json::Value) -> Vec<(String, String)> {
    input
        .get("background_tasks")
        .and_then(|v| v.as_array())
        .map(|tasks| {
            tasks
                .iter()
                .filter(|t| t.get("status").and_then(|s| s.as_str()) == Some("running"))
                .map(|t| {
                    let id = t
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("?")
                        .to_string();
                    let what = t
                        .get("command")
                        .and_then(|v| v.as_str())
                        .or_else(|| t.get("description").and_then(|v| v.as_str()))
                        .unwrap_or("")
                        .to_string();
                    (id, what)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Builds the Stop-hook `block` payload that tells the agent to wait for its
/// running background tasks before ending the turn (keeps the same session
/// alive so background work finishes without a follow-up spawn).
fn background_wait_block(running: &[(String, String)]) -> serde_json::Value {
    let list = running
        .iter()
        .map(|(id, what)| format!("  - {id}: {what}"))
        .collect::<Vec<_>>()
        .join("\n");
    serde_json::json!({
        "decision": "block",
        "reason": format!(
            "A background task you started is still running. Do not end the turn \
             yet — wait for it to finish (use TaskOutput with block=true, or Read \
             its output file), then act on the result and finish the task.\n\
             Running background tasks:\n{list}"
        ),
    })
}

/// Claude Agent client with control protocol support
pub struct ClaudeAgentClient {
    log_writer: LogWriter,
    approvals: Option<Arc<dyn ExecutorApprovalService>>,
    auto_approve: bool, // true when approvals is None
    repo_context: RepoContext,
    commit_reminder: bool,
    commit_reminder_prompt: String,
    cancel: CancellationToken,
    /// Number of consecutive Stop-hook blocks we have issued to wait on
    /// background tasks. Reset to 0 once no background task is running. Acts as
    /// a safety valve against an infinite stop/resume loop if the agent keeps
    /// trying to end the turn without waiting for its background work.
    background_block_count: AtomicUsize,
}

impl ClaudeAgentClient {
    /// Create a new client with optional approval service
    pub fn new(
        log_writer: LogWriter,
        approvals: Option<Arc<dyn ExecutorApprovalService>>,
        repo_context: RepoContext,
        commit_reminder: bool,
        commit_reminder_prompt: String,
        cancel: CancellationToken,
    ) -> Arc<Self> {
        let auto_approve = approvals.is_none();
        Arc::new(Self {
            log_writer,
            approvals,
            auto_approve,
            repo_context,
            commit_reminder,
            commit_reminder_prompt,
            cancel,
            background_block_count: AtomicUsize::new(0),
        })
    }

    async fn handle_approval(
        &self,
        tool_use_id: String,
        tool_name: String,
        tool_input: serde_json::Value,
    ) -> Result<PermissionResult, ExecutorError> {
        let approval_service = self
            .approvals
            .as_ref()
            .ok_or(ExecutorApprovalError::ServiceUnavailable)?;

        let approval_id = match approval_service.create_tool_approval(&tool_name).await {
            Ok(id) => id,
            Err(err) => {
                self.handle_approval_error(&tool_name, &tool_use_id, &err)
                    .await?;
                return Err(err.into());
            }
        };

        let _ = self
            .log_writer
            .log_raw(&serde_json::to_string(&ClaudeJson::ApprovalRequested {
                tool_call_id: tool_use_id.clone(),
                tool_name: tool_name.clone(),
                approval_id: approval_id.clone(),
            })?)
            .await;

        let status = match approval_service
            .wait_tool_approval(&approval_id, self.cancel.clone())
            .await
        {
            Ok(s) => s,
            Err(err) => {
                self.handle_approval_error(&tool_name, &tool_use_id, &err)
                    .await?;
                return Err(err.into());
            }
        };

        self.log_writer
            .log_raw(&serde_json::to_string(&ClaudeJson::ApprovalResponse {
                tool_call_id: tool_use_id.clone(),
                tool_name: tool_name.clone(),
                approval_status: status.clone(),
            })?)
            .await?;

        match status {
            ApprovalStatus::Approved => {
                if tool_name == EXIT_PLAN_MODE_NAME {
                    Ok(PermissionResult::Allow {
                        updated_input: tool_input,
                        updated_permissions: Some(vec![PermissionUpdate {
                            update_type: PermissionUpdateType::SetMode,
                            mode: Some(PermissionMode::BypassPermissions),
                            destination: Some(PermissionUpdateDestination::Session),
                            rules: None,
                            behavior: None,
                            directories: None,
                        }]),
                    })
                } else {
                    Ok(PermissionResult::Allow {
                        updated_input: tool_input,
                        updated_permissions: None,
                    })
                }
            }
            ApprovalStatus::Denied { reason } => Ok(PermissionResult::Deny {
                message: format!("{}{}", TOOL_DENY_PREFIX, reason.unwrap_or_default()),
                interrupt: Some(false),
            }),
            ApprovalStatus::TimedOut => Ok(PermissionResult::Deny {
                message: "Approval request timed out".to_string(),
                interrupt: Some(true),
            }),
            ApprovalStatus::Pending => Ok(PermissionResult::Deny {
                message: "Approval still pending (unexpected)".to_string(),
                interrupt: Some(false),
            }),
        }
    }

    async fn handle_question(
        &self,
        tool_use_id: String,
        tool_name: String,
        tool_input: serde_json::Value,
    ) -> Result<PermissionResult, ExecutorError> {
        let approval_service = self
            .approvals
            .as_ref()
            .ok_or(ExecutorApprovalError::ServiceUnavailable)?;

        let question_count = tool_input
            .get("questions")
            .and_then(|q| q.as_array())
            .map(|a| a.len())
            .unwrap_or(1);

        let approval_id = match approval_service
            .create_question_approval(&tool_name, question_count)
            .await
        {
            Ok(id) => id,
            Err(err) => {
                self.handle_question_error(&tool_use_id, &tool_name, &err)
                    .await?;
                return Err(err.into());
            }
        };

        let _ = self
            .log_writer
            .log_raw(&serde_json::to_string(&ClaudeJson::ApprovalRequested {
                tool_call_id: tool_use_id.clone(),
                tool_name: tool_name.clone(),
                approval_id: approval_id.clone(),
            })?)
            .await;

        let status = match approval_service
            .wait_question_answer(&approval_id, self.cancel.clone())
            .await
        {
            Ok(s) => s,
            Err(err) => {
                self.handle_question_error(&tool_use_id, &tool_name, &err)
                    .await?;
                return Err(err.into());
            }
        };

        self.log_writer
            .log_raw(&serde_json::to_string(&ClaudeJson::QuestionResponse {
                tool_call_id: tool_use_id.clone(),
                tool_name: tool_name.clone(),
                question_status: status.clone(),
            })?)
            .await?;

        match status {
            QuestionStatus::Answered { answers } => {
                let answers_map: serde_json::Map<String, serde_json::Value> = answers
                    .iter()
                    .map(|qa| {
                        (
                            qa.question.clone(),
                            serde_json::Value::String(qa.answer.join(", ")),
                        )
                    })
                    .collect();
                let mut updated = tool_input.clone();
                if let Some(obj) = updated.as_object_mut() {
                    obj.insert(
                        "answers".to_string(),
                        serde_json::Value::Object(answers_map),
                    );
                }
                Ok(PermissionResult::Allow {
                    updated_input: updated,
                    updated_permissions: None,
                })
            }
            QuestionStatus::TimedOut => Ok(PermissionResult::Deny {
                message: "Question request timed out".to_string(),
                interrupt: Some(true),
            }),
        }
    }

    async fn handle_approval_error(
        &self,
        tool_name: &str,
        tool_use_id: &str,
        err: &ExecutorApprovalError,
    ) -> Result<(), ExecutorError> {
        if !matches!(err, ExecutorApprovalError::Cancelled) {
            tracing::error!(
                "Claude approval failed for tool={} call_id={}: {err}",
                tool_name,
                tool_use_id
            );
        }
        let _ = self
            .log_writer
            .log_raw(&serde_json::to_string(&ClaudeJson::ApprovalResponse {
                tool_call_id: tool_use_id.to_string(),
                tool_name: tool_name.to_string(),
                approval_status: ApprovalStatus::Denied {
                    reason: Some(format!("Approval service error: {err}")),
                },
            })?)
            .await;
        Ok(())
    }

    async fn handle_question_error(
        &self,
        tool_use_id: &str,
        tool_name: &str,
        err: &ExecutorApprovalError,
    ) -> Result<(), ExecutorError> {
        if !matches!(err, ExecutorApprovalError::Cancelled) {
            tracing::error!("Claude question failed {err}",);
        }
        let _ = self
            .log_writer
            .log_raw(&serde_json::to_string(&ClaudeJson::QuestionResponse {
                tool_call_id: tool_use_id.to_string(),
                tool_name: tool_name.to_string(),
                question_status: QuestionStatus::TimedOut,
            })?)
            .await;
        Ok(())
    }

    pub async fn on_can_use_tool(
        &self,
        tool_name: String,
        input: serde_json::Value,
        _permission_suggestions: Option<Vec<PermissionUpdate>>,
        tool_use_id: Option<String>,
    ) -> Result<PermissionResult, ExecutorError> {
        if tool_name == ASK_USER_QUESTION_NAME {
            if let Some(latest_tool_use_id) = tool_use_id {
                return self
                    .handle_question(latest_tool_use_id, tool_name, input)
                    .await;
            } else {
                tracing::warn!("AskUserQuestion without tool_use_id, cannot route to approval");
                return Ok(PermissionResult::Deny {
                    message:
                        "AskUserQuestion requires user interaction but no tool_use_id was provided"
                            .to_string(),
                    interrupt: Some(false),
                });
            }
        }
        if self.auto_approve {
            Ok(PermissionResult::Allow {
                updated_input: input,
                updated_permissions: None,
            })
        } else if let Some(latest_tool_use_id) = tool_use_id {
            self.handle_approval(latest_tool_use_id, tool_name, input)
                .await
        } else {
            // Auto approve tools with no matching tool_use_id
            // tool_use_id is undocumented so this may not be possible
            tracing::warn!(
                "No tool_use_id available for tool '{}', cannot request approval",
                tool_name
            );
            Ok(PermissionResult::Allow {
                updated_input: input,
                updated_permissions: None,
            })
        }
    }

    pub async fn on_hook_callback(
        &self,
        callback_id: String,
        input: serde_json::Value,
        _tool_use_id: Option<String>,
    ) -> Result<serde_json::Value, ExecutorError> {
        // Stop hook: drives background-task auto-resume and the optional commit
        // reminder. Returns a `decision` (approve/block) and an optional `reason`.
        if callback_id == STOP_GIT_CHECK_CALLBACK_ID {
            // 1. Background-task auto-resume. If the agent kicked off
            //    `run_in_background` task(s) and then tried to stop, block the
            //    stop so the SAME process keeps going until they finish. Without
            //    this the turn would end, killing the process (and its background
            //    tasks) before the work completed. `background_tasks` is supplied
            //    by the CLI in the Stop hook input and empties once tasks finish.
            const MAX_BACKGROUND_BLOCKS: usize = 20;
            let running = running_background_tasks(&input);
            if running.is_empty() {
                self.background_block_count.store(0, Ordering::SeqCst);
            } else {
                let blocks = self.background_block_count.fetch_add(1, Ordering::SeqCst);
                if blocks < MAX_BACKGROUND_BLOCKS {
                    return Ok(background_wait_block(&running));
                }
                // Safety valve: the agent kept stopping without waiting. Allow
                // the turn to end rather than loop forever.
                tracing::warn!(
                    "Stop hook: {} background task(s) still running after {} resume blocks; \
                     allowing the turn to end",
                    running.len(),
                    blocks
                );
            }

            // 2. Optional uncommitted-changes commit reminder.
            if self.commit_reminder {
                if input
                    .get("stop_hook_active")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                {
                    return Ok(serde_json::json!({"decision": "approve"}));
                }
                let status = self.repo_context.check_uncommitted_changes().await;
                if !status.is_empty() {
                    return Ok(serde_json::json!({
                        "decision": "block",
                        "reason": format!("{}\n{}", self.commit_reminder_prompt, status)
                    }));
                }
            }

            return Ok(serde_json::json!({"decision": "approve"}));
        }

        if self.auto_approve {
            Ok(serde_json::json!({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                    "permissionDecisionReason": "Auto-approved by SDK"
                }
            }))
        } else {
            match callback_id.as_str() {
                AUTO_APPROVE_CALLBACK_ID => Ok(serde_json::json!({
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": "allow",
                        "permissionDecisionReason": "Approved by SDK"
                    }
                })),
                _ => {
                    // Hook callbacks is only used to forward approval requests to can_use_tool.
                    // This works because `ask` decision in hook callback triggers a can_use_tool request
                    // https://docs.claude.com/en/api/agent-sdk/permissions#permission-flow-diagram
                    Ok(serde_json::json!({
                        "hookSpecificOutput": {
                            "hookEventName": "PreToolUse",
                            "permissionDecision": "ask",
                            "permissionDecisionReason": "Forwarding to canusetool service"
                        }
                    }))
                }
            }
        }
    }

    pub async fn log_message(&self, line: &str) -> Result<(), ExecutorError> {
        self.log_writer.log_raw(line).await
    }
}

#[cfg(test)]
mod tests {
    use super::{background_wait_block, running_background_tasks};

    // Shapes below mirror the real Stop-hook `input.background_tasks` observed
    // from `claude -p` (control protocol): each running task carries
    // id/type/status/description/command, and the array empties once finished.

    #[test]
    fn no_background_tasks_field_yields_empty() {
        let input = serde_json::json!({ "stop_hook_active": false });
        assert!(running_background_tasks(&input).is_empty());
    }

    #[test]
    fn empty_background_tasks_yields_empty() {
        let input = serde_json::json!({ "background_tasks": [] });
        assert!(running_background_tasks(&input).is_empty());
    }

    #[test]
    fn running_task_is_extracted_with_command() {
        let input = serde_json::json!({
            "background_tasks": [{
                "id": "bxwcb4god",
                "type": "shell",
                "status": "running",
                "description": "Run sleep then echo marker in background",
                "command": "sleep 6 && echo BG_FINISHED_MARKER"
            }]
        });
        let running = running_background_tasks(&input);
        assert_eq!(running.len(), 1);
        assert_eq!(running[0].0, "bxwcb4god");
        assert_eq!(running[0].1, "sleep 6 && echo BG_FINISHED_MARKER");
    }

    #[test]
    fn non_running_tasks_are_ignored() {
        let input = serde_json::json!({
            "background_tasks": [
                { "id": "a", "status": "completed", "command": "done" },
                { "id": "b", "status": "running", "command": "still going" }
            ]
        });
        let running = running_background_tasks(&input);
        assert_eq!(running.len(), 1);
        assert_eq!(running[0].0, "b");
    }

    #[test]
    fn falls_back_to_description_when_command_absent() {
        let input = serde_json::json!({
            "background_tasks": [{
                "id": "x", "status": "running", "description": "long agent task"
            }]
        });
        let running = running_background_tasks(&input);
        assert_eq!(running[0].1, "long agent task");
    }

    #[test]
    fn background_wait_block_blocks_and_lists_tasks() {
        let running = vec![("bxwcb4god".to_string(), "sleep 6".to_string())];
        let v = background_wait_block(&running);
        assert_eq!(v["decision"], "block");
        let reason = v["reason"].as_str().unwrap();
        assert!(reason.contains("bxwcb4god"));
        assert!(reason.contains("sleep 6"));
        assert!(reason.contains("still running"));
    }
}
