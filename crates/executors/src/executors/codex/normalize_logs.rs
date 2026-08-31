use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock},
    time::Duration,
};

use codex_app_server_protocol::{
    CollabAgentState as AppCollabAgentState, CollabAgentStatus as AppCollabAgentStatus,
    CollabAgentTool as AppCollabAgentTool,
    CollabAgentToolCallStatus as AppCollabAgentToolCallStatus,
    CommandExecutionOutputDeltaNotification, CommandExecutionStatus as AppCommandExecutionStatus,
    DynamicToolCallOutputContentItem as AppDynamicToolCallOutputContentItem,
    DynamicToolCallStatus as AppDynamicToolCallStatus, FileChangeOutputDeltaNotification,
    FileChangePatchUpdatedNotification, ItemCompletedNotification as AppItemCompletedNotification,
    ItemStartedNotification as AppItemStartedNotification, JSONRPCNotification, JSONRPCRequest,
    JSONRPCResponse, McpToolCallProgressNotification, McpToolCallStatus as AppMcpToolCallStatus,
    PatchApplyStatus as AppPatchApplyStatus, ServerNotification, ServerRequest,
    SubAgentActivityKind as AppSubAgentActivityKind, ThreadForkResponse,
    ThreadItem as AppThreadItem, ThreadStartResponse, ThreadTokenUsageUpdatedNotification,
    ToolRequestUserInputQuestion,
};
use codex_protocol::{
    dynamic_tools::DynamicToolCallOutputContentItem as CoreDynamicToolCallOutputContentItem,
    items::TurnItem,
    openai_models::ReasoningEffort,
    plan_tool::{StepStatus, UpdatePlanArgs},
    protocol::{
        AgentMessageContentDeltaEvent, AgentMessageEvent, AgentReasoningEvent,
        AgentReasoningRawContentEvent, AgentReasoningSectionBreakEvent,
        ApplyPatchApprovalRequestEvent, ErrorEvent, EventMsg, ExecApprovalRequestEvent,
        ExecCommandBeginEvent, ExecCommandEndEvent, ExecCommandOutputDeltaEvent, ExecOutputStream,
        ExitedReviewModeEvent, FileChange as CodexProtoFileChange, ItemCompletedEvent,
        ItemStartedEvent, McpInvocation, McpToolCallBeginEvent, McpToolCallEndEvent,
        ModelRerouteEvent, PatchApplyBeginEvent, PatchApplyEndEvent, PatchApplyUpdatedEvent,
        PlanDeltaEvent, ReasoningContentDeltaEvent, ReasoningRawContentDeltaEvent,
        RequestUserInputEvent, StreamErrorEvent, ViewImageToolCallEvent, WarningEvent,
        WebSearchBeginEvent, WebSearchEndEvent,
    },
};
use futures::StreamExt;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use workspace_utils::{
    approvals::{ApprovalStatus, QuestionStatus},
    diff::normalize_unified_diff,
    msg_store::MsgStore,
    path::make_path_relative,
};

use crate::{
    approvals::ToolCallMetadata,
    logs::{
        ActionType, AnsweredQuestion, AskUserQuestionItem, AskUserQuestionOption,
        CommandExitStatus, CommandRunResult, FileChange, NormalizedEntry, NormalizedEntryError,
        NormalizedEntryType, TodoItem, ToolResult, ToolResultValueType, ToolStatus,
        plain_text_processor::PlainTextLogProcessor,
        utils::{
            ConversationPatch, EntryIndexProvider, images,
            patch::{add_normalized_entry, replace_normalized_entry, upsert_normalized_entry},
            shell_command_parsing::{CommandCategory, unwrap_shell_command},
        },
    },
};

trait ToNormalizedEntry {
    fn to_normalized_entry(&self) -> NormalizedEntry;
}

trait ToNormalizedEntryOpt {
    fn to_normalized_entry_opt(&self) -> Option<NormalizedEntry>;
}

#[derive(Debug, Deserialize)]
struct CodexNotificationParams {
    #[serde(rename = "msg")]
    msg: EventMsg,
}

#[derive(Default)]
struct StreamingText {
    index: usize,
    content: String,
}

#[derive(Default)]
struct CommandState {
    index: Option<usize>,
    command: String,
    stdout: String,
    stderr: String,
    formatted_output: Option<String>,
    status: ToolStatus,
    exit_code: Option<i32>,
    awaiting_approval: bool,
    call_id: String,
}

const MAX_NORMALIZED_COMMAND_OUTPUT_BYTES: usize = 256 * 1024;
const COMMAND_OUTPUT_TRUNCATION_MARKER: &str = "\n\n... command output truncated ...\n\n";

impl ToNormalizedEntry for CommandState {
    fn to_normalized_entry(&self) -> NormalizedEntry {
        let content = self.command.to_string();

        NormalizedEntry {
            timestamp: None,
            entry_type: NormalizedEntryType::ToolUse {
                tool_name: "bash".to_string(),
                action_type: ActionType::CommandRun {
                    command: unwrap_shell_command(&self.command).to_string(),
                    result: Some(CommandRunResult {
                        exit_status: self
                            .exit_code
                            .map(|code| CommandExitStatus::ExitCode { code }),
                        output: if let Some(formatted_output) = &self.formatted_output {
                            Some(truncate_command_output(
                                formatted_output,
                                MAX_NORMALIZED_COMMAND_OUTPUT_BYTES,
                            ))
                        } else {
                            build_command_output(Some(&self.stdout), Some(&self.stderr))
                        },
                    }),
                    category: CommandCategory::from_command(&self.command),
                },
                status: self.status.clone(),
            },
            content,
            metadata: serde_json::to_value(ToolCallMetadata {
                tool_call_id: self.call_id.clone(),
            })
            .ok(),
        }
    }
}

struct McpToolState {
    index: Option<usize>,
    invocation: McpInvocation,
    result: Option<ToolResult>,
    status: ToolStatus,
}

struct DynamicToolState {
    index: Option<usize>,
    tool: String,
    arguments: Value,
    result: Option<ToolResult>,
    status: ToolStatus,
    call_id: String,
}

impl ToNormalizedEntry for DynamicToolState {
    fn to_normalized_entry(&self) -> NormalizedEntry {
        NormalizedEntry {
            timestamp: None,
            entry_type: NormalizedEntryType::ToolUse {
                tool_name: self.tool.clone(),
                action_type: ActionType::Tool {
                    tool_name: self.tool.clone(),
                    arguments: Some(self.arguments.clone()),
                    result: self.result.clone(),
                },
                status: self.status.clone(),
            },
            content: self.tool.clone(),
            metadata: serde_json::to_value(ToolCallMetadata {
                tool_call_id: self.call_id.clone(),
            })
            .ok(),
        }
    }
}

impl ToNormalizedEntry for McpToolState {
    fn to_normalized_entry(&self) -> NormalizedEntry {
        let tool_name = format!("mcp:{}:{}", self.invocation.server, self.invocation.tool);
        NormalizedEntry {
            timestamp: None,
            entry_type: NormalizedEntryType::ToolUse {
                tool_name: tool_name.clone(),
                action_type: ActionType::Tool {
                    tool_name,
                    arguments: self.invocation.arguments.clone(),
                    result: self.result.clone(),
                },
                status: self.status.clone(),
            },
            content: self.invocation.tool.clone(),
            metadata: None,
        }
    }
}

#[derive(Default)]
struct WebSearchState {
    index: Option<usize>,
    query: Option<String>,
    status: ToolStatus,
}

impl WebSearchState {
    fn new() -> Self {
        Default::default()
    }
}

impl ToNormalizedEntry for WebSearchState {
    fn to_normalized_entry(&self) -> NormalizedEntry {
        NormalizedEntry {
            timestamp: None,
            entry_type: NormalizedEntryType::ToolUse {
                tool_name: "web_search".to_string(),
                action_type: ActionType::WebFetch {
                    url: self.query.clone().unwrap_or_else(|| "...".to_string()),
                },
                status: self.status.clone(),
            },
            content: self
                .query
                .clone()
                .unwrap_or_else(|| "Web search".to_string()),
            metadata: None,
        }
    }
}

struct UserInputRequestState {
    index: Option<usize>,
    questions: Vec<AskUserQuestionItem>,
    content: String,
    status: ToolStatus,
}

impl ToNormalizedEntry for UserInputRequestState {
    fn to_normalized_entry(&self) -> NormalizedEntry {
        NormalizedEntry {
            timestamp: None,
            entry_type: NormalizedEntryType::ToolUse {
                tool_name: "question".to_string(),
                action_type: ActionType::AskUserQuestion {
                    questions: self.questions.clone(),
                },
                status: self.status.clone(),
            },
            content: self.content.clone(),
            metadata: None,
        }
    }
}

struct PlanState {
    index: Option<usize>,
    text: String,
    status: ToolStatus,
}

impl ToNormalizedEntry for PlanState {
    fn to_normalized_entry(&self) -> NormalizedEntry {
        NormalizedEntry {
            timestamp: None,
            entry_type: NormalizedEntryType::ToolUse {
                tool_name: "plan".to_string(),
                action_type: ActionType::PlanPresentation {
                    plan: self.text.clone(),
                },
                status: self.status.clone(),
            },
            content: "Plan".to_string(),
            metadata: None,
        }
    }
}

struct ReviewState {
    index: Option<usize>,
    description: String,
    status: ToolStatus,
    result: Option<ToolResult>,
}

impl ReviewState {
    fn complete(&mut self, review_event: &ExitedReviewModeEvent, worktree_path: &str) {
        let result_text = match &review_event.review_output {
            Some(output) => {
                let mut sections = Vec::new();
                sections.push(format!(
                    "**Correctness:** {} | **Confidence:** {}",
                    output.overall_correctness, output.overall_confidence_score,
                ));
                let explanation = output.overall_explanation.trim();
                if !explanation.is_empty() {
                    sections.push(explanation.to_string());
                }
                if !output.findings.is_empty() {
                    let mut lines = vec!["### Findings".to_string()];
                    for finding in &output.findings {
                        let abs_path = finding.code_location.absolute_file_path.to_string_lossy();
                        let path = make_path_relative(&abs_path, worktree_path);
                        let start = finding.code_location.line_range.start;
                        let end = finding.code_location.line_range.end;
                        lines.push(format!(
                            "- **P{}** | **Confidence:** {} | {}",
                            finding.priority, finding.confidence_score, finding.title,
                        ));
                        lines.push(format!("  `{path}:{start}-{end}`"));
                        for body_line in finding.body.lines() {
                            lines.push(format!("  {body_line}"));
                        }
                    }
                    sections.push(lines.join("\n"));
                }
                if sections.is_empty() {
                    "Review completed".to_string()
                } else {
                    sections.join("\n\n")
                }
            }
            None => "Review completed".to_string(),
        };
        self.status = ToolStatus::Success;
        self.result = Some(ToolResult::markdown(result_text));
    }
}

impl ToNormalizedEntry for ReviewState {
    fn to_normalized_entry(&self) -> NormalizedEntry {
        NormalizedEntry {
            timestamp: None,
            entry_type: NormalizedEntryType::ToolUse {
                tool_name: "Review".to_string(),
                action_type: ActionType::TaskCreate {
                    description: self.description.clone(),
                    subagent_type: Some("review".to_string()),
                    result: self.result.clone(),
                    last_activity: None,
                    duration_ms: None,
                },
                status: self.status.clone(),
            },
            content: String::new(),
            metadata: None,
        }
    }
}

/// One spawned collab subagent, keyed by its agent thread id (or
/// `call:<call_id>` until the spawn completes and reveals the thread id).
/// Fed by `CollabAgentToolCall` and `SubAgentActivity` thread items.
struct CollabAgentTaskState {
    index: Option<usize>,
    description: String,
    subagent_type: Option<String>,
    status: ToolStatus,
    last_activity: Option<String>,
    result: Option<ToolResult>,
    /// Unix ms when the spawn call started; from notification timestamps so
    /// replayed logs reproduce the same elapsed values.
    started_at_ms: Option<i64>,
    duration_ms: Option<u32>,
}

impl CollabAgentTaskState {
    fn new(description: String, started_at_ms: i64) -> Self {
        Self {
            index: None,
            description,
            subagent_type: None,
            status: ToolStatus::Created,
            last_activity: None,
            result: None,
            started_at_ms: Some(started_at_ms),
            duration_ms: None,
        }
    }

    fn touch(&mut self, event_at_ms: i64) {
        if let Some(started) = self.started_at_ms
            && event_at_ms > started
        {
            self.duration_ms = u32::try_from(event_at_ms - started).ok();
        }
    }
}

impl ToNormalizedEntry for CollabAgentTaskState {
    fn to_normalized_entry(&self) -> NormalizedEntry {
        NormalizedEntry {
            timestamp: None,
            entry_type: NormalizedEntryType::ToolUse {
                tool_name: "agent".to_string(),
                action_type: ActionType::TaskCreate {
                    description: self.description.clone(),
                    subagent_type: self.subagent_type.clone(),
                    result: self.result.clone(),
                    last_activity: self.last_activity.clone(),
                    duration_ms: self.duration_ms,
                },
                status: self.status.clone(),
            },
            content: self.description.clone(),
            metadata: None,
        }
    }
}

#[derive(Default)]
struct PatchState {
    entries: Vec<PatchEntry>,
}

struct PatchEntry {
    index: Option<usize>,
    path: String,
    changes: Vec<FileChange>,
    status: ToolStatus,
    awaiting_approval: bool,
    call_id: String,
}

impl ToNormalizedEntry for PatchEntry {
    fn to_normalized_entry(&self) -> NormalizedEntry {
        let content = self.path.clone();

        NormalizedEntry {
            timestamp: None,
            entry_type: NormalizedEntryType::ToolUse {
                tool_name: "edit".to_string(),
                action_type: ActionType::FileEdit {
                    path: self.path.clone(),
                    changes: self.changes.clone(),
                },
                status: self.status.clone(),
            },
            content,
            metadata: serde_json::to_value(ToolCallMetadata {
                tool_call_id: self.call_id.clone(),
            })
            .ok(),
        }
    }
}

struct LogState {
    entry_index: EntryIndexProvider,
    assistant: Option<StreamingText>,
    thinking: Option<StreamingText>,
    commands: HashMap<String, CommandState>,
    mcp_tools: HashMap<String, McpToolState>,
    dynamic_tools: HashMap<String, DynamicToolState>,
    patches: HashMap<String, PatchState>,
    web_searches: HashMap<String, WebSearchState>,
    user_input_requests: HashMap<String, UserInputRequestState>,
    plans: HashMap<String, PlanState>,
    review: Option<ReviewState>,
    collab_agents: HashMap<String, CollabAgentTaskState>,
    model_params: ModelParamsState,
}

struct ModelParamsState {
    index: Option<usize>,
    model: Option<String>,
    reasoning_effort: Option<ReasoningEffort>,
}

enum StreamingTextKind {
    Assistant,
    Thinking,
}

impl LogState {
    fn new(entry_index: EntryIndexProvider) -> Self {
        Self {
            entry_index,
            assistant: None,
            thinking: None,
            commands: HashMap::new(),
            mcp_tools: HashMap::new(),
            dynamic_tools: HashMap::new(),
            patches: HashMap::new(),
            web_searches: HashMap::new(),
            user_input_requests: HashMap::new(),
            plans: HashMap::new(),
            review: None,
            collab_agents: HashMap::new(),
            model_params: ModelParamsState {
                index: None,
                model: None,
                reasoning_effort: None,
            },
        }
    }

    fn streaming_text_update(
        &mut self,
        content: String,
        type_: StreamingTextKind,
        mode: UpdateMode,
    ) -> (NormalizedEntry, usize, bool) {
        let index_provider = &self.entry_index;
        let entry = match type_ {
            StreamingTextKind::Assistant => &mut self.assistant,
            StreamingTextKind::Thinking => &mut self.thinking,
        };
        let is_new = entry.is_none();
        let (content, index) = if entry.is_none() {
            let index = index_provider.next();
            *entry = Some(StreamingText { index, content });
            (&entry.as_ref().unwrap().content, index)
        } else {
            let streaming_state = entry.as_mut().unwrap();
            match mode {
                UpdateMode::Append => streaming_state.content.push_str(&content),
                UpdateMode::Set => streaming_state.content = content,
            }
            (&streaming_state.content, streaming_state.index)
        };
        let normalized_entry = NormalizedEntry {
            timestamp: None,
            entry_type: match type_ {
                StreamingTextKind::Assistant => NormalizedEntryType::AssistantMessage,
                StreamingTextKind::Thinking => NormalizedEntryType::Thinking,
            },
            content: content.clone(),
            metadata: None,
        };
        (normalized_entry, index, is_new)
    }

    fn streaming_text_append(
        &mut self,
        content: String,
        type_: StreamingTextKind,
    ) -> (NormalizedEntry, usize, bool) {
        self.streaming_text_update(content, type_, UpdateMode::Append)
    }

    fn streaming_text_set(
        &mut self,
        content: String,
        type_: StreamingTextKind,
    ) -> (NormalizedEntry, usize, bool) {
        self.streaming_text_update(content, type_, UpdateMode::Set)
    }

    fn assistant_message_append(&mut self, content: String) -> (NormalizedEntry, usize, bool) {
        self.streaming_text_append(content, StreamingTextKind::Assistant)
    }

    fn thinking_append(&mut self, content: String) -> (NormalizedEntry, usize, bool) {
        self.streaming_text_append(content, StreamingTextKind::Thinking)
    }

    fn assistant_message(&mut self, content: String) -> (NormalizedEntry, usize, bool) {
        self.streaming_text_set(content, StreamingTextKind::Assistant)
    }

    fn thinking(&mut self, content: String) -> (NormalizedEntry, usize, bool) {
        self.streaming_text_set(content, StreamingTextKind::Thinking)
    }

    fn update_tool_status(
        &mut self,
        call_id: &str,
        status: ToolStatus,
        clear_awaiting: bool,
        msg_store: &Arc<MsgStore>,
    ) {
        if let Some(cmd) = self.commands.get_mut(call_id) {
            cmd.status = status.clone();
            if clear_awaiting {
                cmd.awaiting_approval = false;
            }
            if let Some(index) = cmd.index {
                replace_normalized_entry(msg_store, index, cmd.to_normalized_entry());
            }
        } else if let Some(mcp) = self.mcp_tools.get_mut(call_id) {
            mcp.status = status.clone();
            if let Some(index) = mcp.index {
                replace_normalized_entry(msg_store, index, mcp.to_normalized_entry());
            }
        } else if let Some(dynamic_tool) = self.dynamic_tools.get_mut(call_id) {
            dynamic_tool.status = status.clone();
            if let Some(index) = dynamic_tool.index {
                replace_normalized_entry(msg_store, index, dynamic_tool.to_normalized_entry());
            }
        } else if let Some(patch_state) = self.patches.get_mut(call_id) {
            for entry in &mut patch_state.entries {
                entry.status = status.clone();
                if clear_awaiting {
                    entry.awaiting_approval = false;
                }
                if let Some(index) = entry.index {
                    replace_normalized_entry(msg_store, index, entry.to_normalized_entry());
                }
            }
        } else if let Some(input_state) = self.user_input_requests.get_mut(call_id) {
            input_state.status = status;
            if let Some(index) = input_state.index {
                replace_normalized_entry(msg_store, index, input_state.to_normalized_entry());
            }
        } else if let Some(plan_state) = self.plans.get_mut(call_id) {
            plan_state.status = status;
            if let Some(index) = plan_state.index {
                replace_normalized_entry(msg_store, index, plan_state.to_normalized_entry());
            }
        } else if matches!(status, ToolStatus::PendingApproval { .. }) {
            let command_state = self.command_state(call_id.to_string());
            command_state.status = status.clone();
            if clear_awaiting {
                command_state.awaiting_approval = false;
            } else if matches!(status, ToolStatus::PendingApproval { .. }) {
                command_state.awaiting_approval = true;
            }
            if let Some(index) = command_state.index {
                replace_normalized_entry(msg_store, index, command_state.to_normalized_entry());
            }
        }
    }

    fn command_state(&mut self, call_id: String) -> &mut CommandState {
        self.commands
            .entry(call_id.clone())
            .or_insert_with(|| CommandState {
                call_id,
                ..Default::default()
            })
    }
}

enum UpdateMode {
    Append,
    Set,
}

fn normalize_file_changes(
    worktree_path: &str,
    changes: &HashMap<PathBuf, CodexProtoFileChange>,
) -> Vec<(String, Vec<FileChange>)> {
    changes
        .iter()
        .map(|(path, change)| {
            let path_str = path.to_string_lossy();
            let relative = make_path_relative(path_str.as_ref(), worktree_path);
            let file_changes = match change {
                CodexProtoFileChange::Add { content } => vec![FileChange::Write {
                    content: content.clone(),
                }],
                CodexProtoFileChange::Delete { .. } => vec![FileChange::Delete],
                CodexProtoFileChange::Update {
                    unified_diff,
                    move_path,
                } => {
                    let mut edits = Vec::new();
                    if let Some(dest) = move_path {
                        let dest_rel =
                            make_path_relative(dest.to_string_lossy().as_ref(), worktree_path);
                        edits.push(FileChange::Rename { new_path: dest_rel });
                    }
                    let diff = normalize_unified_diff(&relative, unified_diff);
                    edits.push(FileChange::Edit {
                        unified_diff: diff,
                        has_line_numbers: true,
                    });
                    edits
                }
            };
            (relative, file_changes)
        })
        .collect()
}

fn normalize_app_file_changes(
    worktree_path: &str,
    changes: &[codex_app_server_protocol::FileUpdateChange],
) -> Vec<(String, Vec<FileChange>)> {
    changes
        .iter()
        .map(|change| {
            let relative = make_path_relative(&change.path, worktree_path);
            let file_changes = match &change.kind {
                codex_app_server_protocol::PatchChangeKind::Add => vec![FileChange::Write {
                    content: change.diff.clone(),
                }],
                codex_app_server_protocol::PatchChangeKind::Delete => vec![FileChange::Delete],
                codex_app_server_protocol::PatchChangeKind::Update { move_path } => {
                    let mut edits = Vec::new();
                    if let Some(dest) = move_path {
                        let dest_rel = make_path_relative(&dest.to_string_lossy(), worktree_path);
                        edits.push(FileChange::Rename { new_path: dest_rel });
                    }
                    edits.push(FileChange::Edit {
                        unified_diff: normalize_unified_diff(&relative, &change.diff),
                        has_line_numbers: true,
                    });
                    edits
                }
            };
            (relative, file_changes)
        })
        .collect()
}

fn sync_patch_entries(
    state: &mut LogState,
    msg_store: &Arc<MsgStore>,
    entry_index: &EntryIndexProvider,
    call_id: String,
    normalized: Vec<(String, Vec<FileChange>)>,
    status: ToolStatus,
    awaiting_approval: bool,
) {
    let patch_state = state.patches.entry(call_id.clone()).or_default();
    let normalized_len = normalized.len();
    let mut iter = normalized.into_iter();

    for entry in &mut patch_state.entries {
        if let Some((path, file_changes)) = iter.next() {
            entry.path = path;
            entry.changes = file_changes;
            entry.status = status.clone();
            entry.awaiting_approval = awaiting_approval;
            let index = entry.index.unwrap_or_else(|| {
                add_normalized_entry(msg_store, entry_index, entry.to_normalized_entry())
            });
            entry.index = Some(index);
            replace_normalized_entry(msg_store, index, entry.to_normalized_entry());
        }
    }

    if normalized_len < patch_state.entries.len() {
        for entry in patch_state.entries.drain(normalized_len..) {
            if let Some(index) = entry.index {
                msg_store.push_patch(ConversationPatch::remove(index));
            }
        }
    }

    for (path, file_changes) in iter {
        let mut entry = PatchEntry {
            index: None,
            path,
            changes: file_changes,
            status: status.clone(),
            awaiting_approval,
            call_id: call_id.clone(),
        };
        let index = add_normalized_entry(msg_store, entry_index, entry.to_normalized_entry());
        entry.index = Some(index);
        patch_state.entries.push(entry);
    }
}

fn app_command_status_to_tool_status(status: &AppCommandExecutionStatus) -> ToolStatus {
    match status {
        AppCommandExecutionStatus::InProgress => ToolStatus::Created,
        AppCommandExecutionStatus::Completed => ToolStatus::Success,
        AppCommandExecutionStatus::Failed => ToolStatus::Failed,
        AppCommandExecutionStatus::Declined => ToolStatus::Denied { reason: None },
    }
}

fn app_patch_status_to_tool_status(status: &AppPatchApplyStatus) -> ToolStatus {
    match status {
        AppPatchApplyStatus::InProgress => ToolStatus::Created,
        AppPatchApplyStatus::Completed => ToolStatus::Success,
        AppPatchApplyStatus::Failed => ToolStatus::Failed,
        AppPatchApplyStatus::Declined => ToolStatus::Denied { reason: None },
    }
}

fn app_mcp_status_to_tool_status(status: &AppMcpToolCallStatus) -> ToolStatus {
    match status {
        AppMcpToolCallStatus::InProgress => ToolStatus::Created,
        AppMcpToolCallStatus::Completed => ToolStatus::Success,
        AppMcpToolCallStatus::Failed => ToolStatus::Failed,
    }
}

fn app_dynamic_tool_status_to_tool_status(status: &AppDynamicToolCallStatus) -> ToolStatus {
    match status {
        AppDynamicToolCallStatus::InProgress => ToolStatus::Created,
        AppDynamicToolCallStatus::Completed => ToolStatus::Success,
        AppDynamicToolCallStatus::Failed => ToolStatus::Failed,
    }
}

/// Render a tool-output image reference: persist data URLs into
/// `.vibe-attachments/` so the chat can inline them; keep other URLs as text.
fn dynamic_tool_image_markdown(image_url: &str, worktree_path: &str) -> String {
    if let Some((mime, data)) = images::parse_image_data_url(image_url)
        && let Some(rel_path) = images::store_base64_image(worktree_path, mime, data)
    {
        return format!("![tool image]({rel_path})");
    }
    format!("Image: {image_url}")
}

fn dynamic_tool_markdown_from_app_items(
    items: &[AppDynamicToolCallOutputContentItem],
    worktree_path: &str,
) -> String {
    items
        .iter()
        .map(|item| match item {
            AppDynamicToolCallOutputContentItem::InputText { text } => text.clone(),
            AppDynamicToolCallOutputContentItem::InputImage { image_url } => {
                dynamic_tool_image_markdown(image_url, worktree_path)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn dynamic_tool_markdown_from_core_items(
    items: &[CoreDynamicToolCallOutputContentItem],
    worktree_path: &str,
) -> String {
    items
        .iter()
        .map(|item| match item {
            CoreDynamicToolCallOutputContentItem::InputText { text } => text.clone(),
            CoreDynamicToolCallOutputContentItem::InputImage { image_url } => {
                dynamic_tool_image_markdown(image_url, worktree_path)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

struct DynamicToolUpdate {
    call_id: String,
    tool: String,
    arguments: Value,
    status: ToolStatus,
    result: Option<ToolResult>,
}

fn upsert_dynamic_tool_state(
    state: &mut LogState,
    msg_store: &Arc<MsgStore>,
    entry_index: &EntryIndexProvider,
    update: DynamicToolUpdate,
) {
    let DynamicToolUpdate {
        call_id,
        tool,
        arguments,
        status,
        result,
    } = update;
    let dynamic_tool_state = state
        .dynamic_tools
        .entry(call_id.clone())
        .or_insert_with(|| DynamicToolState {
            index: None,
            tool: tool.clone(),
            arguments: arguments.clone(),
            result: None,
            status: ToolStatus::Created,
            call_id: call_id.clone(),
        });
    dynamic_tool_state.tool = tool;
    dynamic_tool_state.arguments = arguments;
    dynamic_tool_state.status = status;
    dynamic_tool_state.result = result;
    let index = if let Some(index) = dynamic_tool_state.index {
        index
    } else {
        let index = add_normalized_entry(
            msg_store,
            entry_index,
            dynamic_tool_state.to_normalized_entry(),
        );
        dynamic_tool_state.index = Some(index);
        index
    };
    replace_normalized_entry(msg_store, index, dynamic_tool_state.to_normalized_entry());
}

fn add_thread_token_usage(
    notification: ThreadTokenUsageUpdatedNotification,
    msg_store: &Arc<MsgStore>,
    entry_index: &EntryIndexProvider,
) {
    add_normalized_entry(
        msg_store,
        entry_index,
        NormalizedEntry {
            timestamp: None,
            entry_type: NormalizedEntryType::TokenUsageInfo(crate::logs::TokenUsageInfo {
                total_tokens: notification.token_usage.last.total_tokens as u32,
                model_context_window: notification
                    .token_usage
                    .model_context_window
                    .unwrap_or_default() as u32,
            }),
            content: format!(
                "Tokens used: {} / Context window: {}",
                notification.token_usage.last.total_tokens,
                notification
                    .token_usage
                    .model_context_window
                    .unwrap_or_default()
            ),
            metadata: None,
        },
    );
}

trait QuestionLike {
    fn question(&self) -> &str;
    fn header(&self) -> &str;
    fn options(&self) -> Option<&[impl QuestionOptionLike]>;
}

trait QuestionOptionLike {
    fn label(&self) -> &str;
    fn description(&self) -> &str;
}

impl QuestionLike for ToolRequestUserInputQuestion {
    fn question(&self) -> &str {
        &self.question
    }

    fn header(&self) -> &str {
        &self.header
    }

    fn options(&self) -> Option<&[impl QuestionOptionLike]> {
        self.options.as_deref()
    }
}

impl QuestionOptionLike for codex_app_server_protocol::ToolRequestUserInputOption {
    fn label(&self) -> &str {
        &self.label
    }

    fn description(&self) -> &str {
        &self.description
    }
}

impl QuestionLike for codex_protocol::request_user_input::RequestUserInputQuestion {
    fn question(&self) -> &str {
        &self.question
    }

    fn header(&self) -> &str {
        &self.header
    }

    fn options(&self) -> Option<&[impl QuestionOptionLike]> {
        self.options.as_deref()
    }
}

impl QuestionOptionLike for codex_protocol::request_user_input::RequestUserInputQuestionOption {
    fn label(&self) -> &str {
        &self.label
    }

    fn description(&self) -> &str {
        &self.description
    }
}

fn question_state_from_questions<T: QuestionLike>(questions: &[T]) -> UserInputRequestState {
    let questions: Vec<AskUserQuestionItem> = questions
        .iter()
        .map(|q| AskUserQuestionItem {
            question: q.question().to_string(),
            header: q.header().to_string(),
            options: q
                .options()
                .unwrap_or(&[])
                .iter()
                .map(|o| AskUserQuestionOption {
                    label: o.label().to_string(),
                    description: o.description().to_string(),
                })
                .collect(),
            multi_select: false,
        })
        .collect();

    let content = if questions.len() == 1 {
        questions[0].question.clone()
    } else {
        format!("{} questions", questions.len())
    };

    UserInputRequestState {
        index: None,
        questions,
        content,
        status: ToolStatus::Created,
    }
}

fn upsert_question_request_state(
    state: &mut LogState,
    msg_store: &Arc<MsgStore>,
    entry_index: &EntryIndexProvider,
    call_id: String,
    questions: &[impl QuestionLike],
) {
    let mut tool_state = question_state_from_questions(questions);
    let fallback_command = state.commands.remove(&call_id);
    if let Some(command_state) = fallback_command.as_ref()
        && matches!(command_state.status, ToolStatus::PendingApproval { .. })
    {
        tool_state.status = command_state.status.clone();
    }
    let existing_index = state
        .user_input_requests
        .get(&call_id)
        .and_then(|s| s.index)
        .or_else(|| fallback_command.and_then(|cmd| cmd.index));
    let index = existing_index.unwrap_or_else(|| {
        add_normalized_entry(msg_store, entry_index, tool_state.to_normalized_entry())
    });
    tool_state.index = Some(index);
    replace_normalized_entry(msg_store, index, tool_state.to_normalized_entry());
    state.user_input_requests.insert(call_id, tool_state);
}

fn handle_direct_item_started(
    notification: AppItemStartedNotification,
    state: &mut LogState,
    msg_store: &Arc<MsgStore>,
    entry_index: &EntryIndexProvider,
    worktree_path: &str,
) {
    state.assistant = None;
    state.thinking = None;

    let event_at_ms = notification.started_at_ms;
    match notification.item {
        AppThreadItem::Plan { id, .. } => {
            let mut plan_state = PlanState {
                index: None,
                text: String::new(),
                status: ToolStatus::Created,
            };
            let index =
                add_normalized_entry(msg_store, entry_index, plan_state.to_normalized_entry());
            plan_state.index = Some(index);
            state.plans.insert(id, plan_state);
        }
        AppThreadItem::CommandExecution { id, command, .. } => {
            let mut command_state = state.commands.remove(&id).unwrap_or_default();
            command_state.command = command;
            command_state.status = ToolStatus::Created;
            command_state.awaiting_approval = false;
            command_state.call_id = id.clone();
            let index = command_state.index.unwrap_or_else(|| {
                add_normalized_entry(msg_store, entry_index, command_state.to_normalized_entry())
            });
            command_state.index = Some(index);
            replace_normalized_entry(msg_store, index, command_state.to_normalized_entry());
            state.commands.insert(id, command_state);
        }
        AppThreadItem::FileChange { id, changes, .. } => {
            let normalized = normalize_app_file_changes(worktree_path, &changes);
            sync_patch_entries(
                state,
                msg_store,
                entry_index,
                id,
                normalized,
                ToolStatus::Created,
                false,
            );
        }
        AppThreadItem::McpToolCall {
            id,
            server,
            tool,
            arguments,
            ..
        } => {
            let tool_state = state.mcp_tools.entry(id.clone()).or_insert(McpToolState {
                index: None,
                invocation: McpInvocation {
                    server,
                    tool,
                    arguments: Some(arguments),
                },
                result: None,
                status: ToolStatus::Created,
            });
            tool_state.status = ToolStatus::Created;
            let index = tool_state.index.unwrap_or_else(|| {
                add_normalized_entry(msg_store, entry_index, tool_state.to_normalized_entry())
            });
            tool_state.index = Some(index);
            replace_normalized_entry(msg_store, index, tool_state.to_normalized_entry());
        }
        AppThreadItem::DynamicToolCall {
            id,
            tool,
            arguments,
            ..
        } => {
            upsert_dynamic_tool_state(
                state,
                msg_store,
                entry_index,
                DynamicToolUpdate {
                    call_id: id,
                    tool,
                    arguments,
                    status: ToolStatus::Created,
                    result: None,
                },
            );
        }
        AppThreadItem::WebSearch(item) => {
            let id = item.id;
            state.web_searches.insert(id.clone(), WebSearchState::new());
            let web_search_state = state.web_searches.get_mut(&id).unwrap();
            let normalized_entry = web_search_state.to_normalized_entry();
            let index = add_normalized_entry(msg_store, entry_index, normalized_entry);
            web_search_state.index = Some(index);
        }
        AppThreadItem::EnteredReviewMode { review, .. } => {
            let mut review_state = ReviewState {
                index: None,
                description: review,
                status: ToolStatus::Created,
                result: None,
            };
            let index =
                add_normalized_entry(msg_store, entry_index, review_state.to_normalized_entry());
            review_state.index = Some(index);
            state.review = Some(review_state);
        }
        item @ (AppThreadItem::CollabAgentToolCall { .. }
        | AppThreadItem::SubAgentActivity { .. }) => {
            handle_collab_thread_item(state, msg_store, entry_index, event_at_ms, item);
        }
        _ => {}
    }
}

fn handle_direct_item_completed(
    notification: AppItemCompletedNotification,
    state: &mut LogState,
    msg_store: &Arc<MsgStore>,
    entry_index: &EntryIndexProvider,
    worktree_path: &str,
) {
    let event_at_ms = notification.completed_at_ms;
    match notification.item {
        AppThreadItem::AgentMessage { text, .. } => {
            state.thinking = None;
            let (entry, index, is_new) = state.assistant_message(text);
            upsert_normalized_entry(msg_store, index, entry, is_new);
            state.assistant = None;
        }
        AppThreadItem::Reasoning { summary, .. } => {
            if !summary.is_empty() {
                state.assistant = None;
                let (entry, index, is_new) = state.thinking(summary.join("\n\n"));
                upsert_normalized_entry(msg_store, index, entry, is_new);
                state.thinking = None;
            }
        }
        AppThreadItem::Plan { id, text } => {
            if let Some(plan_state) = state.plans.get_mut(&id) {
                plan_state.text = text;
                if let Some(index) = plan_state.index {
                    replace_normalized_entry(msg_store, index, plan_state.to_normalized_entry());
                }
            }
        }
        AppThreadItem::CommandExecution {
            id,
            aggregated_output,
            exit_code,
            status,
            ..
        } => {
            if let Some(mut command_state) = state.commands.remove(&id) {
                command_state.formatted_output = aggregated_output;
                command_state.exit_code = exit_code;
                command_state.awaiting_approval = false;
                command_state.status = app_command_status_to_tool_status(&status);
                if let Some(index) = command_state.index {
                    replace_normalized_entry(msg_store, index, command_state.to_normalized_entry());
                }
            }
        }
        AppThreadItem::FileChange { id, status, .. } => {
            if let Some(patch_state) = state.patches.remove(&id) {
                let tool_status = app_patch_status_to_tool_status(&status);
                for mut entry in patch_state.entries {
                    entry.status = tool_status.clone();
                    if let Some(index) = entry.index {
                        replace_normalized_entry(msg_store, index, entry.to_normalized_entry());
                    }
                }
            }
        }
        AppThreadItem::McpToolCall {
            id,
            status,
            result,
            error,
            ..
        } => {
            if let Some(mut mcp_tool_state) = state.mcp_tools.remove(&id) {
                mcp_tool_state.status = app_mcp_status_to_tool_status(&status);
                if let Some(result) = result {
                    if result
                        .content
                        .iter()
                        .all(|block| block.get("type").and_then(|t| t.as_str()) == Some("text"))
                    {
                        mcp_tool_state.result = Some(ToolResult {
                            r#type: ToolResultValueType::Markdown,
                            value: Value::String(
                                result
                                    .content
                                    .iter()
                                    .filter_map(|block| {
                                        block
                                            .get("text")
                                            .and_then(|t| t.as_str())
                                            .map(|s| s.to_owned())
                                    })
                                    .collect::<Vec<String>>()
                                    .join("\n"),
                            ),
                        });
                    } else {
                        let content = result.content;
                        mcp_tool_state.result = Some(ToolResult {
                            r#type: ToolResultValueType::Json,
                            value: result.structured_content.unwrap_or_else(|| {
                                serde_json::to_value(content).unwrap_or_default()
                            }),
                        });
                    }
                } else if let Some(error) = error {
                    mcp_tool_state.result = Some(ToolResult {
                        r#type: ToolResultValueType::Markdown,
                        value: Value::String(error.message),
                    });
                }
                if let Some(index) = mcp_tool_state.index {
                    replace_normalized_entry(
                        msg_store,
                        index,
                        mcp_tool_state.to_normalized_entry(),
                    );
                }
            }
        }
        AppThreadItem::DynamicToolCall {
            id,
            tool,
            arguments,
            status,
            content_items,
            success,
            ..
        } => {
            let dynamic_status = match success {
                Some(false) => ToolStatus::Failed,
                _ => app_dynamic_tool_status_to_tool_status(&status),
            };
            let dynamic_result = content_items.map(|items| {
                ToolResult::markdown(dynamic_tool_markdown_from_app_items(&items, worktree_path))
            });
            upsert_dynamic_tool_state(
                state,
                msg_store,
                entry_index,
                DynamicToolUpdate {
                    call_id: id,
                    tool,
                    arguments,
                    status: dynamic_status,
                    result: dynamic_result,
                },
            );
        }
        AppThreadItem::WebSearch(item) => {
            let id = item.id;
            let query = item.query;
            if let Some(mut entry) = state.web_searches.remove(&id) {
                entry.status = ToolStatus::Success;
                entry.query = Some(query);
                if let Some(index) = entry.index {
                    replace_normalized_entry(msg_store, index, entry.to_normalized_entry());
                }
            }
        }
        AppThreadItem::ImageView { path, .. } => {
            let relative_path = make_path_relative(&path.render_for_ui(), worktree_path);
            add_normalized_entry(
                msg_store,
                entry_index,
                NormalizedEntry {
                    timestamp: None,
                    entry_type: NormalizedEntryType::ToolUse {
                        tool_name: "view_image".to_string(),
                        action_type: ActionType::ImageView {
                            path: relative_path.clone(),
                        },
                        status: ToolStatus::Success,
                    },
                    content: relative_path,
                    metadata: None,
                },
            );
        }
        AppThreadItem::ExitedReviewMode { review, .. } => {
            if let Some(mut review_state) = state.review.take() {
                review_state.status = ToolStatus::Success;
                review_state.result = Some(ToolResult::markdown(review));
                if let Some(index) = review_state.index {
                    replace_normalized_entry(msg_store, index, review_state.to_normalized_entry());
                }
            }
        }
        AppThreadItem::ContextCompaction { .. } => {
            add_normalized_entry(
                msg_store,
                entry_index,
                NormalizedEntry {
                    timestamp: None,
                    entry_type: NormalizedEntryType::SystemMessage,
                    content: "Context compacted".to_string(),
                    metadata: None,
                },
            );
        }
        item @ (AppThreadItem::CollabAgentToolCall { .. }
        | AppThreadItem::SubAgentActivity { .. }) => {
            handle_collab_thread_item(state, msg_store, entry_index, event_at_ms, item);
        }
        _ => {}
    }
}

const COLLAB_AGENT_FALLBACK_DESCRIPTION: &str = "Agent";

/// First line of a collab prompt, capped for display.
fn collab_prompt_line(prompt: &str) -> Option<String> {
    let line = prompt.lines().find(|l| !l.trim().is_empty())?.trim();
    Some(line.chars().take(200).collect())
}

fn upsert_collab_agent(
    agents: &mut HashMap<String, CollabAgentTaskState>,
    msg_store: &Arc<MsgStore>,
    entry_index: &EntryIndexProvider,
    key: &str,
    event_at_ms: i64,
    update: impl FnOnce(&mut CollabAgentTaskState),
) {
    let task = agents.entry(key.to_string()).or_insert_with(|| {
        CollabAgentTaskState::new(COLLAB_AGENT_FALLBACK_DESCRIPTION.to_string(), event_at_ms)
    });
    update(task);
    task.touch(event_at_ms);
    let is_new = task.index.is_none();
    let index = *task.index.get_or_insert_with(|| entry_index.next());
    upsert_normalized_entry(msg_store, index, task.to_normalized_entry(), is_new);
}

fn apply_collab_agent_state(task: &mut CollabAgentTaskState, agent_state: &AppCollabAgentState) {
    let message = agent_state
        .message
        .as_deref()
        .filter(|m| !m.trim().is_empty());
    match agent_state.status {
        AppCollabAgentStatus::PendingInit | AppCollabAgentStatus::Running => {
            task.status = ToolStatus::Created;
        }
        AppCollabAgentStatus::Completed => {
            task.status = ToolStatus::Success;
            if let Some(message) = message {
                task.result = Some(ToolResult::markdown(message.to_string()));
            }
        }
        AppCollabAgentStatus::Errored => {
            task.status = ToolStatus::Failed;
            if let Some(message) = message {
                task.result = Some(ToolResult::markdown(message.to_string()));
            }
        }
        AppCollabAgentStatus::Interrupted => {
            task.status = ToolStatus::Failed;
            task.last_activity = Some("Interrupted".to_string());
        }
        AppCollabAgentStatus::Shutdown => {
            // Normal close: only upgrade a still-running row; keep a final
            // Success/Failed verdict already reported by an earlier wait.
            if matches!(task.status, ToolStatus::Created) {
                task.status = ToolStatus::Success;
            }
        }
        AppCollabAgentStatus::NotFound => {}
    }
}

/// Normalize Codex collab (multi-agent) thread items into one `TaskCreate`
/// entry per spawned agent — the same shape Claude Code Task events use — so
/// the shared subagent panel renders both. Wait/SendInput/Close calls don't get
/// their own entries; they fold into the per-agent rows via `agents_states`.
fn handle_collab_thread_item(
    state: &mut LogState,
    msg_store: &Arc<MsgStore>,
    entry_index: &EntryIndexProvider,
    event_at_ms: i64,
    item: AppThreadItem,
) {
    match item {
        AppThreadItem::CollabAgentToolCall {
            id,
            tool,
            status,
            receiver_thread_ids,
            prompt,
            model,
            agents_states,
            ..
        } => {
            let call_failed = matches!(status, AppCollabAgentToolCallStatus::Failed);
            match tool {
                AppCollabAgentTool::SpawnAgent => {
                    // Spawn begin carries no thread id yet — track the row under
                    // the call id, then re-key it once completion reveals the
                    // spawned agent's thread id.
                    let placeholder_key = format!("call:{id}");
                    let key = match receiver_thread_ids.first() {
                        Some(thread_id) => {
                            if let Some(mut task) = state.collab_agents.remove(&placeholder_key) {
                                if let Some(existing) = state.collab_agents.remove(thread_id) {
                                    // Events for the thread beat the spawn
                                    // completion; fold their outcome into the
                                    // placeholder row.
                                    task.status = existing.status;
                                    task.last_activity =
                                        existing.last_activity.or(task.last_activity);
                                    task.result = existing.result.or(task.result);
                                }
                                state.collab_agents.insert(thread_id.clone(), task);
                            }
                            thread_id.clone()
                        }
                        None => placeholder_key,
                    };
                    upsert_collab_agent(
                        &mut state.collab_agents,
                        msg_store,
                        entry_index,
                        &key,
                        event_at_ms,
                        |task| {
                            if let Some(line) = prompt.as_deref().and_then(collab_prompt_line) {
                                task.description = line;
                            }
                            if model.is_some() {
                                task.subagent_type = model;
                            }
                            if call_failed {
                                task.status = ToolStatus::Failed;
                            }
                        },
                    );
                }
                AppCollabAgentTool::SendInput | AppCollabAgentTool::ResumeAgent => {
                    if !call_failed {
                        let activity = prompt.as_deref().and_then(collab_prompt_line);
                        for thread_id in &receiver_thread_ids {
                            upsert_collab_agent(
                                &mut state.collab_agents,
                                msg_store,
                                entry_index,
                                thread_id,
                                event_at_ms,
                                |task| {
                                    task.status = ToolStatus::Created;
                                    if activity.is_some() {
                                        task.last_activity = activity.clone();
                                    }
                                },
                            );
                        }
                    }
                }
                AppCollabAgentTool::Wait | AppCollabAgentTool::CloseAgent => {}
            }
            for (thread_id, agent_state) in &agents_states {
                // A NotFound answer for a thread we never rendered must not
                // fabricate a phantom "Agent" row stuck in running state.
                if matches!(agent_state.status, AppCollabAgentStatus::NotFound)
                    && !state.collab_agents.contains_key(thread_id)
                {
                    continue;
                }
                upsert_collab_agent(
                    &mut state.collab_agents,
                    msg_store,
                    entry_index,
                    thread_id,
                    event_at_ms,
                    |task| apply_collab_agent_state(task, agent_state),
                );
            }
        }
        AppThreadItem::SubAgentActivity {
            kind,
            agent_thread_id,
            agent_path,
            ..
        } => {
            let agent_name = agent_path
                .rsplit('/')
                .find(|segment| !segment.is_empty())
                .map(|segment| segment.to_string());
            upsert_collab_agent(
                &mut state.collab_agents,
                msg_store,
                entry_index,
                &agent_thread_id,
                event_at_ms,
                |task| {
                    if task.description == COLLAB_AGENT_FALLBACK_DESCRIPTION
                        && let Some(name) = agent_name
                    {
                        task.description = name;
                    }
                    match kind {
                        AppSubAgentActivityKind::Started => {
                            task.status = ToolStatus::Created;
                            task.last_activity = Some("Started".to_string());
                        }
                        AppSubAgentActivityKind::Interacted => {
                            task.status = ToolStatus::Created;
                            task.last_activity = Some("Working".to_string());
                        }
                        AppSubAgentActivityKind::Interrupted => {
                            task.status = ToolStatus::Failed;
                            task.last_activity = Some("Interrupted".to_string());
                        }
                    }
                },
            );
        }
        _ => {}
    }
}

fn handle_direct_request(
    request: ServerRequest,
    state: &mut LogState,
    msg_store: &Arc<MsgStore>,
    entry_index: &EntryIndexProvider,
) -> bool {
    match request {
        ServerRequest::CommandExecutionRequestApproval { params, .. } => {
            let call_id = params.item_id;
            let approval_id = params.approval_id.unwrap_or_default();
            let command_state = state.command_state(call_id.clone());
            if let Some(command) = params.command.filter(|command| !command.is_empty()) {
                command_state.command = command;
            } else if command_state.command.is_empty() {
                command_state.command = params
                    .reason
                    .filter(|reason| !reason.is_empty())
                    .unwrap_or_else(|| "command execution".to_string());
            }
            command_state.awaiting_approval = true;
            command_state.status = ToolStatus::PendingApproval { approval_id };
            if let Some(index) = command_state.index {
                replace_normalized_entry(msg_store, index, command_state.to_normalized_entry());
            } else {
                let index = add_normalized_entry(
                    msg_store,
                    entry_index,
                    command_state.to_normalized_entry(),
                );
                command_state.index = Some(index);
            }
            true
        }
        ServerRequest::ToolRequestUserInput { params, .. } => {
            upsert_question_request_state(
                state,
                msg_store,
                entry_index,
                params.item_id,
                &params.questions,
            );
            true
        }
        ServerRequest::DynamicToolCall { params, .. } => {
            upsert_dynamic_tool_state(
                state,
                msg_store,
                entry_index,
                DynamicToolUpdate {
                    call_id: params.call_id,
                    tool: params.tool,
                    arguments: params.arguments,
                    status: ToolStatus::Created,
                    result: None,
                },
            );
            true
        }
        _ => false,
    }
}

fn handle_direct_notification(
    notification: ServerNotification,
    state: &mut LogState,
    msg_store: &Arc<MsgStore>,
    entry_index: &EntryIndexProvider,
    worktree_path: &str,
) -> bool {
    match notification {
        ServerNotification::ThreadStarted(n) => {
            msg_store.push_session_id(n.thread.id);
            true
        }
        ServerNotification::ThreadTokenUsageUpdated(notification) => {
            add_thread_token_usage(notification, msg_store, entry_index);
            true
        }
        ServerNotification::AgentMessageDelta(notification) => {
            state.thinking = None;
            let (entry, index, is_new) = state.assistant_message_append(notification.delta);
            upsert_normalized_entry(msg_store, index, entry, is_new);
            true
        }
        ServerNotification::ReasoningSummaryTextDelta(notification) => {
            state.assistant = None;
            let (entry, index, is_new) = state.thinking_append(notification.delta);
            upsert_normalized_entry(msg_store, index, entry, is_new);
            true
        }
        ServerNotification::ReasoningTextDelta(notification) => {
            state.assistant = None;
            let (entry, index, is_new) = state.thinking_append(notification.delta);
            upsert_normalized_entry(msg_store, index, entry, is_new);
            true
        }
        ServerNotification::ReasoningSummaryPartAdded(..) => {
            state.assistant = None;
            state.thinking = None;
            true
        }
        ServerNotification::PlanDelta(notification) => {
            state.thinking = None;
            if let Some(plan_state) = state.plans.get_mut(&notification.item_id) {
                plan_state.text.push_str(&notification.delta);
                if let Some(index) = plan_state.index {
                    replace_normalized_entry(msg_store, index, plan_state.to_normalized_entry());
                }
            } else {
                let (entry, index, is_new) = state.assistant_message_append(notification.delta);
                upsert_normalized_entry(msg_store, index, entry, is_new);
            }
            true
        }
        ServerNotification::CommandExecutionOutputDelta(
            CommandExecutionOutputDeltaNotification { item_id, delta, .. },
        ) => {
            if let Some(command_state) = state.commands.get_mut(&item_id) {
                command_state.stdout.push_str(&delta);
                if let Some(index) = command_state.index {
                    replace_normalized_entry(msg_store, index, command_state.to_normalized_entry());
                }
            }
            true
        }
        ServerNotification::FileChangePatchUpdated(FileChangePatchUpdatedNotification {
            item_id,
            changes,
            ..
        }) => {
            state.assistant = None;
            state.thinking = None;
            let normalized = normalize_app_file_changes(worktree_path, &changes);
            sync_patch_entries(
                state,
                msg_store,
                entry_index,
                item_id,
                normalized,
                ToolStatus::Created,
                false,
            );
            true
        }
        ServerNotification::FileChangeOutputDelta(FileChangeOutputDeltaNotification { .. })
        | ServerNotification::McpToolCallProgress(McpToolCallProgressNotification { .. })
        | ServerNotification::ThreadStatusChanged(..)
        | ServerNotification::TurnCompleted(..)
        | ServerNotification::TurnStarted(..) => true,
        ServerNotification::ItemStarted(notification) => {
            handle_direct_item_started(notification, state, msg_store, entry_index, worktree_path);
            true
        }
        ServerNotification::ItemCompleted(notification) => {
            handle_direct_item_completed(
                notification,
                state,
                msg_store,
                entry_index,
                worktree_path,
            );
            true
        }
        ServerNotification::ModelRerouted(notification) => {
            add_normalized_entry(
                msg_store,
                entry_index,
                NormalizedEntry {
                    timestamp: None,
                    entry_type: NormalizedEntryType::SystemMessage,
                    content: format!(
                        "warning: model rerouted from {} to {}",
                        notification.from_model, notification.to_model
                    ),
                    metadata: None,
                },
            );
            true
        }
        ServerNotification::ConfigWarning(notification) => {
            let details = notification
                .details
                .as_deref()
                .map(str::trim)
                .filter(|details| !details.is_empty())
                .map(|details| format!("\n{details}"))
                .unwrap_or_default();
            add_normalized_entry(
                msg_store,
                entry_index,
                NormalizedEntry {
                    timestamp: None,
                    entry_type: NormalizedEntryType::ErrorMessage {
                        error_type: NormalizedEntryError::Other,
                    },
                    content: format!("{}{}", notification.summary, details),
                    metadata: None,
                },
            );
            true
        }
        ServerNotification::Error(notification) => {
            add_normalized_entry(
                msg_store,
                entry_index,
                NormalizedEntry {
                    timestamp: None,
                    entry_type: NormalizedEntryType::ErrorMessage {
                        error_type: NormalizedEntryError::Other,
                    },
                    content: format!("Error: {}", notification.error.message),
                    metadata: None,
                },
            );
            true
        }
        ServerNotification::ContextCompacted(..) => {
            add_normalized_entry(
                msg_store,
                entry_index,
                NormalizedEntry {
                    timestamp: None,
                    entry_type: NormalizedEntryType::SystemMessage,
                    content: "Context compacted".to_string(),
                    metadata: None,
                },
            );
            true
        }
        _ => false,
    }
}

fn format_todo_status(status: &StepStatus) -> String {
    match status {
        StepStatus::Pending => "pending",
        StepStatus::InProgress => "in_progress",
        StepStatus::Completed => "completed",
    }
    .to_string()
}

/// Stderr patterns from codex internals that should be suppressed from user-visible logs.
const SUPPRESSED_STDERR_PATTERNS: &[&str] = &[
    // Codex unconditionally logs this error during its SQLite migration when a rollout file
    // exists on disk but isn't indexed in the state DB — even when the Sqlite feature flag is
    // disabled (which is the default). See: https://github.com/openai/codex/commit/c38a5958
    "state db missing rollout path for",
    // A Codex upgrade can leave models_cache.json in the previous schema. The CLI logs this
    // while discarding the stale cache and refreshing the model catalog, so it is not an agent
    // response parsing failure and should not be surfaced as a failed turn.
    "failed to load models cache: missing field `supports_reasoning_summaries`",
];

/// Codex-specific stderr normalizer that filters noisy internal messages.
fn normalize_codex_stderr_logs(
    msg_store: Arc<MsgStore>,
    entry_index_provider: EntryIndexProvider,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut stderr = msg_store.stderr_chunked_stream();
        let mut processor = PlainTextLogProcessor::builder()
            .normalized_entry_producer(|content: String| NormalizedEntry {
                timestamp: None,
                entry_type: NormalizedEntryType::ErrorMessage {
                    error_type: NormalizedEntryError::Other,
                },
                content: strip_ansi_escapes::strip_str(&content),
                metadata: None,
            })
            .time_gap(Duration::from_secs(2))
            .index_provider(entry_index_provider)
            .transform_lines(Box::new(|lines: &mut Vec<String>| {
                lines.retain(|line| {
                    !SUPPRESSED_STDERR_PATTERNS
                        .iter()
                        .any(|pattern| line.contains(pattern))
                });
            }))
            .build();

        while let Some(Ok(chunk)) = stderr.next().await {
            for patch in processor.process(chunk) {
                msg_store.push_patch(patch);
            }
        }
    })
}

pub fn normalize_logs(
    msg_store: Arc<MsgStore>,
    worktree_path: &Path,
) -> Vec<tokio::task::JoinHandle<()>> {
    let entry_index = EntryIndexProvider::start_from(&msg_store);
    let h1 = normalize_codex_stderr_logs(msg_store.clone(), entry_index.clone());

    let worktree_path_str = worktree_path.to_string_lossy().to_string();
    let h2 = tokio::spawn(async move {
        let mut state = LogState::new(entry_index.clone());
        let mut stdout_lines = msg_store.stdout_lines_stream();

        // When replaying a completed process, the store hands back buffered
        // lines that are immediately `Ready`, so this loop never awaits and
        // never yields to the tokio scheduler. Parsing each line is CPU-bound
        // (serde_json), so a large log (tens of thousands of lines) monopolizes
        // its worker thread and, with a few streams in flight, starves the
        // whole pool — stalling `/api/health` until the supervisor kills us.
        // Cooperatively yield every so often to keep the workers responsive.
        let mut processed_lines: usize = 0;
        while let Some(Ok(line)) = stdout_lines.next().await {
            processed_lines += 1;
            if processed_lines.is_multiple_of(256) {
                tokio::task::yield_now().await;
            }
            if let Ok(rate_limit) = serde_json::from_str::<RateLimit>(&line) {
                add_normalized_entry(&msg_store, &entry_index, rate_limit.to_normalized_entry());
                continue;
            }

            if let Ok(error) = serde_json::from_str::<Error>(&line) {
                add_normalized_entry(&msg_store, &entry_index, error.to_normalized_entry());
                continue;
            }

            if let Ok(approval) = serde_json::from_str::<Approval>(&line) {
                match &approval {
                    Approval::ApprovalRequested {
                        call_id,
                        approval_id,
                        ..
                    } => {
                        let pending_status = ToolStatus::PendingApproval {
                            approval_id: approval_id.clone(),
                        };
                        state.update_tool_status(call_id, pending_status, false, &msg_store);
                    }
                    Approval::ApprovalResponse {
                        call_id,
                        approval_status,
                        ..
                    } => {
                        if let Some(status) = ToolStatus::from_approval_status(approval_status) {
                            state.update_tool_status(call_id, status, true, &msg_store);
                        }

                        if let Some(entry) = approval.to_normalized_entry_opt() {
                            add_normalized_entry(&msg_store, &entry_index, entry);
                        }
                    }
                    Approval::QuestionResponse {
                        call_id,
                        question_status,
                    } => {
                        let status = ToolStatus::from_question_status(question_status);
                        state.update_tool_status(call_id, status, true, &msg_store);

                        if let Some(entry) = approval.to_normalized_entry_opt() {
                            add_normalized_entry(&msg_store, &entry_index, entry);
                        }
                    }
                }
                continue;
            }

            if let Ok(response) = serde_json::from_str::<JSONRPCResponse>(&line) {
                handle_jsonrpc_response(
                    response,
                    &msg_store,
                    &entry_index,
                    &mut state.model_params,
                );
                continue;
            }

            if let Ok(server_notification) = serde_json::from_str::<ServerNotification>(&line) {
                if handle_direct_notification(
                    server_notification,
                    &mut state,
                    &msg_store,
                    &entry_index,
                    &worktree_path_str,
                ) {
                    continue;
                }
            } else if let Some(session_id) = line
                .strip_prefix(r#"{"method":"sessionConfigured","params":{"sessionId":""#)
                .and_then(|suffix| SESSION_ID.captures(suffix).and_then(|caps| caps.get(1)))
            {
                // Best-effort extraction of session ID from logs in case the JSON parsing fails.
                // This could happen if the line is truncated due to size limits because it includes the full session history.
                msg_store.push_session_id(session_id.as_str().to_string());
                continue;
            }

            if let Ok(request) = serde_json::from_str::<JSONRPCRequest>(&line)
                && let Ok(server_request) = ServerRequest::try_from(request)
                && handle_direct_request(server_request, &mut state, &msg_store, &entry_index)
            {
                continue;
            }

            let notification: JSONRPCNotification = match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(_) => continue,
            };

            if !notification.method.starts_with("codex/event") {
                continue;
            }

            let Some(params) = notification
                .params
                .and_then(|p| serde_json::from_value::<CodexNotificationParams>(p).ok())
            else {
                continue;
            };

            let event = params.msg;
            match event {
                EventMsg::SessionConfigured(payload) => {
                    msg_store.push_session_id(payload.session_id.to_string());
                    handle_model_params(
                        Some(payload.model),
                        payload.reasoning_effort,
                        &msg_store,
                        &entry_index,
                        &mut state.model_params,
                    );
                }
                EventMsg::AgentMessageContentDelta(AgentMessageContentDeltaEvent {
                    delta, ..
                }) => {
                    state.thinking = None;
                    let (entry, index, is_new) = state.assistant_message_append(delta);
                    upsert_normalized_entry(&msg_store, index, entry, is_new);
                }
                EventMsg::ReasoningContentDelta(ReasoningContentDeltaEvent { delta, .. }) => {
                    state.assistant = None;
                    let (entry, index, is_new) = state.thinking_append(delta);
                    upsert_normalized_entry(&msg_store, index, entry, is_new);
                }
                EventMsg::ReasoningRawContentDelta(ReasoningRawContentDeltaEvent {
                    delta, ..
                }) => {
                    state.assistant = None;
                    let (entry, index, is_new) = state.thinking_append(delta);
                    upsert_normalized_entry(&msg_store, index, entry, is_new);
                }
                EventMsg::AgentMessage(AgentMessageEvent { message, .. }) => {
                    state.thinking = None;
                    let (entry, index, is_new) = state.assistant_message(message);
                    upsert_normalized_entry(&msg_store, index, entry, is_new);
                    state.assistant = None;
                }
                EventMsg::AgentReasoning(AgentReasoningEvent { text }) => {
                    state.assistant = None;
                    let (entry, index, is_new) = state.thinking(text);
                    upsert_normalized_entry(&msg_store, index, entry, is_new);
                    state.thinking = None;
                }
                EventMsg::AgentReasoningRawContent(AgentReasoningRawContentEvent { text }) => {
                    state.assistant = None;
                    let (entry, index, is_new) = state.thinking(text);
                    upsert_normalized_entry(&msg_store, index, entry, is_new);
                    state.thinking = None;
                }
                EventMsg::AgentReasoningSectionBreak(AgentReasoningSectionBreakEvent {
                    item_id: _,
                    summary_index: _,
                }) => {
                    state.assistant = None;
                    state.thinking = None;
                }
                EventMsg::ExecApprovalRequest(ExecApprovalRequestEvent {
                    call_id,
                    turn_id: _,
                    command,
                    cwd: _,
                    reason,
                    parsed_cmd: _,
                    proposed_execpolicy_amendment: _,
                    ..
                }) => {
                    state.assistant = None;
                    state.thinking = None;

                    let command_text = if command.is_empty() {
                        reason
                            .filter(|r| !r.is_empty())
                            .unwrap_or_else(|| "command execution".to_string())
                    } else {
                        command.join(" ")
                    };

                    let command_state = state.commands.entry(call_id.clone()).or_default();

                    if command_state.command.is_empty() {
                        command_state.command = command_text;
                    }
                    command_state.awaiting_approval = true;
                    command_state.call_id = call_id.clone();
                    if let Some(index) = command_state.index {
                        replace_normalized_entry(
                            &msg_store,
                            index,
                            command_state.to_normalized_entry(),
                        );
                    } else {
                        let index = add_normalized_entry(
                            &msg_store,
                            &entry_index,
                            command_state.to_normalized_entry(),
                        );
                        command_state.index = Some(index);
                    }
                }
                EventMsg::ApplyPatchApprovalRequest(ApplyPatchApprovalRequestEvent {
                    call_id,
                    turn_id: _,
                    changes,
                    reason: _,
                    grant_root: _,
                    ..
                }) => {
                    state.assistant = None;
                    state.thinking = None;

                    let normalized = normalize_file_changes(&worktree_path_str, &changes);
                    sync_patch_entries(
                        &mut state,
                        &msg_store,
                        &entry_index,
                        call_id,
                        normalized,
                        ToolStatus::Created,
                        true,
                    );
                }
                EventMsg::ExecCommandBegin(ExecCommandBeginEvent {
                    call_id,
                    turn_id: _,
                    command,
                    cwd: _,
                    parsed_cmd: _,
                    source: _,
                    interaction_input: _,
                    process_id: _,
                    ..
                }) => {
                    state.assistant = None;
                    state.thinking = None;
                    let command_text = command.join(" ");
                    if command_text.is_empty() {
                        continue;
                    }
                    state.commands.insert(
                        call_id.clone(),
                        CommandState {
                            index: None,
                            command: command_text,
                            stdout: String::new(),
                            stderr: String::new(),
                            formatted_output: None,
                            status: ToolStatus::Created,
                            exit_code: None,
                            awaiting_approval: false,
                            call_id: call_id.clone(),
                        },
                    );
                    let command_state = state.commands.get_mut(&call_id).unwrap();
                    let index = add_normalized_entry(
                        &msg_store,
                        &entry_index,
                        command_state.to_normalized_entry(),
                    );
                    command_state.index = Some(index)
                }
                EventMsg::ExecCommandOutputDelta(ExecCommandOutputDeltaEvent {
                    call_id,
                    stream,
                    chunk,
                }) => {
                    if let Some(command_state) = state.commands.get_mut(&call_id) {
                        let chunk = String::from_utf8_lossy(&chunk);
                        if chunk.is_empty() {
                            continue;
                        }
                        match stream {
                            ExecOutputStream::Stdout => command_state.stdout.push_str(&chunk),
                            ExecOutputStream::Stderr => command_state.stderr.push_str(&chunk),
                        }
                        let Some(index) = command_state.index else {
                            tracing::error!("missing entry index for existing command state");
                            continue;
                        };
                        replace_normalized_entry(
                            &msg_store,
                            index,
                            command_state.to_normalized_entry(),
                        );
                    }
                }
                EventMsg::ExecCommandEnd(ExecCommandEndEvent {
                    call_id,
                    turn_id: _,
                    command: _,
                    cwd: _,
                    parsed_cmd: _,
                    source: _,
                    interaction_input: _,
                    stdout: _,
                    stderr: _,
                    aggregated_output: _,
                    exit_code,
                    duration: _,
                    formatted_output,
                    process_id: _,
                    ..
                }) => {
                    if let Some(mut command_state) = state.commands.remove(&call_id) {
                        command_state.formatted_output = Some(formatted_output);
                        command_state.exit_code = Some(exit_code);
                        command_state.awaiting_approval = false;
                        command_state.status = if exit_code == 0 {
                            ToolStatus::Success
                        } else {
                            ToolStatus::Failed
                        };
                        let Some(index) = command_state.index else {
                            tracing::error!("missing entry index for existing command state");
                            continue;
                        };
                        replace_normalized_entry(
                            &msg_store,
                            index,
                            command_state.to_normalized_entry(),
                        );
                    }
                }
                EventMsg::StreamError(StreamErrorEvent {
                    message,
                    codex_error_info,
                    ..
                }) => {
                    add_normalized_entry(
                        &msg_store,
                        &entry_index,
                        NormalizedEntry {
                            timestamp: None,
                            entry_type: NormalizedEntryType::ErrorMessage {
                                error_type: NormalizedEntryError::Other,
                            },
                            content: format!("Stream error: {message} {codex_error_info:?}"),
                            metadata: None,
                        },
                    );
                }
                EventMsg::McpToolCallBegin(McpToolCallBeginEvent {
                    call_id,
                    invocation,
                    ..
                }) => {
                    state.assistant = None;
                    state.thinking = None;
                    state.mcp_tools.insert(
                        call_id.clone(),
                        McpToolState {
                            index: None,
                            invocation,
                            result: None,
                            status: ToolStatus::Created,
                        },
                    );
                    let mcp_tool_state = state.mcp_tools.get_mut(&call_id).unwrap();
                    let index = add_normalized_entry(
                        &msg_store,
                        &entry_index,
                        mcp_tool_state.to_normalized_entry(),
                    );
                    mcp_tool_state.index = Some(index);
                }
                EventMsg::McpToolCallEnd(McpToolCallEndEvent {
                    call_id, result, ..
                }) => {
                    if let Some(mut mcp_tool_state) = state.mcp_tools.remove(&call_id) {
                        match result {
                            Ok(value) => {
                                mcp_tool_state.status = if value.is_error.unwrap_or(false) {
                                    ToolStatus::Failed
                                } else {
                                    ToolStatus::Success
                                };
                                if value.content.iter().all(|block| {
                                    block.get("type").and_then(|t| t.as_str()) == Some("text")
                                }) {
                                    mcp_tool_state.result = Some(ToolResult {
                                        r#type: ToolResultValueType::Markdown,
                                        value: Value::String(
                                            value
                                                .content
                                                .iter()
                                                .filter_map(|block| {
                                                    block
                                                        .get("text")
                                                        .and_then(|t| t.as_str())
                                                        .map(|s| s.to_owned())
                                                })
                                                .collect::<Vec<String>>()
                                                .join("\n"),
                                        ),
                                    });
                                } else {
                                    mcp_tool_state.result = Some(ToolResult {
                                        r#type: ToolResultValueType::Json,
                                        value: value.structured_content.unwrap_or_else(|| {
                                            serde_json::to_value(value.content).unwrap_or_default()
                                        }),
                                    });
                                }
                            }
                            Err(err) => {
                                mcp_tool_state.status = ToolStatus::Failed;
                                mcp_tool_state.result = Some(ToolResult {
                                    r#type: ToolResultValueType::Markdown,
                                    value: Value::String(err),
                                });
                            }
                        };
                        let Some(index) = mcp_tool_state.index else {
                            tracing::error!("missing entry index for existing mcp tool state");
                            continue;
                        };
                        replace_normalized_entry(
                            &msg_store,
                            index,
                            mcp_tool_state.to_normalized_entry(),
                        );
                    }
                }
                EventMsg::DynamicToolCallRequest(request) => {
                    upsert_dynamic_tool_state(
                        &mut state,
                        &msg_store,
                        &entry_index,
                        DynamicToolUpdate {
                            call_id: request.call_id,
                            tool: request.tool,
                            arguments: request.arguments,
                            status: ToolStatus::Created,
                            result: None,
                        },
                    );
                }
                EventMsg::DynamicToolCallResponse(response) => {
                    let mut result_text = dynamic_tool_markdown_from_core_items(
                        &response.content_items,
                        &worktree_path_str,
                    );
                    if let Some(error) = response.error
                        && !error.trim().is_empty()
                    {
                        if !result_text.is_empty() {
                            result_text.push('\n');
                        }
                        result_text.push_str(&error);
                    }
                    let result = if result_text.is_empty() {
                        None
                    } else {
                        Some(ToolResult::markdown(result_text))
                    };
                    let status = if response.success {
                        ToolStatus::Success
                    } else {
                        ToolStatus::Failed
                    };
                    upsert_dynamic_tool_state(
                        &mut state,
                        &msg_store,
                        &entry_index,
                        DynamicToolUpdate {
                            call_id: response.call_id,
                            tool: response.tool,
                            arguments: response.arguments,
                            status,
                            result,
                        },
                    );
                }
                EventMsg::PatchApplyBegin(PatchApplyBeginEvent {
                    call_id, changes, ..
                }) => {
                    state.assistant = None;
                    state.thinking = None;
                    let normalized = normalize_file_changes(&worktree_path_str, &changes);
                    sync_patch_entries(
                        &mut state,
                        &msg_store,
                        &entry_index,
                        call_id,
                        normalized,
                        ToolStatus::Created,
                        false,
                    );
                }
                EventMsg::PatchApplyUpdated(PatchApplyUpdatedEvent {
                    call_id, changes, ..
                }) => {
                    state.assistant = None;
                    state.thinking = None;
                    let normalized = normalize_file_changes(&worktree_path_str, &changes);
                    sync_patch_entries(
                        &mut state,
                        &msg_store,
                        &entry_index,
                        call_id,
                        normalized,
                        ToolStatus::Created,
                        false,
                    );
                }
                EventMsg::PatchApplyEnd(PatchApplyEndEvent {
                    call_id,
                    stdout: _,
                    stderr: _,
                    success,
                    ..
                }) => {
                    if let Some(patch_state) = state.patches.remove(&call_id) {
                        let status = if success {
                            ToolStatus::Success
                        } else {
                            ToolStatus::Failed
                        };
                        for mut entry in patch_state.entries {
                            entry.status = status.clone();
                            let Some(index) = entry.index else {
                                tracing::error!("missing entry index for existing patch entry");
                                continue;
                            };
                            replace_normalized_entry(
                                &msg_store,
                                index,
                                entry.to_normalized_entry(),
                            );
                        }
                    }
                }
                EventMsg::WebSearchBegin(WebSearchBeginEvent { call_id }) => {
                    state.assistant = None;
                    state.thinking = None;
                    state
                        .web_searches
                        .insert(call_id.clone(), WebSearchState::new());
                    let web_search_state = state.web_searches.get_mut(&call_id).unwrap();
                    let normalized_entry = web_search_state.to_normalized_entry();
                    let index = add_normalized_entry(&msg_store, &entry_index, normalized_entry);
                    web_search_state.index = Some(index);
                }
                EventMsg::WebSearchEnd(WebSearchEndEvent { call_id, query, .. }) => {
                    state.assistant = None;
                    state.thinking = None;
                    if let Some(mut entry) = state.web_searches.remove(&call_id) {
                        entry.status = ToolStatus::Success;
                        entry.query = Some(query.clone());
                        let normalized_entry = entry.to_normalized_entry();
                        let Some(index) = entry.index else {
                            tracing::error!("missing entry index for existing websearch entry");
                            continue;
                        };
                        replace_normalized_entry(&msg_store, index, normalized_entry);
                    }
                }
                EventMsg::ViewImageToolCall(ViewImageToolCallEvent { call_id: _, path }) => {
                    state.assistant = None;
                    state.thinking = None;
                    let path_str = path.inferred_native_path_string();
                    let relative_path = make_path_relative(&path_str, &worktree_path_str);
                    add_normalized_entry(
                        &msg_store,
                        &entry_index,
                        NormalizedEntry {
                            timestamp: None,
                            entry_type: NormalizedEntryType::ToolUse {
                                tool_name: "view_image".to_string(),
                                action_type: ActionType::ImageView {
                                    path: relative_path.clone(),
                                },
                                status: ToolStatus::Success,
                            },
                            content: relative_path.to_string(),
                            metadata: None,
                        },
                    );
                }
                EventMsg::PlanUpdate(UpdatePlanArgs { plan, explanation }) => {
                    let todos: Vec<TodoItem> = plan
                        .iter()
                        .map(|item| TodoItem {
                            content: item.step.clone(),
                            status: format_todo_status(&item.status),
                            priority: None,
                        })
                        .collect();
                    let explanation = explanation
                        .as_ref()
                        .map(|text| text.trim())
                        .filter(|text| !text.is_empty())
                        .map(|text| text.to_string());
                    let content = explanation.clone().unwrap_or_else(|| {
                        if todos.is_empty() {
                            "Plan updated".to_string()
                        } else {
                            format!("Plan updated ({} steps)", todos.len())
                        }
                    });

                    add_normalized_entry(
                        &msg_store,
                        &entry_index,
                        NormalizedEntry {
                            timestamp: None,
                            entry_type: NormalizedEntryType::ToolUse {
                                tool_name: "plan".to_string(),
                                action_type: ActionType::TodoManagement {
                                    todos,
                                    operation: "update".to_string(),
                                },
                                status: ToolStatus::Success,
                            },
                            content,
                            metadata: None,
                        },
                    );
                }
                EventMsg::Warning(WarningEvent { message }) => {
                    add_normalized_entry(
                        &msg_store,
                        &entry_index,
                        NormalizedEntry {
                            timestamp: None,
                            entry_type: NormalizedEntryType::ErrorMessage {
                                error_type: NormalizedEntryError::Other,
                            },
                            content: message,
                            metadata: None,
                        },
                    );
                }
                EventMsg::ModelReroute(ModelRerouteEvent {
                    from_model,
                    to_model,
                    ..
                }) => {
                    add_normalized_entry(
                        &msg_store,
                        &entry_index,
                        NormalizedEntry {
                            timestamp: None,
                            entry_type: NormalizedEntryType::SystemMessage,
                            content: format!(
                                "warning: model rerouted from {from_model} to {to_model}"
                            ),
                            metadata: None,
                        },
                    );
                }
                EventMsg::Error(ErrorEvent {
                    message,
                    codex_error_info,
                }) => {
                    add_normalized_entry(
                        &msg_store,
                        &entry_index,
                        NormalizedEntry {
                            timestamp: None,
                            entry_type: NormalizedEntryType::ErrorMessage {
                                error_type: NormalizedEntryError::Other,
                            },
                            content: format!("Error: {message} {codex_error_info:?}"),
                            metadata: None,
                        },
                    );
                }
                EventMsg::TokenCount(payload) => {
                    if let Some(info) = payload.info {
                        add_normalized_entry(
                            &msg_store,
                            &entry_index,
                            NormalizedEntry {
                                timestamp: None,
                                entry_type: NormalizedEntryType::TokenUsageInfo(
                                    crate::logs::TokenUsageInfo {
                                        total_tokens: info.last_token_usage.total_tokens as u32,
                                        model_context_window: info
                                            .model_context_window
                                            .unwrap_or_default()
                                            as u32,
                                    },
                                ),
                                content: format!(
                                    "Tokens used: {} / Context window: {}",
                                    info.last_token_usage.total_tokens,
                                    info.model_context_window.unwrap_or_default()
                                ),
                                metadata: None,
                            },
                        );
                    }
                }
                EventMsg::EnteredReviewMode(review_request) => {
                    let mut review_state = ReviewState {
                        index: None,
                        description: review_request
                            .user_facing_hint
                            .unwrap_or_else(|| "Reviewing code...".to_string()),
                        status: ToolStatus::Created,
                        result: None,
                    };
                    let index = add_normalized_entry(
                        &msg_store,
                        &entry_index,
                        review_state.to_normalized_entry(),
                    );
                    review_state.index = Some(index);
                    state.review = Some(review_state);
                }
                EventMsg::ExitedReviewMode(review_event) => {
                    if let Some(mut review_state) = state.review.take() {
                        review_state.complete(&review_event, &worktree_path_str);
                        if let Some(index) = review_state.index {
                            replace_normalized_entry(
                                &msg_store,
                                index,
                                review_state.to_normalized_entry(),
                            );
                        }
                    }
                }
                EventMsg::RequestUserInput(RequestUserInputEvent {
                    call_id,
                    turn_id: _,
                    questions: event_questions,
                    auto_resolution_ms: _,
                }) => {
                    state.assistant = None;
                    state.thinking = None;

                    if call_id.is_empty() {
                        continue;
                    }

                    upsert_question_request_state(
                        &mut state,
                        &msg_store,
                        &entry_index,
                        call_id,
                        &event_questions,
                    );
                }
                EventMsg::PlanDelta(PlanDeltaEvent { delta, item_id, .. }) => {
                    state.thinking = None;
                    if let Some(plan_state) = state.plans.get_mut(&item_id) {
                        plan_state.text.push_str(&delta);
                        if let Some(index) = plan_state.index {
                            replace_normalized_entry(
                                &msg_store,
                                index,
                                plan_state.to_normalized_entry(),
                            );
                        }
                    } else {
                        // Backward compat: if no plan state, treat as assistant text
                        let (entry, index, is_new) = state.assistant_message_append(delta);
                        upsert_normalized_entry(&msg_store, index, entry, is_new);
                    }
                }
                EventMsg::ContextCompacted(..) => {
                    add_normalized_entry(
                        &msg_store,
                        &entry_index,
                        NormalizedEntry {
                            timestamp: None,
                            entry_type: NormalizedEntryType::SystemMessage,
                            content: "Context compacted".to_string(),
                            metadata: None,
                        },
                    );
                }
                EventMsg::ItemStarted(ItemStartedEvent {
                    item: TurnItem::Plan(ref plan_item),
                    ..
                }) => {
                    state.assistant = None;
                    state.thinking = None;
                    let mut plan_state = PlanState {
                        index: None,
                        text: String::new(),
                        status: ToolStatus::Created,
                    };
                    let index = add_normalized_entry(
                        &msg_store,
                        &entry_index,
                        plan_state.to_normalized_entry(),
                    );
                    plan_state.index = Some(index);
                    state.plans.insert(plan_item.id.clone(), plan_state);
                }
                EventMsg::ItemCompleted(ItemCompletedEvent {
                    item: TurnItem::Plan(ref plan_item),
                    ..
                }) => {
                    if let Some(plan_state) = state.plans.get_mut(&plan_item.id) {
                        plan_state.text = plan_item.text.clone();
                        if let Some(index) = plan_state.index {
                            replace_normalized_entry(
                                &msg_store,
                                index,
                                plan_state.to_normalized_entry(),
                            );
                        }
                    }
                }
                _ => {}
            }
        }
    });

    vec![h1, h2]
}

fn handle_jsonrpc_response(
    response: JSONRPCResponse,
    msg_store: &Arc<MsgStore>,
    entry_index: &EntryIndexProvider,
    model_params: &mut ModelParamsState,
) {
    if let Ok(resp) = serde_json::from_value::<ThreadStartResponse>(response.result.clone()) {
        msg_store.push_session_id(resp.thread.id);
        handle_model_params(
            Some(resp.model),
            resp.reasoning_effort,
            msg_store,
            entry_index,
            model_params,
        );
        return;
    }

    if let Ok(resp) = serde_json::from_value::<ThreadForkResponse>(response.result.clone()) {
        msg_store.push_session_id(resp.thread.id);
        handle_model_params(
            Some(resp.model),
            resp.reasoning_effort,
            msg_store,
            entry_index,
            model_params,
        );
    }
}

fn handle_model_params(
    model: Option<String>,
    reasoning_effort: Option<ReasoningEffort>,
    msg_store: &Arc<MsgStore>,
    entry_index: &EntryIndexProvider,
    state: &mut ModelParamsState,
) {
    if let Some(model) = model {
        state.model = Some(model);
    }
    if let Some(reasoning_effort) = reasoning_effort {
        state.reasoning_effort = Some(reasoning_effort);
    }

    let mut params = vec![];
    if let Some(model) = &state.model {
        params.push(format!("model: {model}"));
    }
    if let Some(reasoning_effort) = &state.reasoning_effort {
        params.push(format!("reasoning effort: {reasoning_effort}"));
    }

    if params.is_empty() {
        return;
    }

    let is_new = state.index.is_none();
    let index = *state.index.get_or_insert_with(|| entry_index.next());
    let entry = NormalizedEntry {
        timestamp: None,
        entry_type: NormalizedEntryType::SystemMessage,
        content: params.join("  "),
        metadata: None,
    };
    upsert_normalized_entry(msg_store, index, entry, is_new);
}

fn build_command_output(stdout: Option<&str>, stderr: Option<&str>) -> Option<String> {
    let stdout = stdout.map(str::trim).filter(|value| !value.is_empty());
    let stderr = stderr.map(str::trim).filter(|value| !value.is_empty());
    let fixed_bytes = match (stdout, stderr) {
        (None, None) => return None,
        (Some(_), None) => "stdout:\n".len(),
        (None, Some(_)) => "stderr:\n".len(),
        (Some(_), Some(_)) => "stdout:\n".len() + "\n\nstderr:\n".len(),
    };
    let content_budget = MAX_NORMALIZED_COMMAND_OUTPUT_BYTES.saturating_sub(fixed_bytes);
    let (stdout_budget, stderr_budget) = match (stdout, stderr) {
        (Some(_), Some(_)) => (content_budget / 2, content_budget - content_budget / 2),
        (Some(_), None) => (content_budget, 0),
        (None, Some(_)) => (0, content_budget),
        (None, None) => unreachable!(),
    };

    let mut output = String::with_capacity(MAX_NORMALIZED_COMMAND_OUTPUT_BYTES);
    if let Some(stdout) = stdout {
        output.push_str("stdout:\n");
        output.push_str(&truncate_command_output(stdout, stdout_budget));
    }
    if let Some(stderr) = stderr {
        if !output.is_empty() {
            output.push_str("\n\n");
        }
        output.push_str("stderr:\n");
        output.push_str(&truncate_command_output(stderr, stderr_budget));
    }
    Some(output)
}

fn truncate_command_output(output: &str, max_bytes: usize) -> String {
    if output.len() <= max_bytes {
        return output.to_string();
    }

    let content_budget = max_bytes.saturating_sub(COMMAND_OUTPUT_TRUNCATION_MARKER.len());
    let mut head_end = content_budget / 2;
    while head_end > 0 && !output.is_char_boundary(head_end) {
        head_end -= 1;
    }

    let tail_budget = content_budget.saturating_sub(head_end);
    let mut tail_start = output.len().saturating_sub(tail_budget);
    while tail_start < output.len() && !output.is_char_boundary(tail_start) {
        tail_start += 1;
    }

    let mut truncated = String::with_capacity(max_bytes);
    truncated.push_str(&output[..head_end]);
    truncated.push_str(COMMAND_OUTPUT_TRUNCATION_MARKER);
    truncated.push_str(&output[tail_start..]);
    truncated
}

static SESSION_ID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"#)
        .expect("valid regex")
});

#[derive(Serialize, Deserialize, Debug)]
pub enum Error {
    LaunchError { error: String },
    AuthRequired { error: String },
}

impl Error {
    pub fn launch_error(error: String) -> Self {
        Self::LaunchError { error }
    }
    pub fn auth_required(error: String) -> Self {
        Self::AuthRequired { error }
    }

    pub fn raw(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

impl ToNormalizedEntry for Error {
    fn to_normalized_entry(&self) -> NormalizedEntry {
        match self {
            Error::LaunchError { error } => NormalizedEntry {
                timestamp: None,
                entry_type: NormalizedEntryType::ErrorMessage {
                    error_type: NormalizedEntryError::Other,
                },
                content: error.clone(),
                metadata: None,
            },
            Error::AuthRequired { error } => NormalizedEntry {
                timestamp: None,
                entry_type: NormalizedEntryType::ErrorMessage {
                    error_type: NormalizedEntryError::SetupRequired,
                },
                content: error.clone(),
                metadata: None,
            },
        }
    }
}

/// Synthetic log line emitted by `AppServerClient` (not a Codex protocol
/// message) when a turn ends because the account's usage rate limit was
/// reached. It is serialized via [`LogWriter::log_raw`] and picked up by the
/// `normalize_logs` stdout loop, mirroring how [`Error`] / [`Approval`] are
/// threaded through the normalization path. The normalized entry it produces is
/// what the exit monitor reads to schedule an auto-resume once the limit resets.
#[derive(Serialize, Deserialize, Debug)]
pub enum RateLimit {
    LimitReached {
        /// RFC3339 reset time of the window that was hit, when known.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resets_at: Option<String>,
        /// Which window was hit, for display: "5h" (primary) or "weekly"
        /// (secondary).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<String>,
    },
}

impl RateLimit {
    pub fn limit_reached(resets_at: Option<String>, scope: Option<String>) -> Self {
        Self::LimitReached { resets_at, scope }
    }

    pub fn raw(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

impl ToNormalizedEntry for RateLimit {
    fn to_normalized_entry(&self) -> NormalizedEntry {
        match self {
            RateLimit::LimitReached { resets_at, scope } => NormalizedEntry {
                timestamp: None,
                entry_type: NormalizedEntryType::RateLimitInfo(crate::logs::RateLimitInfo {
                    limit_reached: true,
                    resets_at: resets_at.clone(),
                    scope: scope.clone(),
                }),
                content: "Usage rate limit reached".to_string(),
                metadata: None,
            },
        }
    }
}

#[derive(Serialize, Deserialize, Debug)]
pub enum Approval {
    ApprovalRequested {
        call_id: String,
        tool_name: String,
        approval_id: String,
    },
    ApprovalResponse {
        call_id: String,
        tool_name: String,
        approval_status: ApprovalStatus,
    },
    QuestionResponse {
        call_id: String,
        question_status: QuestionStatus,
    },
}

impl Approval {
    pub fn approval_requested(call_id: String, tool_name: String, approval_id: String) -> Self {
        Self::ApprovalRequested {
            call_id,
            tool_name,
            approval_id,
        }
    }

    pub fn approval_response(
        call_id: String,
        tool_name: String,
        approval_status: ApprovalStatus,
    ) -> Self {
        Self::ApprovalResponse {
            call_id,
            tool_name,
            approval_status,
        }
    }

    pub fn question_response(call_id: String, question_status: QuestionStatus) -> Self {
        Self::QuestionResponse {
            call_id,
            question_status,
        }
    }

    pub fn raw(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    pub fn display_tool_name(&self) -> String {
        match self {
            Self::ApprovalRequested { tool_name, .. }
            | Self::ApprovalResponse { tool_name, .. } => match tool_name.as_str() {
                "codex.exec_command" => "Exec Command".to_string(),
                "codex.apply_patch" => "Edit".to_string(),
                "codex.question" => "Question".to_string(),
                "codex.plan" => "Plan".to_string(),
                other => other.to_string(),
            },
            Self::QuestionResponse { .. } => "Question".to_string(),
        }
    }
}

impl ToNormalizedEntryOpt for Approval {
    fn to_normalized_entry_opt(&self) -> Option<NormalizedEntry> {
        let approval_status = match self {
            Self::ApprovalResponse {
                approval_status, ..
            } => approval_status,
            Self::QuestionResponse {
                question_status, ..
            } => {
                return match question_status {
                    QuestionStatus::Answered { answers } => {
                        let qa_pairs: Vec<AnsweredQuestion> = answers
                            .iter()
                            .map(|qa| AnsweredQuestion {
                                question: qa.question.clone(),
                                answer: qa.answer.clone(),
                            })
                            .collect();
                        Some(NormalizedEntry {
                            timestamp: None,
                            entry_type: NormalizedEntryType::UserAnsweredQuestions {
                                answers: qa_pairs,
                            },
                            content: format!(
                                "Answered {} question{}",
                                answers.len(),
                                if answers.len() != 1 { "s" } else { "" }
                            ),
                            metadata: None,
                        })
                    }
                    QuestionStatus::TimedOut => None,
                };
            }
            Self::ApprovalRequested { .. } => return None,
        };
        let tool_name = self.display_tool_name();

        match approval_status {
            ApprovalStatus::Pending | ApprovalStatus::Approved => None,
            ApprovalStatus::Denied { reason } => Some(NormalizedEntry {
                timestamp: None,
                entry_type: NormalizedEntryType::UserFeedback {
                    denied_tool: tool_name.clone(),
                },
                content: reason
                    .clone()
                    .unwrap_or_else(|| "User denied this tool use request".to_string())
                    .trim()
                    .to_string(),
                metadata: None,
            }),
            ApprovalStatus::TimedOut => Some(NormalizedEntry {
                timestamp: None,
                entry_type: NormalizedEntryType::ErrorMessage {
                    error_type: NormalizedEntryError::Other,
                },
                content: format!("Approval timed out for tool {tool_name}"),
                metadata: None,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, sync::Arc};

    use serde_json::json;
    use workspace_utils::{log_msg::LogMsg, msg_store::MsgStore};

    use super::*;
    use crate::logs::{
        ActionType, NormalizedEntryType, utils::patch::extract_normalized_entry_from_patch,
    };

    fn latest_normalized_entries(msg_store: &MsgStore) -> Vec<NormalizedEntry> {
        let mut entries = BTreeMap::new();
        for msg in msg_store.get_history() {
            if let LogMsg::JsonPatch(patch) = msg
                && let Some((index, entry)) = extract_normalized_entry_from_patch(&patch)
            {
                entries.insert(index, entry);
            }
        }
        entries.into_values().collect()
    }

    async fn normalize_lines(lines: &[String]) -> Vec<NormalizedEntry> {
        let msg_store = Arc::new(MsgStore::new());
        for line in lines {
            msg_store.push_stdout(format!("{line}\n"));
        }
        msg_store.push_finished();

        for handle in normalize_logs(msg_store.clone(), Path::new("/tmp/test-worktree")) {
            handle.await.unwrap();
        }

        latest_normalized_entries(&msg_store)
    }

    #[test]
    fn dynamic_tool_image_markdown_persists_data_urls() {
        let dir = tempfile::tempdir().unwrap();
        let worktree = dir.path().to_str().unwrap();
        // 1x1 transparent PNG
        let data_url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

        let markdown = dynamic_tool_image_markdown(data_url, worktree);
        let path = markdown
            .strip_prefix("![tool image](")
            .and_then(|rest| rest.strip_suffix(')'))
            .expect("expected inline image markdown");
        assert!(path.starts_with(".vibe-attachments/agent-"));
        assert!(dir.path().join(path).is_file());

        // Non-data URLs keep the plain-text fallback.
        assert_eq!(
            dynamic_tool_image_markdown("https://example.com/a.png", worktree),
            "Image: https://example.com/a.png"
        );
    }

    #[test]
    fn truncates_large_command_output_without_losing_ends() {
        let stdout = format!(
            "stdout-start{}stdout-end",
            "x".repeat(MAX_NORMALIZED_COMMAND_OUTPUT_BYTES * 2)
        );
        let stderr = format!(
            "stderr-start{}stderr-end",
            "y".repeat(MAX_NORMALIZED_COMMAND_OUTPUT_BYTES * 2)
        );

        let output = build_command_output(Some(&stdout), Some(&stderr)).unwrap();

        assert!(output.len() <= MAX_NORMALIZED_COMMAND_OUTPUT_BYTES);
        assert!(output.contains("stdout-start"));
        assert!(output.contains("stdout-end"));
        assert!(output.contains("stderr-start"));
        assert!(output.contains("stderr-end"));
        assert_eq!(output.matches(COMMAND_OUTPUT_TRUNCATION_MARKER).count(), 2);
    }

    #[test]
    fn truncates_command_output_on_utf8_boundaries() {
        let output = "한".repeat(MAX_NORMALIZED_COMMAND_OUTPUT_BYTES);
        let truncated = truncate_command_output(&output, MAX_NORMALIZED_COMMAND_OUTPUT_BYTES);

        assert!(truncated.len() <= MAX_NORMALIZED_COMMAND_OUTPUT_BYTES);
        assert!(truncated.contains(COMMAND_OUTPUT_TRUNCATION_MARKER));
        assert!(truncated.is_char_boundary(truncated.len()));
    }

    fn tool_use<'a>(entries: &'a [NormalizedEntry], tool_name: &str) -> &'a NormalizedEntry {
        entries
            .iter()
            .find(|entry| {
                matches!(
                    &entry.entry_type,
                    NormalizedEntryType::ToolUse { tool_name: name, .. } if name == tool_name
                )
            })
            .unwrap_or_else(|| panic!("missing tool entry for {tool_name}"))
    }

    fn request_user_input_line(request_id: &str, call_id: &str) -> String {
        json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "item/tool/requestUserInput",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "itemId": call_id,
                "questions": [{
                    "id": "lang",
                    "header": "Language",
                    "question": "Which language?",
                    "options": [{
                        "label": "Rust",
                        "description": "Use Rust"
                    }]
                }]
            }
        })
        .to_string()
    }

    #[tokio::test]
    async fn preserves_direct_command_denial_without_item_started() {
        let call_id = "cmd-1";
        let entries = normalize_lines(&[
            json!({
                "jsonrpc": "2.0",
                "id": "req-1",
                "method": "item/commandExecution/requestApproval",
                "params": {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": call_id,
                    "startedAtMs": 1,
                    "approvalId": "approval-1",
                    "command": "git push"
                }
            })
            .to_string(),
            Approval::approval_response(
                call_id.to_string(),
                "codex.exec_command".to_string(),
                ApprovalStatus::Denied {
                    reason: Some("Denied by user".to_string()),
                },
            )
            .raw(),
        ])
        .await;

        let command = tool_use(&entries, "bash");
        match &command.entry_type {
            NormalizedEntryType::ToolUse {
                action_type: ActionType::CommandRun { command, .. },
                status: ToolStatus::Denied { reason },
                ..
            } => {
                assert_eq!(command, "git push");
                assert_eq!(reason.as_deref(), Some("Denied by user"));
            }
            other => panic!("unexpected command entry: {other:?}"),
        }

        assert!(entries.iter().any(|entry| matches!(
            &entry.entry_type,
            NormalizedEntryType::UserFeedback { denied_tool } if denied_tool == "Exec Command"
        )));
    }

    #[tokio::test]
    async fn normalizes_direct_request_user_input_and_answer() {
        let call_id = "question-1";
        let entries = normalize_lines(&[
            request_user_input_line("req-3", call_id),
            Approval::question_response(
                call_id.to_string(),
                QuestionStatus::Answered {
                    answers: vec![workspace_utils::approvals::QuestionAnswer {
                        question: "Which language?".to_string(),
                        answer: vec!["Rust".to_string()],
                    }],
                },
            )
            .raw(),
        ])
        .await;

        let question = tool_use(&entries, "question");
        match &question.entry_type {
            NormalizedEntryType::ToolUse {
                action_type: ActionType::AskUserQuestion { questions },
                status: ToolStatus::Success,
                ..
            } => {
                assert_eq!(questions.len(), 1);
                assert_eq!(questions[0].question, "Which language?");
            }
            other => panic!("unexpected question entry: {other:?}"),
        }

        assert!(entries.iter().any(|entry| matches!(
            &entry.entry_type,
            NormalizedEntryType::UserAnsweredQuestions { answers }
                if answers.len() == 1 && answers[0].question == "Which language?"
        )));
    }

    #[tokio::test]
    async fn normalizes_direct_dynamic_tool_success() {
        let call_id = "call-dyn-1";
        let tool_name = "lookup_ticket";
        let entries = normalize_lines(&[
            json!({
                "jsonrpc": "2.0",
                "id": "req-dyn-1",
                "method": "item/tool/call",
                "params": {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "callId": call_id,
                    "tool": tool_name,
                    "arguments": {"id": "ABC-123"}
                }
            })
            .to_string(),
            json!({
                "jsonrpc": "2.0",
                "method": "item/completed",
                "params": {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "completedAtMs": 2,
                    "item": {
                        "type": "dynamicToolCall",
                        "id": call_id,
                        "namespace": null,
                        "tool": tool_name,
                        "arguments": {"id": "ABC-123"},
                        "status": "completed",
                        "contentItems": [{
                            "type": "inputText",
                            "text": "Ticket ABC-123 is open."
                        }],
                        "success": true,
                        "durationMs": 1
                    }
                }
            })
            .to_string(),
        ])
        .await;

        let dynamic = tool_use(&entries, tool_name);
        match &dynamic.entry_type {
            NormalizedEntryType::ToolUse {
                action_type:
                    ActionType::Tool {
                        tool_name,
                        arguments,
                        result,
                    },
                status: ToolStatus::Success,
                ..
            } => {
                assert_eq!(tool_name, "lookup_ticket");
                assert_eq!(arguments.as_ref().unwrap()["id"], "ABC-123");
                assert_eq!(
                    result
                        .as_ref()
                        .and_then(|r| r.value.as_str())
                        .unwrap_or_default(),
                    "Ticket ABC-123 is open."
                );
            }
            other => panic!("unexpected dynamic tool entry: {other:?}"),
        }
    }

    #[tokio::test]
    async fn normalizes_direct_raw_reasoning_delta() {
        let entries = normalize_lines(&[json!({
            "jsonrpc": "2.0",
            "method": "item/reasoning/textDelta",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "itemId": "reasoning-1",
                "delta": "raw thought",
                "contentIndex": 0
            }
        })
        .to_string()])
        .await;

        assert!(entries.iter().any(|entry| matches!(
            &entry.entry_type,
            NormalizedEntryType::Thinking
        ) && entry.content == "raw thought"));
    }

    #[tokio::test]
    async fn normalizes_legacy_raw_reasoning_delta() {
        let entries = normalize_lines(&[json!({
            "jsonrpc": "2.0",
            "method": "codex/event",
            "params": {
                "msg": {
                    "type": "reasoning_raw_content_delta",
                    "thread_id": "thread-1",
                    "turn_id": "turn-1",
                    "item_id": "reasoning-1",
                    "delta": "legacy raw thought",
                    "content_index": 0
                }
            }
        })
        .to_string()])
        .await;

        assert!(entries.iter().any(|entry| matches!(
            &entry.entry_type,
            NormalizedEntryType::Thinking
        ) && entry.content == "legacy raw thought"));
    }

    #[tokio::test]
    async fn normalizes_direct_file_change_patch_updated() {
        let item_id = "patch-1";
        let entries = normalize_lines(&[
            json!({
                "jsonrpc": "2.0",
                "method": "item/fileChange/patchUpdated",
                "params": {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": item_id,
                    "changes": [{
                        "path": "/tmp/test-worktree/src/lib.rs",
                        "kind": {"type": "update", "movePath": null},
                        "diff": "@@ -1 +1 @@\n-old\n+new\n"
                    }]
                }
            })
            .to_string(),
            json!({
                "jsonrpc": "2.0",
                "method": "item/fileChange/patchUpdated",
                "params": {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": item_id,
                    "changes": [{
                        "path": "/tmp/test-worktree/src/lib.rs",
                        "kind": {"type": "update", "movePath": null},
                        "diff": "@@ -1 +1 @@\n-new\n+newer\n"
                    }]
                }
            })
            .to_string(),
        ])
        .await;

        let edit = tool_use(&entries, "edit");
        match &edit.entry_type {
            NormalizedEntryType::ToolUse {
                action_type: ActionType::FileEdit { path, changes },
                status: ToolStatus::Created,
                ..
            } => {
                assert_eq!(path, "src/lib.rs");
                assert!(matches!(
                    &changes[..],
                    [FileChange::Edit { unified_diff, .. }] if unified_diff.contains("+newer")
                ));
            }
            other => panic!("unexpected file edit entry: {other:?}"),
        }
    }

    #[tokio::test]
    async fn rate_limit_line_emits_rate_limit_info_entry() {
        let entries = normalize_lines(&[RateLimit::limit_reached(
            Some("2026-06-18T12:00:00+00:00".to_string()),
            Some("5h".to_string()),
        )
        .raw()])
        .await;

        let info = entries
            .iter()
            .find_map(|entry| match &entry.entry_type {
                NormalizedEntryType::RateLimitInfo(info) => Some(info),
                _ => None,
            })
            .expect("missing rate-limit entry");

        assert!(info.limit_reached);
        assert_eq!(info.resets_at.as_deref(), Some("2026-06-18T12:00:00+00:00"));
        assert_eq!(info.scope.as_deref(), Some("5h"));
    }

    #[tokio::test]
    async fn rate_limit_line_without_reset_leaves_fields_none() {
        let entries = normalize_lines(&[RateLimit::limit_reached(None, None).raw()]).await;

        let info = entries
            .iter()
            .find_map(|entry| match &entry.entry_type {
                NormalizedEntryType::RateLimitInfo(info) => Some(info),
                _ => None,
            })
            .expect("missing rate-limit entry");

        assert!(info.limit_reached);
        assert!(info.resets_at.is_none());
        assert!(info.scope.is_none());
    }

    fn collab_item_line(method: &str, ts_key: &str, ts: i64, item: serde_json::Value) -> String {
        json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": {
                "threadId": "thread-main",
                "turnId": "turn-1",
                ts_key: ts,
                "item": item
            }
        })
        .to_string()
    }

    fn spawn_started_line(ts: i64) -> String {
        collab_item_line(
            "item/started",
            "startedAtMs",
            ts,
            json!({
                "type": "collabAgentToolCall",
                "id": "call-spawn-1",
                "tool": "spawnAgent",
                "status": "inProgress",
                "senderThreadId": "thread-main",
                "receiverThreadIds": [],
                "prompt": "Refactor the API\nkeep behavior identical",
                "model": "gpt-5.5",
                "agentsStates": {}
            }),
        )
    }

    fn spawn_completed_line(ts: i64) -> String {
        collab_item_line(
            "item/completed",
            "completedAtMs",
            ts,
            json!({
                "type": "collabAgentToolCall",
                "id": "call-spawn-1",
                "tool": "spawnAgent",
                "status": "completed",
                "senderThreadId": "thread-main",
                "receiverThreadIds": ["agent-t1"],
                "prompt": "Refactor the API\nkeep behavior identical",
                "model": "gpt-5.5",
                "agentsStates": {"agent-t1": {"status": "running", "message": null}}
            }),
        )
    }

    #[allow(clippy::type_complexity)]
    fn collab_task_fields(
        entry: &NormalizedEntry,
    ) -> (
        &str,
        Option<&str>,
        Option<&str>,
        Option<u32>,
        Option<&str>,
        &ToolStatus,
    ) {
        match &entry.entry_type {
            NormalizedEntryType::ToolUse {
                action_type:
                    ActionType::TaskCreate {
                        description,
                        subagent_type,
                        result,
                        last_activity,
                        duration_ms,
                    },
                status,
                ..
            } => (
                description.as_str(),
                subagent_type.as_deref(),
                last_activity.as_deref(),
                *duration_ms,
                result.as_ref().and_then(|r| r.value.as_str()),
                status,
            ),
            other => panic!("expected TaskCreate entry, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn collab_spawn_renders_running_subagent() {
        let entries =
            normalize_lines(&[spawn_started_line(1_000), spawn_completed_line(3_000)]).await;

        let (description, subagent_type, _, duration_ms, _, status) =
            collab_task_fields(tool_use(&entries, "agent"));
        assert_eq!(description, "Refactor the API");
        assert_eq!(subagent_type, Some("gpt-5.5"));
        assert_eq!(duration_ms, Some(2_000));
        assert!(matches!(status, ToolStatus::Created));
        // Wait/SendInput/Close fold into the agent row; the spawn call itself
        // must not add a second entry.
        assert_eq!(
            entries
                .iter()
                .filter(|entry| matches!(
                    &entry.entry_type,
                    NormalizedEntryType::ToolUse {
                        action_type: ActionType::TaskCreate { .. },
                        ..
                    }
                ))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn collab_activity_and_wait_complete_subagent() {
        let entries = normalize_lines(&[
            spawn_started_line(1_000),
            spawn_completed_line(3_000),
            collab_item_line(
                "item/completed",
                "completedAtMs",
                10_000,
                json!({
                    "type": "subAgentActivity",
                    "id": "activity-1",
                    "kind": "interacted",
                    "agentThreadId": "agent-t1",
                    "agentPath": "/root/worker"
                }),
            ),
            collab_item_line(
                "item/completed",
                "completedAtMs",
                61_000,
                json!({
                    "type": "collabAgentToolCall",
                    "id": "call-wait-1",
                    "tool": "wait",
                    "status": "completed",
                    "senderThreadId": "thread-main",
                    "receiverThreadIds": ["agent-t1"],
                    "prompt": null,
                    "model": null,
                    "agentsStates": {"agent-t1": {"status": "completed", "message": "Refactor done"}}
                }),
            ),
        ])
        .await;

        let (description, _, last_activity, duration_ms, result, status) =
            collab_task_fields(tool_use(&entries, "agent"));
        assert_eq!(description, "Refactor the API");
        assert_eq!(last_activity, Some("Working"));
        assert_eq!(duration_ms, Some(60_000));
        assert_eq!(result, Some("Refactor done"));
        assert!(matches!(status, ToolStatus::Success));
    }

    #[tokio::test]
    async fn collab_errored_agent_marks_entry_failed() {
        let entries = normalize_lines(&[
            spawn_started_line(1_000),
            spawn_completed_line(3_000),
            collab_item_line(
                "item/completed",
                "completedAtMs",
                8_000,
                json!({
                    "type": "collabAgentToolCall",
                    "id": "call-wait-1",
                    "tool": "wait",
                    "status": "completed",
                    "senderThreadId": "thread-main",
                    "receiverThreadIds": ["agent-t1"],
                    "prompt": null,
                    "model": null,
                    "agentsStates": {"agent-t1": {"status": "errored", "message": "compile error"}}
                }),
            ),
        ])
        .await;

        let (_, _, _, _, result, status) = collab_task_fields(tool_use(&entries, "agent"));
        assert_eq!(result, Some("compile error"));
        assert!(matches!(status, ToolStatus::Failed));
    }

    #[tokio::test]
    async fn sub_agent_interruption_marks_entry_failed() {
        let entries = normalize_lines(&[
            spawn_started_line(1_000),
            spawn_completed_line(3_000),
            collab_item_line(
                "item/completed",
                "completedAtMs",
                5_000,
                json!({
                    "type": "subAgentActivity",
                    "id": "activity-1",
                    "kind": "interrupted",
                    "agentThreadId": "agent-t1",
                    "agentPath": "/root/worker"
                }),
            ),
        ])
        .await;

        let (_, _, last_activity, _, _, status) = collab_task_fields(tool_use(&entries, "agent"));
        assert_eq!(last_activity, Some("Interrupted"));
        assert!(matches!(status, ToolStatus::Failed));
    }

    #[tokio::test]
    async fn wait_not_found_skips_unknown_agents() {
        let entries = normalize_lines(&[collab_item_line(
            "item/completed",
            "completedAtMs",
            5_000,
            json!({
                "type": "collabAgentToolCall",
                "id": "call-wait-9",
                "tool": "wait",
                "status": "failed",
                "senderThreadId": "thread-main",
                "receiverThreadIds": ["agent-unknown"],
                "prompt": null,
                "model": null,
                "agentsStates": {"agent-unknown": {"status": "notFound", "message": null}}
            }),
        )])
        .await;

        assert!(
            entries.iter().all(|entry| !matches!(
                &entry.entry_type,
                NormalizedEntryType::ToolUse {
                    action_type: ActionType::TaskCreate { .. },
                    ..
                }
            )),
            "NotFound for an unknown thread must not create a phantom agent row"
        );
    }

    #[tokio::test]
    async fn sub_agent_activity_without_spawn_creates_named_row() {
        // Resumed logs can start mid-conversation: activity for an unknown
        // agent still gets a row, named from the agent path.
        let entries = normalize_lines(&[collab_item_line(
            "item/completed",
            "completedAtMs",
            5_000,
            json!({
                "type": "subAgentActivity",
                "id": "activity-1",
                "kind": "started",
                "agentThreadId": "agent-t9",
                "agentPath": "/root/worker"
            }),
        )])
        .await;

        let (description, _, last_activity, _, _, status) =
            collab_task_fields(tool_use(&entries, "agent"));
        assert_eq!(description, "worker");
        assert_eq!(last_activity, Some("Started"));
        assert!(matches!(status, ToolStatus::Created));
    }
}
