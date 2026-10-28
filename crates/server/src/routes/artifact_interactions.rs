use axum::{
    Extension, Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use chrono::{Duration, Utc};
use db::models::{
    execution_process::{ExecutionProcess, ExecutionProcessStatus},
    scratch::DraftFollowUpData,
};
use deployment::Deployment;
use serde::{Deserialize, Serialize};
use services::services::{
    artifact_interactions::{
        self as inputs, ArtifactDelivery, ArtifactHandler, ArtifactInputSchema,
        ArtifactInteraction, ArtifactInteractionRef, ArtifactInteractionState as Status,
        ArtifactResponse, Receipt,
    },
    container::ContainerService,
};
use ts_rs::TS;
use utils::response::ApiResponse;
use uuid::Uuid;

use super::artifacts::{ArtifactQuery, scoped_manifest};
use crate::{DeploymentImpl, error::ApiError};

fn bad(error: anyhow::Error) -> ApiError {
    ApiError::BadRequest(error.to_string())
}

#[allow(clippy::result_large_err)] // Route helpers share the existing ApiError enum.
fn check_owner() -> Result<(), ApiError> {
    if deployment::host_cloud_session_denied() {
        return Err(ApiError::Forbidden(
            "Only the host owner may use artifact input requests".into(),
        ));
    }
    Ok(())
}

async fn owner_id(deployment: &DeploymentImpl) -> String {
    deployment
        .auth_context()
        .get_credentials()
        .await
        .and_then(|credentials| utils::jwt::extract_subject(&credentials.refresh_token).ok())
        .map(|id| id.to_string())
        .unwrap_or_else(|| format!("local:{}", deployment.user_id()))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisterInteraction {
    pub artifact_id: String,
    pub schema: ArtifactInputSchema,
    pub delivery: ArtifactDelivery,
    pub handler: Option<ArtifactHandler>,
    /// Required declaration. No protected handler is installed in this version.
    pub sensitive: bool,
}

pub async fn register(
    Extension(process): Extension<ExecutionProcess>,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<ArtifactQuery>,
    Json(request): Json<RegisterInteraction>,
) -> Result<Json<ApiResponse<ArtifactInteraction>>, ApiError> {
    check_owner()?;
    if process.dropped {
        return Err(ApiError::BadRequest(
            "This execution is no longer active in the conversation".into(),
        ));
    }
    if request.sensitive {
        return Err(ApiError::BadRequest(
            "Sensitive input is not supported".into(),
        ));
    }
    request.schema.check(0).map_err(bad)?;
    inputs::check_destination(request.delivery, request.handler, &request.schema).map_err(bad)?;
    if !matches!(request.schema, ArtifactInputSchema::Object { .. }) {
        return Err(ApiError::BadRequest(
            "The input schema must be an object".into(),
        ));
    }
    if request.delivery == ArtifactDelivery::Wait
        && (process.status != ExecutionProcessStatus::Running
            || deployment
                .container()
                .get_msg_store_by_id(&process.id)
                .await
                .is_none())
    {
        return Err(ApiError::BadRequest(
            "The waiting execution is no longer running".into(),
        ));
    }
    let manifest = scoped_manifest(&deployment, &process, &query)
        .await?
        .ok_or_else(|| {
            ApiError::BadRequest("Attach the artifact before registering input".into())
        })?;
    let bundle = manifest
        .bundles
        .get(&request.artifact_id)
        .ok_or_else(|| ApiError::BadRequest("Unknown artifact".into()))?;
    if bundle.artifact.mime != "text/html"
        || bundle.artifact.content_hash.is_none()
        || bundle.artifact.status != executors::logs::artifacts::ArtifactStatus::Ready
    {
        return Err(ApiError::BadRequest(
            "Interactive input requires an HTML snapshot".into(),
        ));
    }
    let _guard = inputs::LOCK.lock().await;
    let existing = inputs::list(process.session_id, process.id)
        .await
        .map_err(bad)?;
    if existing.len() >= 128 {
        return Err(ApiError::BadRequest(
            "Too many artifact requests in this execution".into(),
        ));
    }
    let version = inputs::bundle_version(bundle).map_err(bad)?;
    for mut receipt in existing {
        refresh(&deployment, &process, &query, &mut receipt).await?;
        if receipt.interaction.artifact_id == request.artifact_id
            && receipt.interaction.state == Status::InputRequired
        {
            if receipt.interaction.version == version
                && receipt.interaction.schema == request.schema
                && receipt.interaction.delivery == request.delivery
                && receipt.interaction.handler == request.handler
            {
                return Ok(Json(ApiResponse::success(receipt.interaction)));
            }
            return Err(ApiError::Conflict(
                "This artifact already has an open input request".into(),
            ));
        }
    }
    let now = Utc::now();
    let interaction = ArtifactInteraction {
        reference: ArtifactInteractionRef {
            session_id: process.session_id,
            execution_id: process.id,
            request_id: Uuid::new_v4(),
        },
        workspace_id: query.workspace_id,
        owner_host: deployment.user_id().to_string(),
        owner_id: owner_id(&deployment).await,
        artifact_id: request.artifact_id,
        artifact_hash: bundle.artifact.content_hash.clone().unwrap(),
        version,
        schema: request.schema,
        delivery: request.delivery,
        handler: request.handler,
        state: Status::InputRequired,
        created_at: now,
        expires_at: now + Duration::hours(10),
        result_process_id: None,
        error: None,
    };
    inputs::save(&Receipt {
        interaction: interaction.clone(),
        boot_id: *inputs::BOOT_ID,
        response: None,
        dispatch_claimed: false,
    })
    .await
    .map_err(bad)?;
    Ok(Json(ApiResponse::success(interaction)))
}

async fn refresh(
    deployment: &DeploymentImpl,
    process: &ExecutionProcess,
    query: &ArtifactQuery,
    receipt: &mut Receipt,
) -> Result<(), ApiError> {
    receipt
        .check_scope(
            query.workspace_id,
            query.session_id,
            process.id,
            deployment.user_id(),
            &owner_id(deployment).await,
        )
        .map_err(bad)?;
    let old = receipt.interaction.state;
    let i = &mut receipt.interaction;
    if i.state == Status::InputRequired
        && (i.expires_at <= Utc::now()
            || process.dropped
            || receipt.boot_id != *inputs::BOOT_ID
            || (i.delivery == ArtifactDelivery::Wait
                && process.status != ExecutionProcessStatus::Running))
    {
        i.state = Status::Expired;
    }
    if matches!(
        i.state,
        Status::Processing | Status::Accepted | Status::Unknown | Status::Failed
    ) {
        if let Some(id) = i.result_process_id {
            if let Some(result) = ExecutionProcess::find_by_id(&deployment.db().pool, id).await? {
                i.state = match result.status {
                    ExecutionProcessStatus::Running => Status::Processing,
                    ExecutionProcessStatus::Completed if result.exit_code == Some(0) => {
                        Status::Completed
                    }
                    ExecutionProcessStatus::Killed => Status::Cancelled,
                    _ => Status::Failed,
                };
            } else {
                i.state = Status::Unknown;
            }
        } else if let Some(queued) = deployment
            .queued_message_service()
            .get_queued(process.session_id)
            .iter()
            .find(|q| q.artifact_request.as_ref() == Some(&i.reference))
        {
            if let Some(error) = &queued.start_error {
                i.state = Status::Failed;
                i.error = Some(error.clone());
            }
        } else if receipt.boot_id != *inputs::BOOT_ID
            && !(receipt.dispatch_claimed && i.state == Status::Failed)
        {
            i.state = Status::Unknown;
        } else if i.delivery == ArtifactDelivery::Wait
            && process.status != ExecutionProcessStatus::Running
        {
            i.state = Status::Expired;
        }
    }
    if old != receipt.interaction.state {
        inputs::save(receipt).await.map_err(bad)?;
    }
    Ok(())
}

pub async fn list(
    Extension(process): Extension<ExecutionProcess>,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<ArtifactQuery>,
) -> Result<Json<ApiResponse<Vec<ArtifactInteraction>>>, ApiError> {
    check_owner()?;
    scoped_manifest(&deployment, &process, &query).await?;
    let _guard = inputs::LOCK.lock().await;
    let mut records = inputs::list(process.session_id, process.id)
        .await
        .map_err(bad)?;
    for receipt in &mut records {
        refresh(&deployment, &process, &query, receipt).await?;
    }
    Ok(Json(ApiResponse::success(
        records.into_iter().map(|r| r.interaction).collect(),
    )))
}

#[derive(Deserialize)]
pub struct InteractionPath {
    id: Uuid,
    request_id: Uuid,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubmitInteraction {
    pub artifact_id: String,
    pub version: String,
    pub owner_host: String,
    pub response: ArtifactResponse,
}

pub async fn respond(
    Extension(process): Extension<ExecutionProcess>,
    State(deployment): State<DeploymentImpl>,
    Path(path): Path<InteractionPath>,
    Query(query): Query<ArtifactQuery>,
    headers: HeaderMap,
    Json(request): Json<SubmitInteraction>,
) -> Result<Json<ApiResponse<ArtifactInteraction>>, ApiError> {
    check_owner()?;
    // Agent registration is allowed; answering is an explicit browser action.
    if headers.contains_key(crate::middleware::agent_access::AGENT_HEADER) {
        return Err(ApiError::Forbidden(
            "Artifact responses require user input".into(),
        ));
    }
    if path.id != process.id || request.owner_host != deployment.user_id() {
        return Err(ApiError::Forbidden("Wrong artifact owner host".into()));
    }
    let manifest = scoped_manifest(&deployment, &process, &query)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Artifact snapshot unavailable".into()))?;
    let reference = ArtifactInteractionRef {
        session_id: process.session_id,
        execution_id: process.id,
        request_id: path.request_id,
    };
    let guard = inputs::LOCK.lock().await;
    let mut receipt = inputs::load(&reference).await.map_err(bad)?;
    refresh(&deployment, &process, &query, &mut receipt).await?;
    // Replays check the original identity/payload, but need not re-run an old bundle.
    if receipt.response.is_none() {
        let current = manifest
            .bundles
            .get(&receipt.interaction.artifact_id)
            .ok_or_else(|| ApiError::BadRequest("Artifact is no longer available".into()))?;
        if inputs::bundle_version(current).map_err(bad)? != receipt.interaction.version {
            receipt.interaction.state = Status::Expired;
            inputs::save(&receipt).await.map_err(bad)?;
            return Err(ApiError::Conflict(
                "Artifact changed; request a new form".into(),
            ));
        }
    }
    let dispatch = receipt
        .accept(&request.artifact_id, &request.version, request.response)
        .map_err(bad)?;
    if !dispatch {
        return Ok(Json(ApiResponse::success(receipt.interaction)));
    }
    let (_, session) = process
        .parent_workspace_and_session(&deployment.db().pool)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Session no longer exists".into()))?;
    let config = if receipt.interaction.delivery == ArtifactDelivery::FollowUp {
        Some(
            ExecutionProcess::latest_executor_config_for_session(&deployment.db().pool, session.id)
                .await?
                .ok_or_else(|| {
                    ApiError::BadRequest("No executor configured for this session".into())
                })?,
        )
    } else {
        None
    };
    inputs::save(&receipt).await.map_err(bad)?;
    if let Some(executor_config) = config {
        let data = DraftFollowUpData {
            message: format!(
                "Artifact response (user input)\n{}",
                serde_json::json!({ "request_id": reference.request_id, "artifact_id": receipt.interaction.artifact_id, "version": receipt.interaction.version, "response": receipt.response })
            ),
            executor_config,
        };
        deployment
            .queued_message_service()
            .enqueue_artifact(session.id, data, reference);
    }
    drop(guard);
    if receipt.interaction.delivery == ArtifactDelivery::Service
        && matches!(receipt.response, Some(ArtifactResponse::Submit { .. }))
    {
        return Ok(Json(ApiResponse::success(
            inputs::dispatch_service(&deployment.db().pool, &receipt.interaction.reference)
                .await
                .map_err(|error| ApiError::Io(std::io::Error::other(error)))?,
        )));
    }
    if receipt.interaction.delivery == ArtifactDelivery::FollowUp
        && let Err(error) = super::sessions::queue::drain_idle_queue(&deployment, &session).await
    {
        tracing::warn!(request_id = %path.request_id, %error, "Artifact follow-up remains queued");
    }
    Ok(Json(ApiResponse::success(receipt.interaction)))
}

#[derive(Serialize, TS)]
pub struct ArtifactInteractionResult {
    pub interaction: ArtifactInteraction,
    pub response: Option<ArtifactResponse>,
}

/// The waiting tool reads structured input directly, never queues behind itself.
pub async fn result(
    Extension(process): Extension<ExecutionProcess>,
    State(deployment): State<DeploymentImpl>,
    Path(path): Path<InteractionPath>,
    Query(query): Query<ArtifactQuery>,
) -> Result<Json<ApiResponse<ArtifactInteractionResult>>, ApiError> {
    check_owner()?;
    let _guard = inputs::LOCK.lock().await;
    let reference = ArtifactInteractionRef {
        session_id: process.session_id,
        execution_id: path.id,
        request_id: path.request_id,
    };
    let mut receipt = inputs::load(&reference).await.map_err(bad)?;
    refresh(&deployment, &process, &query, &mut receipt).await?;
    if receipt.interaction.delivery == ArtifactDelivery::Wait
        && receipt.interaction.state == Status::Accepted
    {
        receipt.interaction.result_process_id = Some(process.id);
        receipt.interaction.state = Status::Processing;
        inputs::save(&receipt).await.map_err(bad)?;
    }
    Ok(Json(ApiResponse::success(ArtifactInteractionResult {
        interaction: receipt.interaction,
        response: receipt.response,
    })))
}
