use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use agent_client_protocol::{self as acp};
use async_trait::async_trait;
use tokio::sync::{Mutex, mpsc};
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};
use workspace_utils::approvals::{ApprovalStatus, QuestionStatus};

use crate::{
    approvals::{ExecutorApprovalError, ExecutorApprovalService},
    executors::acp::{AcpEvent, ApprovalResponse},
    logs::{AskUserQuestionItem, AskUserQuestionOption, TokenUsageInfo},
};

/// ACP's `usage_update` carries the tokens now in context and the window
/// size. Without a window the usage cannot be shown, so it is reported as
/// unknown rather than kept from an earlier model.
pub(super) fn context_usage(usage: &acp::UsageUpdate) -> AcpEvent {
    let size = u32::try_from(usage.size).unwrap_or(u32::MAX);
    let used = if size == 0 {
        0
    } else {
        u32::try_from(usage.used).unwrap_or(u32::MAX)
    };
    AcpEvent::TokenUsage(TokenUsageInfo {
        total_tokens: used,
        model_context_window: size,
    })
}

/// ACP client that handles agent-client protocol communication
#[derive(Clone)]
pub struct AcpClient {
    event_tx: mpsc::UnboundedSender<AcpEvent>,
    approvals: Option<Arc<dyn ExecutorApprovalService>>,
    feedback_queue: Arc<Mutex<Vec<String>>>,
    cancel: CancellationToken,
    replaying: Arc<AtomicBool>,
    /// The last usage reported while a session was being loaded or its model
    /// selected, before the turn began. It is the turn's starting gauge.
    setup_usage: Arc<std::sync::Mutex<Option<TokenUsageInfo>>>,
    /// Approve tool permissions without asking while user questions still
    /// reach the approval service (Auto under an agent that asks both ways).
    auto_approve_tools: bool,
}

impl AcpClient {
    /// Create a new ACP client
    pub fn new(
        event_tx: mpsc::UnboundedSender<AcpEvent>,
        approvals: Option<Arc<dyn ExecutorApprovalService>>,
        cancel: CancellationToken,
    ) -> Self {
        Self {
            event_tx,
            approvals,
            feedback_queue: Arc::new(Mutex::new(Vec::new())),
            cancel,
            replaying: Arc::new(AtomicBool::new(false)),
            setup_usage: Arc::default(),
            auto_approve_tools: false,
        }
    }

    pub fn auto_approving_tools(mut self, auto_approve: bool) -> Self {
        self.auto_approve_tools = auto_approve;
        self
    }

    pub fn record_user_prompt_event(&self, prompt: &str) {
        self.send_event(AcpEvent::User(prompt.to_string()));
    }

    pub(super) fn set_replaying(&self, replaying: bool) {
        self.replaying.store(replaying, Ordering::Relaxed);
    }

    pub(super) fn start_turn(&self, session_id: &acp::SessionId, prompt: &str) {
        self.send_event(AcpEvent::SessionStart(session_id.0.to_string()));
        self.record_user_prompt_event(prompt);
        self.set_replaying(false);
        // Start from what the agent reported for this session and model, or
        // from unknown, never from the previous turn's (possibly other) model.
        let starting = self
            .setup_usage
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
            .unwrap_or(TokenUsageInfo {
                total_tokens: 0,
                model_context_window: 0,
            });
        self.send_event(AcpEvent::TokenUsage(starting));
    }

    /// Reports an event of Vibe Kanban's own into the turn's log.
    pub(super) fn report(&self, event: AcpEvent) {
        self.send_event(event);
    }

    pub(super) fn finish_turn(&self, reason: &acp::StopReason) {
        self.send_event(AcpEvent::Done(
            serde_json::to_string(reason).unwrap_or_default(),
        ));
    }

    /// Send an event to the event channel
    fn send_event(&self, event: AcpEvent) {
        if let Err(e) = self.event_tx.send(event) {
            warn!("Failed to send ACP event: {}", e);
        }
    }

    /// Queue a user feedback message to be sent after a denial.
    pub async fn enqueue_feedback(&self, message: String) {
        let trimmed = message.trim().to_string();
        if !trimmed.is_empty() {
            let mut q = self.feedback_queue.lock().await;
            q.push(trimmed);
        }
    }

    /// Drain and return queued feedback messages.
    pub async fn drain_feedback(&self) -> Vec<String> {
        let mut q = self.feedback_queue.lock().await;
        q.drain(..).collect()
    }
}

#[async_trait(?Send)]
impl acp::Client for AcpClient {
    async fn request_permission(
        &self,
        args: acp::RequestPermissionRequest,
    ) -> Result<acp::RequestPermissionResponse, acp::Error> {
        // pi-acp encodes extension selections as permission options of the same kind.
        if args.tool_call.tool_call_id.0.starts_with("pi-ui-")
            && args
                .tool_call
                .fields
                .raw_input
                .as_ref()
                .and_then(|raw| raw["method"].as_str())
                == Some("select")
        {
            return self.request_pi_selection(args).await;
        }
        self.send_event(AcpEvent::RequestPermission(args.clone()));

        if self.approvals.is_none() || self.auto_approve_tools {
            // Auto-approve with best available option when no approval service is configured
            let chosen_option = args
                .options
                .iter()
                .find(|o| matches!(o.kind, acp::PermissionOptionKind::AllowAlways))
                .or_else(|| {
                    args.options
                        .iter()
                        .find(|o| matches!(o.kind, acp::PermissionOptionKind::AllowOnce))
                })
                .or_else(|| args.options.first());

            let outcome = if let Some(opt) = chosen_option {
                debug!("Auto-approving permission with option: {}", opt.option_id);
                acp::RequestPermissionOutcome::Selected(acp::SelectedPermissionOutcome::new(
                    opt.option_id.clone(),
                ))
            } else {
                warn!("No permission options available, cancelling");
                acp::RequestPermissionOutcome::Cancelled
            };

            return Ok(acp::RequestPermissionResponse::new(outcome));
        }

        let tool_call_id = args.tool_call.tool_call_id.0.to_string();
        let tool_name = args.tool_call.fields.title.as_deref().unwrap_or("tool");
        let approval_service = self
            .approvals
            .as_ref()
            .ok_or(ExecutorApprovalError::ServiceUnavailable)
            .map_err(|_| acp::Error::invalid_request())?;

        let approval_id = match approval_service.create_tool_approval(tool_name).await {
            Ok(id) => id,
            Err(err) => return self.handle_approval_error(err, &tool_call_id),
        };

        self.send_event(AcpEvent::ApprovalRequested {
            tool_call_id: tool_call_id.clone(),
            approval_id: approval_id.clone(),
        });

        let status = match approval_service
            .wait_tool_approval(&approval_id, self.cancel.clone())
            .await
        {
            Ok(s) => s,
            Err(err) => return self.handle_approval_error(err, &tool_call_id),
        };

        // Map our ApprovalStatus to ACP outcome
        let outcome = match &status {
            ApprovalStatus::Approved => {
                let chosen = args
                    .options
                    .iter()
                    .find(|o| matches!(o.kind, acp::PermissionOptionKind::AllowOnce));
                if let Some(opt) = chosen {
                    acp::RequestPermissionOutcome::Selected(acp::SelectedPermissionOutcome::new(
                        opt.option_id.clone(),
                    ))
                } else {
                    tracing::error!("No suitable approval option found, cancelling");
                    return Err(acp::Error::invalid_request());
                }
            }
            ApprovalStatus::Denied { reason } => {
                // If user provided a reason, queue it to send after denial
                if let Some(feedback) = reason.as_ref() {
                    self.enqueue_feedback(feedback.clone()).await;
                }
                let chosen = args
                    .options
                    .iter()
                    .find(|o| matches!(o.kind, acp::PermissionOptionKind::RejectOnce));
                if let Some(opt) = chosen {
                    acp::RequestPermissionOutcome::Selected(acp::SelectedPermissionOutcome::new(
                        opt.option_id.clone(),
                    ))
                } else {
                    warn!("No permission options for denial, cancelling");
                    acp::RequestPermissionOutcome::Cancelled
                }
            }
            ApprovalStatus::TimedOut => {
                warn!("Approval timed out");
                acp::RequestPermissionOutcome::Cancelled
            }
            ApprovalStatus::Pending => {
                // This should not occur after waiter resolves
                warn!("Approval resolved to Pending");
                acp::RequestPermissionOutcome::Cancelled
            }
        };

        self.send_event(AcpEvent::ApprovalResponse(ApprovalResponse {
            tool_call_id: tool_call_id.clone(),
            status: status.clone(),
        }));

        Ok(acp::RequestPermissionResponse::new(outcome))
    }

    async fn session_notification(&self, args: acp::SessionNotification) -> Result<(), acp::Error> {
        if self.replaying.load(Ordering::Relaxed) {
            if let acp::SessionUpdate::UsageUpdate(usage) = &args.update
                && let AcpEvent::TokenUsage(info) = context_usage(usage)
            {
                *self
                    .setup_usage
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(info);
            }
            return Ok(());
        }
        // Convert to typed events
        let event = match args.update {
            acp::SessionUpdate::AgentMessageChunk(chunk) => Some(AcpEvent::Message(chunk.content)),
            acp::SessionUpdate::AgentThoughtChunk(chunk) => Some(AcpEvent::Thought(chunk.content)),
            acp::SessionUpdate::ToolCall(tc) => Some(AcpEvent::ToolCall(tc)),
            acp::SessionUpdate::ToolCallUpdate(update) => Some(AcpEvent::ToolUpdate(update)),
            acp::SessionUpdate::Plan(plan) => Some(AcpEvent::Plan(plan)),
            acp::SessionUpdate::UsageUpdate(usage) => Some(context_usage(&usage)),
            _ => Some(AcpEvent::Other(args)),
        };

        if let Some(event) = event {
            self.send_event(event);
        }

        Ok(())
    }

    // File system operations - not implemented as we don't expose FS
    async fn write_text_file(
        &self,
        _args: acp::WriteTextFileRequest,
    ) -> Result<acp::WriteTextFileResponse, acp::Error> {
        Err(acp::Error::method_not_found())
    }

    async fn read_text_file(
        &self,
        _args: acp::ReadTextFileRequest,
    ) -> Result<acp::ReadTextFileResponse, acp::Error> {
        Err(acp::Error::method_not_found())
    }

    // Terminal operations - not implemented
    async fn create_terminal(
        &self,
        _args: acp::CreateTerminalRequest,
    ) -> Result<acp::CreateTerminalResponse, acp::Error> {
        Err(acp::Error::method_not_found())
    }

    async fn terminal_output(
        &self,
        _args: acp::TerminalOutputRequest,
    ) -> Result<acp::TerminalOutputResponse, acp::Error> {
        Err(acp::Error::method_not_found())
    }

    async fn release_terminal(
        &self,
        _args: acp::ReleaseTerminalRequest,
    ) -> Result<acp::ReleaseTerminalResponse, acp::Error> {
        Err(acp::Error::method_not_found())
    }

    async fn wait_for_terminal_exit(
        &self,
        _args: acp::WaitForTerminalExitRequest,
    ) -> Result<acp::WaitForTerminalExitResponse, acp::Error> {
        Err(acp::Error::method_not_found())
    }

    async fn kill_terminal_command(
        &self,
        _args: acp::KillTerminalCommandRequest,
    ) -> Result<acp::KillTerminalCommandResponse, acp::Error> {
        Err(acp::Error::method_not_found())
    }

    // Extension methods
    async fn ext_method(&self, _args: acp::ExtRequest) -> Result<acp::ExtResponse, acp::Error> {
        Err(acp::Error::method_not_found())
    }

    async fn ext_notification(&self, _args: acp::ExtNotification) -> Result<(), acp::Error> {
        Ok(())
    }
}

impl AcpClient {
    async fn request_pi_selection(
        &self,
        args: acp::RequestPermissionRequest,
    ) -> Result<acp::RequestPermissionResponse, acp::Error> {
        let cancelled = acp::RequestPermissionOutcome::Cancelled;
        let Some(approvals) = &self.approvals else {
            return Ok(acp::RequestPermissionResponse::new(cancelled));
        };
        if args.options.is_empty() {
            return Ok(acp::RequestPermissionResponse::new(cancelled));
        }
        let id = args.tool_call.tool_call_id;
        let title = args
            .tool_call
            .fields
            .title
            .unwrap_or_else(|| "Pi choice".into());
        let mut options = Vec::<AskUserQuestionOption>::new();
        for option in &args.options {
            if !options.iter().any(|item| item.label == option.name) {
                options.push(AskUserQuestionOption {
                    label: option.name.clone(),
                    description: String::new(),
                });
            }
        }
        let question = AskUserQuestionItem {
            question: title.clone(),
            header: "Pi".into(),
            options,
            multi_select: false,
            allow_custom_answer: Some(false),
        };
        let approval_id = approvals
            .create_question_approval(&title, 1)
            .await
            .map_err(|_| acp::Error::internal_error())?;
        self.send_event(AcpEvent::ToolCall(
            acp::ToolCall::new(id.clone(), title.clone())
                .raw_input(serde_json::json!({"piSelection": question})),
        ));
        self.send_event(AcpEvent::ApprovalRequested {
            tool_call_id: id.0.to_string(),
            approval_id: approval_id.clone(),
        });
        let answer = approvals
            .wait_question_answer(&approval_id, self.cancel.clone())
            .await;
        let selected = match &answer {
            Ok(QuestionStatus::Answered { answers }) => match answers.as_slice() {
                [answer] if answer.question == title => match answer.answer.as_slice() {
                    [label] => args.options.iter().find(|option| option.name == *label),
                    _ => None,
                },
                _ => None,
            },
            _ => None,
        };
        self.send_event(AcpEvent::ToolUpdate(acp::ToolCallUpdate::new(
            id,
            acp::ToolCallUpdateFields::new().status(if selected.is_some() {
                acp::ToolCallStatus::Completed
            } else {
                acp::ToolCallStatus::Failed
            }),
        )));
        let outcome = selected.map_or(cancelled, |option| {
            acp::RequestPermissionOutcome::Selected(acp::SelectedPermissionOutcome::new(
                option.option_id.clone(),
            ))
        });
        Ok(acp::RequestPermissionResponse::new(outcome))
    }

    fn handle_approval_error(
        &self,
        err: ExecutorApprovalError,
        tool_call_id: &str,
    ) -> Result<acp::RequestPermissionResponse, acp::Error> {
        if let ExecutorApprovalError::Cancelled = err {
            debug!("ACP approval cancelled for tool_call_id={}", tool_call_id);
            Ok(acp::RequestPermissionResponse::new(
                acp::RequestPermissionOutcome::Cancelled,
            ))
        } else {
            tracing::error!(
                "ACP approval wait failed for tool_call_id={}: {err}",
                tool_call_id
            );
            self.send_event(AcpEvent::ApprovalResponse(ApprovalResponse {
                tool_call_id: tool_call_id.to_string(),
                status: ApprovalStatus::TimedOut,
            }));
            Err(acp::Error::internal_error())
        }
    }
}

#[cfg(test)]
mod tests {
    use acp::Client as _;
    use workspace_utils::approvals::QuestionAnswer;

    use super::*;

    struct SelectSecond;

    #[async_trait]
    impl ExecutorApprovalService for SelectSecond {
        async fn create_tool_approval(&self, _: &str) -> Result<String, ExecutorApprovalError> {
            panic!("a choice must not create a binary approval");
        }

        async fn create_question_approval(
            &self,
            title: &str,
            count: usize,
        ) -> Result<String, ExecutorApprovalError> {
            assert_eq!((title, count), ("Choose a label", 1));
            Ok("fixture".into())
        }

        async fn wait_tool_approval(
            &self,
            _: &str,
            _: CancellationToken,
        ) -> Result<ApprovalStatus, ExecutorApprovalError> {
            panic!("a choice must wait for a question answer");
        }

        async fn wait_question_answer(
            &self,
            approval_id: &str,
            _: CancellationToken,
        ) -> Result<QuestionStatus, ExecutorApprovalError> {
            assert_eq!(approval_id, "fixture");
            Ok(QuestionStatus::Answered {
                answers: vec![QuestionAnswer {
                    question: "Choose a label".into(),
                    answer: vec!["Second".into()],
                }],
            })
        }
    }

    #[tokio::test]
    async fn pi_choice_preserves_selected_option_and_cancels_without_user() {
        let args: acp::RequestPermissionRequest = serde_json::from_value(serde_json::json!({
            "sessionId": "fixture_session",
            "toolCall": {
                "toolCallId": "pi-ui-fixture",
                "title": "Choose a label",
                "rawInput": {"method": "select"}
            },
            "options": [
                {"optionId": "choice-0", "name": "First", "kind": "allow_once"},
                {"optionId": "choice-1", "name": "Second", "kind": "allow_once"}
            ]
        }))
        .unwrap();
        let (tx, mut events) = mpsc::unbounded_channel();
        let client = AcpClient::new(
            tx.clone(),
            Some(Arc::new(SelectSecond)),
            CancellationToken::new(),
        );
        let response = client.request_permission(args.clone()).await.unwrap();
        assert!(
            matches!(response.outcome, acp::RequestPermissionOutcome::Selected(selected) if &*selected.option_id.0 == "choice-1")
        );
        assert!(
            matches!(events.recv().await, Some(AcpEvent::ToolCall(call)) if call.raw_input.as_ref().unwrap()["piSelection"]["options"][1]["label"] == "Second")
        );
        assert!(
            matches!(events.recv().await, Some(AcpEvent::ApprovalRequested { approval_id, .. }) if approval_id == "fixture")
        );

        let client = AcpClient::new(tx, None, CancellationToken::new());
        let response = client.request_permission(args).await.unwrap();
        assert!(matches!(
            response.outcome,
            acp::RequestPermissionOutcome::Cancelled
        ));
    }
}
