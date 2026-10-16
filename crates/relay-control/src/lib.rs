pub mod account;
pub mod account_registration;
pub mod account_sessions;
pub mod signing;

use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

/// Controls the lifecycle of the relay tunnel connection.
///
/// Start/stop can be called from login/logout handlers to dynamically
/// manage the relay without restarting the server.
pub struct RelayControl {
    pub account_update_lock: tokio::sync::Mutex<()>,
    /// Token used to cancel the current relay connection
    shutdown: RwLock<Option<CancellationToken>>,
}

impl Default for RelayControl {
    fn default() -> Self {
        Self::new()
    }
}

impl RelayControl {
    pub fn new() -> Self {
        Self {
            account_update_lock: tokio::sync::Mutex::new(()),
            shutdown: RwLock::new(None),
        }
    }

    /// Create a new cancellation token for a relay session.
    /// Cancels any previously running session first.
    pub async fn reset(&self) -> CancellationToken {
        let mut guard = self.shutdown.write().await;
        if let Some(old) = guard.take() {
            old.cancel();
        }
        let token = CancellationToken::new();
        *guard = Some(token.clone());
        token
    }

    /// Whether the relay session was started, including while it reconnects.
    pub async fn is_running(&self) -> bool {
        self.shutdown
            .read()
            .await
            .as_ref()
            .is_some_and(|token| !token.is_cancelled())
    }

    /// Cancel the current relay session if one is running.
    pub async fn stop(&self) {
        let mut guard = self.shutdown.write().await;
        if let Some(token) = guard.take() {
            token.cancel();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn running_state_tracks_start_stop_and_cancelled_sessions() {
        let control = RelayControl::new();
        assert!(!control.is_running().await);

        let first = control.reset().await;
        assert!(control.is_running().await);
        let second = control.reset().await;
        assert!(first.is_cancelled());
        assert!(control.is_running().await);

        second.cancel();
        assert!(!control.is_running().await);
        let third = control.reset().await;
        assert!(control.is_running().await);
        control.stop().await;
        assert!(third.is_cancelled());
        assert!(!control.is_running().await);
    }
}
