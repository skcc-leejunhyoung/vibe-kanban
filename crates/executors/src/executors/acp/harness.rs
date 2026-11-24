use std::{
    path::{Path, PathBuf},
    process::Stdio,
    rc::Rc,
    sync::Arc,
};

use agent_client_protocol as proto;
use agent_client_protocol::Agent as _;
use command_group::AsyncGroupChild;
use futures::StreamExt;
use tokio::{io::AsyncWriteExt, process::Command, sync::mpsc};
use tokio_util::{
    compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt},
    io::ReaderStream,
    sync::CancellationToken,
};
use tracing::error;
use workspace_utils::{
    approvals::ApprovalStatus, command_ext::GroupSpawnNoWindowExt, stream_lines::LinesStreamExt,
    text::Utf8Decoder,
};

use super::{AcpClient, SessionManager};
use crate::{
    approvals::ExecutorApprovalService,
    command::{CmdOverrides, CommandParts},
    env::{CommitReminder, ExecutionEnv},
    executors::{ExecutorError, ExecutorExitResult, SpawnedChild, acp::AcpEvent},
};

/// Reusable harness for ACP-based conns (Gemini, Qwen, etc.)
pub struct AcpAgentHarness {
    session_namespace: String,
    model: Option<String>,
    mode: Option<String>,
    native_sessions: bool,
    auto_approve_tools: bool,
}

impl Default for AcpAgentHarness {
    fn default() -> Self {
        // Keep existing behavior for Gemini
        Self::new()
    }
}

impl AcpAgentHarness {
    /// Create a harness with the default Gemini namespace
    pub fn new() -> Self {
        Self {
            session_namespace: "gemini_sessions".to_string(),
            model: None,
            mode: None,
            native_sessions: false,
            auto_approve_tools: false,
        }
    }

    /// Create a harness with a custom session namespace (e.g. for Qwen)
    pub fn with_session_namespace(namespace: impl Into<String>) -> Self {
        Self {
            session_namespace: namespace.into(),
            model: None,
            mode: None,
            native_sessions: false,
            auto_approve_tools: false,
        }
    }

    pub fn with_native_sessions(mut self) -> Self {
        self.native_sessions = true;
        self
    }

    /// Approve tool permissions without asking; questions still go to the
    /// approval service.
    pub fn with_auto_approved_tools(mut self, auto_approve: bool) -> Self {
        self.auto_approve_tools = auto_approve;
        self
    }

    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
        self
    }

    pub fn with_mode(mut self, mode: impl Into<String>) -> Self {
        self.mode = Some(mode.into());
        self
    }

    pub fn apply_overrides(&mut self, executor_config: &crate::profile::ExecutorConfig) {
        if let Some(model_id) = &executor_config.model_id {
            self.model = Some(model_id.clone());
        }

        if let Some(agent_id) = &executor_config.agent_id {
            self.mode = Some(agent_id.clone());
        }
    }

    pub async fn spawn_with_command(
        &self,
        current_dir: &Path,
        prompt: String,
        command_parts: CommandParts,
        env: &ExecutionEnv,
        cmd_overrides: &CmdOverrides,
        approvals: Option<std::sync::Arc<dyn ExecutorApprovalService>>,
    ) -> Result<SpawnedChild, ExecutorError> {
        let (program_path, args) = command_parts.into_resolved().await?;
        let mut command = Command::new(program_path);
        command
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(if self.native_sessions {
                Stdio::null()
            } else {
                Stdio::piped()
            })
            .current_dir(current_dir)
            .env("NPM_CONFIG_LOGLEVEL", "error")
            .env("NODE_NO_WARNINGS", "1")
            .args(&args);

        let env = env.clone().with_profile(cmd_overrides);
        env.apply_to_command(&mut command);

        let mut child = command.group_spawn_no_window()?;

        let (exit_tx, exit_rx) = tokio::sync::oneshot::channel::<ExecutorExitResult>();
        let cancel = CancellationToken::new();

        Self::bootstrap_acp_connection(
            &mut child,
            current_dir.to_path_buf(),
            None,
            prompt,
            CommitReminder::from_env(&env),
            Some(exit_tx),
            self.session_namespace.clone(),
            self.native_sessions,
            self.native_sessions
                .then(|| super::super::pi::session_map(&env))
                .flatten(),
            self.model.clone(),
            self.mode.clone(),
            approvals,
            self.auto_approve_tools,
            cancel.clone(),
        )
        .await?;

        Ok(SpawnedChild {
            child,
            exit_signal: Some(exit_rx),
            cancel: Some(cancel),
            subagent_handle: None,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn spawn_follow_up_with_command(
        &self,
        current_dir: &Path,
        prompt: String,
        session_id: &str,
        command_parts: CommandParts,
        env: &ExecutionEnv,
        cmd_overrides: &CmdOverrides,
        approvals: Option<std::sync::Arc<dyn ExecutorApprovalService>>,
    ) -> Result<SpawnedChild, ExecutorError> {
        let (program_path, args) = command_parts.into_resolved().await?;
        let mut command = Command::new(program_path);
        command
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(if self.native_sessions {
                Stdio::null()
            } else {
                Stdio::piped()
            })
            .current_dir(current_dir)
            .env("NPM_CONFIG_LOGLEVEL", "error")
            .env("NODE_NO_WARNINGS", "1")
            .args(&args);

        let env = env.clone().with_profile(cmd_overrides);
        env.apply_to_command(&mut command);

        let mut child = command.group_spawn_no_window()?;

        let (exit_tx, exit_rx) = tokio::sync::oneshot::channel::<ExecutorExitResult>();
        let cancel = CancellationToken::new();

        Self::bootstrap_acp_connection(
            &mut child,
            current_dir.to_path_buf(),
            Some(session_id.to_string()),
            prompt,
            CommitReminder::from_env(&env),
            Some(exit_tx),
            self.session_namespace.clone(),
            self.native_sessions,
            self.native_sessions
                .then(|| super::super::pi::session_map(&env))
                .flatten(),
            self.model.clone(),
            self.mode.clone(),
            approvals,
            self.auto_approve_tools,
            cancel.clone(),
        )
        .await?;

        Ok(SpawnedChild {
            child,
            exit_signal: Some(exit_rx),
            cancel: Some(cancel),
            subagent_handle: None,
        })
    }

    #[allow(clippy::too_many_arguments)]
    async fn bootstrap_acp_connection(
        child: &mut AsyncGroupChild,
        cwd: PathBuf,
        existing_session: Option<String>,
        prompt: String,
        reminder: Option<CommitReminder>,
        exit_signal: Option<tokio::sync::oneshot::Sender<ExecutorExitResult>>,
        session_namespace: String,
        native_sessions: bool,
        pi_session_map: Option<PathBuf>,
        model: Option<String>,
        mode: Option<String>,
        approvals: Option<std::sync::Arc<dyn ExecutorApprovalService>>,
        auto_approve_tools: bool,
        cancel: CancellationToken,
    ) -> Result<(), ExecutorError> {
        // Take child's stdio for ACP wiring
        let orig_stdout = child.inner().stdout.take().ok_or_else(|| {
            ExecutorError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "Child process has no stdout",
            ))
        })?;
        let orig_stdin = child.inner().stdin.take().ok_or_else(|| {
            ExecutorError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "Child process has no stdin",
            ))
        })?;

        // Create a fresh stdout pipe for logs
        let writer = crate::stdout_dup::create_stdout_pipe_writer(child)?;
        let shared_writer = Arc::new(tokio::sync::Mutex::new(writer));
        let (log_tx, mut log_rx) = mpsc::unbounded_channel::<String>();

        // Spawn log -> stdout writer task
        tokio::spawn(async move {
            while let Some(line) = log_rx.recv().await {
                let mut data = line.into_bytes();
                data.push(b'\n');
                let mut w = shared_writer.lock().await;
                let _ = w.write_all(&data).await;
            }
        });

        // ACP client STDIO
        let (mut to_acp_writer, acp_incoming_reader) = tokio::io::duplex(64 * 1024);
        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);

        // Process stdout -> ACP
        let stdout_shutdown_rx = shutdown_rx.clone();
        tokio::spawn(async move {
            let mut stdout_stream = ReaderStream::new(orig_stdout);
            while let Some(res) = stdout_stream.next().await {
                if *stdout_shutdown_rx.borrow() {
                    break;
                }
                match res {
                    Ok(data) => {
                        let _ = to_acp_writer.write_all(&data).await;
                    }
                    Err(_) => break,
                }
            }
        });

        // ACP crate expects futures::AsyncRead + AsyncWrite, use tokio compat to adapt tokio::io::AsyncRead + Write
        let (acp_out_writer, acp_out_reader) = tokio::io::duplex(64 * 1024);
        let outgoing = acp_out_writer.compat_write();
        let incoming = acp_incoming_reader.compat();

        // Process ACP -> stdin
        let stdin_shutdown_rx = shutdown_rx.clone();
        tokio::spawn(async move {
            let mut child_stdin = orig_stdin;
            // Same read-boundary hazard as child stdout: a per-chunk lossy
            // decode would corrupt any non-ASCII character the duplex happens
            // to split, silently mangling the prompt sent to the agent.
            let mut decoder = Utf8Decoder::new();
            let mut lines = ReaderStream::new(acp_out_reader)
                .map(move |res| res.map(|bytes| decoder.push(&bytes)))
                .lines();
            while let Some(result) = lines.next().await {
                if *stdin_shutdown_rx.borrow() {
                    break;
                }
                match result {
                    Ok(line) => {
                        // Use \r\n on Windows for compatibility with buggy ACP implementations
                        const LINE_ENDING: &str = if cfg!(windows) { "\r\n" } else { "\n" };
                        let line = line + LINE_ENDING;
                        if let Err(err) = child_stdin.write_all(line.as_bytes()).await {
                            tracing::debug!("Failed to write to child stdin {err}");
                            break;
                        }
                        let _ = child_stdin.flush().await;
                    }
                    Err(err) => {
                        tracing::debug!("ACP stdin line error {err}");
                        break;
                    }
                }
            }
        });

        let mut exit_signal_tx = exit_signal;

        // Run ACP client in a LocalSet
        tokio::task::spawn_blocking(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("build runtime");

            rt.block_on(async move {
                let local = tokio::task::LocalSet::new();
                local
                    .run_until(async move {
                        // Create event and raw channels
                        // Typed events available for future use; raw lines forwarded and persisted
                        let (event_tx, mut event_rx) =
                            mpsc::unbounded_channel::<crate::executors::acp::AcpEvent>();

                        if native_sessions {
                            let client = AcpClient::new(event_tx, approvals, cancel.clone())
                                .auto_approving_tools(auto_approve_tools);
                            // Native load replays prior messages. Keep them out of this turn.
                            client.set_replaying(true);
                            let (conn, io_fut) = proto::ClientSideConnection::new(
                                client.clone(),
                                outgoing,
                                incoming,
                                |fut| {
                                    tokio::task::spawn_local(fut);
                                },
                            );
                            let io_handle = tokio::task::spawn_local(async move {
                                let _ = io_fut.await;
                            });
                            let mut turn = Box::pin(run_native_turn(
                                &conn,
                                &client,
                                cwd,
                                existing_session,
                                model,
                                prompt,
                                reminder,
                                pi_session_map.as_deref(),
                                &cancel,
                            ));
                            let mut produced_output = false;
                            let result = loop {
                                let event = tokio::select! {
                                    result = &mut turn => break result,
                                    Some(event) = event_rx.recv() => event,
                                };
                                produced_output |= matches!(event, AcpEvent::Message(_) | AcpEvent::ToolCall(_));
                                let _ = log_tx.send(event.to_string());
                            };
                            while let Ok(event) = event_rx.try_recv() {
                                produced_output |= matches!(event, AcpEvent::Message(_) | AcpEvent::ToolCall(_));
                                let _ = log_tx.send(event.to_string());
                            }
                            // pi-acp can return end_turn after Pi's provider rejected the request.
                            let result = result.and_then(|_| {
                                if produced_output || cancel.is_cancelled() {
                                    Ok(())
                                } else {
                                    Err(crate::executors::utils::agent_error(
                                        "Pi returned no response. Check the model or renew the provider credentials with Pi's /login command, then retry.",
                                    ))
                                }
                            });
                            let status = match result {
                                Ok(()) => ExecutorExitResult::Success,
                                Err(err) => {
                                    let _ =
                                        log_tx.send(AcpEvent::Error(err.to_string()).to_string());
                                    ExecutorExitResult::Failure
                                }
                            };
                            io_handle.abort();
                            let _ = shutdown_tx.send(true);
                            drop(log_tx);
                            if let Some(tx) = exit_signal_tx.take() {
                                let _ = tx.send(status);
                            }
                            return;
                        }

                        // Create session manager
                        let session_manager = match SessionManager::new(session_namespace) {
                            Ok(sm) => sm,
                            Err(e) => {
                                error!("Failed to create session manager: {}", e);
                                return;
                            }
                        };
                        let session_manager = std::sync::Arc::new(session_manager);

                        // Create ACP client with approvals support
                        let client =
                            AcpClient::new(event_tx.clone(), approvals.clone(), cancel.clone())
                                .auto_approving_tools(auto_approve_tools);
                        let client_feedback_handle = client.clone();

                        client.record_user_prompt_event(&prompt);

                        // Set up connection
                        let (conn, io_fut) =
                            proto::ClientSideConnection::new(client, outgoing, incoming, |fut| {
                                tokio::task::spawn_local(fut);
                            });
                        let conn = Rc::new(conn);

                        // Drive I/O
                        let io_handle = tokio::task::spawn_local(async move {
                            let _ = io_fut.await;
                        });

                        // Initialize
                        let _ = conn
                            .initialize(proto::InitializeRequest::new(proto::ProtocolVersion::V1))
                            .await;

                        // Handle session creation/forking
                        let (acp_session_id, display_session_id, prompt_to_send) =
                            if let Some(existing) = existing_session {
                                // Fork existing session
                                let new_ui_id = uuid::Uuid::new_v4().to_string();
                                let _ = session_manager.fork_session(&existing, &new_ui_id);

                                let history = session_manager.read_session_raw(&new_ui_id).ok();
                                let meta =
                                    history.map(|h| serde_json::json!({ "history_jsonl": h }));

                                let mut req = proto::NewSessionRequest::new(cwd.clone());
                                if let Some(m) = meta
                                    && let Some(obj) = m.as_object()
                                {
                                    req = req.meta(obj.clone());
                                }
                                match conn.new_session(req).await {
                                    Ok(resp) => {
                                        let resume_prompt = session_manager
                                            .generate_resume_prompt(&new_ui_id, &prompt)
                                            .unwrap_or_else(|_| prompt.clone());
                                        (resp.session_id.0.to_string(), new_ui_id, resume_prompt)
                                    }
                                    Err(e) => {
                                        error!("Failed to create session: {}", e);
                                        return;
                                    }
                                }
                            } else {
                                // New session
                                match conn
                                    .new_session(proto::NewSessionRequest::new(cwd.clone()))
                                    .await
                                {
                                    Ok(resp) => {
                                        let sid = resp.session_id.0.to_string();
                                        (sid.clone(), sid, prompt)
                                    }
                                    Err(e) => {
                                        error!("Failed to create session: {}", e);
                                        return;
                                    }
                                }
                            };

                        // Emit session ID
                        let _ = log_tx
                            .send(AcpEvent::SessionStart(display_session_id.clone()).to_string());

                        if let Some(model) = model.clone() {
                            match conn
                                .set_session_model(proto::SetSessionModelRequest::new(
                                    proto::SessionId::new(acp_session_id.clone()),
                                    model,
                                ))
                                .await
                            {
                                Ok(_) => {}
                                Err(e) => error!("Failed to set session mode: {}", e),
                            }
                        }

                        if let Some(mode) = mode.clone() {
                            match conn
                                .set_session_mode(proto::SetSessionModeRequest::new(
                                    proto::SessionId::new(acp_session_id.clone()),
                                    mode,
                                ))
                                .await
                            {
                                Ok(_) => {}
                                Err(e) => error!("Failed to set session mode: {}", e),
                            }
                        }

                        // Start raw event forwarder and persistence
                        let app_tx_clone = log_tx.clone();
                        let sess_id_for_writer = display_session_id.clone();
                        let sm_for_writer = session_manager.clone();
                        let conn_for_cancel = conn.clone();
                        let acp_session_id_for_cancel = acp_session_id.clone();
                        tokio::task::spawn_local(async move {
                            while let Some(event) = event_rx.recv().await {
                                if let AcpEvent::ApprovalResponse(resp) = &event
                                    && let ApprovalStatus::Denied {
                                        reason: Some(reason),
                                    } = &resp.status
                                    && !reason.trim().is_empty()
                                {
                                    let _ = conn_for_cancel
                                        .cancel(proto::CancelNotification::new(
                                            proto::SessionId::new(
                                                acp_session_id_for_cancel.clone(),
                                            ),
                                        ))
                                        .await;
                                }

                                let line = event.to_string();
                                // Forward to stdout
                                let _ = app_tx_clone.send(line.clone());
                                // Persist to session file
                                let _ = sm_for_writer.append_raw_line(&sess_id_for_writer, &line);
                            }
                        });

                        // Save prompt to session
                        let _ = session_manager.append_raw_line(
                            &display_session_id,
                            &serde_json::to_string(&serde_json::json!({ "user": prompt_to_send }))
                                .unwrap_or_default(),
                        );

                        // Build prompt request
                        let initial_req = proto::PromptRequest::new(
                            proto::SessionId::new(acp_session_id.clone()),
                            vec![proto::ContentBlock::Text(proto::TextContent::new(
                                prompt_to_send,
                            ))],
                        );

                        let mut current_req = Some(initial_req);
                        let mut reminder = reminder;

                        while let Some(req) = current_req.take() {
                            if cancel.is_cancelled() {
                                tracing::debug!("ACP executor cancelled, stopping prompt loop");
                                break;
                            }

                            tracing::trace!(?req, "sending ACP prompt request");
                            // Send the prompt and await completion to obtain stop_reason
                            let prompt_result = tokio::select! {
                                _ = cancel.cancelled() => {
                                    tracing::debug!("ACP executor cancelled during prompt");
                                    break;
                                }
                                result = conn.prompt(req) => result,
                            };

                            let mut ended = false;
                            match prompt_result {
                                Ok(resp) => {
                                    ended = resp.stop_reason == proto::StopReason::EndTurn;
                                    // Emit done with stop_reason
                                    let stop_reason = serde_json::to_string(&resp.stop_reason)
                                        .unwrap_or_default();
                                    let _ = log_tx.send(AcpEvent::Done(stop_reason).to_string());
                                }
                                Err(e) => {
                                    tracing::debug!("error {} {e} {:?}", e.code, e.data);
                                    if e.code
                                        == proto::ErrorCode::InternalError
                                        && e.data
                                            .as_ref()
                                            .is_some_and(|d| d == "server shut down unexpectedly")
                                    {
                                        tracing::debug!("ACP server killed");
                                    } else {
                                        let _ = log_tx
                                            .send(AcpEvent::Error(format!("{e}")).to_string());
                                    }
                                }
                            }

                            // Flush any pending user feedback after finish
                            let feedback = client_feedback_handle
                                .drain_feedback()
                                .await
                                .join("\n")
                                .trim()
                                .to_string();
                            if !feedback.is_empty() {
                                tracing::trace!(?feedback, "sending ACP follow-up feedback");
                                let session_id = proto::SessionId::new(acp_session_id.clone());
                                let feedback_req = proto::PromptRequest::new(
                                    session_id.clone(),
                                    vec![proto::ContentBlock::Text(proto::TextContent::new(
                                        feedback,
                                    ))],
                                );
                                current_req = Some(feedback_req);
                            } else if ended
                                && !cancel.is_cancelled()
                                && let Some(text) = match reminder.take() {
                                    Some(reminder) => reminder.prompt().await,
                                    None => None,
                                }
                            {
                                let _ = log_tx.send(AcpEvent::System(text.clone()).to_string());
                                let _ = session_manager.append_raw_line(
                                    &display_session_id,
                                    &serde_json::json!({ "user": text }).to_string(),
                                );
                                current_req = Some(proto::PromptRequest::new(
                                    proto::SessionId::new(acp_session_id.clone()),
                                    vec![proto::ContentBlock::Text(proto::TextContent::new(text))],
                                ));
                            }
                        }

                        // Notify container of completion
                        if let Some(tx) = exit_signal_tx.take() {
                            let _ = tx.send(ExecutorExitResult::Success);
                        }

                        // Cancel session work
                        let _ = conn
                            .cancel(proto::CancelNotification::new(proto::SessionId::new(
                                acp_session_id,
                            )))
                            .await;

                        // Cleanup
                        drop(conn);
                        let _ = shutdown_tx.send(true);
                        let _ = io_handle.await;
                        drop(log_tx);
                    })
                    .await;
            });
        });

        Ok(())
    }
}

pub(in crate::executors) fn pi_error(stage: &str, error: proto::Error) -> ExecutorError {
    if error.code == proto::ErrorCode::AuthRequired {
        return ExecutorError::AuthRequired(
            "Pi needs a provider. Run pi and use /login, or set a provider API key in the executor environment."
                .to_string(),
        );
    }
    ExecutorError::Io(std::io::Error::other(format!(
        "Pi ACP {stage} failed (code {}). Check the configured model and Pi installation.",
        i32::from(error.code)
    )))
}

#[allow(clippy::too_many_arguments)]
async fn run_native_turn(
    conn: &proto::ClientSideConnection,
    client: &AcpClient,
    cwd: PathBuf,
    existing_session: Option<String>,
    model: Option<String>,
    prompt: String,
    mut reminder: Option<CommitReminder>,
    pi_session_map: Option<&Path>,
    cancel: &CancellationToken,
) -> Result<(), ExecutorError> {
    let session_id = tokio::select! {
        _ = cancel.cancelled() => return Ok(()),
        result = tokio::time::timeout(std::time::Duration::from_secs(30), async {
            let initialized = conn.initialize(proto::InitializeRequest::new(proto::ProtocolVersion::V1))
                .await.map_err(|e| pi_error("initialization", e))?;
            let session_id = if let Some(id) = existing_session {
                let id = proto::SessionId::new(id);
                if !initialized.agent_capabilities.load_session {
                    return Err(ExecutorError::FollowUpNotSupported(
                        "The installed pi-acp adapter does not support session/load. Install pi-acp@0.0.35.".into(),
                    ));
                }
                conn.load_session(proto::LoadSessionRequest::new(id.clone(), cwd))
                    .await.map_err(|e| pi_error("session resume", e))?;
                id
            } else {
                conn.new_session(proto::NewSessionRequest::new(cwd))
                    .await.map_err(|e| pi_error("session creation", e))?.session_id
            };
            if let Some(model) = model {
                conn.set_session_config_option(proto::SetSessionConfigOptionRequest::new(session_id.clone(), "model", model))
                    .await.map_err(|e| pi_error("model selection", e))?;
            }
            Ok::<_, ExecutorError>(session_id)
        }) => result.map_err(|_| ExecutorError::Io(std::io::Error::other("Pi ACP setup timed out. Check that pi-acp and Pi start on this host.")))??,
    };

    client.start_turn(&session_id, &prompt);
    let compacting = crate::executors::utils::parse_slash_command::<
        crate::executors::utils::SlashCommandCall<'_>,
    >(&prompt)
    .is_some_and(|command| command.name == "compact");
    let mut prompt = prompt;
    loop {
        let started_at = chrono::Utc::now().timestamp_millis();
        let response = conn.prompt(proto::PromptRequest::new(
            session_id.clone(),
            vec![proto::ContentBlock::Text(proto::TextContent::new(prompt))],
        ));
        tokio::pin!(response);
        let stop_reason = tokio::select! {
            result = &mut response => {
                let result = result.map_err(|e| pi_error("prompt", e))?;
                if result.stop_reason == proto::StopReason::EndTurn
                    && let Some(session_map) = pi_session_map
                    && let Ok(Some(error)) = tokio::time::timeout(
                        std::time::Duration::from_secs(1),
                        super::super::pi::session_provider_error(session_map, &session_id.0, started_at),
                    ).await
                {
                    return Err(error);
                }
                result.stop_reason
            }
            _ = cancel.cancelled() => {
                let _ = tokio::time::timeout(std::time::Duration::from_secs(2), async {
                    conn.cancel(proto::CancelNotification::new(session_id)).await?;
                    response.await
                }).await;
                return Ok(());
            }
        };
        if compacting {
            // Pi reports no context size until the next reply after compaction.
            client.report(AcpEvent::TokenUsage(crate::logs::TokenUsageInfo {
                total_tokens: 0,
                model_context_window: 0,
            }));
        }
        let next = match (stop_reason == proto::StopReason::EndTurn, reminder.take()) {
            (true, Some(reminder)) => reminder.prompt().await,
            _ => None,
        };
        let Some(next) = next else {
            client.finish_turn(&stop_reason);
            return Ok(());
        };
        client.report(AcpEvent::System(next.clone()));
        prompt = next;
    }
}

#[cfg(all(test, unix))]
mod reminder_tests {
    use tokio::io::AsyncReadExt;

    use super::*;
    use crate::{command::CommandParts, env::RepoContext};

    /// A minimal ACP agent: every prompt reports its context with
    /// `usage_update`, replies, and ends the turn.
    const AGENT: &str = r#"
import json, sys
prompts = []
def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()
def update(kind, **fields):
    send({"jsonrpc": "2.0", "method": "session/update",
          "params": {"sessionId": "sess-fixture", "update": {"sessionUpdate": kind, **fields}}})
for line in sys.stdin:
    message = json.loads(line)
    method, request = message.get("method"), message.get("id")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": request, "result": {"protocolVersion": 1, "agentCapabilities": {}}})
    elif method == "session/new":
        send({"jsonrpc": "2.0", "id": request, "result": {"sessionId": "sess-fixture"}})
    elif method == "session/prompt":
        prompts.append(message["params"]["prompt"][0]["text"])
        with open(sys.argv[1], "w") as log:
            json.dump(prompts, log)
        update("usage_update", used=100 * len(prompts), size=1000)
        update("agent_message_chunk", content={"type": "text", "text": "reply %d" % len(prompts)})
        send({"jsonrpc": "2.0", "id": request, "result": {"stopReason": "end_turn"}})
    elif request is not None:
        send({"jsonrpc": "2.0", "id": request, "result": None})
"#;

    async fn run(harness: AcpAgentHarness) -> (Vec<String>, Vec<AcpEvent>) {
        let fixture = tempfile::tempdir().unwrap();
        let repo = fixture.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        assert!(
            std::process::Command::new("git")
                .args(["init", "-q"])
                .current_dir(&repo)
                .status()
                .unwrap()
                .success()
        );
        std::fs::write(repo.join("left-over.txt"), "fixture").unwrap();
        let script = fixture.path().join("agent.py");
        std::fs::write(&script, AGENT).unwrap();
        let prompts = fixture.path().join("prompts.json");
        let env = ExecutionEnv::new(
            RepoContext::new(fixture.path().to_path_buf(), vec!["repo".into()]),
            true,
            "Commit the changes.".into(),
        );
        let command = CommandParts::new(
            "python3".into(),
            vec![
                script.to_string_lossy().into(),
                prompts.to_string_lossy().into(),
            ],
        );
        let mut spawned = harness
            .spawn_with_command(
                &repo,
                "Fix the fixture".into(),
                command,
                &env,
                &CmdOverrides::default(),
                None,
            )
            .await
            .unwrap();
        let mut stdout = spawned.child.inner().stdout.take().unwrap();
        let status = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            spawned.exit_signal.take().unwrap(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(matches!(status, ExecutorExitResult::Success));
        let _ = spawned.child.kill().await;
        let mut output = String::new();
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            stdout.read_to_string(&mut output),
        )
        .await;
        let prompts: Vec<String> =
            serde_json::from_str(&std::fs::read_to_string(prompts).unwrap()).unwrap();
        let events = output
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        (prompts, events)
    }

    fn check(prompts: &[String], events: &[AcpEvent]) {
        assert_eq!(prompts.len(), 2, "the reminder is sent once: {prompts:?}");
        assert!(prompts[1].starts_with("Commit the changes.\n"));
        assert!(prompts[1].contains("left-over.txt"));
        assert!(events.iter().any(|event| matches!(event,
            AcpEvent::System(text) if text == &prompts[1])));
        let usage: Vec<_> = events
            .iter()
            .filter_map(|event| match event {
                AcpEvent::TokenUsage(info) => Some((info.total_tokens, info.model_context_window)),
                _ => None,
            })
            .collect();
        assert_eq!(usage, [(100, 1000), (200, 1000)]);
    }

    #[tokio::test]
    #[ignore = "runs a python3 ACP agent fixture"]
    async fn native_session_reminds_once_and_reports_usage() {
        let (prompts, events) = run(AcpAgentHarness::new().with_native_sessions()).await;
        check(&prompts, &events);
    }

    #[tokio::test]
    #[ignore = "runs a python3 ACP agent fixture and writes ~/.vibe-kanban session history"]
    async fn replayed_session_reminds_once_and_reports_usage() {
        let namespace = format!("acp-reminder-fixture-{}", uuid::Uuid::new_v4());
        let (prompts, events) =
            run(AcpAgentHarness::with_session_namespace(namespace.clone())).await;
        if let Ok(manager) = SessionManager::new(namespace) {
            let _ = std::fs::remove_dir_all(manager.base_dir());
        }
        check(&prompts, &events);
    }
}
