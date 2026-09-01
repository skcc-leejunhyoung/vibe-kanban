//! Extracts searchable rows from normalized conversation logs into
//! `session_message_index`, once per execution at the point logs become
//! immutable: the exit monitor for live processes, and a startup backfill for
//! historical ones.

use std::collections::BTreeMap;

use db::models::session_message_index::{NewSessionMessage, SessionMessageIndex};
use executors::logs::{
    NormalizedEntry, NormalizedEntryType, utils::patch::extract_normalized_entry_from_patch,
};
use futures::StreamExt;
use json_patch::Patch;
use utils::log_msg::LogMsg;

use crate::services::container::ContainerService;

/// Coalesce a patch stream (adds, replaces, removes) into the final indexable
/// rows, keyed by entry index.
pub fn collect_indexable_rows<'a>(
    patches: impl IntoIterator<Item = &'a Patch>,
) -> Vec<NewSessionMessage> {
    let mut by_index: BTreeMap<usize, NormalizedEntry> = BTreeMap::new();
    for patch in patches {
        if let Some((index, entry)) = extract_normalized_entry_from_patch(patch) {
            by_index.insert(index, entry);
        } else {
            for op in &patch.0 {
                if let json_patch::PatchOperation::Remove(_) = op
                    && let Some(index) = op
                        .path()
                        .as_str()
                        .strip_prefix("/entries/")
                        .and_then(|s| s.parse::<usize>().ok())
                {
                    by_index.remove(&index);
                }
            }
        }
    }
    by_index
        .into_iter()
        .filter_map(|(index, entry)| to_row(index, entry))
        .collect()
}

/// Map a normalized entry to an index row. Only conversation-shaped entries
/// are indexed; UI/status entries (loading, token usage, …) and tool result
/// payloads (which live in entry metadata, not `content`) are excluded.
fn to_row(index: usize, entry: NormalizedEntry) -> Option<NewSessionMessage> {
    let (entry_type, tool_name) = match &entry.entry_type {
        NormalizedEntryType::UserMessage => ("user_message", None),
        NormalizedEntryType::UserFeedback { denied_tool } => {
            ("user_feedback", Some(denied_tool.clone()))
        }
        NormalizedEntryType::AssistantMessage => ("assistant_message", None),
        NormalizedEntryType::Thinking => ("thinking", None),
        NormalizedEntryType::ToolUse { tool_name, .. } => ("tool_use", Some(tool_name.clone())),
        NormalizedEntryType::SystemMessage => ("system_message", None),
        NormalizedEntryType::ErrorMessage { .. } => ("error_message", None),
        NormalizedEntryType::UserAnsweredQuestions { .. } => ("user_answered_questions", None),
        NormalizedEntryType::Loading
        | NormalizedEntryType::NextAction { .. }
        | NormalizedEntryType::TokenUsageInfo(_)
        | NormalizedEntryType::RateLimitInfo(_)
        | NormalizedEntryType::BackgroundTasksWaiting { .. } => return None,
    };
    let mut content = entry.content.trim().to_string();
    if content.is_empty()
        && let NormalizedEntryType::UserAnsweredQuestions { answers } = &entry.entry_type
    {
        content = answers
            .iter()
            .map(|a| format!("Q: {}\nA: {}", a.question, a.answer.join(", ")))
            .collect::<Vec<_>>()
            .join("\n");
    }
    if content.is_empty() {
        return None;
    }
    Some(NewSessionMessage {
        entry_index: index as i64,
        entry_type: entry_type.to_string(),
        tool_name,
        content,
    })
}

/// One-time startup sweep: extract every finished coding-agent execution that
/// has never been indexed. Re-normalization is serialized behind the historical
/// replay semaphore inside `stream_normalized_logs`, so this cannot starve
/// interactive replays.
pub async fn backfill(container: &(impl ContainerService + Sync)) {
    let pool = container.db().pool.clone();
    let pending = match SessionMessageIndex::find_unindexed_executions(&pool).await {
        Ok(pending) => pending,
        Err(e) => {
            tracing::warn!("Session message index backfill query failed: {}", e);
            return;
        }
    };
    if pending.is_empty() {
        return;
    }
    tracing::info!(
        "Backfilling session message index for {} executions",
        pending.len()
    );
    for item in pending {
        let rows = match container.stream_normalized_logs(&item.execution_id).await {
            Some(mut stream) => {
                let mut patches = Vec::new();
                while let Some(msg) = stream.next().await {
                    match msg {
                        Ok(LogMsg::JsonPatch(patch)) => patches.push(patch),
                        Ok(LogMsg::Finished) | Err(_) => break,
                        Ok(_) => {}
                    }
                }
                collect_indexable_rows(patches.iter())
            }
            // No logs / unsupported action: mark as indexed so the backfill
            // never rescans it.
            None => Vec::new(),
        };
        if let Err(e) = SessionMessageIndex::rebuild_for_execution(
            &pool,
            item.session_id,
            item.execution_id,
            item.created_at,
            &rows,
        )
        .await
        {
            tracing::warn!(
                "Failed to backfill session message index for {}: {}",
                item.execution_id,
                e
            );
        }
    }
    tracing::info!("Session message index backfill complete");
}

#[cfg(test)]
mod tests {
    use executors::logs::utils::patch::ConversationPatch;

    use super::*;

    fn entry(entry_type: NormalizedEntryType, content: &str) -> NormalizedEntry {
        NormalizedEntry {
            timestamp: None,
            entry_type,
            content: content.to_string(),
            metadata: None,
        }
    }

    #[test]
    fn collect_keeps_last_write_and_honors_removes() {
        let patches = [
            ConversationPatch::add_normalized_entry(
                0,
                entry(NormalizedEntryType::UserMessage, "지난주 검색 결정"),
            ),
            ConversationPatch::add_normalized_entry(
                1,
                entry(NormalizedEntryType::Loading, "spinner"),
            ),
            ConversationPatch::add_normalized_entry(
                2,
                entry(NormalizedEntryType::AssistantMessage, "draft"),
            ),
            ConversationPatch::replace(
                2,
                entry(NormalizedEntryType::AssistantMessage, "final answer"),
            ),
            ConversationPatch::add_normalized_entry(
                3,
                entry(NormalizedEntryType::AssistantMessage, "stale"),
            ),
            ConversationPatch::remove(3),
        ];
        let rows = collect_indexable_rows(patches.iter());
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].entry_index, 0);
        assert_eq!(rows[0].entry_type, "user_message");
        assert_eq!(rows[0].content, "지난주 검색 결정");
        assert_eq!(rows[1].entry_index, 2);
        assert_eq!(rows[1].content, "final answer");
    }

    #[test]
    fn tool_use_keeps_tool_name_and_summary_line() {
        let patches = [ConversationPatch::add_normalized_entry(
            0,
            entry(
                NormalizedEntryType::ToolUse {
                    tool_name: "bash".to_string(),
                    action_type: executors::logs::ActionType::Other {
                        description: "cargo test".to_string(),
                    },
                    status: Default::default(),
                },
                "`cargo test --workspace`",
            ),
        )];
        let rows = collect_indexable_rows(patches.iter());
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].entry_type, "tool_use");
        assert_eq!(rows[0].tool_name.as_deref(), Some("bash"));
        assert_eq!(rows[0].content, "`cargo test --workspace`");
    }
}
