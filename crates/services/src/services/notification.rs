use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use db::models::web_push_subscription::{WebPushSubscription, WebPushSubscriptionModel};
use secrecy::{ExposeSecret, SecretString};
use serde::Serialize;
use sqlx::SqlitePool;
use tokio::sync::RwLock;
use utils::{self, command_ext::NoWindowExt};
use uuid::Uuid;
use web_push::{
    ContentEncoding, IsahcWebPushClient, SubscriptionInfo, Urgency, VapidSignatureBuilder,
    WebPushClient, WebPushError, WebPushMessageBuilder,
};

use crate::services::{
    config::{Config, SoundFile},
    remote_client::RemoteClient,
};

/// Trait for sending push notifications. Implementations can use
/// platform-specific OS commands, Tauri's notification plugin, etc.
#[async_trait]
pub trait PushNotifier: Send + Sync + 'static {
    async fn send(&self, title: &str, message: &str, workspace_id: Option<Uuid>);
}

/// Global push notifier set before server startup (e.g., by the Tauri app).
/// Falls back to `DefaultPushNotifier` if not set.
static GLOBAL_PUSH_NOTIFIER: OnceLock<Arc<dyn PushNotifier>> = OnceLock::new();

/// Register a custom push notifier globally. Must be called before the server
/// starts (i.e., before `LocalDeployment::new()`). Typically called from the
/// Tauri app to inject a `TauriNotifier` that uses the native notification API.
pub fn set_global_push_notifier(notifier: Arc<dyn PushNotifier>) {
    let _ = GLOBAL_PUSH_NOTIFIER.set(notifier);
}

/// Get the global push notifier, or `DefaultPushNotifier` if none was set.
pub fn get_global_push_notifier() -> Arc<dyn PushNotifier> {
    GLOBAL_PUSH_NOTIFIER
        .get()
        .cloned()
        .unwrap_or_else(|| Arc::new(DefaultPushNotifier))
}

/// Default push notifier using platform-specific OS commands.
/// Used as a fallback when no Tauri app handle is available.
pub struct DefaultPushNotifier;

/// Cache for WSL root path from PowerShell
static WSL_ROOT_PATH_CACHE: OnceLock<Option<String>> = OnceLock::new();

#[async_trait]
impl PushNotifier for DefaultPushNotifier {
    async fn send(&self, title: &str, message: &str, workspace_id: Option<Uuid>) {
        if cfg!(target_os = "macos") {
            let click_url = local_notification_click_url(workspace_id).await;
            send_macos_notification(title, message, click_url.as_deref()).await;
        } else if cfg!(target_os = "linux") && !utils::is_wsl2() {
            send_linux_notification(title, message).await;
        } else if cfg!(target_os = "windows") || (cfg!(target_os = "linux") && utils::is_wsl2()) {
            send_windows_notification(title, message).await;
        }
    }
}

/// Service for handling cross-platform notifications including sound alerts and push notifications
#[derive(Clone)]
pub struct NotificationService {
    config: Arc<RwLock<Config>>,
    pool: SqlitePool,
    push_notifier: Arc<dyn PushNotifier>,
    /// When the local host is paired to a remote, notifications are also
    /// forwarded to the user's remote web push subscriptions (phone, etc.).
    remote_client: Option<RemoteClient>,
}

impl std::fmt::Debug for NotificationService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NotificationService")
            .field("config", &self.config)
            .finish()
    }
}

impl NotificationService {
    pub fn new(
        config: Arc<RwLock<Config>>,
        pool: SqlitePool,
        remote_client: Option<RemoteClient>,
    ) -> Self {
        Self {
            config,
            pool,
            push_notifier: get_global_push_notifier(),
            remote_client,
        }
    }

    /// Send both sound and push notifications if enabled.
    /// `workspace_id` is forwarded to the push notifier so Tauri can emit a
    /// navigation event when the notification is clicked.
    pub async fn notify(&self, title: &str, message: &str, workspace_id: Option<Uuid>) {
        let config = self.config.read().await.notifications.clone();

        if config.sound_enabled {
            Self::play_sound_notification(&config.sound_file).await;
        }

        if config.push_enabled {
            // Forward to the user's remote web push subscriptions (phone, etc.)
            // regardless of how the notification is delivered locally.
            self.forward_to_remote_web_push(title, message, workspace_id);

            let web_push_active = self
                .send_web_push(title, message, workspace_id)
                .await
                .unwrap_or_else(|error| {
                    tracing::warn!(?error, "failed to send local web push notifications");
                    false
                });
            if web_push_active {
                return;
            }

            self.push_notifier.send(title, message, workspace_id).await;
        }
    }

    /// Deliver a push to this host's LOCAL subscriptions only (and the OS
    /// notifier fallback), without forwarding to the user's remote web push
    /// subscriptions.
    ///
    /// Used for events the remote already pushes to remote subscriptions on its
    /// own (e.g. an issue becoming "ready for review", which the remote delivers
    /// as an `issue_review_requested` notification). Forwarding those again would
    /// double-notify remote devices (phone), so we only cover the disjoint local
    /// subscriptions (e.g. a desktop browser paired via the local server) that
    /// the remote notification never reaches.
    pub async fn notify_local_only(&self, title: &str, message: &str, workspace_id: Option<Uuid>) {
        let config = self.config.read().await.notifications.clone();

        if !config.push_enabled {
            return;
        }

        let web_push_active = self
            .send_web_push(title, message, workspace_id)
            .await
            .unwrap_or_else(|error| {
                tracing::warn!(?error, "failed to send local web push notifications");
                false
            });
        if web_push_active {
            return;
        }

        self.push_notifier.send(title, message, workspace_id).await;
    }

    /// Fire-and-forget forward of a notification to the authenticated user's
    /// remote web push subscriptions via the paired remote server.
    fn forward_to_remote_web_push(&self, title: &str, message: &str, workspace_id: Option<Uuid>) {
        let Some(client) = self.remote_client.clone() else {
            return;
        };
        let title = title.to_string();
        let message = message.to_string();
        tokio::spawn(async move {
            if let Err(error) = client
                .send_self_web_push(&title, &message, workspace_id)
                .await
            {
                tracing::debug!(?error, "failed to forward notification to remote web push");
            }
        });
    }

    pub fn web_push_public_key(&self) -> Option<String> {
        WebPushConfig::from_env().map(|config| config.public_key)
    }

    pub async fn upsert_web_push_subscription(
        &self,
        endpoint: &str,
        p256dh: &str,
        auth: &str,
        user_agent: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        WebPushSubscriptionModel::upsert(&self.pool, endpoint, p256dh, auth, user_agent)
            .await
            .map(|_| ())
    }

    pub async fn delete_web_push_subscription(&self, endpoint: &str) -> Result<(), sqlx::Error> {
        WebPushSubscriptionModel::delete(&self.pool, endpoint)
            .await
            .map(|_| ())
    }

    async fn send_web_push(
        &self,
        title: &str,
        message: &str,
        workspace_id: Option<Uuid>,
    ) -> Result<bool, sqlx::Error> {
        if !WebPushSubscriptionModel::has_any(&self.pool).await? {
            return Ok(false);
        }

        let Some(config) = WebPushConfig::from_env() else {
            return Ok(false);
        };

        let subscriptions = WebPushSubscriptionModel::list(&self.pool).await?;
        if subscriptions.is_empty() {
            return Ok(false);
        }

        let client = match IsahcWebPushClient::new() {
            Ok(client) => client,
            Err(error) => {
                tracing::warn!(?error, "failed to initialize local web push client");
                return Ok(true);
            }
        };

        let payload = LocalPushPayload {
            title,
            body: message,
            deeplink_path: local_web_push_click_url(workspace_id).await,
        };

        for subscription in subscriptions {
            if let Err(error) =
                send_to_subscription(&client, &config, &subscription, &payload).await
            {
                tracing::warn!(
                    error = %error,
                    endpoint = %subscription.endpoint,
                    "failed to send local web push notification"
                );
                if is_expired_subscription_error(&error)
                    && let Err(delete_error) =
                        WebPushSubscriptionModel::delete(&self.pool, &subscription.endpoint).await
                {
                    tracing::warn!(
                        ?delete_error,
                        "failed to delete expired local web push subscription"
                    );
                }
            }
        }

        Ok(true)
    }

    /// Play a system sound notification across platforms
    async fn play_sound_notification(sound_file: &SoundFile) {
        let file_path = match sound_file.get_path().await {
            Ok(path) => path,
            Err(e) => {
                tracing::error!("Failed to create cached sound file: {}", e);
                return;
            }
        };

        // Use platform-specific sound notification
        // Note: spawn() calls are intentionally not awaited - sound notifications should be fire-and-forget
        if cfg!(target_os = "macos") {
            let _ = tokio::process::Command::new("afplay")
                .arg(&file_path)
                .spawn();
        } else if cfg!(target_os = "linux") && !utils::is_wsl2() {
            // Try different Linux audio players
            if tokio::process::Command::new("paplay")
                .arg(&file_path)
                .spawn()
                .is_ok()
            {
                // Success with paplay
            } else if tokio::process::Command::new("aplay")
                .arg(&file_path)
                .spawn()
                .is_ok()
            {
                // Success with aplay
            } else {
                // Try system bell as fallback
                let _ = tokio::process::Command::new("echo")
                    .arg("-e")
                    .arg("\\a")
                    .spawn();
            }
        } else if cfg!(target_os = "windows") || (cfg!(target_os = "linux") && utils::is_wsl2()) {
            // Convert WSL path to Windows path if in WSL2
            let file_path = if utils::is_wsl2() {
                if let Some(windows_path) = wsl_to_windows_path(&file_path).await {
                    windows_path
                } else {
                    file_path.to_string_lossy().to_string()
                }
            } else {
                file_path.to_string_lossy().to_string()
            };

            let _ = tokio::process::Command::new("powershell.exe")
                .arg("-c")
                .arg(format!(
                    r#"(New-Object Media.SoundPlayer "{file_path}").PlaySync()"#
                ))
                .no_window()
                .spawn();
        }
    }
}

#[derive(Debug, Clone)]
struct WebPushConfig {
    public_key: String,
    private_key: SecretString,
    subject: String,
}

impl WebPushConfig {
    fn from_env() -> Option<Self> {
        let public_key = std::env::var("WEB_PUSH_VAPID_PUBLIC_KEY")
            .ok()
            .filter(|value| !value.trim().is_empty())?;
        let private_key = std::env::var("WEB_PUSH_VAPID_PRIVATE_KEY")
            .ok()
            .filter(|value| !value.trim().is_empty())?;
        let subject = std::env::var("WEB_PUSH_VAPID_SUBJECT")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "mailto:admin@vibekanban.com".to_string());

        Some(Self {
            public_key,
            private_key: SecretString::new(private_key.into()),
            subject,
        })
    }
}

#[derive(Serialize)]
struct LocalPushPayload<'a> {
    title: &'a str,
    body: &'a str,
    deeplink_path: Option<String>,
}

async fn send_to_subscription(
    client: &IsahcWebPushClient,
    config: &WebPushConfig,
    subscription: &WebPushSubscription,
    payload: &LocalPushPayload<'_>,
) -> Result<(), WebPushError> {
    let subscription_info = SubscriptionInfo::new(
        subscription.endpoint.as_str(),
        subscription.p256dh.as_str(),
        subscription.auth.as_str(),
    );

    let mut signature =
        VapidSignatureBuilder::from_base64(config.private_key.expose_secret(), &subscription_info)?;
    signature.add_claim("sub", config.subject.as_str());
    let signature = signature.build()?;

    let payload = serde_json::to_vec(payload).map_err(|_| WebPushError::InvalidResponse)?;

    let mut message = WebPushMessageBuilder::new(&subscription_info);
    message.set_payload(ContentEncoding::Aes128Gcm, &payload);
    message.set_vapid_signature(signature);
    message.set_ttl(60 * 60 * 24);
    message.set_urgency(Urgency::Normal);

    client.send(message.build()?).await
}

fn is_expired_subscription_error(error: &WebPushError) -> bool {
    matches!(
        error,
        WebPushError::EndpointNotFound(_) | WebPushError::EndpointNotValid(_)
    )
}

// --- Platform-specific push notification helpers (used by DefaultPushNotifier) ---

const REMOTE_NOTIFICATION_URL_ENV: &str = "VK_NOTIFICATION_REMOTE_URL";
const PUBLIC_BASE_URL_ENV: &str = "PUBLIC_BASE_URL";
const LOCAL_WEB_PUSH_BASE_URL_ENV: &str = "WEB_PUSH_LOCAL_BASE_URL";
const WEB_PUSH_WORKSPACE_PATH_TEMPLATE_ENV: &str = "WEB_PUSH_WORKSPACE_PATH_TEMPLATE";
const DEFAULT_WEB_PUSH_WORKSPACE_PATH_TEMPLATE: &str = "/workspace/{workspace_id}";

fn local_notification_url(port: u16) -> String {
    format!("http://localhost:{port}")
}

fn normalize_remote_notification_url(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.starts_with("https://") {
        Some(format!("{trimmed}/"))
    } else {
        None
    }
}

fn remote_notification_url_from_env() -> Option<String> {
    for key in [REMOTE_NOTIFICATION_URL_ENV, PUBLIC_BASE_URL_ENV] {
        let Ok(value) = std::env::var(key) else {
            continue;
        };

        if let Some(url) = normalize_remote_notification_url(&value) {
            return Some(url);
        }

        tracing::warn!(
            env = key,
            "ignoring notification remote URL because it is not an https URL"
        );
    }

    None
}

async fn notification_click_url() -> Option<String> {
    match utils::port_file::read_port_file("vibe-kanban").await {
        Ok(port) => Some(local_notification_url(port)),
        Err(error) => {
            tracing::debug!(%error, "local Vibe Kanban port file unavailable");
            remote_notification_url_from_env()
        }
    }
}

/// Click target for a local OS notification: deep-link straight to the workspace
/// when known (so clicking opens the completed workspace), else the app root.
async fn local_notification_click_url(workspace_id: Option<Uuid>) -> Option<String> {
    if let Some(url) = local_web_push_click_url(workspace_id).await {
        return Some(url);
    }
    notification_click_url().await
}

fn web_push_workspace_path(workspace_id: Uuid) -> String {
    let template = std::env::var(WEB_PUSH_WORKSPACE_PATH_TEMPLATE_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_WEB_PUSH_WORKSPACE_PATH_TEMPLATE.to_string());
    let path = template.replace("{workspace_id}", &workspace_id.to_string());

    if path.starts_with('/') {
        path
    } else {
        format!("/{path}")
    }
}

fn normalize_local_web_push_base_url(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_end_matches('/');
    let is_loopback = trimmed.starts_with("http://localhost:")
        || trimmed == "http://localhost"
        || trimmed.starts_with("https://localhost:")
        || trimmed == "https://localhost"
        || trimmed.starts_with("http://127.0.0.1:")
        || trimmed == "http://127.0.0.1"
        || trimmed.starts_with("https://127.0.0.1:")
        || trimmed == "https://127.0.0.1";

    is_loopback.then(|| trimmed.to_string())
}

fn build_web_push_click_url(base_url: &str, workspace_id: Uuid) -> Option<String> {
    normalize_local_web_push_base_url(base_url)
        .map(|base_url| format!("{base_url}{}", web_push_workspace_path(workspace_id)))
}

async fn local_web_push_base_url() -> Option<String> {
    if let Ok(value) = std::env::var(LOCAL_WEB_PUSH_BASE_URL_ENV) {
        if let Some(base_url) = normalize_local_web_push_base_url(&value) {
            return Some(base_url);
        }

        tracing::warn!(
            env = LOCAL_WEB_PUSH_BASE_URL_ENV,
            "ignoring local web push base URL because it is not a loopback URL"
        );
    }

    match utils::port_file::read_port_file("vibe-kanban").await {
        Ok(port) => Some(local_notification_url(port)),
        Err(error) => {
            tracing::debug!(%error, "local Vibe Kanban port file unavailable");
            None
        }
    }
}

async fn local_web_push_click_url(workspace_id: Option<Uuid>) -> Option<String> {
    let workspace_id = workspace_id?;
    let base_url = local_web_push_base_url().await?;
    build_web_push_click_url(&base_url, workspace_id)
}

/// Locate the `terminal-notifier` binary (PATH first, then common Homebrew
/// locations). Returns `None` if it is not installed.
fn find_terminal_notifier() -> Option<String> {
    use std::path::Path;

    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':') {
            let candidate = Path::new(dir).join("terminal-notifier");
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }

    for candidate in [
        "/opt/homebrew/bin/terminal-notifier",
        "/usr/local/bin/terminal-notifier",
    ] {
        if Path::new(candidate).is_file() {
            return Some(candidate.to_string());
        }
    }

    None
}

/// Send macOS notification.
///
/// `osascript display notification` has no click URL support, so use
/// `terminal-notifier` when available and fall back to display-only banners.
async fn send_macos_notification(title: &str, message: &str, click_url: Option<&str>) {
    if let (Some(bin), Some(url)) = (find_terminal_notifier(), click_url) {
        let _ = tokio::process::Command::new(bin)
            .arg("-title")
            .arg(title)
            .arg("-message")
            .arg(message)
            .arg("-open")
            .arg(url)
            .arg("-sound")
            .arg("default")
            .spawn();
        return;
    }

    let script = format!(
        r#"display notification "{message}" with title "{title}" sound name "Glass""#,
        message = message.replace('"', r#"\""#),
        title = title.replace('"', r#"\""#)
    );

    let _ = tokio::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .spawn();
}

/// Send Linux notification using notify-rust
async fn send_linux_notification(title: &str, message: &str) {
    use notify_rust::Notification;

    let title = title.to_string();
    let message = message.to_string();

    let _handle = tokio::task::spawn_blocking(move || {
        match Notification::new()
            .summary(&title)
            .body(&message)
            .timeout(10000)
            .show()
        {
            Ok(_) => {}
            Err(e) => {
                let err_str = e.to_string();
                if err_str.contains("ServiceUnknown")
                    || err_str.contains("org.freedesktop.Notifications")
                {
                    tracing::warn!("Linux notification daemon not available: {}", e);
                } else {
                    tracing::warn!("Failed to send Linux notification: {}", e);
                }
            }
        }
    });
    drop(_handle); // Don't await, fire-and-forget
}

/// Send Windows/WSL notification using PowerShell toast script
async fn send_windows_notification(title: &str, message: &str) {
    let script_path = match utils::get_powershell_script().await {
        Ok(path) => path,
        Err(e) => {
            tracing::error!("Failed to get PowerShell script: {}", e);
            return;
        }
    };

    // Convert WSL path to Windows path if in WSL2
    let script_path_str = if utils::is_wsl2() {
        if let Some(windows_path) = wsl_to_windows_path(&script_path).await {
            windows_path
        } else {
            script_path.to_string_lossy().to_string()
        }
    } else {
        script_path.to_string_lossy().to_string()
    };

    let _ = tokio::process::Command::new("powershell.exe")
        .arg("-NoProfile")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(script_path_str)
        .arg("-Title")
        .arg(title)
        .arg("-Message")
        .arg(message)
        .no_window()
        .spawn();
}

/// Get WSL root path via PowerShell (cached)
async fn get_wsl_root_path() -> Option<String> {
    if let Some(cached) = WSL_ROOT_PATH_CACHE.get() {
        return cached.clone();
    }

    match tokio::process::Command::new("powershell.exe")
        .arg("-c")
        .arg("(Get-Location).Path -replace '^.*::', ''")
        .current_dir("/")
        .no_window()
        .output()
        .await
    {
        Ok(output) => {
            match String::from_utf8(output.stdout) {
                Ok(pwd_str) => {
                    let pwd = pwd_str.trim();
                    tracing::info!("WSL root path detected: {}", pwd);

                    // Cache the result
                    let _ = WSL_ROOT_PATH_CACHE.set(Some(pwd.to_string()));
                    return Some(pwd.to_string());
                }
                Err(e) => {
                    tracing::error!("Failed to parse PowerShell pwd output as UTF-8: {}", e);
                }
            }
        }
        Err(e) => {
            tracing::error!("Failed to execute PowerShell pwd command: {}", e);
        }
    }

    // Cache the failure result
    let _ = WSL_ROOT_PATH_CACHE.set(None);
    None
}

/// Convert WSL path to Windows UNC path for PowerShell
async fn wsl_to_windows_path(wsl_path: &std::path::Path) -> Option<String> {
    let path_str = wsl_path.to_string_lossy();

    // Relative paths work fine as-is in PowerShell
    if !path_str.starts_with('/') {
        tracing::debug!("Using relative path as-is: {}", path_str);
        return Some(path_str.to_string());
    }

    // Get cached WSL root path from PowerShell
    if let Some(wsl_root) = get_wsl_root_path().await {
        // Simply concatenate WSL root with the absolute path - PowerShell doesn't mind /
        let windows_path = format!("{wsl_root}{path_str}");
        tracing::debug!("WSL path converted: {} -> {}", path_str, windows_path);
        Some(windows_path)
    } else {
        tracing::error!(
            "Failed to determine WSL root path for conversion: {}",
            path_str
        );
        None
    }
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::{
        build_web_push_click_url, local_notification_url, normalize_local_web_push_base_url,
        normalize_remote_notification_url,
    };

    #[test]
    fn local_notification_url_targets_localhost_root() {
        assert_eq!(local_notification_url(47823), "http://localhost:47823");
    }

    #[test]
    fn remote_notification_url_requires_https() {
        assert_eq!(
            normalize_remote_notification_url(" https://kanban.example.com/path/ "),
            Some("https://kanban.example.com/path/".to_string())
        );
        assert_eq!(
            normalize_remote_notification_url("http://example.com"),
            None
        );
        assert_eq!(
            normalize_remote_notification_url("file:///tmp/private"),
            None
        );
        assert_eq!(
            normalize_remote_notification_url("vibe-kanban://open"),
            None
        );
    }

    #[test]
    fn local_web_push_url_targets_workspace_alias() {
        let workspace_id = Uuid::parse_str("018f5f99-7f0d-7a7f-9abc-001122334455").unwrap();

        assert_eq!(
            build_web_push_click_url("http://localhost:4173", workspace_id),
            Some(
                "http://localhost:4173/workspace/018f5f99-7f0d-7a7f-9abc-001122334455".to_string()
            )
        );
    }

    #[test]
    fn local_web_push_base_url_requires_loopback() {
        assert_eq!(
            normalize_local_web_push_base_url(" http://localhost:4173/ "),
            Some("http://localhost:4173".to_string())
        );
        assert_eq!(
            normalize_local_web_push_base_url("https://127.0.0.1:4173"),
            Some("https://127.0.0.1:4173".to_string())
        );
        assert_eq!(
            normalize_local_web_push_base_url("https://vk.example.com"),
            None
        );
    }
}
