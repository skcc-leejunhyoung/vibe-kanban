//! Opt-in smoke tests through the real executor, with an isolated model provider.
//! Configure VK_TEST_*_COMMAND and each CLI's provider environment. The provider
//! should stream two text chunks, answer with the selected model ID, and pause
//! after the first chunk for prompts containing WAIT.

use std::{path::Path, sync::Arc, time::Duration};

use executors::{
    approvals::NoopExecutorApprovalService,
    env::ExecutionEnv,
    executors::{CodingAgent, ExecutorExitResult, StandardCodingAgentExecutor, acp::AcpEvent},
    logs::{NormalizedEntryType, utils::patch::extract_normalized_entry_from_patch},
    profile::ExecutorConfig,
};
use futures::StreamExt;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, BufReader};
use workspace_utils::{log_msg::LogMsg, msg_store::MsgStore};

fn executor(name: &str, command_env: &str, model: &str) -> CodingAgent {
    let command = std::env::var(command_env).expect("configure the isolated CLI command");
    let mut agent: CodingAgent = serde_json::from_value(json!({
        name: {"model": model, "base_command_override": command}
    }))
    .expect("executor profile must deserialize");
    agent.use_approvals(Arc::new(NoopExecutorApprovalService));
    agent
}

async fn run_turn(
    agent: &CodingAgent,
    cwd: &Path,
    session: Option<&str>,
    prompt: &str,
    stop: bool,
    expected: &str,
) -> String {
    let env = ExecutionEnv::new(Default::default(), false, String::new());
    let mut spawned = match session {
        Some(id) => agent.spawn_follow_up(cwd, prompt, id, None, &env).await,
        None => agent.spawn(cwd, prompt, &env).await,
    }
    .expect("executor should spawn");
    let stdout = spawned.child.inner().stdout.take().unwrap();
    let stderr = spawned.child.inner().stderr.take().map(|mut stderr| {
        tokio::spawn(async move {
            let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
        })
    });
    let store = Arc::new(MsgStore::new());
    let normalizers = agent.normalize_logs(store.clone(), cwd);
    let mut lines = BufReader::new(stdout).lines();
    let mut streamed_chunks = 0;
    let mut errors = Vec::new();
    let mut approval_requested = false;
    let mut approval_resolved = false;
    let read = tokio::time::timeout(Duration::from_secs(30), async {
        while let Some(line) = lines.next_line().await.unwrap() {
            store.push_stdout(format!("{line}\n"));
            if let Ok(event) = line.parse::<AcpEvent>() {
                match event {
                    AcpEvent::Message(_) => {
                        streamed_chunks += 1;
                        if stop && streamed_chunks == 1 {
                            spawned
                                .cancel
                                .as_ref()
                                .expect("interrupt supported")
                                .cancel();
                        }
                    }
                    AcpEvent::ApprovalRequested { .. } => approval_requested = true,
                    AcpEvent::ApprovalResponse(_) => approval_resolved = true,
                    AcpEvent::Error(error) => errors.push(error),
                    _ => {}
                }
            }
        }
    })
    .await;
    let completion = tokio::time::timeout(
        Duration::from_secs(5),
        spawned.exit_signal.take().expect("protocol exit signal"),
    )
    .await;
    let _ = spawned.child.kill().await;
    if let Some(stderr) = stderr {
        stderr.abort();
    }
    store.push_finished();
    for task in normalizers {
        task.await.unwrap();
    }
    read.expect("executor did not close its output");
    assert!(errors.is_empty(), "{errors:?}");
    assert!(matches!(completion, Ok(Ok(ExecutorExitResult::Success))));
    let mut id = None;
    let mut answer = false;
    for log in store.get_history() {
        match log {
            LogMsg::SessionId(value) => id = Some(value),
            LogMsg::JsonPatch(patch) => {
                if let Some((_, entry)) = extract_normalized_entry_from_patch(&patch)
                    && matches!(entry.entry_type, NormalizedEntryType::AssistantMessage)
                {
                    answer |= entry.content.contains(expected);
                }
            }
            _ => {}
        }
    }
    if stop {
        assert_eq!(
            streamed_chunks, 1,
            "interrupt must stop after the first chunk"
        );
        assert!(
            !answer,
            "interrupted turn must not receive the final model response"
        );
    } else {
        assert!(
            answer,
            "{prompt}: normalized answer must contain {expected}"
        );
        if prompt.contains("APPROVAL") {
            assert!(
                approval_requested && approval_resolved,
                "expected a complete Vibe Kanban approval"
            );
        }
    }
    id.expect("a native session ID was emitted")
}

async fn check_agent(name: &str, command: &str) {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().canonicalize().unwrap();
    let model = "smoke/test-b";
    let agent = executor(name, command, model);
    let mut patches = agent.discover_options(Some(&cwd), None).await.unwrap();
    let patch = patches.next().await.unwrap();
    let serialized = serde_json::to_value(&patch).unwrap();
    assert!(
        serialized.to_string().contains("test-b"),
        "model discovery did not return the configured model: {serialized}"
    );
    let session = run_turn(&agent, &cwd, None, "First turn", false, "test-b").await;
    let mut alternate = agent.clone();
    let mut options = ExecutorConfig::new(name.parse().unwrap());
    options.model_id = Some("smoke/test-a".into());
    alternate.apply_overrides(&options);
    let updated = run_turn(
        &alternate,
        &cwd,
        Some(&session),
        "Follow-up turn",
        false,
        "test-a",
    )
    .await;
    assert_eq!(updated, session);
    let interrupted = run_turn(
        &agent,
        &cwd,
        Some(&session),
        "WAIT for more chunks",
        true,
        "test-b",
    )
    .await;
    assert_eq!(interrupted, session);
    let recovered = run_turn(
        &agent,
        &cwd,
        Some(&session),
        "Resume the interrupted conversation",
        false,
        "test-b",
    )
    .await;
    assert_eq!(recovered, session);
}

#[tokio::test]
#[ignore = "requires an isolated OpenCode v2 installation and model endpoint"]
async fn opencode_v2_streams_resumes_and_stops() {
    check_agent("OPENCODE_V2", "VK_TEST_OPENCODE_V2_COMMAND").await;
}

#[tokio::test]
#[ignore = "requires an isolated Pi and pi-acp installation and model endpoint"]
async fn pi_streams_resumes_and_stops() {
    check_agent("PI", "VK_TEST_PI_COMMAND").await;
}

#[tokio::test]
#[ignore = "requires an isolated ZCode installation and model endpoint"]
async fn zcode_streams_resumes_and_stops() {
    check_agent("ZCODE", "VK_TEST_ZCODE_COMMAND").await;
}

#[tokio::test]
#[ignore = "requires an isolated OpenCode 1.4.7 installation and model endpoint"]
async fn opencode_v1_profile_starts_and_continues() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().canonicalize().unwrap();
    let agent = executor("OPENCODE", "VK_TEST_OPENCODE_V1_COMMAND", "smoke/test-b");
    let session = run_turn(&agent, &cwd, None, "First v1 turn", false, "test-b").await;
    run_turn(&agent, &cwd, Some(&session), "Continue v1", false, "test-b").await;
}

#[tokio::test]
#[ignore = "requires three isolated CLIs, a tool-calling model fixture, and a Pi confirmation extension"]
async fn new_agents_forward_approval_requests() {
    for (name, command) in [
        ("OPENCODE_V2", "VK_TEST_OPENCODE_V2_COMMAND"),
        ("PI", "VK_TEST_PI_COMMAND"),
        ("ZCODE", "VK_TEST_ZCODE_COMMAND"),
    ] {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().canonicalize().unwrap();
        if name == "OPENCODE_V2" {
            std::fs::write(
                cwd.join("opencode.json"),
                r#"{"permissions":[{"action":"*","resource":"*","effect":"ask"}]}"#,
            )
            .unwrap();
        }
        let agent = executor(name, command, "smoke/test-b");
        run_turn(
            &agent,
            &cwd,
            None,
            "APPROVAL for a harmless workspace command",
            false,
            "test-b",
        )
        .await;
    }
}

#[tokio::test]
async fn new_profiles_report_a_missing_installation() {
    use executors::{
        executors::{AvailabilityInfo, BaseCodingAgent},
        profile::{ExecutorConfigs, ExecutorProfileId},
    };

    let defaults = ExecutorConfigs::from_defaults();
    assert!(matches!(
        defaults.get_coding_agent(&ExecutorProfileId::new(BaseCodingAgent::Opencode)),
        Some(CodingAgent::Opencode(_)),
    ));

    let root = tempfile::tempdir().unwrap();
    let missing = root.path().join("missing-agent");
    for name in ["OPENCODE_V2", "PI", "ZCODE"] {
        let id = ExecutorProfileId::new(name.parse().unwrap());
        let default = defaults
            .get_coding_agent(&id)
            .expect("registered default profile");
        assert_eq!(default.get_preset_options().executor, id.executor);
        let agent: CodingAgent = serde_json::from_value(json!({
            name: {"base_command_override": missing.to_string_lossy()}
        }))
        .unwrap();
        assert!(matches!(
            agent.get_availability_info(),
            AvailabilityInfo::NotFound
        ));
        let mut patches = agent
            .discover_options(Some(root.path()), None)
            .await
            .unwrap();
        let patch = serde_json::to_value(patches.next().await.unwrap()).unwrap();
        assert!(
            patch[0]["value"]["error"]
                .as_str()
                .unwrap()
                .contains("Install")
        );
    }
}
