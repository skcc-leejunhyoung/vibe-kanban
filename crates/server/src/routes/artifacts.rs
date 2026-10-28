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
    pub(super) workspace_id: Uuid,
    pub(super) session_id: Uuid,
    pub(super) id: Option<String>,
    pub(super) hash: Option<String>,
    pub(super) version: Option<String>,
}

pub(super) async fn scoped_manifest(
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
        let _guard = artifacts::RECOVERY.lock().await;
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
                None,
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
    // Attachment lines queued after the execution closed (a Drawer note written
    // in its last seconds) are registered on the next read.
    if let Some(saved) = manifest.as_ref()
        && saved.list.complete
        && artifacts::has_pending_registrations(session.id, process.id).await
        && let Some(root) = workspace.container_ref.as_ref()
    {
        let _guard = artifacts::RECOVERY.lock().await;
        let root = std::path::PathBuf::from(root);
        let working = root.join(session.agent_working_dir.as_deref().unwrap_or(""));
        artifacts::register(
            root,
            working,
            workspace.id,
            session.id,
            process.id,
            deployment.file().clone(),
            None,
        )
        .await
        .map_err(|error| ApiError::BadRequest(error.to_string()))?;
        manifest = artifacts::load(session.id, process.id)
            .await
            .map_err(|error| ApiError::BadRequest(error.to_string()))?;
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
        let _guard = artifacts::RECOVERY.lock().await;
        // A concurrent history request may already have sealed/recovered it.
        if let Some(saved) = artifacts::load(session.id, process.id)
            .await
            .map_err(|error| ApiError::BadRequest(error.to_string()))?
        {
            *manifest = saved;
        }
        if manifest.list.complete {
            return Ok(Some(manifest.clone()));
        }
        artifacts::seal_interrupted(manifest)
            .await
            .map_err(|error| ApiError::BadRequest(error.to_string()))?;
    }
    Ok(manifest)
}

#[derive(Deserialize)]
pub struct RegisterArtifactsRequest {
    /// Markdown whose standalone `[Title](path "vibe-artifact")` lines name
    /// the files to register, relative to the session's working directory.
    pub text: String,
}

#[derive(serde::Serialize)]
pub struct RegisterArtifactsResponse {
    /// True while the execution runs: its observer registers the files on
    /// its next tick (within a second). False once they are in the manifest.
    pub queued: bool,
    pub files: Vec<String>,
    pub missing: Vec<String>,
}

/// Register attachment lines written outside the transcript — a Drawer note
/// the agent wrote through `vk drawer` — into this execution's manifest, so
/// the note's `vibe-artifact` links render like the chat's.
pub async fn register(
    Extension(process): Extension<ExecutionProcess>,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<ArtifactQuery>,
    Json(request): Json<RegisterArtifactsRequest>,
) -> Result<Json<ApiResponse<RegisterArtifactsResponse>>, ApiError> {
    let (workspace, session) = process
        .parent_workspace_and_session(&deployment.db().pool)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Execution scope not found".into()))?;
    if workspace.id != query.workspace_id || session.id != query.session_id {
        return Err(ApiError::BadRequest(
            "Execution does not belong to this workspace/session".into(),
        ));
    }
    let root = std::path::PathBuf::from(
        workspace
            .container_ref
            .as_ref()
            .ok_or_else(|| ApiError::BadRequest("Workspace has no checkout".into()))?,
    );
    let working = root.join(session.agent_working_dir.as_deref().unwrap_or(""));
    let live = matches!(process.status, ExecutionProcessStatus::Running)
        && deployment
            .container()
            .get_msg_store_by_id(&process.id)
            .await
            .is_some();
    if live {
        // The observer owns an open manifest: queue, and it registers on its
        // next tick. A request landing as the execution closes is drained by
        // its final tick, or by the next read of the sealed manifest.
        artifacts::queue_registration(session.id, process.id, &request.text)
            .await
            .map_err(|error| ApiError::BadRequest(error.to_string()))?;
        // Resolve the lines now so the caller learns about typos at once.
        let canonical_root = std::fs::canonicalize(&root).unwrap_or(root.clone());
        let canonical_working = std::fs::canonicalize(&working).unwrap_or(working.clone());
        let (mut files, mut missing) = (Vec::new(), Vec::new());
        for candidate in executors::logs::artifacts::markdown_candidates(&request.text) {
            if let executors::logs::artifacts::ArtifactCandidate::File(raw) = candidate {
                match artifacts::resolve_reference(&canonical_root, &canonical_working, &raw) {
                    Ok(path) if path.is_file() => files.push(
                        path.strip_prefix(&canonical_root)
                            .map(|p| p.to_string_lossy().replace('\\', "/"))
                            .unwrap_or(raw),
                    ),
                    _ => missing.push(raw),
                }
            }
        }
        return Ok(Json(ApiResponse::success(RegisterArtifactsResponse {
            queued: true,
            files,
            missing,
        })));
    }
    // Finished: make sure the manifest exists and is sealed, then register the
    // text straight into it (the outcome reports this text's own lines).
    scoped_manifest(&deployment, &process, &query).await?;
    let _guard = artifacts::RECOVERY.lock().await;
    let bad = |error: anyhow::Error| ApiError::BadRequest(error.to_string());
    let mut outcome = artifacts::register(
        root.clone(),
        working.clone(),
        workspace.id,
        session.id,
        process.id,
        deployment.file().clone(),
        Some(&request.text),
    )
    .await
    .map_err(bad)?;
    if outcome.is_none()
        && let Some(mut manifest) = artifacts::load(session.id, process.id).await.map_err(bad)?
        && !manifest.list.complete
    {
        // The row still says Running but nothing is streaming (a stale status
        // after a restart): seal what was preserved, then register.
        artifacts::seal_interrupted(&mut manifest)
            .await
            .map_err(bad)?;
        outcome = artifacts::register(
            root,
            working,
            workspace.id,
            session.id,
            process.id,
            deployment.file().clone(),
            Some(&request.text),
        )
        .await
        .map_err(bad)?;
    }
    let outcome = outcome.ok_or_else(|| {
        ApiError::BadRequest("Execution is still closing; retry in a moment".into())
    })?;
    Ok(Json(ApiResponse::success(RegisterArtifactsResponse {
        queued: false,
        files: outcome.files,
        missing: outcome.missing,
    })))
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
    let id = query
        .id
        .as_deref()
        .ok_or_else(|| ApiError::BadRequest("Artifact snapshot not available".into()))?;
    let bundle = manifest
        .bundles
        .get(id)
        .ok_or_else(|| ApiError::BadRequest("Artifact snapshot not available".into()))?;
    if let Some(version) = &query.version
        && services::services::artifact_interactions::bundle_version(bundle)
            .map_err(|error| ApiError::BadRequest(error.to_string()))?
            != *version
    {
        return Err(ApiError::Conflict(
            "Artifact changed; request a new form".into(),
        ));
    }
    // Only document snapshots reload the manifest behind the recovery lock.
    let converted = if artifacts::is_document(&bundle.artifact.mime) {
        artifacts::ensure_document_preview(
            process.session_id,
            process.id,
            id,
            deployment.file().clone(),
        )
        .await
        .map_err(|error| ApiError::BadRequest(error.to_string()))?
    } else {
        None
    };
    let bundle = converted.unwrap_or_else(|| bundle.clone());
    Ok(Json(ApiResponse::success(bundle)))
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
