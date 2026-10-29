use std::sync::{Arc, OnceLock};

use api_types::{Notification, NotificationIntent};
use async_trait::async_trait;
use db::models::{
    web_push_subscription::{WebPushSubscription, WebPushSubscriptionModel},
    workspace::Workspace,
};
use secrecy::{ExposeSecret, SecretString};
use serde::Serialize;
use serde_json::json;
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

    /// Like `send`, but a click opens `click_url` (a Drawer note rather than a
    /// workspace). Notifiers without click targets just show the banner.
    async fn send_to_url(&self, title: &str, message: &str, click_url: Option<&str>) {
        let _ = click_url;
        self.send(title, message, None).await;
    }
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

    async fn send_to_url(&self, title: &str, message: &str, click_url: Option<&str>) {
        if cfg!(target_os = "macos") {
            send_macos_notification(title, message, click_url).await;
        } else {
            self.send(title, message, None).await;
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
        let service = Self {
            config,
            pool,
            push_notifier: get_global_push_notifier(),
            remote_client,
        };
        if service.remote_client.is_some() {
            let background = service.clone();
            tokio::spawn(async move {
                let mut timer = tokio::time::interval(std::time::Duration::from_secs(5));
                loop {
                    timer.tick().await;
                    if let Err(error) = background.drain_dispatches().await {
                        tracing::warn!(?error, "notification dispatch reconciliation failed");
                    }
                }
            });
        }
        service
    }

    /// Explicit agent/CLI/automation reports remain user-facing regardless of destination.
    pub async fn notify(&self, title: &str, message: &str, workspace_id: Option<Uuid>) {
        self.dispatch(
            title,
            message,
            workspace_id,
            None,
            NotificationIntent::UserReport,
            Uuid::new_v4().to_string(),
            false,
        )
        .await;
    }

    pub async fn notify_drawer_note(
        &self,
        title: &str,
        message: &str,
        workspace_id: Option<Uuid>,
        note_id: Uuid,
    ) {
        self.dispatch(
            title,
            message,
            workspace_id,
            Some(note_id),
            NotificationIntent::UserReport,
            Uuid::new_v4().to_string(),
            false,
        )
        .await;
    }

    pub async fn notify_raw(
        &self,
        title: &str,
        message: &str,
        workspace_id: Uuid,
        source_key: String,
        local_only: bool,
    ) {
        self.dispatch(
            title,
            message,
            Some(workspace_id),
            None,
            NotificationIntent::RawEvent,
            source_key,
            local_only,
        )
        .await;
    }

    #[allow(clippy::too_many_arguments)]
    async fn dispatch(
        &self,
        title: &str,
        message: &str,
        workspace_id: Option<Uuid>,
        note_id: Option<Uuid>,
        intent: NotificationIntent,
        source_key: String,
        local_only: bool,
    ) {
        let owner = match &self.remote_client {
            Some(client) => client.notification_account().await,
            None => None,
        };
        if owner.is_none() {
            self.display_local(title, message, workspace_id, note_id, None)
                .await;
            return;
        }
        let autopilot = note_id.is_some()
            || match workspace_id {
                Some(id) => Workspace::find_by_id(&self.pool, id)
                    .await
                    .ok()
                    .flatten()
                    .is_none_or(|ws| ws.autopilot),
                None => false,
            };
        let config = self.config.read().await.notifications.clone();
        let payload = json!({"title":title,"body":message,"workspace_id":workspace_id,"drawer_note_id":note_id,"intent":intent,"autopilot":autopilot,"source_key":source_key,"remote_push_enabled":config.push_enabled&&!local_only,"owner_user_id":owner,"local_only":local_only});
        if let Err(error) = sqlx::query(
            "INSERT OR IGNORE INTO notification_dispatch_outbox(source_key,payload) VALUES(?,?)",
        )
        .bind(&source_key)
        .bind(payload.to_string())
        .execute(&self.pool)
        .await
        {
            tracing::error!(?error, "could not persist notification dispatch");
            return;
        }
        // Explicit reports can alert locally offline. Raw events stay silent until
        // the central routing decision; an unknown response is retried by source key.
        if intent == NotificationIntent::UserReport {
            self.display_once(
                &format!("notification:{source_key}"),
                title,
                message,
                workspace_id,
                note_id,
                None,
            )
            .await;
        }
    }

    async fn display_local(
        &self,
        title: &str,
        message: &str,
        workspace_id: Option<Uuid>,
        note_id: Option<Uuid>,
        deeplink: Option<&str>,
    ) {
        let config = self.config.read().await.notifications.clone();
        if config.sound_enabled {
            Self::play_sound_notification(&config.sound_file).await;
        }
        if !config.push_enabled {
            return;
        }
        if let Some(path) = note_id
            .map(drawer_note_path)
            .or_else(|| deeplink.map(str::to_owned))
        {
            let url = local_web_push_base_url()
                .await
                .map(|base| format!("{base}{path}"));
            if !self
                .send_web_push_with_deeplink(title, message, url.clone())
                .await
                .unwrap_or(false)
            {
                self.push_notifier
                    .send_to_url(title, message, url.as_deref())
                    .await;
            }
        } else if !self
            .send_web_push(title, message, workspace_id)
            .await
            .unwrap_or(false)
        {
            self.push_notifier.send(title, message, workspace_id).await;
        }
    }

    async fn display_once(
        &self,
        key: &str,
        title: &str,
        message: &str,
        workspace_id: Option<Uuid>,
        note_id: Option<Uuid>,
        deeplink: Option<&str>,
    ) {
        use crate::services::automation::{ActionReceipt, begin_action, complete_action};
        match begin_action(&self.pool, key, "notification_display").await {
            Ok(ActionReceipt::Claimed) => {
                self.display_local(title, message, workspace_id, note_id, deeplink)
                    .await;
                if let Err(error) = complete_action(&self.pool, key, &()).await {
                    tracing::warn!(?error, "notification display receipt incomplete");
                }
            }
            Ok(_) => {}
            Err(error) => tracing::warn!(?error, "could not claim notification display"),
        }
    }

    pub async fn display_notification(
        &self,
        id: Uuid,
        revision: i32,
    ) -> Result<(), crate::services::remote_client::RemoteClientError> {
        let Some(client) = &self.remote_client else {
            return Ok(());
        };
        let notification = client.get_notification(id).await?;
        if notification.revision != revision
            || notification.routing_state != api_types::NotificationRoutingState::User
            || notification.seen
            || notification.dismissed_at.is_some()
        {
            return Ok(());
        }
        if notification.payload.local_only == Some(true)
            && (notification.payload.host_id.is_none()
                || notification.payload.host_id != client.registered_host_id().await?)
        {
            return Ok(());
        }
        self.display_canonical(&notification).await;
        Ok(())
    }

    async fn display_canonical(&self, n: &Notification) {
        let key = n
            .source_key
            .clone()
            .unwrap_or_else(|| format!("{}:{}", n.id, n.revision));
        let title = n.payload.title.as_deref().unwrap_or("Vibe Kanban");
        let message = api_types::notification_body(n.notification_type, &n.payload);
        let deeplink =
            if n.notification_type == api_types::NotificationType::PullRequestCommentAdded {
                n.payload.pull_request_url.as_ref().map(|pr| {
                    format!(
                        "/pull-requests?{}",
                        url::form_urlencoded::Serializer::new(String::new())
                            .append_pair("prUrl", pr)
                            .finish()
                    )
                })
            } else {
                n.payload.deeplink_path.clone()
            };
        self.display_once(
            &format!("notification:{key}"),
            title,
            &message,
            n.payload.workspace_id,
            n.payload.drawer_note_id,
            deeplink.as_deref(),
        )
        .await;
    }

    async fn drain_dispatches(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(client) = &self.remote_client else {
            return Ok(());
        };
        let Some(owner) = client.notification_account().await else {
            return Ok(());
        };
        let host_id = client.registered_host_id().await?;
        if let Some(host_id) = host_id {
            client
                .notification_request(
                    reqwest::Method::PUT,
                    "/v1/notification-host-capabilities",
                    &json!({"host_id":host_id,"protocol":1}),
                )
                .await?;
        }
        let payloads=sqlx::query_as::<_,(String,String)>("SELECT source_key,payload FROM notification_dispatch_outbox WHERE json_extract(payload,'$.owner_user_id')=? AND next_attempt_at<=unixepoch() ORDER BY created_at LIMIT 100").bind(owner.to_string()).fetch_all(&self.pool).await?;
        for (key, payload) in payloads {
            let mut payload: serde_json::Value = serde_json::from_str(&payload)?;
            if payload["owner_user_id"] != json!(owner) {
                continue;
            }
            payload["host_id"] = json!(host_id);
            // Signed-in standalone clients have no host delivery worker. Keep
            // their legacy local alerts instead of silently retaining an outbox.
            if host_id.is_none() && payload["intent"] == json!("raw_event") {
                payload["intent"] = json!("legacy");
            }
            let notification = match client.dispatch_notification(&payload).await {
                Ok(notification) => notification,
                Err(crate::services::remote_client::RemoteClientError::Http {
                    status: 400..=499,
                    ..
                }) => {
                    // A deleted Drawer target must not block unrelated later alerts.
                    sqlx::query("UPDATE notification_dispatch_outbox SET next_attempt_at=unixepoch()+60 WHERE source_key=?").bind(&key).execute(&self.pool).await?;
                    continue;
                }
                Err(error) => return Err(error.into()),
            };
            if host_id.is_none() {
                self.display_canonical(&notification).await;
            }
            sqlx::query("DELETE FROM notification_dispatch_outbox WHERE source_key=?")
                .bind(key)
                .execute(&self.pool)
                .await?;
        }
        let Some(host_id) = host_id else {
            return Ok(());
        };
        let deliveries = client
            .notification_request(
                reqwest::Method::POST,
                "/v1/notification-host-deliveries",
                &json!({"host_id":host_id}),
            )
            .await?;
        for delivery in deliveries["deliveries"].as_array().into_iter().flatten() {
            let n: Notification = serde_json::from_value(delivery["notification"].clone())?;
            self.display_notification(n.id, n.revision).await?;
            client
                .notification_request(
                    reqwest::Method::POST,
                    &format!("/v1/notification-host-deliveries/{}/complete", n.id),
                    &json!({"host_id":host_id,"revision":n.revision,"token":delivery["token"]}),
                )
                .await?;
        }
        Ok(())
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
        let deeplink = local_web_push_click_url(workspace_id).await;
        self.send_web_push_with_deeplink(title, message, deeplink)
            .await
    }

    async fn send_web_push_with_deeplink(
        &self,
        title: &str,
        message: &str,
        deeplink_path: Option<String>,
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
            deeplink_path,
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
    workspace_path_from_template(&template, workspace_id)
}

fn workspace_path_from_template(template: &str, workspace_id: Uuid) -> String {
    let template = if template.contains("{workspace_id}") {
        template
    } else {
        tracing::warn!(
            env = WEB_PUSH_WORKSPACE_PATH_TEMPLATE_ENV,
            "ignoring web push workspace path template without workspace_id placeholder"
        );
        DEFAULT_WEB_PUSH_WORKSPACE_PATH_TEMPLATE
    };
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

/// The Drawer page opened on one note (both web apps route `/drawer`).
fn drawer_note_path(note_id: Uuid) -> String {
    format!("/drawer?note={note_id}")
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

    // Pass title/message as AppleScript `argv` instead of interpolating them into
    // the script source. The previous version only escaped `"`, so a value
    // containing a backslash or newline (workspace/issue names and agent-emitted
    // tool names are untrusted content) could terminate the string literal and
    // execute arbitrary AppleScript — e.g. `do shell script` — as the user.
    // With `on run argv` the values are opaque argument strings.
    const NOTIFY_SCRIPT: &str = r#"on run argv
    display notification (item 1 of argv) with title (item 2 of argv) sound name "Glass"
end run"#;

    // `--` stops osascript's own option parsing: a message starting with `-`
    // would otherwise be consumed as a flag and the notification dropped.
    let _ = tokio::process::Command::new("osascript")
        .arg("-e")
        .arg(NOTIFY_SCRIPT)
        .arg("--")
        .arg(message)
        .arg(title)
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
        normalize_remote_notification_url, workspace_path_from_template,
    };

    #[tokio::test]
    async fn raw_notifications_are_durable_and_silent_and_reports_display_once() {
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };

        use serde_json::{Value, json};
        use sqlx::sqlite::SqlitePoolOptions;
        use tokio::sync::RwLock;

        use super::{Config, NotificationService, PushNotifier, RemoteClient};
        use crate::services::{
            auth::AuthContext,
            oauth_credentials::{Credentials, OAuthCredentials},
        };
        struct CountingNotifier(AtomicUsize);
        #[async_trait::async_trait]
        impl PushNotifier for CountingNotifier {
            async fn send(&self, _: &str, _: &str, _: Option<Uuid>) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
            async fn send_to_url(&self, _: &str, _: &str, _: Option<&str>) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let auth = AuthContext::new(
            Arc::new(OAuthCredentials::new(
                dir.path().join("synthetic-credentials.json"),
            )),
            Arc::new(RwLock::new(None)),
        );
        // Unsigned synthetic token used only to correlate the local account.
        let token = "eyJhbGciOiAiSFMyNTYiLCAidHlwIjogIkpXVCJ9.eyJzdWIiOiAiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMTIzIiwgImV4cCI6IDQxMDI0NDQ4MDB9.c3ludGhldGlj";
        auth.save_credentials(&Credentials {
            access_token: Some(token.into()),
            refresh_token: token.into(),
            expires_at: Some(chrono::Utc::now() + chrono::Duration::hours(1)),
        })
        .await
        .unwrap();
        let client = RemoteClient::new(
            "http://127.0.0.1:1",
            auth.clone(),
            "synthetic-machine".into(),
        )
        .unwrap();
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
        let notifier = Arc::new(CountingNotifier(AtomicUsize::new(0)));
        let mut config = Config::default();
        config.notifications.sound_enabled = false;
        config.notifications.push_enabled = true;
        let mut service = NotificationService {
            config: Arc::new(RwLock::new(config)),
            pool: pool.clone(),
            push_notifier: notifier.clone(),
            remote_client: Some(client),
        };
        for autopilot in [true, false] {
            let workspace = Uuid::new_v4();
            sqlx::query("INSERT INTO workspaces(id,branch,autopilot) VALUES(?,'vk/synthetic',?)")
                .bind(workspace)
                .bind(autopilot)
                .execute(&pool)
                .await
                .unwrap();
            let key = format!("synthetic:{workspace}");
            service
                .notify_raw(
                    "Synthetic title",
                    "Synthetic body",
                    workspace,
                    key.clone(),
                    false,
                )
                .await;
            service
                .notify_raw(
                    "Synthetic title",
                    "Synthetic body",
                    workspace,
                    key.clone(),
                    false,
                )
                .await;
            let payload: String = sqlx::query_scalar(
                "SELECT payload FROM notification_dispatch_outbox WHERE source_key=?",
            )
            .bind(key)
            .fetch_one(&pool)
            .await
            .unwrap();
            let payload: Value = serde_json::from_str(&payload).unwrap();
            assert_eq!(payload["intent"], "raw_event");
            assert_eq!(payload["workspace_id"], json!(workspace));
            assert_eq!(payload["autopilot"], json!(autopilot));
            assert_eq!(
                payload["owner_user_id"],
                "00000000-0000-4000-8000-000000000123"
            );
        }
        assert_eq!(notifier.0.load(Ordering::SeqCst), 0);
        service
            .notify_raw(
                "Synthetic",
                "Unknown",
                Uuid::new_v4(),
                "synthetic-unknown".into(),
                false,
            )
            .await;
        let payload: String = sqlx::query_scalar(
            "SELECT payload FROM notification_dispatch_outbox WHERE source_key='synthetic-unknown'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&payload).unwrap()["autopilot"],
            true
        );
        service
            .notify_raw(
                "Synthetic local",
                "Body",
                Uuid::new_v4(),
                "synthetic-local-only".into(),
                true,
            )
            .await;
        let local_payload: String = sqlx::query_scalar("SELECT payload FROM notification_dispatch_outbox WHERE source_key='synthetic-local-only'").fetch_one(&pool).await.unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&local_payload).unwrap()["remote_push_enabled"],
            false
        );
        service
            .notify("User report", "Synthetic report", None)
            .await;
        assert_eq!(notifier.0.load(Ordering::SeqCst), 1);
        service
            .display_once("synthetic-display", "Synthetic", "Body", None, None, None)
            .await;
        service
            .display_once("synthetic-display", "Synthetic", "Body", None, None, None)
            .await;
        assert_eq!(notifier.0.load(Ordering::SeqCst), 2);
        let payloads: Vec<String> =
            sqlx::query_scalar("SELECT payload FROM notification_dispatch_outbox")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(payloads.len(), 5);
        assert!(
            payloads
                .iter()
                .any(|p| serde_json::from_str::<Value>(p).unwrap()["intent"] == "user_report")
        );
        // An unavailable target is retained for retry without blocking later alerts.
        // The signed-in standalone path also has to display accepted rows locally.
        use axum::{
            Json, Router,
            http::StatusCode,
            response::IntoResponse,
            routing::{get, post},
        };
        let rejected = Arc::new(AtomicUsize::new(0));
        let rejections = rejected.clone();
        let router=Router::new().route("/v1/hosts",get(||async{Json(json!({"hosts":[]}))})).route("/v1/web-push/self",post(move|Json(body):Json<Value>|{
            let rejections=rejections.clone();
            async move {
                if body["source_key"]=="synthetic-unknown" {
                    rejections.fetch_add(1,Ordering::SeqCst);
                    return (StatusCode::NOT_FOUND,Json(json!({"error":"synthetic target unavailable"}))).into_response();
                }
                Json(json!({"id":Uuid::new_v4(),"organization_id":Uuid::new_v4(),"user_id":body["owner_user_id"],"notification_type":"workspace_task_completed","payload":body,"issue_id":null,"comment_id":null,"seen":false,"dismissed_at":null,"created_at":"2026-01-01T00:00:00Z","intent":"legacy","routing_state":"user","revision":1,"source_key":body["source_key"]})).into_response()
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        service.remote_client = Some(
            RemoteClient::new(
                &format!("http://{address}"),
                auth,
                "synthetic-machine".into(),
            )
            .unwrap(),
        );
        service.drain_dispatches().await.unwrap();
        assert_eq!(notifier.0.load(Ordering::SeqCst), 5);
        assert_eq!(rejected.load(Ordering::SeqCst), 1);
        service.drain_dispatches().await.unwrap();
        assert_eq!(rejected.load(Ordering::SeqCst), 1);
        let remaining: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM notification_dispatch_outbox")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(remaining, 1);
        server.abort();
    }

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
    fn workspace_path_rejects_template_without_workspace_id() {
        let workspace_id = Uuid::parse_str("018f5f99-7f0d-7a7f-9abc-001122334455").unwrap();

        assert_eq!(
            workspace_path_from_template("/workspace", workspace_id),
            "/workspace/018f5f99-7f0d-7a7f-9abc-001122334455"
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
