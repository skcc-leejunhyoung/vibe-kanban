use axum::{
    Json, Router,
    extract::{Query, State},
    http::StatusCode,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};

use crate::{DeploymentImpl, agent_memory_sync};

#[derive(Serialize)]
struct StartResponse {
    started: bool,
}

#[derive(Deserialize)]
struct LogsQuery {
    limit: Option<i64>,
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/agent-memory-sync/status", get(status))
        .route("/agent-memory-sync/logs", get(logs))
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
        if let Err(error) = agent_memory_sync::run_now(deployment, "manual").await {
            tracing::warn!(?error, "manual agent memory sync failed");
        }
    });
    (StatusCode::ACCEPTED, Json(StartResponse { started: true }))
}

async fn logs(
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<LogsQuery>,
) -> Result<Json<Vec<agent_memory_sync::AgentMemorySyncLogEntry>>, (StatusCode, String)> {
    agent_memory_sync::logs(&deployment, query.limit.unwrap_or(200))
        .await
        .map(Json)
        .map_err(internal_error)
}

fn internal_error(error: anyhow::Error) -> (StatusCode, String) {
    tracing::error!(?error, "failed to load agent memory sync status");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        "failed to load agent memory sync status".to_string(),
    )
}
