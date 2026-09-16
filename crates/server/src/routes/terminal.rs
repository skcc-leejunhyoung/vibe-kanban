use std::path::PathBuf;

use axum::{
    Router,
    extract::{Query, State, ws::Message},
    response::IntoResponse,
    routing::get,
};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use db::models::{workspace::Workspace, workspace_repo::WorkspaceRepo};
use deployment::Deployment;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    DeploymentImpl,
    error::ApiError,
    middleware::signed_ws::{MaybeSignedWebSocket, SignedWsUpgrade},
};

#[derive(Debug, Deserialize)]
struct TerminalQuery {
    /// Omitted for the standalone terminal, which starts in the user's home.
    pub workspace_id: Option<Uuid>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
}

fn default_cols() -> u16 {
    80
}

fn default_rows() -> u16 {
    24
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TerminalCommand {
    Input { data: String },
    Resize { cols: u16, rows: u16 },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TerminalMessage {
    Output {
        data: String,
    },
    /// The shell exited. The client closes the tab on this instead of treating
    /// the socket drop as a dead link and reconnecting into a fresh shell.
    Exit,
    Error {
        message: String,
    },
}

async fn terminal_ws(
    ws: SignedWsUpgrade,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<TerminalQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let working_dir = match query.workspace_id {
        Some(workspace_id) => workspace_working_dir(&deployment, workspace_id).await?,
        None => {
            dirs::home_dir().ok_or_else(|| ApiError::BadRequest("No home directory".to_string()))?
        }
    };

    Ok(ws.on_upgrade(move |socket| {
        handle_terminal_ws(socket, deployment, working_dir, query.cols, query.rows)
    }))
}

async fn workspace_working_dir(
    deployment: &DeploymentImpl,
    workspace_id: Uuid,
) -> Result<PathBuf, ApiError> {
    let attempt = Workspace::find_by_id(&deployment.db().pool, workspace_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Attempt not found".to_string()))?;

    let container_ref = attempt
        .container_ref
        .ok_or_else(|| ApiError::BadRequest("Attempt has no workspace directory".to_string()))?;

    let base_dir = PathBuf::from(&container_ref);
    if !base_dir.exists() {
        return Err(ApiError::BadRequest(
            "Workspace directory does not exist".to_string(),
        ));
    }

    match WorkspaceRepo::find_repos_for_workspace(&deployment.db().pool, workspace_id).await {
        Ok(repos) if repos.len() == 1 => {
            let repo_dir = base_dir.join(&repos[0].name);
            if repo_dir.exists() {
                return Ok(repo_dir);
            }
        }
        Ok(_) => {}
        Err(e) => {
            tracing::warn!(
                "Failed to resolve repos for workspace {}: {}",
                attempt.id,
                e
            );
        }
    }

    Ok(base_dir)
}

async fn handle_terminal_ws(
    mut socket: MaybeSignedWebSocket,
    deployment: DeploymentImpl,
    working_dir: PathBuf,
    cols: u16,
    rows: u16,
) {
    let (session_id, mut output_rx) = match deployment
        .pty()
        .create_session(working_dir, cols, rows)
        .await
    {
        Ok(result) => result,
        Err(e) => {
            tracing::error!("Failed to create PTY session: {}", e);
            let _ = send_error(&mut socket, &e.to_string()).await;
            return;
        }
    };

    let pty_service = deployment.pty().clone();
    let session_id_for_input = session_id;

    loop {
        tokio::select! {
            maybe_output = output_rx.recv() => {
                let Some(data) = maybe_output else {
                    // PTY reader hit EOF: the shell exited (`exit`, Ctrl-D, or a
                    // crash). Say so explicitly — dropping the socket instead
                    // reaches the client as an abnormal close, which its
                    // reconnect path cannot tell apart from a lost connection.
                    let _ = send_exit(&mut socket).await;
                    break;
                };

                let msg = TerminalMessage::Output {
                    data: BASE64.encode(&data),
                };
                let json = match serde_json::to_string(&msg) {
                    Ok(j) => j,
                    Err(_) => continue,
                };

                if socket.send(Message::Text(json.into())).await.is_err() {
                    break;
                }
            }
            inbound = socket.recv() => {
                match inbound {
                    Ok(Some(Message::Text(text))) => {
                        if let Ok(cmd) = serde_json::from_str::<TerminalCommand>(text.as_str()) {
                            match cmd {
                                TerminalCommand::Input { data } => {
                                    if let Ok(bytes) = BASE64.decode(&data) {
                                        let _ = pty_service.write(session_id_for_input, &bytes).await;
                                    }
                                }
                                TerminalCommand::Resize { cols, rows } => {
                                    let _ = pty_service.resize(session_id_for_input, cols, rows).await;
                                }
                            }
                        }
                    }
                    Ok(Some(Message::Close(_))) => break,
                    Ok(Some(_)) => {}
                    Ok(None) => break,
                    Err(error) => {
                        tracing::warn!("terminal WS receive error: {}", error);
                        break;
                    }
                }
            }
        }
    }

    let _ = deployment.pty().close_session(session_id).await;
}

async fn send_exit(socket: &mut MaybeSignedWebSocket) -> anyhow::Result<()> {
    let json = serde_json::to_string(&TerminalMessage::Exit)?;
    socket.send(Message::Text(json.into())).await?;
    socket.close().await?;
    Ok(())
}

async fn send_error(socket: &mut MaybeSignedWebSocket, message: &str) -> anyhow::Result<()> {
    let msg = TerminalMessage::Error {
        message: message.to_string(),
    };
    let json = serde_json::to_string(&msg).unwrap_or_default();
    socket.send(Message::Text(json.into())).await?;
    socket.close().await?;
    Ok(())
}

pub(super) fn router() -> Router<DeploymentImpl> {
    Router::new().route("/terminal/ws", get(terminal_ws))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn omitting_workspace_id_selects_the_home_terminal() {
        let query: TerminalQuery = serde_urlencoded::from_str("cols=120&rows=40").unwrap();
        assert!(query.workspace_id.is_none());
        assert_eq!((query.cols, query.rows), (120, 40));
    }

    #[test]
    fn workspace_id_still_round_trips() {
        let id = Uuid::new_v4();
        let query: TerminalQuery =
            serde_urlencoded::from_str(&format!("workspace_id={id}")).unwrap();
        assert_eq!(query.workspace_id, Some(id));
        assert_eq!((query.cols, query.rows), (80, 24));
    }

    #[test]
    fn exit_is_tagged_so_the_client_can_close_the_tab() {
        let json = serde_json::to_string(&TerminalMessage::Exit).unwrap();
        assert_eq!(json, r#"{"type":"exit"}"#);
    }

    // The two sides of this socket are written in different languages and get
    // edited independently, so pin the frames verbatim: these are exactly the
    // strings TerminalProvider.tsx puts on and takes off the wire.
    #[test]
    fn client_frames_parse() {
        let input: TerminalCommand =
            serde_json::from_str(r#"{"type":"input","data":"7ZWc6riA"}"#).unwrap();
        assert!(matches!(input, TerminalCommand::Input { data } if data == "7ZWc6riA"));

        let resize: TerminalCommand =
            serde_json::from_str(r#"{"type":"resize","cols":120,"rows":40}"#).unwrap();
        assert!(matches!(
            resize,
            TerminalCommand::Resize {
                cols: 120,
                rows: 40
            }
        ));
    }

    #[test]
    fn server_frames_match_the_fields_the_client_reads() {
        let output = serde_json::to_string(&TerminalMessage::Output {
            data: "7ZWc6riA".to_string(),
        })
        .unwrap();
        assert_eq!(output, r#"{"type":"output","data":"7ZWc6riA"}"#);

        let error = serde_json::to_string(&TerminalMessage::Error {
            message: "boom".to_string(),
        })
        .unwrap();
        assert_eq!(error, r#"{"type":"error","message":"boom"}"#);
    }
}
