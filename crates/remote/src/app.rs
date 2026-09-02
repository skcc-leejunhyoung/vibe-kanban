use std::{net::SocketAddr, sync::Arc};

use anyhow::{Context, bail};
use secrecy::ExposeSecret;
use tracing::instrument;

use crate::{
    AppState,
    attachments::cleanup::spawn_cleanup_task,
    auth::{
        GitHubOAuthProvider, GoogleOAuthProvider, JwtService, OAuthHandoffService,
        OAuthTokenValidator, ProviderRegistry,
    },
    azure_blob::AzureBlobService,
    config::RemoteServerConfig,
    db, routes,
};

pub struct Server;

impl Server {
    #[instrument(name = "remote_server", skip(config), fields(listen_addr = %config.listen_addr))]
    pub async fn run(config: RemoteServerConfig) -> anyhow::Result<()> {
        let pool = db::create_pool(&config.database_url)
            .await
            .context("failed to create postgres pool")?;

        db::migrate(&pool)
            .await
            .context("failed to run database migrations")?;
        crate::automation::spawn_outbox(pool.clone());

        let mut backfilled_snapshots = 0;
        loop {
            let backfilled = db::agent_memory::backfill_snapshot_entries(&pool, 100)
                .await
                .context("failed to backfill agent memory snapshot entries")?;
            backfilled_snapshots += backfilled;
            if backfilled < 100 {
                break;
            }
        }
        if backfilled_snapshots > 0 {
            tracing::info!(
                snapshot_count = backfilled_snapshots,
                "backfilled agent memory snapshot entries"
            );
        }

        if let Some(password) = config.electric_role_password.as_ref() {
            db::ensure_electric_role_password(&pool, password.expose_secret())
                .await
                .context("failed to set electric role password")?;
        }

        if !config.electric_publication_names.is_empty() {
            db::electric_publications::ensure_electric_publications(
                &pool,
                &config.electric_publication_names,
            )
            .await
            .context("failed to sync Electric publications")?;
        }

        let auth_config = config.auth.clone();
        let jwt = Arc::new(JwtService::new(auth_config.jwt_secret().clone()));

        let mut registry = ProviderRegistry::new();

        if let Some(github) = auth_config.github() {
            registry.register(GitHubOAuthProvider::new(
                github.client_id().to_string(),
                github.client_secret().clone(),
            )?);
        }

        if let Some(google) = auth_config.google() {
            registry.register(GoogleOAuthProvider::new(
                google.client_id().to_string(),
                google.client_secret().clone(),
            )?);
        }

        if registry.is_empty() && auth_config.local().is_none() {
            bail!("no OAuth providers configured");
        }

        let registry = Arc::new(registry);

        let handoff_service = Arc::new(OAuthHandoffService::new(
            pool.clone(),
            registry.clone(),
            jwt.clone(),
            auth_config.public_base_url().to_string(),
        ));

        let oauth_token_validator = Arc::new(OAuthTokenValidator::new(
            pool.clone(),
            registry.clone(),
            jwt.clone(),
        ));

        let server_public_base_url = config.server_public_base_url.clone().ok_or_else(|| {
            anyhow::anyhow!(
                "SERVER_PUBLIC_BASE_URL is not set. Please set it in your .env.remote file."
            )
        })?;

        let azure_blob = config.azure_blob.as_ref().map(AzureBlobService::new);
        if azure_blob.is_some() {
            tracing::info!("Azure Blob storage service initialized");
        } else {
            tracing::info!(
                "Azure Blob storage not configured. Set AZURE_STORAGE_ACCOUNT_NAME and AZURE_STORAGE_ACCOUNT_KEY to enable issue attachments."
            );
        }

        let http_client = reqwest::Client::builder()
            .user_agent("VibeKanbanRemote/1.0")
            .build()
            .context("failed to create HTTP client")?;

        if let Some(ref azure_blob_service) = azure_blob {
            spawn_cleanup_task(pool.clone(), azure_blob_service.clone());
        }

        let state = AppState::new(
            pool.clone(),
            config.clone(),
            jwt,
            handoff_service,
            oauth_token_validator,
            server_public_base_url,
            http_client,
            azure_blob,
        );

        let router = routes::router(state);
        let addr: SocketAddr = config
            .listen_addr
            .parse()
            .context("listen address is invalid")?;
        let tcp_listener = tokio::net::TcpListener::bind(addr)
            .await
            .context("failed to bind tcp listener")?;

        tracing::info!(%addr, "shared sync server listening");

        let make_service = router.into_make_service();

        axum::serve(tcp_listener, make_service)
            .await
            .context("shared sync server failure")?;

        Ok(())
    }
}
