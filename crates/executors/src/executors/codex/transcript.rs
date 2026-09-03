//! Flatten a Codex `thread/read` response into display markdown for the
//! shared subagent transcript viewer.

use codex_app_server_protocol::{Thread, ThreadItem, UserInput};

pub fn thread_transcript_markdown(thread: &Thread) -> String {
    let mut sections: Vec<String> = Vec::new();
    for turn in &thread.turns {
        for item in &turn.items {
            if let Some(section) = thread_item_markdown(item) {
                sections.push(section);
            }
        }
    }
    if sections.is_empty() {
        "_No transcript content._".to_string()
    } else {
        sections.join("\n\n")
    }
}

fn thread_item_markdown(item: &ThreadItem) -> Option<String> {
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
                Some(format!("**User**\n\n{text}"))
            }
        }
        ThreadItem::AgentMessage { text, .. } => {
            if text.is_empty() {
                None
            } else {
                Some(format!("**Agent**\n\n{text}"))
            }
        }
        ThreadItem::Plan { text, .. } => {
            if text.is_empty() {
                None
            } else {
                Some(format!("**Plan**\n\n{text}"))
            }
        }
        ThreadItem::Reasoning { summary, .. } => {
            let text = summary.join("\n");
            if text.is_empty() {
                None
            } else {
                Some(format!("_Thinking:_ {text}"))
            }
        }
        ThreadItem::CommandExecution {
            command, exit_code, ..
        } => {
            let suffix = exit_code
                .filter(|code| *code != 0)
                .map(|code| format!(" (exit {code})"))
                .unwrap_or_default();
            Some(format!("`$ {command}`{suffix}"))
        }
        ThreadItem::FileChange { changes, .. } => {
            let paths = changes
                .iter()
                .map(|change| format!("`{}`", change.path))
                .collect::<Vec<_>>()
                .join(", ");
            Some(format!("_Edited:_ {paths}"))
        }
        ThreadItem::McpToolCall { server, tool, .. } => Some(format!("_Tool:_ `{server}/{tool}`")),
        ThreadItem::DynamicToolCall { tool, .. } => Some(format!("_Tool:_ `{tool}`")),
        ThreadItem::FunctionCallOutput { .. } => None,
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn flattens_messages_commands_and_reasoning() {
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
                "aggregatedOutput": null,
                "exitCode": 1,
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

        let markdown = thread_transcript_markdown(&thread_with_items(items));
        assert!(markdown.contains("**User**\n\nFix the bug"));
        assert!(markdown.contains("_Thinking:_ Scanning the module"));
        assert!(markdown.contains("`$ cargo test` (exit 1)"));
        assert!(markdown.contains("**Agent**\n\nDone."));
    }

    #[test]
    fn empty_thread_yields_placeholder() {
        let markdown = thread_transcript_markdown(&thread_with_items(vec![]));
        assert_eq!(markdown, "_No transcript content._");
    }
}
