//! Opt-in upgrade checks through the real executors, including normalization and resume.
//! Set VK_TEST_CODEX_COMMAND / VK_TEST_CLAUDE_COMMAND to test an isolated CLI installation.
//! These tests use existing CLI authentication for small inference/compaction requests.

use std::{path::Path, sync::Arc, time::Duration};

use executors::{
    env::ExecutionEnv,
    executors::{StandardCodingAgentExecutor, claude::ClaudeCode, codex::Codex},
    logs::{NormalizedEntryType, utils::patch::extract_normalized_entry_from_patch},
};
use serde_json::json;
use tokio::io::AsyncReadExt;
use workspace_utils::{log_msg::LogMsg, msg_store::MsgStore};

async fn check_output(
    executor: &impl StandardCodingAgentExecutor,
    cwd: &Path,
    session: Option<&str>,
    prompt: &str,
    expected: &str,
) -> Option<String> {
    let env = ExecutionEnv::new(Default::default(), false, String::new());
    let mut spawned = match session {
        Some(session) => {
            executor
                .spawn_follow_up(cwd, prompt, session, None, &env)
                .await
        }
        None => executor.spawn(cwd, prompt, &env).await,
    }
    .expect("CLI should launch");
    let mut stdout = spawned.child.inner().stdout.take().unwrap();
    let mut stderr = spawned.child.inner().stderr.take().unwrap();
    let output = tokio::spawn(async move {
        let mut text = String::new();
        stdout.read_to_string(&mut text).await.unwrap();
        text
    });
    let errors = tokio::spawn(async move {
        let mut text = String::new();
        stderr.read_to_string(&mut text).await.unwrap();
        text
    });
    let completion = tokio::time::timeout(Duration::from_secs(90), async {
        if let Some(signal) = spawned.exit_signal.take() {
            matches!(
                signal.await.unwrap(),
                executors::executors::ExecutorExitResult::Success
            )
        } else {
            spawned.child.wait().await.unwrap().success()
        }
    })
    .await;
    if let Some(cancel) = spawned.cancel.take() {
        cancel.cancel();
    }
    spawned.subagent_handle.take();
    let _ = spawned.child.kill().await;
    let stdout = tokio::time::timeout(Duration::from_secs(10), output)
        .await
        .unwrap()
        .unwrap();
    let stderr = tokio::time::timeout(Duration::from_secs(10), errors)
        .await
        .unwrap()
        .unwrap();
    assert!(
        completion.expect("turn must complete within 90 seconds"),
        "executor reported failure"
    );

    let store = Arc::new(MsgStore::new());
    store.push_stdout(stdout);
    store.push(LogMsg::Stderr(stderr));
    store.push_finished();
    for handle in executor.normalize_logs(store.clone(), cwd) {
        handle.await.unwrap();
    }
    let mut session_id = None;
    let mut answer_seen = false;
    let mut errors = Vec::new();
    for message in store.get_history() {
        match message {
            LogMsg::SessionId(id) => session_id = Some(id),
            LogMsg::JsonPatch(patch) => {
                if let Some((_, entry)) = extract_normalized_entry_from_patch(&patch) {
                    answer_seen |= matches!(
                        entry.entry_type,
                        NormalizedEntryType::AssistantMessage | NormalizedEntryType::SystemMessage
                    ) && entry.content.contains(expected);
                    if matches!(entry.entry_type, NormalizedEntryType::ErrorMessage { .. }) {
                        errors.push(entry.content);
                    }
                }
            }
            _ => {}
        }
    }
    assert!(
        answer_seen,
        "normalized answer must contain the synthetic marker"
    );
    assert!(
        errors.is_empty(),
        "normalization errors for {prompt}: {errors:?}"
    );
    session_id
}

#[tokio::test]
#[ignore = "requires an authenticated Codex CLI; makes small inference and compaction requests"]
async fn codex_cli_completes_and_resumes() {
    let command = std::env::var("VK_TEST_CODEX_COMMAND").unwrap_or_else(|_| "codex".to_string());
    let executor: Codex =
        serde_json::from_value(json!({"base_command_override": command})).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let session = check_output(
        &executor,
        dir.path(),
        None,
        "Reply exactly COMPAT_INITIAL_OK. Do not use tools or modify files.",
        "COMPAT_INITIAL_OK",
    )
    .await
    .expect("native session ID for resume");
    let session = check_output(
        &executor,
        dir.path(),
        Some(&session),
        "/compact Preserve the synthetic compatibility markers.",
        "Context compacted",
    )
    .await
    .expect("compacted session ID");
    check_output(
        &executor,
        dir.path(),
        Some(&session),
        "Reply exactly COMPAT_RESUMED_OK. Do not use tools or modify files.",
        "COMPAT_RESUMED_OK",
    )
    .await
    .expect("resumed session ID");
}

#[tokio::test]
#[ignore = "requires an authenticated Claude Code CLI; makes two small inference requests"]
async fn claude_cli_completes_and_resumes() {
    let command = std::env::var("VK_TEST_CLAUDE_COMMAND").unwrap_or_else(|_| "claude".to_string());
    let executor: ClaudeCode =
        serde_json::from_value(json!({"base_command_override": command})).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let session = check_output(
        &executor,
        dir.path(),
        None,
        "Reply exactly COMPAT_INITIAL_OK. Do not use tools or modify files.",
        "COMPAT_INITIAL_OK",
    )
    .await
    .expect("native session ID for resume");
    check_output(
        &executor,
        dir.path(),
        Some(&session),
        "Reply exactly COMPAT_RESUMED_OK. Do not use tools or modify files.",
        "COMPAT_RESUMED_OK",
    )
    .await
    .expect("resumed session ID");
}

#[tokio::test]
#[ignore = "requires an installed Codex CLI; reads live command catalogs without inference"]
async fn codex_cli_slash_command_catalogs() {
    let command = std::env::var("VK_TEST_CODEX_COMMAND").unwrap_or_else(|_| "codex".to_string());
    let executor: Codex =
        serde_json::from_value(json!({"base_command_override": command})).unwrap();
    let dir = tempfile::tempdir().unwrap();
    for (prompt, expected) in [
        ("/help", "Codex commands in Vibe Kanban"),
        ("/model", "Available models"),
        ("/skills", "Available skills"),
        ("/status", "Session Status"),
    ] {
        check_output(&executor, dir.path(), None, prompt, expected).await;
    }
}
