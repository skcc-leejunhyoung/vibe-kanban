use std::sync::Arc;

use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, ChildStdout},
    sync::Mutex,
};
use tokio_util::sync::CancellationToken;

use super::types::{
    CLIMessage, ControlRequestType, ControlResponseMessage, ControlResponseType,
    is_task_notification_result,
};
use crate::{
    approvals::ExecutorApprovalError,
    executors::{
        ExecutorError,
        claude::{
            client::ClaudeAgentClient,
            types::{Message, PermissionMode, SDKControlRequest, SDKControlRequestType},
        },
    },
};

/// Handles bidirectional control protocol communication
#[derive(Clone)]
pub struct ProtocolPeer {
    stdin: Arc<Mutex<Option<ChildStdin>>>,
}

impl ProtocolPeer {
    pub fn spawn(
        stdin: ChildStdin,
        stdout: ChildStdout,
        client: Arc<ClaudeAgentClient>,
        cancel: CancellationToken,
    ) -> Self {
        let peer = Self {
            stdin: Arc::new(Mutex::new(Some(stdin))),
        };

        let reader_peer = peer.clone();
        tokio::spawn(async move {
            if let Err(e) = reader_peer.read_loop(stdout, client, cancel).await {
                tracing::error!("Protocol reader loop error: {}", e);
            }
        });

        peer
    }

    async fn read_loop(
        &self,
        stdout: ChildStdout,
        client: Arc<ClaudeAgentClient>,
        cancel: CancellationToken,
    ) -> Result<(), ExecutorError> {
        let mut reader = BufReader::new(stdout);
        let mut buffer = String::new();
        let mut interrupt_sent = false;

        loop {
            buffer.clear();
            tokio::select! {
                biased;
                _ = cancel.cancelled(), if !interrupt_sent => {
                    interrupt_sent = true;
                    tracing::info!("Cancellation received in read_loop, sending interrupt to Claude");
                    if let Err(e) = self.interrupt().await {
                        tracing::warn!("Failed to send interrupt to Claude: {e}");
                    }
                    // Continue the loop to read Claude's response (it should send a result)
                }
                line_result = reader.read_line(&mut buffer) => {
                    match line_result {
                        Ok(0) => {
                            self.stdin.lock().await.take();
                            break;
                        }
                        Ok(_) => {
                            let line = buffer.trim();
                            if line.is_empty() {
                                continue;
                            }
                            client.log_message(line).await?;

                            // Parse and handle control messages
                            match serde_json::from_str::<CLIMessage>(line) {
                                Ok(CLIMessage::ControlRequest {
                                    request_id,
                                    request,
                                }) => {
                                    self.handle_control_request(&client, request_id, request)
                                        .await;
                                }
                                Ok(CLIMessage::Result(result)) => {
                                    // The background-task drain's own result:
                                    // the prompt's turn is still ahead (or
                                    // running), so keep stdin and stdout open.
                                    if is_task_notification_result(&result) {
                                        continue;
                                    }
                                    self.stdin.lock().await.take();
                                    break;
                                }
                                _ => {}
                            }
                        }
                        Err(e) => {
                            tracing::error!("Error reading stdout: {}", e);
                            break;
                        }
                    }
                }
            }
        }
        Ok(())
    }

    async fn handle_control_request(
        &self,
        client: &Arc<ClaudeAgentClient>,
        request_id: String,
        request: ControlRequestType,
    ) {
        match request {
            ControlRequestType::Unknown { subtype } => {
                if let Err(error) = self
                    .send_error(
                        request_id,
                        format!("Unsupported Claude Code control request: {subtype}"),
                    )
                    .await
                {
                    tracing::error!("Failed to reject unsupported control request: {error}");
                }
            }
            ControlRequestType::CanUseTool {
                tool_name,
                input,
                permission_suggestions,
                blocked_paths: _,
                tool_use_id,
            } => {
                match client
                    .on_can_use_tool(tool_name, input, permission_suggestions, tool_use_id)
                    .await
                {
                    Ok(result) => {
                        if let Err(e) = self
                            .send_hook_response(request_id, serde_json::to_value(result).unwrap())
                            .await
                        {
                            tracing::error!("Failed to send permission result: {e}");
                        }
                    }
                    Err(ExecutorError::ExecutorApprovalError(ExecutorApprovalError::Cancelled)) => {
                    }
                    Err(e) => {
                        tracing::error!("Error in on_can_use_tool: {e}");
                        if let Err(e2) = self.send_error(request_id, e.to_string()).await {
                            tracing::error!("Failed to send error response: {e2}");
                        }
                    }
                }
            }
            ControlRequestType::HookCallback {
                callback_id,
                input,
                tool_use_id,
            } => {
                match client
                    .on_hook_callback(callback_id, input, tool_use_id)
                    .await
                {
                    Ok(hook_output) => {
                        if let Err(e) = self.send_hook_response(request_id, hook_output).await {
                            tracing::error!("Failed to send hook callback result: {e}");
                        }
                    }
                    Err(e) => {
                        tracing::error!("Error in on_hook_callback: {e}");
                        if let Err(e2) = self.send_error(request_id, e.to_string()).await {
                            tracing::error!("Failed to send error response: {e2}");
                        }
                    }
                }
            }
        }
    }

    pub async fn send_hook_response(
        &self,
        request_id: String,
        hook_output: serde_json::Value,
    ) -> Result<(), ExecutorError> {
        self.send_json(&ControlResponseMessage::new(ControlResponseType::Success {
            request_id,
            response: Some(hook_output),
        }))
        .await
    }

    /// Send error response to CLI
    async fn send_error(&self, request_id: String, error: String) -> Result<(), ExecutorError> {
        self.send_json(&ControlResponseMessage::new(ControlResponseType::Error {
            request_id,
            error: Some(error),
        }))
        .await
    }

    async fn send_json<T: serde::Serialize>(&self, message: &T) -> Result<(), ExecutorError> {
        let json = serde_json::to_string(message)?;
        let mut stdin = self.stdin.lock().await;
        let stdin = stdin.as_mut().ok_or_else(|| {
            ExecutorError::Io(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "Claude Code stdin is closed",
            ))
        })?;
        stdin.write_all(json.as_bytes()).await?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await?;
        Ok(())
    }

    pub async fn send_user_message(&self, content: String) -> Result<(), ExecutorError> {
        let message = Message::new_user(content);
        self.send_json(&message).await
    }

    pub async fn initialize(&self, hooks: Option<serde_json::Value>) -> Result<(), ExecutorError> {
        self.send_json(&SDKControlRequest::new(SDKControlRequestType::Initialize {
            hooks,
        }))
        .await
    }
    pub async fn interrupt(&self) -> Result<(), ExecutorError> {
        self.send_json(&SDKControlRequest::new(SDKControlRequestType::Interrupt {}))
            .await
    }

    /// Stop a single running background task (`stop_task` control request).
    /// Fire-and-forget like `interrupt`: the CLI acks via a control_response we
    /// don't correlate.
    pub async fn stop_task(&self, task_id: String) -> Result<(), ExecutorError> {
        self.send_json(&SDKControlRequest::new(SDKControlRequestType::StopTask {
            task_id,
        }))
        .await
    }

    pub async fn set_permission_mode(&self, mode: PermissionMode) -> Result<(), ExecutorError> {
        self.send_json(&SDKControlRequest::new(
            SDKControlRequestType::SetPermissionMode { mode },
        ))
        .await
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::{process::Stdio, time::Duration};

    use tokio::process::Command;

    use super::*;
    use crate::{env::RepoContext, executors::codex::client::LogWriter};

    #[tokio::test]
    async fn terminal_output_closes_stdin_while_live_handle_remains() {
        for script in [
            r#"printf '%s\n' '{"type":"result","subtype":"success","result":"done"}'; cat >/dev/null"#,
            "exec 1>&-; cat >/dev/null",
        ] {
            let mut command = Command::new("sh");
            command
                .arg("-c")
                .arg(script)
                .kill_on_drop(true)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped());
            let mut child = command.spawn().unwrap();
            let stdin = child.stdin.take().unwrap();
            let stdout = child.stdout.take().unwrap();
            let cancel = CancellationToken::new();
            let client = ClaudeAgentClient::new(
                LogWriter::new(tokio::io::sink()),
                None,
                RepoContext::default(),
                false,
                String::new(),
                cancel.clone(),
            );
            let peer = ProtocolPeer::spawn(stdin, stdout, client, cancel);

            let status = tokio::time::timeout(Duration::from_secs(2), child.wait())
                .await
                .expect("Claude-style process should receive stdin EOF")
                .unwrap();
            assert!(status.success());
            assert!(matches!(
                peer.send_user_message("too late".to_string()).await,
                Err(ExecutorError::Io(error)) if error.kind() == std::io::ErrorKind::BrokenPipe
            ));
        }
    }

    #[tokio::test]
    async fn unknown_control_request_receives_error_and_the_turn_continues() {
        let mut child = Command::new("sh")
            .args(["-c", r#"printf '%s\n' '{"type":"control_request","request_id":"future-request","request":{"subtype":"future_permission_check"}}'; IFS= read -r reply; printf '%s\n' "$reply" >&2; printf '%s\n' '{"type":"result","subtype":"success","result":"done"}'; cat >/dev/null"#])
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
            .kill_on_drop(true).spawn().unwrap();
        let cancel = CancellationToken::new();
        let client = ClaudeAgentClient::new(
            LogWriter::new(tokio::io::sink()),
            None,
            RepoContext::default(),
            false,
            String::new(),
            cancel.clone(),
        );
        let _peer = ProtocolPeer::spawn(
            child.stdin.take().unwrap(),
            child.stdout.take().unwrap(),
            client,
            cancel,
        );
        let output = tokio::time::timeout(Duration::from_secs(2), child.wait_with_output())
            .await
            .expect("unknown requests must not leave the CLI waiting")
            .unwrap();
        let response: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
        assert_eq!(response["response"]["subtype"], "error");
        assert_eq!(response["response"]["request_id"], "future-request");
        assert!(
            response["response"]["error"]
                .as_str()
                .unwrap()
                .contains("future_permission_check")
        );
    }

    /// A `--resume` with orphaned background tasks drains their
    /// `task_notification`s as a turn of its own, whose `result`
    /// (`origin.kind == "task-notification"`) arrives before the prompt's turn
    /// starts. Treating it as terminal closed stdin and stopped reading, so
    /// the prompt's tool calls and answer never reached the logs.
    #[tokio::test]
    async fn task_notification_result_keeps_reading_until_the_prompt_result() {
        use tokio::io::{AsyncBufReadExt, BufReader};

        const NOTIFICATION_RESULT: &str = r#"{"type":"result","subtype":"success","num_turns":0,"result":"","origin":{"kind":"task-notification"}}"#;
        const ASSISTANT: &str = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"still working"}]}}"#;
        const FINAL_RESULT: &str = r#"{"type":"result","subtype":"success","result":"done","terminal_reason":"completed"}"#;
        // Emit the drain's result, wait for our prompt on stdin, answer it,
        // then idle until stdin EOF like the CLI does.
        let script = format!(
            "printf '%s\\n' '{NOTIFICATION_RESULT}'; read line; printf '%s\\n' '{ASSISTANT}' '{FINAL_RESULT}'; cat >/dev/null"
        );
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg(script)
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        let mut child = command.spawn().unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let cancel = CancellationToken::new();
        let (log_writer, log_reader) = tokio::io::duplex(64 * 1024);
        let client = ClaudeAgentClient::new(
            LogWriter::new(log_writer),
            None,
            RepoContext::default(),
            false,
            String::new(),
            cancel.clone(),
        );
        let peer = ProtocolPeer::spawn(stdin, stdout, client, cancel);

        let mut log_lines = BufReader::new(log_reader).lines();
        let mut next_log_line = async || {
            tokio::time::timeout(Duration::from_secs(2), log_lines.next_line())
                .await
                .expect("log line should arrive")
                .unwrap()
                .expect("log should not end before the prompt result")
        };
        assert_eq!(next_log_line().await, NOTIFICATION_RESULT);
        peer.send_user_message("continue".to_string())
            .await
            .expect("stdin must stay open after a task-notification result");

        let status = tokio::time::timeout(Duration::from_secs(2), child.wait())
            .await
            .expect("the prompt's result should close stdin")
            .unwrap();
        assert!(status.success());
        assert_eq!(next_log_line().await, ASSISTANT);
        assert_eq!(next_log_line().await, FINAL_RESULT);
        assert!(matches!(
            peer.send_user_message("too late".to_string()).await,
            Err(ExecutorError::Io(error)) if error.kind() == std::io::ErrorKind::BrokenPipe
        ));
    }
}
