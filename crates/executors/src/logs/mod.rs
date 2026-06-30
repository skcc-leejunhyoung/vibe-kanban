use json_patch::PatchOperation;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use workspace_utils::{
    approvals::{ApprovalStatus, QuestionStatus},
    log_msg::LogMsg,
};

use crate::logs::utils::shell_command_parsing::CommandCategory;

pub mod plain_text_processor;
pub mod stderr_processor;
pub mod utils;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolResultValueType {
    Markdown,
    Json,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ToolResult {
    pub r#type: ToolResultValueType,
    /// For Markdown, this will be a JSON string; for JSON, a structured value
    pub value: serde_json::Value,
}

impl ToolResult {
    pub fn markdown<S: Into<String>>(markdown: S) -> Self {
        Self {
            r#type: ToolResultValueType::Markdown,
            value: serde_json::Value::String(markdown.into()),
        }
    }

    pub fn json(value: serde_json::Value) -> Self {
        Self {
            r#type: ToolResultValueType::Json,
            value,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CommandExitStatus {
    ExitCode { code: i32 },
    Success { success: bool },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct CommandRunResult {
    pub exit_status: Option<CommandExitStatus>,
    pub output: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct NormalizedConversation {
    pub entries: Vec<NormalizedEntry>,
    pub session_id: Option<String>,
    pub executor_type: String,
    pub prompt: Option<String>,
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NormalizedEntryError {
    SetupRequired,
    Other,
}

#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NormalizedEntryType {
    UserMessage,
    UserFeedback {
        denied_tool: String,
    },
    AssistantMessage,
    ToolUse {
        tool_name: String,
        action_type: ActionType,
        status: ToolStatus,
    },
    SystemMessage,
    ErrorMessage {
        error_type: NormalizedEntryError,
    },
    Thinking,
    Loading,
    NextAction {
        failed: bool,
        execution_processes: usize,
        needs_setup: bool,
    },
    TokenUsageInfo(TokenUsageInfo),
    RateLimitInfo(RateLimitInfo),
    UserAnsweredQuestions {
        answers: Vec<AnsweredQuestion>,
    },
    /// The agent left one or more `run_in_background` tasks running and the Stop
    /// hook held the turn open so the same process waits for them to finish.
    /// Surfaced inline so the user sees *why* the agent is still running instead
    /// of just a spinner.
    BackgroundTasksWaiting {
        /// Command/description of each background task being awaited.
        tasks: Vec<String>,
    },
}

/// A question–answer pair from a completed AskUserQuestion interaction.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AnsweredQuestion {
    pub question: String,
    pub answer: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct TokenUsageInfo {
    pub total_tokens: u32,
    pub model_context_window: u32,
}

/// Emitted when the coding agent reports a usage rate-limit. Used both for UI
/// display and as the signal the exit monitor reads to schedule an automatic
/// resume once the limit resets.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct RateLimitInfo {
    /// True when the agent actually stopped because a usage limit was reached
    /// (as opposed to a routine usage update). Only `true` entries trigger
    /// auto-resume scheduling.
    pub limit_reached: bool,
    /// Best-known reset time as an RFC3339 timestamp, when the agent reports it.
    /// `None` means unknown — the resume scheduler falls back to a conservative
    /// estimate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
    /// Which limit window was hit (agent-specific, e.g. "5h", "weekly"). For
    /// display only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct NormalizedEntry {
    pub timestamp: Option<String>,
    pub entry_type: NormalizedEntryType,
    pub content: String,
    #[ts(skip)]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, Default)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ToolStatus {
    #[default]
    Created,
    Success,
    Failed,
    Denied {
        reason: Option<String>,
    },
    PendingApproval {
        approval_id: String,
    },
    TimedOut,
}

impl ToolStatus {
    pub fn from_approval_status(status: &ApprovalStatus) -> Option<Self> {
        match status {
            ApprovalStatus::Approved => Some(ToolStatus::Created),
            ApprovalStatus::Denied { reason } => Some(ToolStatus::Denied {
                reason: reason.clone(),
            }),
            ApprovalStatus::TimedOut => Some(ToolStatus::TimedOut),
            ApprovalStatus::Pending => None,
        }
    }

    pub fn from_question_status(status: &QuestionStatus) -> Self {
        match status {
            QuestionStatus::Answered { .. } => ToolStatus::Success,
            QuestionStatus::TimedOut => ToolStatus::TimedOut,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct TodoItem {
    pub content: String,
    pub status: String,
    #[serde(default)]
    pub priority: Option<String>,
}

/// Progress of the most recent agent TODO list found in a process's logs.
#[derive(Debug, Clone, Copy)]
pub struct TodoProgress {
    pub total: usize,
    pub completed: usize,
}

/// Scan normalized-conversation log messages for the latest non-empty TODO list
/// the agent wrote (`ActionType::TodoManagement`) and report how many of its
/// items are completed. Returns `None` when the process never produced a TODO
/// list, so callers can hide the indicator entirely.
pub fn todo_progress_from_logs(messages: &[LogMsg]) -> Option<TodoProgress> {
    let mut latest_todos: Option<Vec<TodoItem>> = None;
    for msg in messages {
        let LogMsg::JsonPatch(patch) = msg else {
            continue;
        };
        for op in patch.iter() {
            // Normalized entries arrive as JSON-patch ops on `/entries/<n>`;
            // a TodoWrite may first `add` an entry then `replace` it as items
            // complete, so we honor both and keep the last non-empty list.
            let value = match op {
                PatchOperation::Add(add) if add.path.strip_prefix("/entries/").is_some() => {
                    &add.value
                }
                PatchOperation::Replace(replace)
                    if replace.path.strip_prefix("/entries/").is_some() =>
                {
                    &replace.value
                }
                _ => continue,
            };
            if let Ok(NormalizedEntry {
                entry_type:
                    NormalizedEntryType::ToolUse {
                        action_type: ActionType::TodoManagement { todos, .. },
                        ..
                    },
                ..
            }) = serde_json::from_value::<NormalizedEntry>(value.clone())
                && !todos.is_empty()
            {
                latest_todos = Some(todos);
            }
        }
    }

    let todos = latest_todos?;
    let completed = todos
        .iter()
        .filter(|t| t.status.eq_ignore_ascii_case("completed"))
        .count();
    Some(TodoProgress {
        total: todos.len(),
        completed,
    })
}

/// Types of tool actions that can be performed
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum ActionType {
    FileRead {
        path: String,
    },
    FileEdit {
        path: String,
        changes: Vec<FileChange>,
    },
    CommandRun {
        command: String,
        #[serde(default)]
        result: Option<CommandRunResult>,
        #[serde(default)]
        category: CommandCategory,
    },
    Search {
        query: String,
    },
    WebFetch {
        url: String,
    },
    /// Generic tool with optional arguments and result for rich rendering
    Tool {
        tool_name: String,
        #[serde(default)]
        arguments: Option<serde_json::Value>,
        #[serde(default)]
        result: Option<ToolResult>,
    },
    TaskCreate {
        description: String,
        #[serde(default)]
        subagent_type: Option<String>,
        #[serde(default)]
        result: Option<ToolResult>,
    },
    PlanPresentation {
        plan: String,
    },
    TodoManagement {
        todos: Vec<TodoItem>,
        operation: String,
    },
    AskUserQuestion {
        questions: Vec<AskUserQuestionItem>,
    },
    Other {
        description: String,
    },
}

/// A single question in an AskUserQuestion tool call.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AskUserQuestionItem {
    pub question: String,
    pub header: String,
    pub options: Vec<AskUserQuestionOption>,
    #[serde(rename = "multiSelect")]
    pub multi_select: bool,
}

/// An option for an AskUserQuestion question.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AskUserQuestionOption {
    pub label: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum FileChange {
    /// Create a file if it doesn't exist, and overwrite its content.
    Write { content: String },
    /// Delete a file.
    Delete,
    /// Rename a file.
    Rename { new_path: String },
    /// Edit a file with a unified diff.
    Edit {
        /// Unified diff containing file header and hunks.
        unified_diff: String,
        /// Whether line number in the hunks are reliable.
        has_line_numbers: bool,
    },
}

#[cfg(test)]
mod todo_progress_tests {
    use json_patch::Patch;
    use workspace_utils::log_msg::LogMsg;

    use super::*;

    fn todo_entry_value(items: &[(&str, &str)]) -> serde_json::Value {
        let todos: Vec<TodoItem> = items
            .iter()
            .map(|(content, status)| TodoItem {
                content: content.to_string(),
                status: status.to_string(),
                priority: None,
            })
            .collect();
        let entry = NormalizedEntry {
            timestamp: None,
            entry_type: NormalizedEntryType::ToolUse {
                tool_name: "TodoWrite".to_string(),
                action_type: ActionType::TodoManagement {
                    todos,
                    operation: "write".to_string(),
                },
                status: ToolStatus::Success,
            },
            content: String::new(),
            metadata: None,
        };
        serde_json::to_value(entry).unwrap()
    }

    fn patch_msg(index: usize, value: serde_json::Value) -> LogMsg {
        let patch: Patch = serde_json::from_value(serde_json::json!([
            { "op": "add", "path": format!("/entries/{index}"), "value": value }
        ]))
        .unwrap();
        LogMsg::JsonPatch(patch)
    }

    #[test]
    fn none_without_logs() {
        assert!(todo_progress_from_logs(&[]).is_none());
    }

    #[test]
    fn none_without_todo_entries() {
        let entry = NormalizedEntry {
            timestamp: None,
            entry_type: NormalizedEntryType::AssistantMessage,
            content: "hello".to_string(),
            metadata: None,
        };
        let msgs = vec![patch_msg(0, serde_json::to_value(entry).unwrap())];
        assert!(todo_progress_from_logs(&msgs).is_none());
    }

    #[test]
    fn counts_completed_items() {
        let msgs = vec![patch_msg(
            0,
            todo_entry_value(&[("a", "completed"), ("b", "in_progress"), ("c", "pending")]),
        )];
        let progress = todo_progress_from_logs(&msgs).unwrap();
        assert_eq!(progress.total, 3);
        assert_eq!(progress.completed, 1);
    }

    #[test]
    fn uses_latest_nonempty_list() {
        let msgs = vec![
            patch_msg(0, todo_entry_value(&[("a", "pending"), ("b", "pending")])),
            patch_msg(
                1,
                todo_entry_value(&[("a", "completed"), ("b", "completed"), ("c", "completed")]),
            ),
            // A trailing TodoRead emits an empty list; it must not reset the count.
            patch_msg(2, todo_entry_value(&[])),
        ];
        let progress = todo_progress_from_logs(&msgs).unwrap();
        assert_eq!(progress.total, 3);
        assert_eq!(progress.completed, 3);
    }
}
