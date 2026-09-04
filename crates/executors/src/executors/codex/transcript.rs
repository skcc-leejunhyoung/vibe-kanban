//! Convert a Codex `thread/read` response for the shared subagent transcript
//! viewer.

use codex_app_server_protocol::{Thread, ThreadItem, UserInput};

use crate::{executors::codex::normalize_logs::normalize_thread_transcript, logs::NormalizedEntry};

pub fn thread_transcript_entries(thread: &Thread, worktree_path: &str) -> Vec<NormalizedEntry> {
    normalize_thread_transcript(thread, worktree_path)
}

pub fn thread_transcript_markdown(thread: &Thread) -> String {
    let mut messages: Vec<(&str, String)> = Vec::new();
    for turn in &thread.turns {
        for item in &turn.items {
            if let Some((role, content)) = thread_item_markdown(item) {
                if let Some((last_role, last_content)) = messages.last_mut()
                    && *last_role == role
                {
                    last_content.push_str("\n\n");
                    last_content.push_str(&content);
                } else {
                    messages.push((role, content));
                }
            }
        }
    }
    if messages.is_empty() {
        "_No transcript content._".to_string()
    } else {
        messages
            .into_iter()
            .map(|(role, content)| format!("**{role}**\n\n{content}"))
            .collect::<Vec<_>>()
            .join("\n\n")
    }
}

fn thread_item_markdown(item: &ThreadItem) -> Option<(&'static str, String)> {
    match item {
        ThreadItem::UserMessage { content, .. } => {
            let text = content
                .iter()
                .filter_map(|input| match input {
                    UserInput::Text { text, .. } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            if text.is_empty() {
                None
            } else {
                Some(("User", text))
            }
        }
        ThreadItem::AgentMessage { text, .. } => {
            if text.is_empty() {
                None
            } else {
                Some(("Agent", text.clone()))
            }
        }
        ThreadItem::Plan { text, .. } => {
            if text.is_empty() {
                None
            } else {
                Some(("Agent", format!("**Plan**\n\n{text}")))
            }
        }
        ThreadItem::Reasoning { summary, .. } => {
            let text = summary.join("\n");
            if text.is_empty() {
                None
            } else {
                Some(("Agent", format!("_Thinking:_ {text}")))
            }
        }
        ThreadItem::CommandExecution {
            command, exit_code, ..
        } => {
            let suffix = exit_code
                .filter(|code| *code != 0)
                .map(|code| format!(" (exit {code})"))
                .unwrap_or_default();
            Some(("Agent", format!("`$ {command}`{suffix}")))
        }
        ThreadItem::FileChange { changes, .. } => {
            let paths = changes
                .iter()
                .map(|change| format!("`{}`", change.path))
                .collect::<Vec<_>>()
                .join(", ");
            Some(("Agent", format!("_Edited:_ {paths}")))
        }
        ThreadItem::McpToolCall { server, tool, .. } => {
            Some(("Agent", format!("_Tool:_ `{server}/{tool}`")))
        }
        ThreadItem::DynamicToolCall { tool, .. } => Some(("Agent", format!("_Tool:_ `{tool}`"))),
        ThreadItem::FunctionCallOutput { .. } => None,
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logs::{ActionType, CommandExitStatus, NormalizedEntryType, ToolStatus};

    fn thread_with_items(items: Vec<ThreadItem>) -> Thread {
        // Thread has many required fields; deserialize a minimal JSON skeleton
        // instead of spelling out every struct literal field.
        let mut thread: Thread = serde_json::from_value(serde_json::json!({
            "id": "thread-1",
            "sessionId": "session-1",
            "forkedFromId": null,
            "parentThreadId": null,
            "preview": "",
            "ephemeral": false,
            "modelProvider": "openai",
            "createdAt": 0,
            "updatedAt": 0,
            "recencyAt": null,
            "status": {"type": "idle"},
            "path": null,
            "cwd": "/",
            "cliVersion": "0.0.0",
            "source": "cli",
            "threadSource": null,
            "agentNickname": null,
            "agentRole": null,
            "gitInfo": null,
            "name": null,
            "extra": null,
            "turns": [],
        }))
        .expect("minimal thread skeleton deserializes");
        thread.turns = vec![
            serde_json::from_value(serde_json::json!({
                "id": "turn-1",
                "items": [],
                "status": "completed",
                "error": null,
                "startedAt": null,
                "completedAt": null,
                "durationMs": null,
            }))
            .expect("minimal turn skeleton deserializes"),
        ];
        thread.turns[0].items = items;
        thread
    }

    #[test]
    fn flattens_and_normalizes_messages_commands_and_reasoning() {
        let items: Vec<ThreadItem> = vec![
            serde_json::from_value(serde_json::json!({
                "type": "userMessage",
                "id": "i1",
                "clientId": null,
                "content": [{"type": "text", "text": "Fix the bug"}],
            }))
            .unwrap(),
            serde_json::from_value(serde_json::json!({
                "type": "reasoning",
                "id": "i2",
                "summary": ["Scanning the module"],
                "content": [],
            }))
            .unwrap(),
            serde_json::from_value(serde_json::json!({
                "type": "commandExecution",
                "id": "i3",
                "command": "cargo test",
                "cwd": "/",
                "processId": null,
                "status": "completed",
                "commandActions": [],
                "aggregatedOutput": "ok",
                "exitCode": 0,
                "durationMs": null,
            }))
            .unwrap(),
            serde_json::from_value(serde_json::json!({
                "type": "agentMessage",
                "id": "i4",
                "text": "Done.",
            }))
            .unwrap(),
        ];

        let thread = thread_with_items(items);
        assert_eq!(
            thread_transcript_markdown(&thread),
            "**User**\n\nFix the bug\n\n**Agent**\n\n_Thinking:_ Scanning the module\n\n`$ cargo test`\n\nDone."
        );

        let entries = thread_transcript_entries(&thread, "/");
        assert_eq!(entries.len(), 4);
        assert!(matches!(
            &entries[0].entry_type,
            NormalizedEntryType::UserMessage
        ));
        assert!(matches!(
            &entries[1].entry_type,
            NormalizedEntryType::Thinking
        ));
        assert!(matches!(
            &entries[2].entry_type,
            NormalizedEntryType::ToolUse {
                action_type: ActionType::CommandRun { result: Some(result), .. },
                status: ToolStatus::Success,
                ..
            } if result.output.as_deref() == Some("ok")
                && matches!(
                    &result.exit_status,
                    Some(CommandExitStatus::ExitCode { code: 0 })
                )
        ));
        assert!(matches!(
            &entries[3].entry_type,
            NormalizedEntryType::AssistantMessage
        ));
    }

    #[test]
    fn empty_thread_yields_placeholder() {
        let thread = thread_with_items(vec![]);
        assert_eq!(
            thread_transcript_markdown(&thread),
            "_No transcript content._"
        );
        assert!(thread_transcript_entries(&thread, "/").is_empty());
    }
}
