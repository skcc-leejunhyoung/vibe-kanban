use std::{collections::BTreeMap, path::Path, sync::Arc};

use base64::Engine;
use executors::{
    executors::{StandardCodingAgentExecutor, claude::ClaudeCode, codex::Codex},
    logs::{
        ActionType, NormalizedEntry, NormalizedEntryType,
        artifacts::{ArtifactCandidate, entry_candidates},
        utils::patch::extract_normalized_entry_from_patch,
    },
};
use workspace_utils::{log_msg::LogMsg, msg_store::MsgStore};

async fn normalize(
    fixture: &str,
    worktree: &Path,
    claude: bool,
) -> BTreeMap<usize, NormalizedEntry> {
    let store = Arc::new(MsgStore::new());
    for line in fixture
        .replace("__WORKTREE__", worktree.to_str().unwrap())
        .lines()
    {
        store.push_stdout(format!("{line}\n"));
    }
    store.push_finished();
    let handles = if claude {
        serde_json::from_value::<ClaudeCode>(serde_json::json!({}))
            .unwrap()
            .normalize_logs(store.clone(), worktree)
    } else {
        serde_json::from_value::<Codex>(serde_json::json!({}))
            .unwrap()
            .normalize_logs(store.clone(), worktree)
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
    entries
}

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
        let entries = normalize(fixture, dir.path(), claude).await;
        let candidates = entries
            .values()
            .flat_map(entry_candidates)
            .collect::<Vec<_>>();
        assert!(candidates.iter().any(|candidate| matches!(candidate, ArtifactCandidate::File(path) if path.ends_with("index.html"))), "missing CLI file candidate (claude={claude}): {candidates:?}; entries: {entries:?}");
    }
}

#[test]
fn actual_child_transcripts_discover_inline_html_and_mermaid() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let thread = serde_json::from_str(
        &include_str!("fixtures/artifacts/codex-0.153.4-subagent.json")
            .replace("__WORKTREE__", root)
            .replace("__CODEX_HOME__", root),
    )
    .unwrap();
    let codex = executors::executors::codex::transcript::thread_transcript_entries(&thread, root);
    let claude = executors::executors::claude::task_output_to_entries(
        &include_str!("fixtures/artifacts/claude-2.1.258-subagent.jsonl")
            .replace("__WORKTREE__", root),
        root,
    );
    for entries in [codex, claude] {
        let outputs = entries
            .iter()
            .flat_map(entry_candidates)
            .collect::<Vec<_>>();
        assert!(outputs.iter().any(|candidate| matches!(candidate, ArtifactCandidate::Inline {name, ..} if name.ends_with(".html"))));
        assert!(outputs.iter().any(|candidate| matches!(candidate, ArtifactCandidate::Inline {name, ..} if name.ends_with(".mmd"))));
        assert!(
            !outputs
                .iter()
                .any(|candidate| matches!(candidate, ArtifactCandidate::File(_)))
        );
    }
}

#[tokio::test]
async fn native_image_generation_preserves_original_png_once() {
    let dir = tempfile::tempdir().unwrap();
    let worktree = dir.path().join("workspace");
    std::fs::create_dir(&worktree).unwrap();
    let png = include_bytes!("fixtures/artifacts/codex-0.153.4-generated.png");
    let fixture = include_str!("fixtures/artifacts/codex-0.153.4-image-generation.jsonl")
        .replace("__CODEX_HOME__", dir.path().to_str().unwrap())
        .replace(
            "__IMAGE_PNG_BASE64__",
            &base64::engine::general_purpose::STANDARD.encode(png),
        );
    let entries = normalize(&fixture, &worktree, false).await;
    let images: Vec<_> = entries
        .values()
        .filter_map(|entry| match &entry.entry_type {
            NormalizedEntryType::ToolUse {
                action_type: ActionType::ImageView { path },
                ..
            } => Some(path),
            _ => None,
        })
        .collect();
    assert_eq!(images.len(), 1);
    assert!(images[0].starts_with(".vibe-attachments/"));
    assert_eq!(std::fs::read(worktree.join(images[0])).unwrap(), png);
}

#[tokio::test]
async fn native_read_and_image_view_reuse_the_original_file_without_duplicate_images() {
    let png = include_bytes!("fixtures/artifacts/codex-0.153.4-generated.png");
    let claude = include_str!("fixtures/artifacts/claude-2.1.258-read-image.jsonl").replace(
        "__READ_IMAGE_BASE64__",
        &base64::engine::general_purpose::STANDARD
            .encode(include_bytes!("fixtures/artifacts/claude-2.1.258-read.jpg")),
    );
    for (is_claude, fixture) in [
        (true, claude.as_str()),
        (
            false,
            include_str!("fixtures/artifacts/codex-0.153.4-image-view.jsonl"),
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("out")).unwrap();
        std::fs::write(dir.path().join("out/existing-circle.png"), png).unwrap();
        let entries = normalize(fixture, dir.path(), is_claude).await;
        let paths: Vec<_> = entries
            .values()
            .filter_map(|entry| match &entry.entry_type {
                NormalizedEntryType::ToolUse {
                    action_type: ActionType::ImageView { path },
                    ..
                } => Some(path.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(paths, ["out/existing-circle.png"]);
        assert!(!dir.path().join(".vibe-attachments").exists());
    }
}

#[tokio::test]
async fn native_mcp_and_dynamic_tool_images_replay_as_preserved_files() {
    let mcp = include_str!("fixtures/artifacts/codex-0.153.4-mcp-image.jsonl");
    let event: serde_json::Value = serde_json::from_str(mcp.lines().last().unwrap()).unwrap();
    let image = event["params"]["item"]["result"]["content"]
        .as_array()
        .unwrap()
        .iter()
        .find(|block| block["type"] == "image")
        .unwrap();
    let expected = base64::engine::general_purpose::STANDARD
        .decode(image["data"].as_str().unwrap())
        .unwrap();
    for fixture in [
        mcp,
        include_str!("fixtures/artifacts/codex-0.153.4-dynamic-image.jsonl"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let entries = normalize(fixture, dir.path(), false).await;
        let paths = entries
            .values()
            .flat_map(entry_candidates)
            .filter_map(|candidate| match candidate {
                ArtifactCandidate::File(path) if path.starts_with(".vibe-attachments/") => {
                    Some(path)
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            paths.len(),
            1,
            "expected image reference; entry types: {:?}",
            entries
                .values()
                .map(|entry| &entry.entry_type)
                .collect::<Vec<_>>()
        );
        assert_eq!(std::fs::read(dir.path().join(&paths[0])).unwrap(), expected);
    }
}
