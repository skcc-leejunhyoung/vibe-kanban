use std::sync::Arc;

use api_types::ProfileResponse;
use tokio::sync::{Mutex as TokioMutex, OwnedMutexGuard, RwLock};
use uuid::Uuid;

use super::oauth_credentials::{Credentials, OAuthCredentials, ReconnectGuard};

#[derive(Clone)]
pub struct AuthContext {
    oauth: Arc<OAuthCredentials>,
    profile: Arc<RwLock<Option<ProfileResponse>>>,
    remote_auth_degraded_slug: Arc<RwLock<Option<String>>>,
    refresh_lock: Arc<TokioMutex<()>>,
}

impl AuthContext {
    pub fn new(
        oauth: Arc<OAuthCredentials>,
        profile: Arc<RwLock<Option<ProfileResponse>>>,
    ) -> Self {
        Self {
            oauth,
            profile,
            remote_auth_degraded_slug: Arc::new(RwLock::new(None)),
            refresh_lock: Arc::new(TokioMutex::new(())),
        }
    }

    pub async fn get_credentials(&self) -> Option<Credentials> {
        self.oauth.get().await
    }

    pub async fn save_credentials(&self, creds: &Credentials) -> std::io::Result<()> {
        self.oauth.save(creds).await
    }

    pub async fn clear_credentials(&self) -> std::io::Result<()> {
        self.oauth.clear().await
    }

    pub async fn begin_reconnect(&self) -> Option<(Credentials, Arc<ReconnectGuard>)> {
        self.oauth.begin_reconnect().await
    }

    pub async fn is_reconnecting(&self) -> bool {
        self.oauth.is_reconnecting().await
    }

    pub async fn replace_credentials(
        &self,
        expected_refresh_token: &str,
        creds: Option<&Credentials>,
    ) -> std::io::Result<bool> {
        self.oauth
            .replace_if_current(expected_refresh_token, creds)
            .await
    }

    pub async fn save_reconnected_credentials(
        &self,
        creds: &Credentials,
        user_id: Uuid,
    ) -> std::io::Result<bool> {
        self.oauth.save_for_user(creds, user_id).await
    }

    pub async fn remote_auth_degraded_slug(&self) -> Option<String> {
        self.remote_auth_degraded_slug.read().await.clone()
    }

    pub async fn set_remote_auth_degraded_slug(&self, slug: impl Into<String>) {
        *self.remote_auth_degraded_slug.write().await = Some(slug.into());
    }

    pub async fn clear_remote_auth_degraded_slug(&self) {
        *self.remote_auth_degraded_slug.write().await = None;
    }

    pub async fn cached_profile(&self) -> Option<ProfileResponse> {
        self.profile.read().await.clone()
    }

    pub async fn set_profile(&self, profile: ProfileResponse) {
        *self.profile.write().await = Some(profile)
    }

    pub async fn clear_profile(&self) {
        *self.profile.write().await = None
    }

    pub async fn refresh_guard(&self) -> OwnedMutexGuard<()> {
        self.refresh_lock.clone().lock_owned().await
    }
}
