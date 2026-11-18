use std::{sync::LazyLock, time::Duration};

use axum::{
    Extension, Json, Router,
    extract::{Path, Query, State},
    http::HeaderMap,
    routing::{get, post},
};
use db::models::execution_process::ExecutionProcess;
use deployment::Deployment;
use moka::future::Cache;
use serde::{Deserialize, Serialize};
use serde_json::json;
use services::services::{
    artifact_interactions::{
        ArtifactAutomationBinding, ArtifactAutomationSnapshot, ArtifactInputSchema,
    },
    artifacts,
    drawer_artifacts::{
        self as stored, ArtifactOwner, DrawerArtifactDocument, DrawerArtifactFile, StoredArtifact,
    },
    remote_client::RemoteClient,
};
use utils::response::ApiResponse;
use uuid::Uuid;

use super::artifacts::{ArtifactQuery, scoped_manifest};
use crate::{DeploymentImpl, error::ApiError};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DrawerChannelConfig {
    pub data_schema: ArtifactInputSchema,
    pub publishers: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisterDrawerArtifact {
    pub id: Uuid,
    pub note_id: Uuid,
    pub artifact_id: String,
    pub config: DrawerChannelConfig,
    pub sensitive: bool,
}

#[derive(Deserialize)]
pub struct VersionQuery {
    pub version: String,
    #[serde(flatten)]
    pub owner: NoteQuery,
}
#[derive(Deserialize)]
pub struct NoteQuery {
    pub note_id: Option<Uuid>,
    pub workspace_id: Option<Uuid>,
    pub session_id: Option<Uuid>,
}

#[cfg(test)]
mod owner_tests {
    use super::*;

    #[test]
    fn owner_queries_require_one_complete_unambiguous_owner() {
        let note = Uuid::new_v4();
        let workspace = Uuid::new_v4();
        let session = Uuid::new_v4();
        for bits in 0..8 {
            let query = NoteQuery {
                note_id: (bits & 1 != 0).then_some(note),
                workspace_id: (bits & 2 != 0).then_some(workspace),
                session_id: (bits & 4 != 0).then_some(session),
            };
            assert_eq!(query.artifact_owner().is_ok(), bits == 1 || bits == 6);
        }
        assert!(
            serde_json::from_value::<ArtifactOwner>(
                json!({"kind":"drawer","note_id":note,"workspace_id":workspace})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<ArtifactOwner>(
                json!({"kind":"workspace","workspace_id":workspace})
            )
            .is_err()
        );
    }
}
impl NoteQuery {
    fn artifact_owner(&self) -> Result<ArtifactOwner, &'static str> {
        match (self.note_id, self.workspace_id, self.session_id) {
            (Some(note_id), None, None) => Ok(ArtifactOwner::Drawer { note_id }),
            (None, Some(workspace_id), Some(session_id)) => Ok(ArtifactOwner::Workspace {
                workspace_id,
                session_id,
            }),
            _ => Err("Provide exactly one note or workspace session owner"),
        }
    }
}

fn bad(error: impl std::fmt::Display) -> ApiError {
    ApiError::BadRequest(error.to_string())
}

async fn owner(deployment: &DeploymentImpl) -> Result<(RemoteClient, Uuid, Uuid), ApiError> {
    if deployment::host_cloud_session_denied() {
        return Err(ApiError::Forbidden(
            "Only the host owner may use Drawer artifacts".into(),
        ));
    }
    let client = deployment.remote_client()?;
    let owner = client
        .notification_account()
        .await
        .ok_or_else(|| ApiError::Forbidden("Sign in to use Drawer artifacts".into()))?;
    let client = client.for_account(owner);
    let host = client.current_host_id().await?;
    Ok((client, owner, host))
}

pub async fn register(
    Extension(process): Extension<ExecutionProcess>,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<ArtifactQuery>,
    headers: HeaderMap,
    Json(request): Json<RegisterDrawerArtifact>,
) -> Result<Json<ApiResponse<serde_json::Value>>, ApiError> {
    let (client, owner, host) = owner(&deployment).await?;
    if request.sensitive {
        return Err(bad("Sensitive Drawer artifacts are not supported"));
    }
    if headers.contains_key(crate::middleware::agent_access::AGENT_HEADER)
        && !deployment.config().read().await.agent_access.write_issues
    {
        return Err(ApiError::Forbidden(
            "Drawer registration requires agent_access.write_issues as well as automation_write"
                .into(),
        ));
    }
    let _guard = stored::LOCK.lock().await;
    let note = client
        .drawer_note(request.note_id)
        .await?
        .ok_or_else(|| ApiError::Forbidden("Drawer note is unavailable".into()))?;
    if note.owner_user_id != owner || note.host_id != Some(host) || note.archived_at.is_some() {
        return Err(ApiError::Forbidden(
            "An active Drawer note on this host is required".into(),
        ));
    }
    let manifest = scoped_manifest(&deployment, &process, &query)
        .await?
        .ok_or_else(|| bad("Artifact snapshot is not ready"))?;
    if stored::source_transferred(&deployment.db().pool, process.id, &request.artifact_id)
        .await
        .map_err(bad)?
    {
        return Err(ApiError::Conflict(
            "Source artifact ownership was transferred".into(),
        ));
    }
    let bundle = manifest
        .bundles
        .get(&request.artifact_id)
        .ok_or_else(|| bad("Unknown artifact"))?;
    if bundle.artifact.mime != "text/html"
        || bundle.artifact.status != executors::logs::artifacts::ArtifactStatus::Ready
    {
        return Err(bad("Drawer dashboards require HTML"));
    }
    request.config.data_schema.check(0).map_err(bad)?;
    if request.config.publishers.is_empty() || request.config.publishers.len() > 16 {
        return Err(bad(
            "One to sixteen registered publisher Rules are required",
        ));
    }
    let (path, snapshots) = snapshot_files(&process, bundle).await?;
    let config = serde_json::to_string(&request.config).map_err(bad)?;
    let version = stored::document_version(request.note_id, &snapshots, &config).map_err(bad)?;
    if let Ok(existing) = stored::load(&deployment.db().pool, request.id).await {
        if existing.owner_id != owner
            || existing.host_id != host
            || existing.note_id != Some(note.id)
            || existing.version != version
            || existing.deleted
        {
            return Err(ApiError::Conflict(
                "Drawer artifact ID is already used; choose a new ID".into(),
            ));
        }
        if existing.attached {
            client.ensure_account().await?;
            let existing = stored::reconcile(&deployment.db().pool, existing.id, Some(&note))
                .await
                .map_err(bad)?;
            if existing.deleted {
                return Err(ApiError::Conflict(
                    "Drawer dashboard was revoked; register with a new ID".into(),
                ));
            }
            client.ensure_account().await?;
            return Ok(Json(ApiResponse::success(registration(&existing))));
        }
        return Err(ApiError::Conflict(
            "Registration is unconfirmed; inspect the Drawer note before retrying with a new ID"
                .into(),
        ));
    }
    let document = DrawerArtifactDocument {
        id: request.id,
        note_id: Some(note.id),
        workspace_id: None,
        session_id: None,
        name: bundle.artifact.name.clone(),
        path,
        version: version.clone(),
        files: snapshots,
    };
    let record = StoredArtifact {
        id: request.id,
        note_id: Some(note.id),
        workspace_id: None,
        session_id: None,
        owner_id: owner,
        host_id: host,
        channel_id: format!("drawer_{}", request.id.simple()),
        document: serde_json::to_string(&document).map_err(bad)?,
        channel_config: config,
        version,
        binding_version: String::new(),
        revision: 1,
        archived: false,
        deleted: false,
        attached: false,
    };
    client.ensure_account().await?;
    stored::insert(&deployment.db().pool, &record)
        .await
        .map_err(bad)?;
    let result = async {
        let binding_config = json!({"id":record.channel_id, "scope":record.scope(deployment.user_id()), "sensitive":false, "enabled":true,
            "data_schema":request.config.data_schema, "publishers":request.config.publishers, "actions":{}});
        let _: serde_json::Value = super::automation::artifact_channel(&record.channel_id, "configure", binding_config).await?;
        let binding: ArtifactAutomationBinding = super::automation::artifact_channel(&record.channel_id, "describe", json!({"scope":record.scope(deployment.user_id())})).await?;
        sqlx::query("UPDATE drawer_artifacts SET binding_version = ? WHERE id = ?")
            .bind(&binding.version).bind(record.id).execute(&deployment.db().pool).await?;
        let attached = client.attach_drawer_artifact(note.id, record.id, host).await?;
        client.ensure_account().await?;
        let confirmed = stored::reconcile(&deployment.db().pool, record.id, Some(&attached.data)).await.map_err(bad)?;
        if confirmed.deleted { return Err(bad("Dashboard link is not a standalone artifact line; close Markdown fences before registering")); }
        Ok::<_, ApiError>(())
    }.await;
    if let Err(error) = result {
        // Cloud attachment may have committed before a response was lost.
        let current = client.drawer_note(note.id).await;
        client.ensure_account().await?;
        // A failed reread stays pending for durable reconciliation.
        if let Ok(current) = current {
            let recovered = stored::reconcile(&deployment.db().pool, record.id, current.as_ref())
                .await
                .map_err(bad)?;
            if recovered.attached && !recovered.deleted {
                client.ensure_account().await?;
                return Ok(Json(ApiResponse::success(registration(&recovered))));
            }
        }
        return Err(error);
    }
    client.ensure_account().await?;
    Ok(Json(ApiResponse::success(registration(&record))))
}

async fn snapshot_files(
    process: &ExecutionProcess,
    bundle: &executors::logs::artifacts::ArtifactBundle,
) -> Result<(String, Vec<DrawerArtifactFile>), ApiError> {
    if bundle.artifact.mime != "text/html"
        || bundle.artifact.status != executors::logs::artifacts::ArtifactStatus::Ready
    {
        return Err(bad("Artifact transfers require ready read-only HTML"));
    }
    let path = bundle
        .base_path
        .clone()
        .or_else(|| bundle.artifact.path.clone())
        .unwrap_or_else(|| bundle.artifact.name.clone());
    let root_hash = bundle
        .artifact
        .content_hash
        .clone()
        .ok_or_else(|| bad("Artifact snapshot is not ready"))?;
    let files = std::iter::once((path.clone(), bundle.artifact.mime.clone(), root_hash)).chain(
        bundle.resources.iter().map(|resource| {
            (
                resource.path.clone(),
                resource.mime.clone(),
                resource.content_hash.clone(),
            )
        }),
    );
    let mut snapshots = Vec::new();
    let mut size = 0;
    for (path, mime, hash) in files {
        if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(bad("Invalid snapshot hash"));
        }
        let file = artifacts::directory(process.session_id, process.id).join(hash);
        if tokio::fs::metadata(&file).await?.len() > stored::MAX_DOCUMENT_BYTES as u64 {
            return Err(bad("Snapshot is too large"));
        }
        let bytes = tokio::fs::read(file).await?;
        size += bytes.len();
        if size > stored::MAX_DOCUMENT_BYTES {
            return Err(bad("Snapshot is too large"));
        }
        snapshots.push(DrawerArtifactFile { path, mime, bytes });
    }
    if snapshots.first().is_none_or(|file| {
        file.bytes.len() > 2 * 1024 * 1024 || std::str::from_utf8(&file.bytes).is_err()
    }) {
        return Err(bad("HTML must be UTF-8 and at most 2 MiB"));
    }
    Ok((path, snapshots))
}

fn registration(record: &StoredArtifact) -> serde_json::Value {
    json!({"id":record.id, "note_id":record.note_id, "owner":record.artifact_owner().ok(), "version":record.version,
        "channel_id":record.channel_id, "attachment":format!("[Dashboard]({} \"vibe-artifact\")", record.link())})
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MoveDrawerArtifact {
    note_id: Uuid,
    target_note_id: Uuid,
    version: String,
}

async fn move_artifact(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<MoveDrawerArtifact>,
) -> Result<Json<ApiResponse<serde_json::Value>>, ApiError> {
    transfer_checked(
        deployment,
        id,
        headers,
        TransferArtifact {
            source: ArtifactOwner::Drawer {
                note_id: request.note_id,
            },
            target: ArtifactOwner::Drawer {
                note_id: request.target_note_id,
            },
            version: request.version,
            recovery_count: None,
        },
    )
    .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TransferArtifact {
    source: ArtifactOwner,
    target: ArtifactOwner,
    version: String,
    recovery_count: Option<usize>,
}

async fn transfer(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<TransferArtifact>,
) -> Result<Json<ApiResponse<serde_json::Value>>, ApiError> {
    transfer_checked(deployment, id, headers, request).await
}

async fn transfer_checked(
    deployment: DeploymentImpl,
    id: Uuid,
    headers: HeaderMap,
    request: TransferArtifact,
) -> Result<Json<ApiResponse<serde_json::Value>>, ApiError> {
    let (client, owner, host) = owner(&deployment).await?;
    write_access(&deployment, &headers).await?;
    let _guard = stored::LOCK.lock().await;
    let _lifecycle = services::services::artifact_interactions::LIFECYCLE_LOCK
        .lock()
        .await;
    let record = stored::load(&deployment.db().pool, id)
        .await
        .map_err(|_| ApiError::Forbidden("Artifact is unavailable".into()))?;
    if record.owner_id != owner || record.host_id != host {
        return Err(ApiError::Forbidden("Wrong artifact owner or host".into()));
    }
    if record.deleted || !record.attached {
        return Err(ApiError::Conflict("Artifact is no longer available".into()));
    }
    if let Some(pending) = stored::pending_move(&deployment.db().pool, id)
        .await
        .map_err(bad)?
    {
        if pending.source != request.source || pending.version != request.version {
            return Err(ApiError::Conflict(
                "Another artifact transfer is pending; retry the original request".into(),
            ));
        }
        if pending.target != request.target {
            if request.recovery_count != Some(pending.previous_targets.len()) {
                return Err(ApiError::Conflict("Read transfer status and provide its current recovery_count before changing the destination".into()));
            }
            stored::retarget_transfer(
                &deployment.db().pool,
                &client,
                &record,
                request.target,
                pending.previous_targets.len(),
            )
            .await
            .map_err(bad)?;
        }
    } else {
        if let Some(completed) = stored::completed_move(&deployment.db().pool, id)
            .await
            .map_err(bad)?
            && completed.source == request.source
            && completed.target == request.target
            && completed.version == request.version
            && record.artifact_owner().map_err(bad)? == request.target
        {
            client.ensure_account().await?;
            return Ok(Json(ApiResponse::success(registration(&record))));
        }
        if record.artifact_owner().map_err(bad)? != request.source
            || record.version != request.version
        {
            return Err(ApiError::Conflict(
                "Artifact changed; reload before transferring".into(),
            ));
        }
        let binding: ArtifactAutomationBinding = super::automation::artifact_channel(
            &record.channel_id,
            "describe",
            json!({"scope":record.scope(deployment.user_id())}),
        )
        .await?;
        if binding.version != record.binding_version {
            return Err(ApiError::Conflict(
                "Artifact channel changed; reconcile its binding before transferring".into(),
            ));
        }
        stored::prepare_transfer(
            &deployment.db().pool,
            &client,
            &record,
            request.target,
            deployment.user_id(),
            None,
        )
        .await
        .map_err(bad)?;
    }
    let record = stored::resume_move(&deployment.db().pool, &client, id).await.map_err(|error| {
        tracing::warn!(%error, "Artifact transfer pending");
        ApiError::Conflict("Artifact transfer is pending; recovery retries every 15 seconds. Retry the original request".into())
    })?;
    CHECKED.invalidate(&(id, owner)).await;
    client.ensure_account().await?;
    Ok(Json(ApiResponse::success(registration(&record))))
}

async fn write_access(deployment: &DeploymentImpl, headers: &HeaderMap) -> Result<(), ApiError> {
    if headers.contains_key(crate::middleware::agent_access::AGENT_HEADER)
        && !deployment.config().read().await.agent_access.write_issues
    {
        return Err(ApiError::Forbidden(
            "Artifact transfers also require agent_access.write_issues".into(),
        ));
    }
    Ok(())
}

async fn transfer_status(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
) -> Result<Json<ApiResponse<serde_json::Value>>, ApiError> {
    let (client, account, host) = owner(&deployment).await?;
    let _guard = stored::LOCK.lock().await;
    let record = stored::load(&deployment.db().pool, id)
        .await
        .map_err(|_| ApiError::Forbidden("Artifact is unavailable".into()))?;
    if record.owner_id != account || record.host_id != host {
        return Err(ApiError::Forbidden("Wrong artifact owner or host".into()));
    }
    if record.deleted {
        return Err(ApiError::Conflict("Artifact is no longer available".into()));
    }
    let pending = stored::pending_move(&deployment.db().pool, id)
        .await
        .map_err(bad)?;
    client.ensure_account().await?;
    Ok(Json(ApiResponse::success(json!({"id":id,
        "status": if pending.is_some() { "pending" } else { "ready" },
        "source":record.artifact_owner().map_err(bad)?, "version":record.version,
        "target":pending.as_ref().map(|pending| &pending.target),
        "recovery_count":pending.as_ref().map_or(0, |pending| pending.previous_targets.len())
    }))))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransferExecutionArtifact {
    pub id: Uuid,
    pub artifact_id: String,
    pub automation_channel: String,
    pub version: String,
    pub target: ArtifactOwner,
    pub sensitive: bool,
    pub recovery_count: Option<usize>,
}

pub async fn transfer_info(
    Extension(process): Extension<ExecutionProcess>,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<ArtifactQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, ApiError> {
    let (client, account, _) = owner(&deployment).await?;
    let manifest = scoped_manifest(&deployment, &process, &query)
        .await?
        .ok_or_else(|| bad("Source snapshot unavailable"))?;
    let id = query
        .id
        .as_ref()
        .ok_or_else(|| bad("Source artifact ID required"))?;
    if stored::source_transferred(&deployment.db().pool, process.id, id)
        .await
        .map_err(bad)?
    {
        return Err(ApiError::Conflict(
            "Source artifact was already transferred".into(),
        ));
    }
    let bundle = manifest
        .bundles
        .get(id)
        .ok_or_else(|| bad("Unknown artifact"))?;
    let version = services::services::artifact_interactions::bundle_version(bundle).map_err(bad)?;
    let receipts = services::services::artifact_interactions::list(process.session_id, process.id)
        .await
        .map_err(bad)?;
    let channels: std::collections::BTreeSet<_> = receipts
        .into_iter()
        .filter(|receipt| {
            receipt.interaction.artifact_id == *id
                && receipt.interaction.version == version
                && receipt.interaction.owner_id == account.to_string()
                && receipt.interaction.owner_host == deployment.user_id()
        })
        .filter_map(|receipt| {
            receipt
                .interaction
                .automation
                .map(|binding| binding.channel_id)
        })
        .collect();
    client.ensure_account().await?;
    Ok(Json(ApiResponse::success(
        json!({"artifact_id":id,"version":version,"channels":channels}),
    )))
}

pub async fn transfer_execution(
    Extension(process): Extension<ExecutionProcess>,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<ArtifactQuery>,
    headers: HeaderMap,
    Json(request): Json<TransferExecutionArtifact>,
) -> Result<Json<ApiResponse<serde_json::Value>>, ApiError> {
    let (client, owner, host) = owner(&deployment).await?;
    write_access(&deployment, &headers).await?;
    if request.sensitive || process.dropped {
        return Err(bad("Only non-sensitive active artifacts may transfer"));
    }
    let source = ArtifactOwner::Workspace {
        workspace_id: query.workspace_id,
        session_id: query.session_id,
    };
    let _guard = stored::LOCK.lock().await;
    let _lifecycle = services::services::artifact_interactions::LIFECYCLE_LOCK
        .lock()
        .await;
    let manifest = scoped_manifest(&deployment, &process, &query)
        .await?
        .ok_or_else(|| bad("Artifact snapshot is unavailable"))?;
    if stored::source_transferred(&deployment.db().pool, process.id, &request.artifact_id)
        .await
        .map_err(bad)?
    {
        let mapped: Uuid = sqlx::query_scalar("SELECT artifact_id FROM artifact_transfer_sources WHERE execution_id = ? AND source_artifact_id = ?")
            .bind(process.id).bind(&request.artifact_id).fetch_one(&deployment.db().pool).await?;
        if mapped != request.id {
            return Err(ApiError::Conflict(
                "Source already transferred with another ID".into(),
            ));
        }
        drop(_lifecycle);
        drop(_guard);
        return transfer_checked(
            deployment,
            request.id,
            headers,
            TransferArtifact {
                source,
                target: request.target,
                version: request.version,
                recovery_count: request.recovery_count,
            },
        )
        .await;
    }
    let bundle = manifest
        .bundles
        .get(&request.artifact_id)
        .ok_or_else(|| bad("Unknown source artifact"))?;
    if services::services::artifact_interactions::bundle_version(bundle).map_err(bad)?
        != request.version
    {
        return Err(ApiError::Conflict(
            "Source artifact changed; reload before transferring".into(),
        ));
    }
    let receipts = services::services::artifact_interactions::list(process.session_id, process.id)
        .await
        .map_err(bad)?;
    let receipt = receipts
        .iter()
        .find(|receipt| {
            let input = &receipt.interaction;
            input.artifact_id == request.artifact_id
                && input.version == request.version
                && input.delivery
                    == services::services::artifact_interactions::ArtifactDelivery::Automation
                && input
                    .automation
                    .as_ref()
                    .is_some_and(|binding| binding.channel_id == request.automation_channel)
        })
        .ok_or_else(|| bad("Source must have a registered automation binding for this version"))?;
    receipt
        .check_scope(
            query.workspace_id,
            query.session_id,
            process.id,
            deployment.user_id(),
            &owner.to_string(),
        )
        .map_err(bad)?;
    if receipt.workspace_epoch
        != services::services::artifact_interactions::workspace_epoch(
            &deployment.db().pool,
            query.workspace_id,
        )
        .await
        .map_err(bad)?
    {
        return Err(ApiError::Conflict(
            "Source workspace lifecycle changed".into(),
        ));
    }
    let scope = json!({"owner_id":owner,"owner_host":deployment.user_id(),"workspace_id":query.workspace_id,"session_id":query.session_id});
    let inspected: serde_json::Value = super::automation::artifact_channel(
        &request.automation_channel,
        "inspect",
        json!({"scope":scope}),
    )
    .await?;
    let binding: ArtifactAutomationBinding =
        serde_json::from_value(inspected["binding"].clone()).map_err(bad)?;
    binding.check().map_err(bad)?;
    if inspected["transferable"] != true
        || binding.channel_id != request.automation_channel
        || receipt.interaction.automation.as_ref() != Some(&binding)
    {
        return Err(ApiError::Conflict(
            "Source binding changed or has actions or unfinished requests".into(),
        ));
    }
    services::services::artifact_interactions::ensure_exclusive_channel(
        &deployment.db().pool,
        &receipt.interaction,
    )
    .await
    .map_err(bad)?;
    let (path, files) = snapshot_files(&process, bundle).await?;
    let document = DrawerArtifactDocument {
        id: request.id,
        note_id: None,
        workspace_id: Some(query.workspace_id),
        session_id: Some(query.session_id),
        name: bundle.artifact.name.clone(),
        path,
        version: request.version.clone(),
        files,
    };
    let record = StoredArtifact {
        id: request.id,
        note_id: None,
        workspace_id: Some(query.workspace_id),
        session_id: Some(query.session_id),
        owner_id: owner,
        host_id: host,
        channel_id: request.automation_channel,
        document: serde_json::to_string(&document).map_err(bad)?,
        channel_config:
            json!({"data_schema":binding.data_schema,"publishers":inspected["publishers"]})
                .to_string(),
        binding_version: binding.version,
        version: request.version,
        revision: 1,
        archived: false,
        deleted: false,
        attached: true,
    };
    stored::validate_owner(&deployment.db().pool, &client, &record, &source)
        .await
        .map_err(bad)?;
    stored::validate_destination(&deployment.db().pool, &client, &record, &request.target)
        .await
        .map_err(bad)?;
    if source == request.target {
        return Err(bad("Choose another artifact owner"));
    }
    client.ensure_account().await?;
    stored::import_source(
        &deployment.db().pool,
        &record,
        process.id,
        &request.artifact_id,
        request.target,
        scope,
        deployment.user_id(),
    )
    .await
    .map_err(bad)?;
    let record = stored::resume_move(&deployment.db().pool, &client, record.id)
        .await
        .map_err(|error| {
            tracing::warn!(%error, "Artifact transfer pending");
            ApiError::Conflict(
                "Artifact transfer is pending; retry the same request or allow automatic recovery"
                    .into(),
            )
        })?;
    client.ensure_account().await?;
    Ok(Json(ApiResponse::success(registration(&record))))
}

#[derive(Serialize, ts_rs::TS)]
pub struct ArtifactSummary {
    pub id: Uuid,
    pub name: String,
    pub version: String,
    pub owner: ArtifactOwner,
}

async fn workspace_list(
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<NoteQuery>,
) -> Result<Json<ApiResponse<Vec<ArtifactSummary>>>, ApiError> {
    let (client, owner, host) = owner(&deployment).await?;
    let location = query.artifact_owner().map_err(bad)?;
    let ArtifactOwner::Workspace {
        workspace_id,
        session_id,
    } = location
    else {
        return Err(bad("Workspace session required"));
    };
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ? AND workspace_id = ?)",
    )
    .bind(session_id)
    .bind(workspace_id)
    .fetch_one(&deployment.db().pool)
    .await?;
    if !exists {
        return Err(ApiError::Forbidden(
            "Workspace session is unavailable".into(),
        ));
    }
    let rows: Vec<(Uuid, String, String)> = sqlx::query_as("SELECT a.id, json_extract(a.document, '$.name'), a.version FROM drawer_artifacts a WHERE a.owner_id = ? AND a.host_id = ? AND a.workspace_id = ? AND a.session_id = ? AND a.deleted = 0 AND a.attached = 1 AND NOT EXISTS(SELECT 1 FROM drawer_artifact_moves m WHERE m.artifact_id = a.id AND m.completed = 0) ORDER BY a.id")
        .bind(owner).bind(host).bind(workspace_id).bind(session_id).fetch_all(&deployment.db().pool).await?;
    let items = rows
        .into_iter()
        .map(|(id, name, version)| ArtifactSummary {
            id,
            name,
            version,
            owner: ArtifactOwner::Workspace {
                workspace_id,
                session_id,
            },
        })
        .collect();
    client.ensure_account().await?;
    Ok(Json(ApiResponse::success(items)))
}

/// Dashboards poll every 2 s; a cloud check covers them for this long and the
/// 15 s sync still reconciles, so open viewers add no cloud reads.
static CHECKED: LazyLock<Cache<(Uuid, Uuid), ()>> = LazyLock::new(|| {
    Cache::builder()
        .max_capacity(1024)
        .time_to_live(Duration::from_secs(15))
        .build()
});

async fn recently_checked(
    deployment: &DeploymentImpl,
    id: Uuid,
    artifact_owner: &ArtifactOwner,
) -> Option<(RemoteClient, StoredArtifact)> {
    if deployment::host_cloud_session_denied() {
        return None;
    }
    let client = deployment.remote_client().ok()?;
    let owner = client.notification_account().await?;
    if !CHECKED.contains_key(&(id, owner)) {
        return None;
    }
    let record = stored::load(&deployment.db().pool, id).await.ok()?;
    if stored::pending_move(&deployment.db().pool, id)
        .await
        .ok()?
        .is_some()
    {
        return None;
    }
    (record.owner_id == owner
        && record.artifact_owner().ok().as_ref() == Some(artifact_owner)
        && record.attached
        && !record.deleted)
        .then(|| (client.for_account(owner), record))
}

async fn checked(
    deployment: &DeploymentImpl,
    id: Uuid,
    artifact_owner: &ArtifactOwner,
) -> Result<(RemoteClient, StoredArtifact), ApiError> {
    if let Some(found) = recently_checked(deployment, id, artifact_owner).await {
        return Ok(found);
    }
    let (client, owner, host) = owner(deployment).await?;
    let _guard = stored::LOCK.lock().await;
    let record = stored::load(&deployment.db().pool, id)
        .await
        .map_err(|_| ApiError::Forbidden("Drawer artifact is unavailable".into()))?;
    if record.owner_id != owner || record.host_id != host {
        return Err(ApiError::Forbidden(
            "Wrong Drawer artifact owner, note or host".into(),
        ));
    }
    let current_owner = record.artifact_owner().map_err(bad)?;
    if let Some(pending) = stored::pending_move(&deployment.db().pool, id)
        .await
        .map_err(bad)?
        && (current_owner == *artifact_owner || pending.target == *artifact_owner)
    {
        return Err(ApiError::Conflict("Drawer artifact move is pending".into()));
    }
    if current_owner != *artifact_owner {
        return Err(ApiError::Forbidden(
            "Wrong Drawer artifact owner, note or host".into(),
        ));
    }
    let note = if let Some(note_id) = record.note_id {
        client.drawer_note(note_id).await?
    } else {
        None
    };
    client.ensure_account().await?;
    let record = stored::reconcile(&deployment.db().pool, id, note.as_ref())
        .await
        .map_err(bad)?;
    if record.deleted || !record.attached {
        return Err(ApiError::Conflict(
            "Drawer artifact is no longer available".into(),
        ));
    }
    CHECKED.insert((id, owner), ()).await;
    Ok((client, record))
}

async fn document(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
    Query(query): Query<NoteQuery>,
) -> Result<Json<ApiResponse<DrawerArtifactDocument>>, ApiError> {
    let (client, record) = checked(&deployment, id, &query.artifact_owner().map_err(bad)?).await?;
    let document = serde_json::from_str(&record.document).map_err(bad)?;
    client.ensure_account().await?;
    Ok(Json(ApiResponse::success(document)))
}

async fn snapshot(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
    Query(query): Query<VersionQuery>,
) -> Result<Json<ApiResponse<ArtifactAutomationSnapshot>>, ApiError> {
    let (client, record) =
        checked(&deployment, id, &query.owner.artifact_owner().map_err(bad)?).await?;
    if record.version != query.version {
        return Err(ApiError::Conflict("Drawer artifact version changed".into()));
    }
    if record.archived {
        return Err(ApiError::Conflict("Drawer dashboard is archived".into()));
    }
    let pending = format!("drawer_artifact:{}:{}", record.id, record.revision);
    let queued: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM automation_event_outbox WHERE id = ?)")
            .bind(&pending)
            .fetch_one(&deployment.db().pool)
            .await?;
    if queued {
        client.ensure_account().await?;
        let _: serde_json::Value = super::automation::artifact_channel(&record.channel_id, "lifecycle", json!({
            "type":"drawer_artifact_lifecycle", "hostId":deployment.user_id(), "artifactId":record.id,
            "revision":record.revision, "paused":false, "deleted":false
        })).await?;
        sqlx::query("DELETE FROM automation_event_outbox WHERE id = ?")
            .bind(pending)
            .execute(&deployment.db().pool)
            .await?;
    }
    let value: ArtifactAutomationSnapshot = super::automation::artifact_channel(&record.channel_id, "snapshot",
        json!({"scope":record.scope(deployment.user_id()), "version":record.binding_version, "binding_id":record.id})).await?;
    client.ensure_account().await?;
    Ok(Json(ApiResponse::success(value)))
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/drawer-artifacts/{id}", get(document))
        .route("/drawer-artifacts/{id}/snapshot", get(snapshot))
        .route("/drawer-artifacts/{id}/move", post(move_artifact))
        .route("/artifacts/{id}", get(document))
        .route("/artifacts/{id}/snapshot", get(snapshot))
        .route(
            "/artifacts/{id}/transfer",
            get(transfer_status).post(transfer),
        )
        .route("/artifacts", get(workspace_list))
}
