use api_types::{AgentMemoryMutation, CreateAgentMemoryMutationRequest};
use axum::{
    Json, Router,
    extract::{Query, State},
    http::StatusCode,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use services::services::remote_client::RemoteClientError;

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
        .route("/agent-memory-sync/run-wait", post(run_wait))
        .route("/agent-memory-sync/run-all", post(run_all))
        .route("/agent-memory-sync/pending", get(pending))
        .route(
            "/agent-memory-sync/mutations",
            get(list_mutations).post(create_mutation),
        )
}

async fn list_mutations(
    State(deployment): State<DeploymentImpl>,
) -> Result<Json<Vec<AgentMemoryMutation>>, (StatusCode, String)> {
    deployment
        .remote_client()
        .map_err(|error| internal_error(error.into()))?
        .list_agent_memory_mutations()
        .await
        .map(Json)
        .map_err(remote_error)
}

async fn create_mutation(
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<CreateAgentMemoryMutationRequest>,
) -> Result<Json<AgentMemoryMutation>, (StatusCode, String)> {
    deployment
        .remote_client()
        .map_err(|error| internal_error(error.into()))?
        .create_agent_memory_mutation(&payload)
        .await
        .map(Json)
        .map_err(remote_error)
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

async fn run_wait(
    State(deployment): State<DeploymentImpl>,
) -> Json<agent_memory_sync::AgentMemoryHostRunResult> {
    Json(agent_memory_sync::run_if_opted_in(deployment, "global").await)
}

async fn run_all(
    State(deployment): State<DeploymentImpl>,
) -> Result<(StatusCode, Json<StartResponse>), (StatusCode, String)> {
    let session = agent_memory_sync::request_central_sync(&deployment, "manual")
        .await
        .map_err(internal_error)?;
    tokio::spawn(async move {
        if let Err(error) = agent_memory_sync::sync_control_plane(&deployment).await {
            tracing::warn!(?error, "central agent memory sync execution failed");
        }
    });
    tracing::info!(session_id = %session.id, round = session.round, "central agent memory sync requested");
    Ok((StatusCode::ACCEPTED, Json(StartResponse { started: true })))
}

async fn pending(
    State(deployment): State<DeploymentImpl>,
) -> Result<Json<agent_memory_sync::AgentMemoryPendingStatus>, (StatusCode, String)> {
    agent_memory_sync::pending_status(&deployment)
        .await
        .map(Json)
        .map_err(internal_error)
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

fn remote_error(error: RemoteClientError) -> (StatusCode, String) {
    match error {
        RemoteClientError::Http { status, body } => (
            StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
            body,
        ),
        error => internal_error(error.into()),
    }
}
