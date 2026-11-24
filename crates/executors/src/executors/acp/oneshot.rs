//! One-shot text generation over ACP: a fresh agent process and session answer
//! a single prompt and exit. The agent's tool and question requests are all
//! refused, and no conversation is continued or changed.

use std::{path::Path, sync::Arc, time::Duration};

use agent_client_protocol as proto;
use agent_client_protocol::Agent as _;
use tokio::process::Command;
use tokio_util::{
    compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt},
    sync::CancellationToken,
};

use super::{AcpClient, AcpEvent};
use crate::{
    command::{CmdOverrides, CommandParts},
    env::ExecutionEnv,
    executors::{ExecutorError, utils},
};

/// How the agent is told which model answers.
pub enum ModelSelection {
    /// The command line already carries it.
    None,
    /// `session/set_model`.
    SessionModel(String),
    /// `session/set_config_option` for the `model` option.
    ConfigOption(String),
}

fn protocol_error(stage: &str, error: proto::Error) -> ExecutorError {
    utils::agent_error(format!(
        "ACP {stage} failed (code {}).",
        i32::from(error.code)
    ))
}

pub async fn generate_text(
    command: CommandParts,
    cwd: &Path,
    env: &ExecutionEnv,
    cmd_overrides: &CmdOverrides,
    model: ModelSelection,
    prompt: &str,
) -> Result<String, ExecutorError> {
    let (program, args) = command.into_resolved().await?;
    let mut process = Command::new(program);
    process
        .args(args)
        .current_dir(cwd)
        .kill_on_drop(true)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .env("NPM_CONFIG_LOGLEVEL", "error")
        .env("NODE_NO_WARNINGS", "1");
    env.clone()
        .with_profile(cmd_overrides)
        .apply_to_command(&mut process);
    let mut child = process.spawn().map_err(ExecutorError::Io)?;
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let (cwd, prompt) = (cwd.to_path_buf(), prompt.to_string());
    let answer = tokio::task::spawn_blocking(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(ExecutorError::Io)?;
        tokio::task::LocalSet::new().block_on(&rt, async move {
            let (events, mut receiver) = tokio::sync::mpsc::unbounded_channel();
            let client = AcpClient::new(
                events,
                Some(Arc::new(utils::DenyAllApprovals)),
                CancellationToken::new(),
            );
            let (conn, io) = proto::ClientSideConnection::new(
                client,
                stdin.compat_write(),
                stdout.compat(),
                |task| {
                    tokio::task::spawn_local(task);
                },
            );
            let driver = tokio::task::spawn_local(io);
            let result = async {
                conn.initialize(proto::InitializeRequest::new(proto::ProtocolVersion::V1))
                    .await
                    .map_err(|e| protocol_error("initialization", e))?;
                let session = conn
                    .new_session(proto::NewSessionRequest::new(cwd))
                    .await
                    .map_err(|e| protocol_error("session creation", e))?
                    .session_id;
                match model {
                    ModelSelection::None => {}
                    ModelSelection::SessionModel(id) => {
                        conn.set_session_model(proto::SetSessionModelRequest::new(
                            session.clone(),
                            id,
                        ))
                        .await
                        .map_err(|e| protocol_error("model selection", e))?;
                    }
                    ModelSelection::ConfigOption(id) => {
                        conn.set_session_config_option(proto::SetSessionConfigOptionRequest::new(
                            session.clone(),
                            "model",
                            id,
                        ))
                        .await
                        .map_err(|e| protocol_error("model selection", e))?;
                    }
                }
                conn.prompt(proto::PromptRequest::new(
                    session,
                    vec![proto::ContentBlock::Text(proto::TextContent::new(prompt))],
                ))
                .await
                .map_err(|e| protocol_error("prompt", e))?;
                Ok::<_, ExecutorError>(())
            }
            .await;
            driver.abort();
            result?;
            let mut text = String::new();
            while let Ok(event) = receiver.try_recv() {
                if let AcpEvent::Message(proto::ContentBlock::Text(chunk)) = event {
                    text.push_str(&chunk.text);
                }
            }
            Ok::<_, ExecutorError>(text)
        })
    })
    .await
    .map_err(|_| utils::agent_error("The ACP agent stopped unexpectedly."))?;
    let _ = tokio::time::timeout(Duration::from_secs(2), child.kill()).await;
    answer
}
