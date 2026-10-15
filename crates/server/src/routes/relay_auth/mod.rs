use axum::Router;

use crate::DeploymentImpl;

pub mod account;
pub mod client;
pub mod server;

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .merge(server::router())
        .merge(client::router())
        .merge(account::router())
}
