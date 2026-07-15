use api_types::{
    AgentMemoryInboxResponse, AgentMemoryKind, AgentMemoryMutation,
    AgentMemoryMutationInboxResponse, AgentMemoryMutationOperation, AgentMemoryReceipt,
    AgentMemoryScope, CreateAgentMemoryMutationRequest, RecordAgentMemoryMutationReceiptRequest,
    RecordAgentMemoryReceiptRequest, UpsertAgentMemorySnapshotRequest,
    UpsertAgentMemorySnapshotResponse,
};
use axum::{
    Json, Router,
    extract::{Extension, Query, State},
    http::StatusCode,
    routing::{get, post},
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::error::ErrorResponse;
use crate::{AppState, auth::RequestContext, db::agent_memory};

const MAX_SNAPSHOT_BYTES: usize = 64 * 1024;
const MAX_REASON_BYTES: usize = 4 * 1024;
const MAX_MUTATION_TEXT_BYTES: usize = 16 * 1024;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/agent-memory/snapshots",
            get(get_snapshot).put(upsert_snapshot),
        )
        .route("/agent-memory/inbox", get(inbox))
        .route("/agent-memory/receipts", post(record_receipt))
        .route(
            "/agent-memory/mutations",
            get(list_mutations).post(create_mutation),
        )
        .route("/agent-memory/mutation-inbox", get(mutation_inbox))
        .route(
            "/agent-memory/mutation-receipts",
            post(record_mutation_receipt),
        )
}

async fn list_mutations(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
) -> Result<Json<Vec<AgentMemoryMutation>>, ErrorResponse> {
    agent_memory::list_mutations(state.pool(), ctx.user.id)
        .await
        .map(Json)
        .map_err(internal_memory_error)
}

async fn create_mutation(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Json(payload): Json<CreateAgentMemoryMutationRequest>,
) -> Result<Json<AgentMemoryMutation>, ErrorResponse> {
    validate_scope(payload.scope, payload.scope_key.as_deref())?;
    if payload.match_text.trim().is_empty()
        || payload.match_text.len() > MAX_MUTATION_TEXT_BYTES
        || payload
            .replacement_text
            .as_ref()
            .is_some_and(|text| text.len() > MAX_MUTATION_TEXT_BYTES)
    {
        return Err(ErrorResponse::new(
            StatusCode::BAD_REQUEST,
            "invalid memory mutation text",
        ));
    }
    match payload.operation {
        AgentMemoryMutationOperation::Update
            if payload
                .replacement_text
                .as_deref()
                .is_none_or(|text| text.trim().is_empty()) =>
        {
            return Err(ErrorResponse::new(
                StatusCode::BAD_REQUEST,
                "memory update requires replacement_text",
            ));
        }
        AgentMemoryMutationOperation::Delete if payload.replacement_text.is_some() => {
            return Err(ErrorResponse::new(
                StatusCode::BAD_REQUEST,
                "memory deletion cannot have replacement_text",
            ));
        }
        _ => {}
    }
    agent_memory::create_mutation(state.pool(), ctx.user.id, &payload)
        .await
        .map(Json)
        .map_err(|error| {
            if error.to_string().contains("generation conflict") {
                ErrorResponse::new(StatusCode::CONFLICT, "memory generation conflict")
            } else {
                tracing::error!(?error, "failed to create memory mutation");
                ErrorResponse::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "failed to create memory mutation",
                )
            }
        })
}

#[derive(Deserialize)]
struct MutationInboxQuery {
    target_host_id: Uuid,
    target_agent: AgentMemoryKind,
    scope: AgentMemoryScope,
    scope_key: Option<String>,
}

async fn mutation_inbox(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Query(query): Query<MutationInboxQuery>,
) -> Result<Json<AgentMemoryMutationInboxResponse>, ErrorResponse> {
    ensure_owned_host(&state, ctx.user.id, query.target_host_id).await?;
    validate_scope(query.scope, query.scope_key.as_deref())?;
    agent_memory::mutation_inbox(
        state.pool(),
        ctx.user.id,
        query.target_host_id,
        query.target_agent,
        query.scope,
        query.scope_key.as_deref(),
    )
    .await
    .map(Json)
    .map_err(internal_memory_error)
}

async fn record_mutation_receipt(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Json(payload): Json<RecordAgentMemoryMutationReceiptRequest>,
) -> Result<StatusCode, ErrorResponse> {
    ensure_owned_host(&state, ctx.user.id, payload.target_host_id).await?;
    if payload
        .reason
        .as_ref()
        .is_some_and(|reason| reason.len() > MAX_REASON_BYTES)
    {
        return Err(ErrorResponse::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "memory mutation receipt reason exceeds 4 KiB",
        ));
    }
    match agent_memory::record_mutation_receipt(state.pool(), ctx.user.id, &payload).await {
        Ok(true) => Ok(StatusCode::NO_CONTENT),
        Ok(false) => Err(ErrorResponse::new(
            StatusCode::NOT_FOUND,
            "memory mutation not found",
        )),
        Err(error) => Err(internal_memory_error(error)),
    }
}

fn internal_memory_error(error: anyhow::Error) -> ErrorResponse {
    tracing::error!(?error, "agent memory operation failed");
    ErrorResponse::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "agent memory operation failed",
    )
}

async fn upsert_snapshot(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Json(mut payload): Json<UpsertAgentMemorySnapshotRequest>,
) -> Result<Json<UpsertAgentMemorySnapshotResponse>, ErrorResponse> {
    ensure_owned_host(&state, ctx.user.id, payload.source_host_id).await?;
    if payload.content.len() > MAX_SNAPSHOT_BYTES {
        return Err(ErrorResponse::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "memory snapshot exceeds 64 KiB",
        ));
    }
    validate_scope(payload.scope, payload.scope_key.as_deref())?;
    payload.content_hash = hex::encode(Sha256::digest(payload.content.as_bytes()));

    agent_memory::upsert_snapshot(state.pool(), ctx.user.id, &payload)
        .await
        .map(Json)
        .map_err(|error| {
            tracing::error!(?error, "failed to upsert agent memory snapshot");
            ErrorResponse::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to store agent memory snapshot",
            )
        })
}

#[derive(Deserialize)]
struct InboxQuery {
    target_host_id: Uuid,
    target_agent: AgentMemoryKind,
    scope: AgentMemoryScope,
    scope_key: Option<String>,
}

#[derive(Deserialize)]
struct SnapshotQuery {
    source_host_id: Uuid,
    source_agent: AgentMemoryKind,
    scope: AgentMemoryScope,
    scope_key: Option<String>,
}

async fn get_snapshot(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Query(query): Query<SnapshotQuery>,
) -> Result<Json<api_types::AgentMemorySnapshot>, ErrorResponse> {
    ensure_owned_host(&state, ctx.user.id, query.source_host_id).await?;
    validate_scope(query.scope, query.scope_key.as_deref())?;
    agent_memory::find_snapshot(
        state.pool(),
        ctx.user.id,
        query.source_host_id,
        query.source_agent,
        query.scope,
        query.scope_key.as_deref(),
    )
    .await
    .map_err(|error| {
        tracing::error!(?error, "failed to load agent memory snapshot");
        ErrorResponse::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "failed to load agent memory snapshot",
        )
    })?
    .map(Json)
    .ok_or_else(|| ErrorResponse::new(StatusCode::NOT_FOUND, "memory snapshot not found"))
}

async fn inbox(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Query(query): Query<InboxQuery>,
) -> Result<Json<AgentMemoryInboxResponse>, ErrorResponse> {
    ensure_owned_host(&state, ctx.user.id, query.target_host_id).await?;
    validate_scope(query.scope, query.scope_key.as_deref())?;

    agent_memory::inbox(
        state.pool(),
        ctx.user.id,
        query.target_host_id,
        query.target_agent,
        query.scope,
        query.scope_key.as_deref(),
    )
    .await
    .map(Json)
    .map_err(|error| {
        tracing::error!(?error, "failed to load agent memory inbox");
        ErrorResponse::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "failed to load agent memory inbox",
        )
    })
}

async fn record_receipt(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Json(payload): Json<RecordAgentMemoryReceiptRequest>,
) -> Result<Json<AgentMemoryReceipt>, ErrorResponse> {
    ensure_owned_host(&state, ctx.user.id, payload.target_host_id).await?;
    if payload
        .reason
        .as_ref()
        .is_some_and(|reason| reason.len() > MAX_REASON_BYTES)
    {
        return Err(ErrorResponse::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "memory receipt reason exceeds 4 KiB",
        ));
    }

    agent_memory::record_receipt(state.pool(), ctx.user.id, &payload)
        .await
        .map_err(|error| {
            tracing::error!(?error, "failed to record agent memory receipt");
            ErrorResponse::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to record agent memory receipt",
            )
        })?
        .map(Json)
        .ok_or_else(|| {
            ErrorResponse::new(
                StatusCode::NOT_FOUND,
                "memory snapshot or revision not found",
            )
        })
}

async fn ensure_owned_host(
    state: &AppState,
    user_id: Uuid,
    host_id: Uuid,
) -> Result<(), ErrorResponse> {
    match agent_memory::host_belongs_to_user(state.pool(), host_id, user_id).await {
        Ok(true) => Ok(()),
        Ok(false) => Err(ErrorResponse::new(StatusCode::FORBIDDEN, "host not owned")),
        Err(error) => {
            tracing::error!(?error, "failed to validate memory sync host");
            Err(ErrorResponse::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to validate host",
            ))
        }
    }
}

fn validate_scope(scope: AgentMemoryScope, scope_key: Option<&str>) -> Result<(), ErrorResponse> {
    if scope == AgentMemoryScope::Repository && scope_key.map(str::trim).is_none_or(str::is_empty) {
        return Err(ErrorResponse::new(
            StatusCode::BAD_REQUEST,
            "repository scope requires scope_key",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_repository_scope() {
        assert!(validate_scope(AgentMemoryScope::Repository, None).is_err());
        assert!(validate_scope(AgentMemoryScope::Repository, Some(" ")).is_err());
        assert!(validate_scope(AgentMemoryScope::Repository, Some("repo")).is_ok());
        assert!(validate_scope(AgentMemoryScope::UserGlobal, None).is_ok());
    }
}
