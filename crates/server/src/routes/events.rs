use std::time::Duration;

use axum::{
    BoxError, Router,
    extract::{Query, State},
    response::{
        Json as ResponseJson, Sse,
        sse::{Event, KeepAlive},
    },
    routing::get,
};
use deployment::Deployment;
use futures_util::TryStreamExt;
use serde::Deserialize;
use services::services::agent_journal::{self, JournalPage};
use utils::response::ApiResponse;

use crate::DeploymentImpl;

const DEFAULT_JOURNAL_LIMIT: usize = 200;
const MAX_JOURNAL_LIMIT: usize = 1000;
const DEFAULT_WAIT_SECS: u64 = 30;

/// Query for `/events/journal` and `/events/wait`.
#[derive(Debug, Deserialize)]
pub struct JournalQuery {
    /// Return events after this cursor (0 = everything still buffered).
    #[serde(default)]
    pub since: u64,
    /// Comma-separated kind prefixes, e.g. `process.,approval.pending`.
    pub kinds: Option<String>,
    pub limit: Option<usize>,
    /// Long-poll timeout in seconds (`/events/wait` only, max 60).
    pub timeout: Option<u64>,
}

impl JournalQuery {
    fn kinds(&self) -> Vec<String> {
        self.kinds
            .as_deref()
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|k| !k.is_empty())
            .map(str::to_string)
            .collect()
    }

    fn limit(&self) -> usize {
        self.limit
            .unwrap_or(DEFAULT_JOURNAL_LIMIT)
            .clamp(1, MAX_JOURNAL_LIMIT)
    }
}

/// Events an agent can poll for (process ends, approvals, status notes, vibe
/// phases, workspace lifecycle, queue changes, scheduled resumes, cloud
/// notifications), newest last, after a cursor.
async fn journal(Query(query): Query<JournalQuery>) -> ResponseJson<ApiResponse<JournalPage>> {
    ResponseJson(ApiResponse::success(agent_journal::list(
        query.since,
        &query.kinds(),
        query.limit(),
    )))
}

/// Like `journal`, but holds the request open until a matching event lands or
/// the timeout passes.
async fn wait(Query(query): Query<JournalQuery>) -> ResponseJson<ApiResponse<JournalPage>> {
    let timeout = Duration::from_secs(query.timeout.unwrap_or(DEFAULT_WAIT_SECS));
    ResponseJson(ApiResponse::success(
        agent_journal::wait(query.since, &query.kinds(), query.limit(), timeout).await,
    ))
}

async fn events(
    State(deployment): State<DeploymentImpl>,
) -> Result<Sse<impl futures_util::Stream<Item = Result<Event, BoxError>>>, axum::http::StatusCode>
{
    // Ask the container service for a combined "history + live" stream
    let stream = deployment.stream_events().await;
    Ok(Sse::new(stream.map_err(|e| -> BoxError { e.into() })).keep_alive(KeepAlive::default()))
}

pub(super) fn router(_: &DeploymentImpl) -> Router<DeploymentImpl> {
    let events_router = Router::new()
        .route("/", get(events))
        .route("/journal", get(journal))
        .route("/wait", get(wait));

    Router::new().nest("/events", events_router)
}
