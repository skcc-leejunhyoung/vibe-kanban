use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
};

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use thiserror::Error;
use tokio::sync::mpsc;
use utils::shell::get_interactive_shell;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum PtyError {
    #[error("Failed to create PTY: {0}")]
    CreateFailed(String),
    #[error("Session not found: {0}")]
    SessionNotFound(Uuid),
    #[error("Failed to write to PTY: {0}")]
    WriteFailed(String),
    #[error("Failed to resize PTY: {0}")]
    ResizeFailed(String),
    #[error("Session already closed")]
    SessionClosed,
}

/// POSIX locale precedence: the first of these that is set wins.
const LOCALE_VARS: [&str; 3] = ["LC_ALL", "LC_CTYPE", "LANG"];

const DEFAULT_UTF8_LOCALE: &str = if cfg!(target_os = "macos") {
    "en_US.UTF-8"
} else {
    "C.UTF-8"
};

fn is_utf8_locale(value: &str) -> bool {
    value.rsplit('.').next().is_some_and(|codeset| {
        codeset.eq_ignore_ascii_case("UTF-8") || codeset.eq_ignore_ascii_case("utf8")
    })
}

/// The PTY inherits the server's environment, and the server is usually started
/// from launchd / the menu-bar app, which pass no locale at all. Without a UTF-8
/// LC_CTYPE the shell falls back to the C locale and every multi-byte character
/// — Hangul, powerline glyphs — is mangled a byte at a time.
///
/// Returns the variable to override, or `None` when the inherited locale is
/// already UTF-8.
fn utf8_locale_override(
    lookup: impl Fn(&str) -> Option<String>,
) -> Option<(&'static str, &'static str)> {
    for key in LOCALE_VARS {
        let Some(value) = lookup(key).filter(|value| !value.trim().is_empty()) else {
            continue;
        };
        return (!is_utf8_locale(&value)).then_some((key, DEFAULT_UTF8_LOCALE));
    }
    Some(("LC_CTYPE", DEFAULT_UTF8_LOCALE))
}

struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    _output_handle: thread::JoinHandle<()>,
    closed: bool,
}

#[derive(Clone)]
pub struct PtyService {
    sessions: Arc<Mutex<HashMap<Uuid, PtySession>>>,
}

impl PtyService {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn create_session(
        &self,
        working_dir: PathBuf,
        cols: u16,
        rows: u16,
    ) -> Result<(Uuid, mpsc::UnboundedReceiver<Vec<u8>>), PtyError> {
        let session_id = Uuid::new_v4();
        let (output_tx, output_rx) = mpsc::unbounded_channel();
        let shell = get_interactive_shell().await;

        let result = tokio::task::spawn_blocking(move || {
            let pty_system = NativePtySystem::default();

            let pty_pair = pty_system
                .openpty(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| PtyError::CreateFailed(e.to_string()))?;

            let mut cmd = CommandBuilder::new(&shell);
            cmd.cwd(&working_dir);

            // Configure shell-specific options
            let shell_name = shell.file_name().and_then(|n| n.to_str()).unwrap_or("");

            if shell_name == "powershell.exe" || shell_name == "pwsh.exe" {
                // PowerShell: use -NoLogo for cleaner startup
                cmd.arg("-NoLogo");
            } else if shell_name == "cmd.exe" {
                // cmd.exe: no special args needed
            } else {
                // Unix shells. Run as a login shell so the user's real profile
                // loads exactly as it would in Terminal.app — PATH from
                // `.zprofile`, plus `.zshrc` extras like oh-my-zsh. We
                // deliberately do not override PROMPT/PS1: the user's theme is
                // the point.
                if shell_name == "zsh" || shell_name == "bash" {
                    cmd.arg("-l");
                }
                cmd.env("VIBE_KANBAN_TERMINAL", "1");

                if let Some((key, value)) = utf8_locale_override(|k| std::env::var(k).ok()) {
                    cmd.env(key, value);
                }
            }

            cmd.env("TERM", "xterm-256color");
            cmd.env("COLORTERM", "truecolor");

            let child = pty_pair
                .slave
                .spawn_command(cmd)
                .map_err(|e| PtyError::CreateFailed(e.to_string()))?;

            let writer = pty_pair
                .master
                .take_writer()
                .map_err(|e| PtyError::CreateFailed(e.to_string()))?;

            let mut reader = pty_pair
                .master
                .try_clone_reader()
                .map_err(|e| PtyError::CreateFailed(e.to_string()))?;

            let output_handle = thread::spawn(move || {
                let mut buf = [0u8; 65536];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            if output_tx.send(buf[..n].to_vec()).is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                drop(child);
            });

            Ok::<_, PtyError>((pty_pair.master, writer, output_handle))
        })
        .await
        .map_err(|e| PtyError::CreateFailed(e.to_string()))??;

        let (master, writer, output_handle) = result;

        let session = PtySession {
            writer,
            master,
            _output_handle: output_handle,
            closed: false,
        };

        self.sessions
            .lock()
            .map_err(|e| PtyError::CreateFailed(e.to_string()))?
            .insert(session_id, session);

        Ok((session_id, output_rx))
    }

    pub async fn write(&self, session_id: Uuid, data: &[u8]) -> Result<(), PtyError> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|e| PtyError::WriteFailed(e.to_string()))?;
        let session = sessions
            .get_mut(&session_id)
            .ok_or(PtyError::SessionNotFound(session_id))?;

        if session.closed {
            return Err(PtyError::SessionClosed);
        }

        session
            .writer
            .write_all(data)
            .map_err(|e| PtyError::WriteFailed(e.to_string()))?;

        session
            .writer
            .flush()
            .map_err(|e| PtyError::WriteFailed(e.to_string()))?;

        Ok(())
    }

    pub async fn resize(&self, session_id: Uuid, cols: u16, rows: u16) -> Result<(), PtyError> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|e| PtyError::ResizeFailed(e.to_string()))?;
        let session = sessions
            .get(&session_id)
            .ok_or(PtyError::SessionNotFound(session_id))?;

        if session.closed {
            return Err(PtyError::SessionClosed);
        }

        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PtyError::ResizeFailed(e.to_string()))?;

        Ok(())
    }

    pub async fn close_session(&self, session_id: Uuid) -> Result<(), PtyError> {
        if let Some(mut session) = self
            .sessions
            .lock()
            .map_err(|_| PtyError::SessionClosed)?
            .remove(&session_id)
        {
            session.closed = true;
        }
        Ok(())
    }
}

impl Default for PtyService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lookup(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> + use<> {
        let pairs: Vec<(String, String)> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        move |key| pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone())
    }

    #[test]
    fn utf8_locale_is_left_alone() {
        assert_eq!(
            utf8_locale_override(lookup(&[("LANG", "ko_KR.UTF-8")])),
            None
        );
        assert_eq!(
            utf8_locale_override(lookup(&[("LC_CTYPE", "C.utf8")])),
            None
        );
    }

    #[test]
    fn missing_or_c_locale_is_overridden() {
        // Launchd-started server: no locale at all.
        assert_eq!(
            utf8_locale_override(lookup(&[])),
            Some(("LC_CTYPE", DEFAULT_UTF8_LOCALE))
        );
        assert_eq!(
            utf8_locale_override(lookup(&[("LANG", "C")])),
            Some(("LANG", DEFAULT_UTF8_LOCALE))
        );
        // Empty values are ignored, the way POSIX skips them.
        assert_eq!(
            utf8_locale_override(lookup(&[("LC_ALL", ""), ("LANG", "en_US.UTF-8")])),
            None
        );
    }

    #[test]
    fn lc_all_outranks_lang() {
        // A non-UTF-8 LC_ALL wins over a UTF-8 LANG, so LC_ALL is what we fix.
        assert_eq!(
            utf8_locale_override(lookup(&[("LC_ALL", "en_US"), ("LANG", "en_US.UTF-8")])),
            Some(("LC_ALL", DEFAULT_UTF8_LOCALE))
        );
    }
}
