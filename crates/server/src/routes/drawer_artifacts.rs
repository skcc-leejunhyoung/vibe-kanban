use axum::{
    Extension, Json, Router,
    extract::{Path, Query, State},
    http::HeaderMap,
    routing::get,
};
use db::models::execution_process::ExecutionProcess;
use deployment::Deployment;
use serde::{Deserialize, Serialize};
use serde_json::json;
use services::services::{
    artifact_interactions::{
        ArtifactAutomationBinding, ArtifactAutomationSnapshot, ArtifactInputSchema,
    },
    artifacts,
    drawer_artifacts::{
        self as stored, DrawerArtifactDocument, DrawerArtifactFile, StoredArtifact,
    },
    remote_client::RemoteClient,
};
use sha2::{Digest, Sha256};
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
    pub note_id: Uuid,
}
#[derive(Deserialize)]
pub struct NoteQuery {
    pub note_id: Uuid,
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
    let config = serde_json::to_string(&request.config).map_err(bad)?;
    let version = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(request.note_id, &snapshots, &config)).map_err(bad)?)
    );
    if let Ok(existing) = stored::load(&deployment.db().pool, request.id).await {
        if existing.owner_id != owner
            || existing.host_id != host
            || existing.note_id != note.id
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
                    "Drawer dashboard link was removed; register with a new ID".into(),
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
        note_id: note.id,
        name: bundle.artifact.name.clone(),
        path,
        version: version.clone(),
        files: snapshots,
    };
    let record = StoredArtifact {
        id: request.id,
        note_id: note.id,
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

fn registration(record: &StoredArtifact) -> serde_json::Value {
    json!({"id":record.id, "note_id":record.note_id, "version":record.version,
        "channel_id":record.channel_id, "attachment":format!("[Dashboard]({} \"vibe-artifact\")", record.link())})
}

async fn checked(
    deployment: &DeploymentImpl,
    id: Uuid,
    note_id: Uuid,
) -> Result<(RemoteClient, StoredArtifact), ApiError> {
    let (client, owner, host) = owner(deployment).await?;
    let _guard = stored::LOCK.lock().await;
    let record = stored::load(&deployment.db().pool, id)
        .await
        .map_err(|_| ApiError::Forbidden("Drawer artifact is unavailable".into()))?;
    if record.owner_id != owner || record.host_id != host || record.note_id != note_id {
        return Err(ApiError::Forbidden(
            "Wrong Drawer artifact owner, note or host".into(),
        ));
    }
    let note = client.drawer_note(record.note_id).await?;
    client.ensure_account().await?;
    let record = stored::reconcile(&deployment.db().pool, id, note.as_ref())
        .await
        .map_err(bad)?;
    if record.deleted || !record.attached {
        return Err(ApiError::Conflict(
            "Drawer artifact is no longer available".into(),
        ));
    }
    Ok((client, record))
}

async fn document(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
    Query(query): Query<NoteQuery>,
) -> Result<Json<ApiResponse<DrawerArtifactDocument>>, ApiError> {
    let (client, record) = checked(&deployment, id, query.note_id).await?;
    let document = serde_json::from_str(&record.document).map_err(bad)?;
    client.ensure_account().await?;
    Ok(Json(ApiResponse::success(document)))
}

async fn snapshot(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
    Query(query): Query<VersionQuery>,
) -> Result<Json<ApiResponse<ArtifactAutomationSnapshot>>, ApiError> {
    let (client, record) = checked(&deployment, id, query.note_id).await?;
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
}
