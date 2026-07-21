mod app;
pub mod attachments;
pub mod audit;
mod auth;
pub mod azure_blob;
pub mod config;
pub mod db;
mod middleware;
pub mod mutation_definition;
pub mod notifications;
pub mod routes;
pub mod shape_definition;
pub mod shape_route;
pub mod shape_routes;
pub mod shapes;
mod shared_key_auth;
mod state;
mod web_push_notifications;

use std::env;

pub use app::Server;
pub use state::AppState;
use tracing_error::ErrorLayer;
use tracing_subscriber::{
    Layer,
    fmt::{self, format::FmtSpan},
    layer::SubscriberExt,
    util::SubscriberInitExt,
};
pub fn init_tracing() {
    if tracing::dispatcher::has_been_set() {
        return;
    }

    let env_filter = env::var("RUST_LOG").unwrap_or_else(|_| "info,sqlx=warn".to_string());
    let fmt_layer = fmt::layer()
        .json()
        .with_target(false)
        .with_span_events(FmtSpan::CLOSE)
        .boxed();

    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(env_filter))
        .with(ErrorLayer::default())
        .with(fmt_layer)
        .init();

    tracing::info!("Tracing initialized (stdout only)");
}
