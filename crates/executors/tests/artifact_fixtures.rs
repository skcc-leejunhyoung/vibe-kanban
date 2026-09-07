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
async fn file_operations_in_real_cli_logs_do_not_publish_artifacts() {
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
        assert!(
            candidates.is_empty(),
            "file operations are not attachments (claude={claude}): {candidates:?}"
        );
        // Add an assistant publication to the same native log format; tools
        // still produce no cards and the CLI transport preserves the marker.
        let text = "[report](index.html \"vibe-artifact\")";
        let publication = if claude {
            serde_json::json!({"type":"assistant", "message":{"role":"assistant", "content":[{"type":"text", "text":text}]}})
        } else {
            serde_json::json!({"method":"item/completed", "params":{"threadId":"thread", "turnId":"turn", "completedAtMs":1, "item":{"type":"agentMessage", "id":"published-report", "text":text}}})
        };
        let published = normalize(
            &format!("{}\n{}\n", fixture.trim_end(), publication),
            dir.path(),
            claude,
        )
        .await;
        assert_eq!(
            published
                .values()
                .flat_map(entry_candidates)
                .collect::<Vec<_>>(),
            vec![ArtifactCandidate::File("index.html".into())],
            "claude={claude}"
        );
    }
}

#[test]
fn child_transcripts_require_explicit_inline_attachment_markers() {
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
    for mut entries in [codex, claude] {
        assert!(entries.iter().flat_map(entry_candidates).next().is_none());
        for entry in &mut entries {
            entry.content = entry
                .content
                .replace("```html", "```html vibe-artifact")
                .replace("```mermaid", "```mermaid vibe-artifact");
        }
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
        assert!(entries.values().flat_map(entry_candidates).next().is_none());
        let paths = std::fs::read_dir(dir.path().join(".vibe-attachments"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.file_name().is_some_and(|name| name != ".gitignore"))
            .collect::<Vec<_>>();
        assert_eq!(
            paths.len(),
            1,
            "native tool image bytes remain available without publishing a card"
        );
        assert_eq!(std::fs::read(&paths[0]).unwrap(), expected);
        assert!(
            serde_json::to_string(&entries)
                .unwrap()
                .contains(paths[0].file_name().unwrap().to_str().unwrap())
        );
    }
}
