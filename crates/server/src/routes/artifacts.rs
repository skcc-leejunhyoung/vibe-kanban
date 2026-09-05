use axum::{
    Extension, Json,
    body::Body,
    extract::{Query, State},
    http::header,
    response::Response,
};
use db::models::execution_process::{ExecutionProcess, ExecutionProcessStatus};
use deployment::Deployment;
use executors::logs::artifacts::{ArtifactBundle, ArtifactList};
use futures_util::StreamExt;
use serde::Deserialize;
use services::services::{
    artifacts::{self, ArtifactManifest},
    container::ContainerService,
};
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

#[derive(Deserialize)]
pub struct ArtifactQuery {
    workspace_id: Uuid,
    session_id: Uuid,
    id: Option<String>,
    hash: Option<String>,
}

async fn scoped_manifest(
    deployment: &DeploymentImpl,
    process: &ExecutionProcess,
    query: &ArtifactQuery,
) -> Result<Option<ArtifactManifest>, ApiError> {
    let (workspace, session) = process
        .parent_workspace_and_session(&deployment.db().pool)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Execution scope not found".into()))?;
    if workspace.id != query.workspace_id || session.id != query.session_id {
        return Err(ApiError::BadRequest(
            "Execution does not belong to this workspace/session".into(),
        ));
    }
    let mut manifest = artifacts::load(session.id, process.id)
        .await
        .map_err(|error| ApiError::BadRequest(error.to_string()))?;
    if manifest.is_none() && !matches!(process.status, ExecutionProcessStatus::Running) {
        // ponytail: serialize rare legacy recovery; use per-execution locks if
        // concurrent history recovery becomes a measured bottleneck.
        static RECOVERY: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
        let _guard = RECOVERY.lock().await;
        manifest = artifacts::load(session.id, process.id)
            .await
            .map_err(|error| ApiError::BadRequest(error.to_string()))?;
        if manifest.is_none()
            && let Some(root) = workspace.container_ref.as_ref()
        {
            let mut entries = std::collections::BTreeMap::new();
            if let Some(mut stream) = deployment
                .container()
                .stream_normalized_logs(&process.id)
                .await
            {
                while let Some(Ok(utils::log_msg::LogMsg::JsonPatch(patch))) = stream.next().await {
                    if let Some((index, entry)) =
                        executors::logs::utils::patch::extract_normalized_entry_from_patch(&patch)
                    {
                        entries.insert(index, entry);
                    }
                }
            }
            let root = std::path::PathBuf::from(root);
            let working = root.join(session.agent_working_dir.as_deref().unwrap_or(""));
            artifacts::ArtifactObserver::recover(
                root,
                working,
                workspace.id,
                session.id,
                process.id,
                deployment.file().clone(),
                entries,
            )
            .await
            .map_err(|error| ApiError::BadRequest(error.to_string()))?;
            manifest = artifacts::load(session.id, process.id)
                .await
                .map_err(|error| ApiError::BadRequest(error.to_string()))?;
        }
    }
    if manifest
        .as_ref()
        .is_some_and(|m| m.workspace_id != workspace.id)
    {
        return Err(ApiError::BadRequest("Invalid artifact scope".into()));
    }
    if let Some(manifest) = manifest.as_mut()
        && !manifest.list.complete
        && !matches!(process.status, ExecutionProcessStatus::Running)
        && deployment
            .container()
            .get_msg_store_by_id(&process.id)
            .await
            .is_none()
    {
        artifacts::seal_interrupted(manifest)
            .await
            .map_err(|error| ApiError::BadRequest(error.to_string()))?;
    }
    Ok(manifest)
}

pub async fn list(
    Extension(process): Extension<ExecutionProcess>,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<ArtifactQuery>,
) -> Result<Json<ApiResponse<ArtifactList>>, ApiError> {
    let manifest = scoped_manifest(&deployment, &process, &query).await?;
    let list = manifest.map(|m| m.list).unwrap_or(ArtifactList {
        artifacts: Vec::new(),
        complete: !matches!(process.status, ExecutionProcessStatus::Running),
        warnings: Vec::new(),
    });
    Ok(Json(ApiResponse::success(list)))
}

pub async fn bundle(
    Extension(process): Extension<ExecutionProcess>,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<ArtifactQuery>,
) -> Result<Json<ApiResponse<ArtifactBundle>>, ApiError> {
    let manifest = scoped_manifest(&deployment, &process, &query)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Artifact snapshot not available".into()))?;
    let bundle = query
        .id
        .as_ref()
        .and_then(|id| manifest.bundles.get(id))
        .ok_or_else(|| ApiError::BadRequest("Artifact snapshot not available".into()))?;
    Ok(Json(ApiResponse::success(bundle.clone())))
}

pub async fn content(
    Extension(process): Extension<ExecutionProcess>,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<ArtifactQuery>,
) -> Result<Response, ApiError> {
    let manifest = scoped_manifest(&deployment, &process, &query)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Artifact snapshot not available".into()))?;
    let artifact = query
        .id
        .as_ref()
        .and_then(|id| manifest.list.artifacts.iter().find(|a| &a.id == id))
        .ok_or_else(|| ApiError::BadRequest("Unknown artifact".into()))?;
    let hash = query
        .hash
        .as_deref()
        .or(artifact.content_hash.as_deref())
        .ok_or_else(|| ApiError::BadRequest("Artifact content is missing".into()))?;
    let allowed = artifact.content_hash.as_deref() == Some(hash)
        || manifest.bundles.get(&artifact.id).is_some_and(|bundle| {
            bundle
                .resources
                .iter()
                .any(|resource| resource.content_hash == hash)
        });
    if !allowed || hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ApiError::BadRequest("Unknown artifact resource".into()));
    }
    let bytes =
        tokio::fs::read(artifacts::directory(process.session_id, process.id).join(hash)).await?;
    if bytes.len() as u64 > artifacts::MAX_FILE_BYTES {
        return Err(ApiError::BadRequest(
            "Artifact resource is too large".into(),
        ));
    }
    // Never serve active HTML/SVG on the app origin, even on direct navigation.
    // The parent fetches bytes through host transport and builds the isolation boundary.
    Response::builder()
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_DISPOSITION, "attachment; filename=artifact")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; sandbox",
        )
        .header(header::CACHE_CONTROL, "private, no-store")
        .body(Body::from(bytes))
        .map_err(|error| ApiError::BadRequest(error.to_string()))
}
