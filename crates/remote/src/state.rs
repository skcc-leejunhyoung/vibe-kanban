use std::sync::Arc;

use sqlx::PgPool;

use crate::{
    auth::{JwtService, OAuthHandoffService, OAuthTokenValidator, ProviderRegistry},
    azure_blob::AzureBlobService,
    config::RemoteServerConfig,
};

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub config: RemoteServerConfig,
    pub jwt: Arc<JwtService>,
    pub server_public_base_url: String,
    pub http_client: reqwest::Client,
    handoff: Arc<OAuthHandoffService>,
    oauth_token_validator: Arc<OAuthTokenValidator>,
    azure_blob: Option<AzureBlobService>,
}

impl AppState {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        pool: PgPool,
        config: RemoteServerConfig,
        jwt: Arc<JwtService>,
        handoff: Arc<OAuthHandoffService>,
        oauth_token_validator: Arc<OAuthTokenValidator>,
        server_public_base_url: String,
        http_client: reqwest::Client,
        azure_blob: Option<AzureBlobService>,
    ) -> Self {
        Self {
            pool,
            config,
            jwt,
            server_public_base_url,
            http_client,
            handoff,
            oauth_token_validator,
            azure_blob,
        }
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub fn config(&self) -> &RemoteServerConfig {
        &self.config
    }

    pub fn jwt(&self) -> Arc<JwtService> {
        Arc::clone(&self.jwt)
    }

    pub fn handoff(&self) -> Arc<OAuthHandoffService> {
        Arc::clone(&self.handoff)
    }

    pub fn providers(&self) -> Arc<ProviderRegistry> {
        self.handoff.providers()
    }

    pub fn oauth_token_validator(&self) -> Arc<OAuthTokenValidator> {
        Arc::clone(&self.oauth_token_validator)
    }

    pub fn azure_blob(&self) -> Option<&AzureBlobService> {
        self.azure_blob.as_ref()
    }
}
