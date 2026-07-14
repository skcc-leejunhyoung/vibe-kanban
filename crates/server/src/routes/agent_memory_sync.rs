use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{get, post},
};
use serde::Serialize;

use crate::{DeploymentImpl, agent_memory_sync};

#[derive(Serialize)]
struct StartResponse {
    started: bool,
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/agent-memory-sync/status", get(status))
        .route("/agent-memory-sync/run", post(run))
}

async fn status(
    State(deployment): State<DeploymentImpl>,
) -> Result<Json<agent_memory_sync::AgentMemorySyncStatus>, (StatusCode, String)> {
    agent_memory_sync::status(&deployment)
        .await
        .map(Json)
        .map_err(internal_error)
}

async fn run(State(deployment): State<DeploymentImpl>) -> (StatusCode, Json<StartResponse>) {
    tokio::spawn(async move {
        if let Err(error) = agent_memory_sync::run_now(deployment).await {
            tracing::warn!(?error, "manual agent memory sync failed");
        }
    });
    (StatusCode::ACCEPTED, Json(StartResponse { started: true }))
}

fn internal_error(error: anyhow::Error) -> (StatusCode, String) {
    tracing::error!(?error, "failed to load agent memory sync status");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        "failed to load agent memory sync status".to_string(),
    )
}
