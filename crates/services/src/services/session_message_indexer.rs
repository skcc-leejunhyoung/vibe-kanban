//! Extracts searchable rows from normalized conversation logs into
//! `session_message_index`, once per execution at the point logs become
//! immutable: the exit monitor for live processes, and a startup backfill for
//! historical ones.

use std::{collections::BTreeMap, time::Duration};

use db::models::{
    execution_process::ExecutionProcess,
    session_message_index::{NewSessionMessage, SessionMessageIndex},
};
use executors::{
    actions::{ExecutorAction, ExecutorActionType},
    logs::{
        NormalizedEntry, NormalizedEntryType, utils::patch::extract_normalized_entry_from_patch,
    },
};
use futures::StreamExt;
use json_patch::Patch;
use utils::log_msg::LogMsg;

use crate::services::container::ContainerService;

const BACKFILL_INITIAL_DELAY: Duration = Duration::from_secs(60);
const BACKFILL_ITEM_PAUSE: Duration = Duration::from_millis(500);
/// Index position of the synthesized turn prompt; sorts before every
/// normalized entry of the execution.
pub const PROMPT_ENTRY_INDEX: i64 = -1;

/// The user's prompt for a turn is not a normalized entry (no executor emits
/// one; the UI synthesizes it from the action), so index it as a leading
/// `user_message` row.
pub fn prompt_row(action: &ExecutorAction) -> Option<NewSessionMessage> {
    let prompt = match action.typ() {
        ExecutorActionType::CodingAgentInitialRequest(request) => &request.prompt,
        ExecutorActionType::CodingAgentFollowUpRequest(request) => &request.prompt,
        ExecutorActionType::ReviewRequest(request) => &request.prompt,
        _ => return None,
    };
    let content = prompt.trim();
    (!content.is_empty()).then(|| NewSessionMessage {
        entry_index: PROMPT_ENTRY_INDEX,
        entry_type: "user_message".to_string(),
        tool_name: None,
        content: content.to_string(),
    })
}

/// All index rows for an execution: the turn prompt followed by the coalesced
/// normalized entries.
pub fn index_rows<'a>(
    action: Option<&ExecutorAction>,
    patches: impl IntoIterator<Item = &'a Patch>,
) -> Vec<NewSessionMessage> {
    action
        .and_then(prompt_row)
        .into_iter()
        .chain(collect_indexable_rows(patches))
        .collect()
}

/// [`index_rows`] off the async workers. Each patch is round-tripped through
/// `serde_json::Value` and a long turn holds tens of thousands of them, so
/// running this inline on a tokio worker stalls the runtime (and with it the
/// supervisor's `/api/health` probe) for seconds at every turn end.
pub async fn index_rows_blocking(
    action: Option<ExecutorAction>,
    patches: Vec<Patch>,
) -> Vec<NewSessionMessage> {
    tokio::task::spawn_blocking(move || index_rows(action.as_ref(), patches.iter()))
        .await
        .unwrap_or_else(|e| {
            tracing::warn!("Session message extraction task failed: {}", e);
            Vec::new()
        })
}

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
///
/// System messages are excluded too: measured over a real index they were 17%
/// of all rows and none were worth a search — CLI spinner lines ("requesting"),
/// hook/status events, model banners, compaction notices, unparsed-JSON dumps
/// and half-megabyte skill bodies. Executor failures are `ErrorMessage`, which
/// stays indexed.
fn to_row(index: usize, entry: NormalizedEntry) -> Option<NewSessionMessage> {
    let (entry_type, tool_name) = match &entry.entry_type {
        NormalizedEntryType::UserMessage => ("user_message", None),
        NormalizedEntryType::UserFeedback { denied_tool } => {
            ("user_feedback", Some(denied_tool.clone()))
        }
        NormalizedEntryType::AssistantMessage => ("assistant_message", None),
        NormalizedEntryType::Thinking => ("thinking", None),
        NormalizedEntryType::ToolUse { tool_name, .. } => ("tool_use", Some(tool_name.clone())),
        NormalizedEntryType::ErrorMessage { .. } => ("error_message", None),
        NormalizedEntryType::UserAnsweredQuestions { .. } => ("user_answered_questions", None),
        NormalizedEntryType::SystemMessage
        | NormalizedEntryType::Loading
        | NormalizedEntryType::NextAction { .. }
        | NormalizedEntryType::TokenUsageInfo(_)
        | NormalizedEntryType::RateLimitInfo(_)
        | NormalizedEntryType::BackgroundTasksWaiting { .. } => return None,
    };
    let mut content = entry.content.trim().to_string();
    // The rendered content is just "Answered N questions"; index the actual
    // question/answer text so the user's decisions are searchable.
    if let NormalizedEntryType::UserAnsweredQuestions { answers } = &entry.entry_type
        && !answers.is_empty()
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
    // Let startup (health probes, first workspace opens) settle before the
    // sweep, and pace items so interactive replays waiting on the shared
    // semaphore get in between them.
    tokio::time::sleep(BACKFILL_INITIAL_DELAY).await;
    let total = pending.len();
    for (done, item) in pending.into_iter().enumerate() {
        if done > 0 {
            tokio::time::sleep(BACKFILL_ITEM_PAUSE).await;
        }
        if done > 0 && done % 200 == 0 {
            tracing::info!("Session message index backfill: {done}/{total}");
        }
        let action = ExecutionProcess::find_by_id(&pool, item.execution_id)
            .await
            .ok()
            .flatten()
            .and_then(|process| process.executor_action().ok().cloned());
        // No logs / unsupported action yields no patches; the prompt row (if
        // any) is still written and the execution is marked so the backfill
        // never rescans it.
        let mut patches = Vec::new();
        if let Some(mut stream) = container.stream_normalized_logs(&item.execution_id).await {
            while let Some(msg) = stream.next().await {
                match msg {
                    Ok(LogMsg::JsonPatch(patch)) => patches.push(patch),
                    Ok(LogMsg::Finished) | Err(_) => break,
                    Ok(_) => {}
                }
            }
        }
        let rows = index_rows_blocking(action, patches).await;
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
    fn answered_questions_index_question_and_answer_text() {
        let patches = [ConversationPatch::add_normalized_entry(
            0,
            entry(
                NormalizedEntryType::UserAnsweredQuestions {
                    answers: vec![executors::logs::AnsweredQuestion {
                        question: "인증 방식은?".to_string(),
                        answer: vec!["OAuth".to_string()],
                    }],
                },
                "Answered 1 question",
            ),
        )];
        let rows = collect_indexable_rows(patches.iter());
        assert_eq!(rows.len(), 1);
        assert!(rows[0].content.contains("인증 방식은?"));
        assert!(rows[0].content.contains("OAuth"));
    }

    #[test]
    fn prompt_is_indexed_as_leading_user_message() {
        // Same JSON shape as a stored `executor_action` row.
        let action: ExecutorAction = serde_json::from_value(serde_json::json!({
            "typ": {
                "type": "CodingAgentFollowUpRequest",
                "prompt": "  좋아. 수정 커밋 올려줘. ",
                "session_id": "01a0605b-5831-7130-93a4-5f2247856867",
                "reset_to_message_id": null,
                "executor_config": {"executor": "CODEX", "variant": "DEFAULT"},
                "working_dir": null
            },
            "next_action": null
        }))
        .unwrap();
        let patches = [ConversationPatch::add_normalized_entry(
            0,
            entry(NormalizedEntryType::AssistantMessage, "done"),
        )];
        let rows = index_rows(Some(&action), patches.iter());
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].entry_index, PROMPT_ENTRY_INDEX);
        assert_eq!(rows[0].entry_type, "user_message");
        assert_eq!(rows[0].content, "좋아. 수정 커밋 올려줘.");
        assert_eq!(rows[1].entry_index, 0);
        assert!(index_rows(None, patches.iter()).len() == 1);
    }

    #[test]
    fn system_messages_are_skipped_but_errors_are_kept() {
        let patches = [
            ConversationPatch::add_normalized_entry(
                0,
                entry(NormalizedEntryType::SystemMessage, "requesting"),
            ),
            ConversationPatch::add_normalized_entry(
                1,
                entry(NormalizedEntryType::SystemMessage, "System: hook_started"),
            ),
            ConversationPatch::add_normalized_entry(
                2,
                entry(
                    NormalizedEntryType::SystemMessage,
                    "Unrecognized JSON message: {\"id\":1}",
                ),
            ),
            ConversationPatch::add_normalized_entry(
                3,
                entry(
                    NormalizedEntryType::ErrorMessage {
                        error_type: executors::logs::NormalizedEntryError::Other,
                    },
                    "OAuth session expired",
                ),
            ),
        ];
        let rows = collect_indexable_rows(patches.iter());
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].entry_index, 3);
        assert_eq!(rows[0].entry_type, "error_message");
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
