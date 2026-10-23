use api_types::{AgentEventsPage, PushAgentEventsRequest};
use axum::{
    Json, Router,
    extract::{Extension, Query, State},
    http::StatusCode,
    routing::get,
};
use serde::Deserialize;

use super::error::ErrorResponse;
use crate::{
    AppState,
    auth::RequestContext,
    db::{agent_events, hosts::HostRepository},
};

const MAX_BATCH: usize = 500;
const MAX_EVENT_DATA_BYTES: usize = 64 * 1024;
const DEFAULT_LIMIT: i64 = 200;
const MAX_LIMIT: i64 = 1000;

pub fn router() -> Router<AppState> {
    Router::new().route("/agent-events", get(list_events).post(push_events))
}

/// A host pushes a batch of its journal events.
async fn push_events(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Json(payload): Json<PushAgentEventsRequest>,
) -> Result<StatusCode, ErrorResponse> {
    if payload.events.len() > MAX_BATCH
        || payload.events.iter().any(|event| {
            event.kind.is_empty()
                || event.kind.len() > 128
                || event.data.to_string().len() > MAX_EVENT_DATA_BYTES
        })
    {
        return Err(ErrorResponse::new(
            StatusCode::BAD_REQUEST,
            "invalid agent event batch",
        ));
    }
    match HostRepository::new(state.pool())
        .is_owned_by(payload.host_id, ctx.user.id)
        .await
    {
        Ok(true) => {}
        Ok(false) => return Err(ErrorResponse::new(StatusCode::FORBIDDEN, "host not owned")),
        Err(error) => return Err(internal(error)),
    }
    agent_events::insert_batch(state.pool(), ctx.user.id, payload.host_id, &payload.events)
        .await
        .map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct ListQuery {
    #[serde(default)]
    since: i64,
    /// Comma-separated kind prefixes, e.g. `process.,approval.pending`.
    kinds: Option<String>,
    limit: Option<i64>,
}

/// Every event the caller's hosts pushed after `since`.
async fn list_events(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Query(query): Query<ListQuery>,
) -> Result<Json<AgentEventsPage>, ErrorResponse> {
    let kinds: Vec<String> = query
        .kinds
        .as_deref()
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|kind| !kind.is_empty())
        .map(str::to_string)
        .collect();
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let (events, cursor) =
        agent_events::list(state.pool(), ctx.user.id, query.since, &kinds, limit)
            .await
            .map_err(internal)?;
    Ok(Json(AgentEventsPage { events, cursor }))
}

fn internal(error: sqlx::Error) -> ErrorResponse {
    tracing::error!(?error, "agent event operation failed");
    ErrorResponse::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "agent event operation failed",
    )
}
