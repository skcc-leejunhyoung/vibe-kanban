use std::{collections::BTreeMap, sync::Arc};

use executors::{
    executors::{StandardCodingAgentExecutor, claude::ClaudeCode, codex::Codex},
    logs::{
        artifacts::{ArtifactCandidate, entry_candidates},
        utils::patch::extract_normalized_entry_from_patch,
    },
};
use workspace_utils::{log_msg::LogMsg, msg_store::MsgStore};

#[tokio::test]
async fn discovers_files_in_real_unmodified_cli_logs_without_assistant_links() {
    let dir = tempfile::tempdir().unwrap();
    for (claude, fixture) in [
        (
            true,
            include_str!("fixtures/artifacts/claude-2.1.258-write.jsonl"),
        ),
        (
            false,
            include_str!("fixtures/artifacts/codex-0.153.4-file-change.jsonl"),
        ),
    ] {
        let store = Arc::new(MsgStore::new());
        for line in fixture
            .replace("__WORKTREE__", dir.path().to_str().unwrap())
            .lines()
        {
            store.push_stdout(format!("{line}\n"));
        }
        store.push_finished();
        let handles = if claude {
            serde_json::from_value::<ClaudeCode>(serde_json::json!({}))
                .unwrap()
                .normalize_logs(store.clone(), dir.path())
        } else {
            serde_json::from_value::<Codex>(serde_json::json!({}))
                .unwrap()
                .normalize_logs(store.clone(), dir.path())
        };
        for handle in handles {
            handle.await.unwrap();
        }
        let mut entries = BTreeMap::new();
        for message in store.get_history() {
            if let LogMsg::JsonPatch(patch) = message
                && let Some((index, entry)) = extract_normalized_entry_from_patch(&patch)
            {
                entries.insert(index, entry);
            }
        }
        let candidates = entries
            .values()
            .flat_map(entry_candidates)
            .collect::<Vec<_>>();
        assert!(candidates.iter().any(|candidate| matches!(candidate, ArtifactCandidate::File(path) if path.ends_with("index.html"))), "missing CLI file candidate (claude={claude}): {candidates:?}; entries: {entries:?}");
    }
}
