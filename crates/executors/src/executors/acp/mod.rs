pub mod client;
pub mod harness;
pub mod normalize_logs;
pub mod oneshot;
pub mod session;

use std::{fmt::Display, str::FromStr};

pub use client::AcpClient;
pub use harness::AcpAgentHarness;
pub use normalize_logs::*;
use serde::{Deserialize, Serialize};
pub use session::SessionManager;
use workspace_utils::approvals::ApprovalStatus;

/// Parsed event types for internal processing
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AcpEvent {
    User(String),
    SessionStart(String),
    Message(agent_client_protocol::ContentBlock),
    Thought(agent_client_protocol::ContentBlock),
    ToolCall(agent_client_protocol::ToolCall),
    ToolUpdate(agent_client_protocol::ToolCallUpdate),
    Plan(agent_client_protocol::Plan),
    AvailableCommands(Vec<agent_client_protocol::AvailableCommand>),
    CurrentMode(agent_client_protocol::SessionModeId),
    RequestPermission(agent_client_protocol::RequestPermissionRequest),
    ApprovalRequested {
        tool_call_id: String,
        approval_id: String,
    },
    ApprovalResponse(ApprovalResponse),
    /// Tokens in the current context and the window of the model that
    /// measured them. `0 / 0` means not known until the next reply.
    TokenUsage(crate::logs::TokenUsageInfo),
    /// A note from Vibe Kanban itself, shown as a system message.
    System(String),
    QuestionAnswered {
        tool_call_id: String,
        answers: Vec<crate::logs::AnsweredQuestion>,
    },
    Error(String),
    Done(String),
    Other(agent_client_protocol::SessionNotification),
}

impl Display for AcpEvent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", serde_json::to_string(self).unwrap_or_default())
    }
}

impl FromStr for AcpEvent {
    type Err = serde_json::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        serde_json::from_str(s)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalResponse {
    pub tool_call_id: String,
    pub status: ApprovalStatus,
}

impl AcpEvent {
    pub(super) fn text(text: &str) -> Self {
        Self::Message(agent_client_protocol::ContentBlock::Text(
            agent_client_protocol::TextContent::new(text.to_owned()),
        ))
    }

    pub(super) fn thought(text: &str) -> Self {
        Self::Thought(agent_client_protocol::ContentBlock::Text(
            agent_client_protocol::TextContent::new(text.to_owned()),
        ))
    }

    pub(super) async fn write_to(
        &self,
        writer: &mut (impl tokio::io::AsyncWrite + Unpin),
    ) -> Result<(), super::ExecutorError> {
        use tokio::io::AsyncWriteExt as _;
        writer
            .write_all(format!("{self}\n").as_bytes())
            .await
            .map_err(super::ExecutorError::Io)?;
        writer.flush().await.map_err(super::ExecutorError::Io)
    }
}
