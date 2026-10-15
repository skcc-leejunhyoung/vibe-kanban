use std::sync::Arc;

use sqlx::PgPool;

use super::{auth::JwtService, config::RelayServerConfig, relay_registry::RelayRegistry};

#[derive(Clone)]
pub struct RelayAppState {
    pub pool: PgPool,
    pub config: RelayServerConfig,
    pub jwt: Arc<JwtService>,
    pub relay_registry: RelayRegistry,
    pub connection_guards: super::connection_guards::ConnectionGuards,
}

impl RelayAppState {
    pub fn new(pool: PgPool, config: RelayServerConfig, jwt: Arc<JwtService>) -> Self {
        Self {
            pool,
            config,
            jwt,
            relay_registry: RelayRegistry::default(),
            connection_guards: Default::default(),
        }
    }
}
