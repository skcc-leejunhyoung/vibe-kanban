use anyhow::{Result, bail};
use api_types::DrawerNote;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, SqlitePool};
use ts_rs::TS;
use uuid::Uuid;

use super::remote_client::RemoteClient;

pub static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
pub const MAX_DOCUMENT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ArtifactOwner {
    Drawer {
        note_id: Uuid,
    },
    Workspace {
        workspace_id: Uuid,
        session_id: Uuid,
    },
}

impl ArtifactOwner {
    pub fn scope(&self, id: Uuid, owner: Uuid, host: &str) -> Value {
        match self {
            Self::Drawer { note_id } => json!({"kind":"drawer", "owner_id":owner,
                "owner_host":host, "artifact_id":id, "note_id":note_id}),
            Self::Workspace {
                workspace_id,
                session_id,
            } => json!({"kind":"workspace_artifact",
                "owner_id":owner, "owner_host":host, "artifact_id":id,
                "workspace_id":workspace_id, "session_id":session_id}),
        }
    }

    fn columns(&self) -> (Option<Uuid>, Option<Uuid>, Option<Uuid>) {
        match self {
            Self::Drawer { note_id } => (Some(*note_id), None, None),
            Self::Workspace {
                workspace_id,
                session_id,
            } => (None, Some(*workspace_id), Some(*session_id)),
        }
    }

    fn href(&self, host: Uuid) -> String {
        match self {
            Self::Drawer { note_id } => format!("/drawer?note={note_id}"),
            Self::Workspace { workspace_id, .. } => {
                format!("/hosts/{host}/workspaces/{workspace_id}")
            }
        }
    }

    fn forward_href(&self, host: Uuid, artifact: Uuid) -> String {
        let href = self.href(host);
        format!(
            "{href}{}artifact={artifact}",
            if href.contains('?') { "&" } else { "?" }
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct DrawerArtifactFile {
    pub path: String,
    pub mime: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct DrawerArtifactDocument {
    pub id: Uuid,
    pub note_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workspace_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_id: Option<Uuid>,
    pub name: String,
    pub path: String,
    pub version: String,
    pub files: Vec<DrawerArtifactFile>,
}

#[derive(Debug, Clone, FromRow)]
pub struct StoredArtifact {
    pub id: Uuid,
    pub note_id: Option<Uuid>,
    pub workspace_id: Option<Uuid>,
    pub session_id: Option<Uuid>,
    pub owner_id: Uuid,
    pub host_id: Uuid,
    pub channel_id: String,
    pub document: String,
    pub channel_config: String,
    pub binding_version: String,
    pub version: String,
    pub revision: i64,
    pub archived: bool,
    pub deleted: bool,
    pub attached: bool,
}

impl StoredArtifact {
    pub fn artifact_owner(&self) -> Result<ArtifactOwner> {
        match (self.note_id, self.workspace_id, self.session_id) {
            (Some(note_id), None, None) => Ok(ArtifactOwner::Drawer { note_id }),
            (None, Some(workspace_id), Some(session_id)) => Ok(ArtifactOwner::Workspace {
                workspace_id,
                session_id,
            }),
            _ => bail!("Invalid artifact ownership"),
        }
    }

    pub fn scope(&self, host: &str) -> Value {
        self.artifact_owner()
            .expect("validated artifact owner")
            .scope(self.id, self.owner_id, host)
    }

    pub fn link(&self) -> String {
        format!("drawer-artifacts/{}", self.id)
    }
}

/// A note's own dashboard line, which never resolves to a workspace file.
pub fn is_link(raw: &str) -> bool {
    raw.get(..17)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("drawer-artifacts/"))
        && raw
            .get(17..)
            .is_some_and(|id| id.len() == 36 && Uuid::try_parse(id).is_ok())
}

pub async fn load(pool: &SqlitePool, id: Uuid) -> Result<StoredArtifact> {
    Ok(
        sqlx::query_as("SELECT * FROM drawer_artifacts WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await?,
    )
}

pub async fn insert(pool: &SqlitePool, record: &StoredArtifact) -> Result<()> {
    let mut connection = pool.acquire().await?;
    insert_on(&mut connection, record).await
}

async fn insert_on(connection: &mut sqlx::SqliteConnection, record: &StoredArtifact) -> Result<()> {
    if record.document.len() > MAX_DOCUMENT_BYTES {
        bail!("Drawer artifact exceeds 8 MiB snapshot limit");
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM drawer_artifacts WHERE deleted = 0")
        .fetch_one(&mut *connection)
        .await?;
    if count >= 128 {
        bail!("Too many Drawer artifacts");
    }
    record.artifact_owner()?;
    sqlx::query("INSERT INTO drawer_artifacts (id, note_id, workspace_id, session_id, owner_id, host_id, channel_id, document, channel_config, version, binding_version, attached) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(record.id).bind(record.note_id).bind(record.workspace_id).bind(record.session_id).bind(record.owner_id).bind(record.host_id)
        .bind(&record.channel_id).bind(&record.document).bind(&record.channel_config).bind(&record.version).bind(&record.binding_version)
        .bind(record.attached)
        .execute(&mut *connection).await?;
    Ok(())
}

pub fn document_version(note: Uuid, files: &[DrawerArtifactFile], config: &str) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(note, files, config))?)
    ))
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PendingMove {
    operation_id: Uuid,
    pub source: ArtifactOwner,
    pub target: ArtifactOwner,
    pub version: String,
    owner_host: String,
    #[serde(default)]
    source_scope: Option<Value>,
    #[serde(default)]
    pub previous_targets: Vec<ArtifactOwner>,
}

pub async fn pending_move(pool: &SqlitePool, id: Uuid) -> Result<Option<PendingMove>> {
    let payload: Option<String> = sqlx::query_scalar(
        "SELECT payload FROM drawer_artifact_moves WHERE artifact_id = ? AND completed = 0",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    payload
        .map(|payload| serde_json::from_str(&payload).map_err(Into::into))
        .transpose()
}

pub async fn completed_move(pool: &SqlitePool, id: Uuid) -> Result<Option<PendingMove>> {
    let payload: Option<String> = sqlx::query_scalar(
        "SELECT payload FROM drawer_artifact_moves WHERE artifact_id = ? AND completed = 1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    payload
        .map(|payload| serde_json::from_str(&payload).map_err(Into::into))
        .transpose()
}

pub fn linked(body: &str, id: Uuid) -> bool {
    executors::logs::artifacts::markdown_candidates(body)
        .iter()
        .any(|candidate| {
            matches!(candidate, executors::logs::artifacts::ArtifactCandidate::File(path)
            if path.eq_ignore_ascii_case(&format!("drawer-artifacts/{id}")))
        })
}

fn active_note(record: &StoredArtifact, note: &DrawerNote) -> Result<()> {
    if note.owner_user_id != record.owner_id
        || note.host_id != Some(record.host_id)
        || note.archived_at.is_some()
    {
        bail!("An active Drawer note owned by the same user on this host is required");
    }
    Ok(())
}

/// Replace only real standalone attachment lines, retaining quoted examples.
fn move_links_to(body: &str, id: Uuid, href: &str) -> Result<(String, String)> {
    let mut result = String::new();
    let mut attachment = None;
    let mut offset = 0;
    for line in body.split_inclusive('\n') {
        let end = offset + line.len();
        if linked(line, id)
            && executors::logs::artifacts::markdown_candidates(&body[..end]).len()
                > executors::logs::artifacts::markdown_candidates(&body[..offset]).len()
        {
            attachment.get_or_insert_with(|| line.trim().to_string());
            result.push_str(&format!("[Dashboard]({href})"));
            if line.ends_with('\n') {
                result.push('\n');
            }
        } else {
            result.push_str(line);
        }
        offset = end;
    }
    Ok((
        result,
        attachment
            .ok_or_else(|| anyhow::anyhow!("Source note has no standalone dashboard link"))?,
    ))
}

fn move_links(body: &str, id: Uuid, target: Uuid) -> Result<(String, String)> {
    move_links_to(
        body,
        id,
        &ArtifactOwner::Drawer { note_id: target }.forward_href(Uuid::nil(), id),
    )
}

fn redirect_forward_links(
    body: &str,
    id: Uuid,
    previous: &[ArtifactOwner],
    target: &ArtifactOwner,
    host: Uuid,
) -> String {
    let old: Vec<_> = previous
        .iter()
        .map(|owner| format!("[Dashboard]({})", owner.forward_href(host, id)))
        .collect();
    let mut output = String::new();
    let mut offset = 0;
    for line in body.split_inclusive('\n') {
        if old
            .iter()
            .any(|old| old == line.trim_end_matches(['\r', '\n']))
        {
            // Probe with an attachment so the existing parser excludes code fences and quotes.
            let probe = format!(
                "{}[Dashboard](drawer-artifacts/{id} \"vibe-artifact\")\n",
                &body[..offset]
            );
            if linked(&probe, id) && !linked(&body[..offset], id) {
                output.push_str(&format!(
                    "[Dashboard]({}){}",
                    target.forward_href(host, id),
                    if line.ends_with('\n') { "\n" } else { "" }
                ));
                offset += line.len();
                continue;
            }
        }
        output.push_str(line);
        offset += line.len();
    }
    output
}

fn link_changes(
    record: &StoredArtifact,
    source: &DrawerNote,
    target: &DrawerNote,
) -> Result<Value> {
    let (source_body, attachment) = move_links(&source.body, record.id, target.id)?;
    let target_body = if linked(&target.body, record.id) {
        target.body.clone()
    } else {
        format!("{}\n\n{attachment}", target.body)
    };
    if source_body.len() > 64 * 1024
        || target_body.len() > 64 * 1024
        || !linked(&target_body, record.id)
    {
        bail!("Target must accept a standalone dashboard link within 64 KiB");
    }
    Ok(json!({"host_id":record.host_id,"target_note_id":target.id,
        "source_body":source.body,"target_body":target.body,
        "source_body_after":source_body,"target_body_after":target_body}))
}

fn moved_document(
    record: &StoredArtifact,
    target: &ArtifactOwner,
) -> Result<DrawerArtifactDocument> {
    let mut document: DrawerArtifactDocument = serde_json::from_str(&record.document)?;
    if document.id != record.id
        || document.note_id != record.note_id
        || document.workspace_id != record.workspace_id
        || document.session_id != record.session_id
        || document.version != record.version
    {
        bail!("Drawer document metadata does not match its binding");
    }
    (document.note_id, document.workspace_id, document.session_id) = target.columns();
    // Include the previous version so moving back cannot revive a stale request.
    document.version = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(
            &record.version,
            target,
            &document.files,
            &record.channel_config,
        ))?)
    );
    Ok(document)
}

/// Caller holds LOCK. The journal fences reconciliation until all stores agree.
pub async fn prepare_move(
    pool: &SqlitePool,
    record: &StoredArtifact,
    source: &DrawerNote,
    target: &DrawerNote,
    owner_host: &str,
) -> Result<()> {
    active_note(record, source)?;
    active_note(record, target)?;
    if Some(source.id) != record.note_id
        || source.id == target.id
        || record.deleted
        || !record.attached
        || record.archived
    {
        bail!("Only an attached, active dashboard can move to another note");
    }
    let target_owner = ArtifactOwner::Drawer { note_id: target.id };
    moved_document(record, &target_owner)?;
    link_changes(record, source, target)?;
    let pending = PendingMove {
        operation_id: Uuid::new_v4(),
        source: record.artifact_owner()?,
        target: target_owner,
        version: record.version.clone(),
        owner_host: owner_host.into(),
        source_scope: None,
        previous_targets: Vec::new(),
    };
    let inserted = sqlx::query("INSERT INTO drawer_artifact_moves (artifact_id, payload) VALUES (?, ?) ON CONFLICT(artifact_id) DO UPDATE SET payload = excluded.payload, completed = 0 WHERE completed = 1")
        .bind(record.id).bind(serde_json::to_string(&pending)?).execute(pool).await?;
    if inserted.rows_affected() != 1 {
        bail!("Another Drawer move is already pending");
    }
    Ok(())
}

pub async fn validate_owner(
    pool: &SqlitePool,
    client: &RemoteClient,
    record: &StoredArtifact,
    owner: &ArtifactOwner,
) -> Result<Option<DrawerNote>> {
    match owner {
        ArtifactOwner::Drawer { note_id } => {
            let note = client
                .drawer_note(*note_id)
                .await?
                .ok_or_else(|| anyhow::anyhow!("Drawer note is unavailable"))?;
            active_note(record, &note)?;
            Ok(Some(note))
        }
        ArtifactOwner::Workspace {
            workspace_id,
            session_id,
        } => {
            let active: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspaces w JOIN sessions s ON s.workspace_id = w.id WHERE w.id = ? AND s.id = ? AND w.archived = 0)")
                .bind(workspace_id).bind(session_id).fetch_one(pool).await?;
            if !active {
                bail!("An active workspace session on this host is required");
            }
            client.ensure_account().await?;
            Ok(None)
        }
    }
}

pub async fn prepare_transfer(
    pool: &SqlitePool,
    client: &RemoteClient,
    record: &StoredArtifact,
    target: ArtifactOwner,
    host: &str,
    source_scope: Option<Value>,
) -> Result<()> {
    let source = record.artifact_owner()?;
    if source == target || record.deleted || !record.attached || record.archived {
        bail!("Only an attached active artifact can transfer to another owner");
    }
    let source_note = validate_owner(pool, client, record, &source).await?;
    validate_destination(pool, client, record, &target).await?;
    if let Some(note) = source_note {
        move_links_to(
            &note.body,
            record.id,
            &target.forward_href(record.host_id, record.id),
        )?;
    }
    let pending = PendingMove {
        operation_id: Uuid::new_v4(),
        source,
        target,
        version: record.version.clone(),
        owner_host: host.into(),
        source_scope,
        previous_targets: Vec::new(),
    };
    client.ensure_account().await?;
    let saved = sqlx::query("INSERT INTO drawer_artifact_moves (artifact_id, payload) VALUES (?, ?) ON CONFLICT(artifact_id) DO UPDATE SET payload = excluded.payload, completed = 0 WHERE completed = 1")
        .bind(record.id).bind(serde_json::to_string(&pending)?).execute(pool).await?;
    if saved.rows_affected() != 1 {
        bail!("Another artifact transfer is pending");
    }
    Ok(())
}

pub async fn validate_destination(
    pool: &SqlitePool,
    client: &RemoteClient,
    record: &StoredArtifact,
    target: &ArtifactOwner,
) -> Result<Option<DrawerNote>> {
    moved_document(record, target)?;
    let note = validate_owner(pool, client, record, target).await?;
    if let Some(note) = &note {
        let body = if linked(&note.body, record.id) {
            note.body.clone()
        } else {
            format!(
                "{}\n\n[Dashboard]({} \"vibe-artifact\")",
                note.body,
                record.link()
            )
        };
        if body.len() > 64 * 1024 || !linked(&body, record.id) {
            bail!("Target note cannot accept the artifact");
        }
    }
    Ok(note)
}

/// Keep the operation identity when recovering an ambiguous worker response.
pub async fn retarget_transfer(
    pool: &SqlitePool,
    client: &RemoteClient,
    record: &StoredArtifact,
    target: ArtifactOwner,
    expected_count: usize,
) -> Result<()> {
    let mut pending = pending_move(pool, record.id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("No pending transfer"))?;
    if pending.source != record.artifact_owner()?
        || pending.version != record.version
        || record.deleted
    {
        bail!("Artifact transfer conflicts with the stored document");
    }
    if pending.previous_targets.len() != expected_count {
        bail!("Recovery destination changed; read transfer status before retrying");
    }
    if pending.target == target {
        return Ok(());
    }
    validate_destination(pool, client, record, &target).await?;
    pending.previous_targets.push(pending.target);
    pending.target = target;
    client.ensure_account().await?;
    let saved = sqlx::query(
        "UPDATE drawer_artifact_moves SET payload = ? WHERE artifact_id = ? AND completed = 0",
    )
    .bind(serde_json::to_string(&pending)?)
    .bind(record.id)
    .execute(pool)
    .await?;
    if saved.rows_affected() != 1 {
        bail!("Pending transfer changed");
    }
    Ok(())
}

pub async fn source_transferred(
    pool: &SqlitePool,
    execution: Uuid,
    artifact: &str,
) -> Result<bool> {
    Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM artifact_transfer_sources WHERE execution_id = ? AND source_artifact_id = ?)")
        .bind(execution).bind(artifact).fetch_one(pool).await?)
}

pub async fn import_source(
    pool: &SqlitePool,
    record: &StoredArtifact,
    execution: Uuid,
    artifact: &str,
    target: ArtifactOwner,
    source_scope: Value,
    host: &str,
) -> Result<()> {
    moved_document(record, &target)?;
    let pending = PendingMove {
        operation_id: Uuid::new_v4(),
        source: record.artifact_owner()?,
        target,
        version: record.version.clone(),
        owner_host: host.into(),
        source_scope: Some(source_scope),
        previous_targets: Vec::new(),
    };
    let mut tx = pool.begin().await?;
    insert_on(&mut tx, record).await?;
    sqlx::query("INSERT INTO artifact_transfer_sources (execution_id, source_artifact_id, artifact_id) VALUES (?, ?, ?)")
        .bind(execution).bind(artifact).bind(record.id).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO drawer_artifact_moves (artifact_id, payload) VALUES (?, ?)")
        .bind(record.id)
        .bind(serde_json::to_string(&pending)?)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn resume_move(
    pool: &SqlitePool,
    client: &RemoteClient,
    id: Uuid,
) -> Result<StoredArtifact> {
    let (url, token) = super::automation::endpoint()
        .ok_or_else(|| anyhow::anyhow!("Artifact automation unavailable; move remains pending"))?;
    resume_move_to(pool, client, id, &url, &token).await
}

async fn resume_move_to(
    pool: &SqlitePool,
    client: &RemoteClient,
    id: Uuid,
    url: &str,
    token: &str,
) -> Result<StoredArtifact> {
    let pending = pending_move(pool, id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("No pending artifact transfer"))?;
    let record = load(pool, id).await?;
    if record.artifact_owner()? != pending.source
        || record.version != pending.version
        || record.deleted
    {
        bail!("Artifact transfer conflicts with the stored document");
    }
    let document = moved_document(&record, &pending.target)?;
    // The journal authorized the source before cleanup; recovery only needs
    // the saved snapshot and a still-authorized destination.
    let source = if let ArtifactOwner::Drawer { note_id } = pending.source {
        client.drawer_note(note_id).await?.filter(|note| {
            note.owner_user_id == record.owner_id
                && note.host_id == Some(record.host_id)
                && note.archived_at.is_none()
        })
    } else {
        None
    };
    let target = validate_owner(pool, client, &record, &pending.target).await?;
    client.ensure_account().await?;
    match (&source, &target) {
        (Some(source), Some(target)) if source.id != target.id && linked(&source.body, id) => {
            client
                .move_drawer_artifact_links(source.id, &link_changes(&record, source, target)?)
                .await?;
        }
        (Some(source), None) if linked(&source.body, id) => {
            let (after, _) = move_links_to(
                &source.body,
                id,
                &pending.target.forward_href(record.host_id, id),
            )?;
            client
                .compare_drawer_artifact_body(source.id, record.host_id, &source.body, &after)
                .await?;
        }
        (_, Some(target)) if !linked(&target.body, id) => {
            let after = format!(
                "{}\n\n[Dashboard]({} \"vibe-artifact\")",
                target.body,
                record.link()
            );
            if after.len() > 64 * 1024 || !linked(&after, id) {
                bail!("Target note cannot accept the artifact");
            }
            client
                .compare_drawer_artifact_body(target.id, record.host_id, &target.body, &after)
                .await?;
        }
        _ => {}
    }
    if !pending.previous_targets.is_empty() {
        let mut stale = pending.previous_targets.clone();
        stale.push(pending.source.clone());
        let mut visited = std::collections::HashSet::new();
        for old in stale {
            let ArtifactOwner::Drawer { note_id } = old else {
                continue;
            };
            if old == pending.target || !visited.insert(note_id) {
                continue;
            }
            if let Some(note) = client.drawer_note(note_id).await?
                && note.owner_user_id == record.owner_id
                && note.host_id == Some(record.host_id)
                && note.archived_at.is_none()
            {
                let after = if linked(&note.body, id) {
                    move_links_to(
                        &note.body,
                        id,
                        &pending.target.forward_href(record.host_id, id),
                    )?
                    .0
                } else {
                    redirect_forward_links(
                        &note.body,
                        id,
                        &pending.previous_targets,
                        &pending.target,
                        record.host_id,
                    )
                };
                if after != note.body {
                    client
                        .compare_drawer_artifact_body(note.id, record.host_id, &note.body, &after)
                        .await?;
                }
            }
        }
    }
    client.ensure_account().await?;
    let source_scope = pending
        .source_scope
        .clone()
        .unwrap_or_else(|| record.scope(&pending.owner_host));
    let mut response = reqwest::Client::new()
        .post(format!("{}/api/artifact-channels/{}/transfer", url.trim_end_matches('/'), record.channel_id))
        .timeout(std::time::Duration::from_secs(20)).bearer_auth(token)
        .json(&json!({"operation_id":pending.operation_id,"scope":source_scope,
            "version":record.binding_version,"target_scope":pending.target.scope(id, record.owner_id, &pending.owner_host),
            "previous_targets":pending.previous_targets.iter().map(|owner| owner.scope(id, record.owner_id, &pending.owner_host)).collect::<Vec<_>>()}))
        .send().await?;
    if !response.status().is_success() {
        bail!(
            "Automation transfer returned {}; transfer remains pending",
            response.status()
        );
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if body.len() + chunk.len() > 128 * 1024 {
            bail!("Transferred binding is too large");
        }
        body.extend_from_slice(&chunk);
    }
    let binding: super::artifact_interactions::ArtifactAutomationBinding =
        serde_json::from_slice(&body)?;
    if binding.channel_id != record.channel_id || binding.version.is_empty() {
        bail!("Invalid transferred binding");
    }
    if let Some(target) = validate_owner(pool, client, &record, &pending.target).await?
        && !linked(&target.body, id)
    {
        bail!("Target artifact link changed; transfer remains pending");
    }
    client.ensure_account().await?;
    let mut tx = pool.begin().await?;
    let (note, workspace, session) = pending.target.columns();
    let updated = sqlx::query("UPDATE drawer_artifacts SET note_id = ?, workspace_id = ?, session_id = ?, document = ?, version = ?, binding_version = ?, revision = revision + 1, archived = 0 WHERE id = ? AND version = ? AND deleted = 0")
        .bind(note).bind(workspace).bind(session).bind(serde_json::to_string(&document)?).bind(&document.version)
        .bind(binding.version).bind(id).bind(&pending.version).execute(&mut *tx).await?;
    if updated.rows_affected() != 1 {
        bail!("Artifact changed during transfer");
    }
    let revision = record.revision + 1;
    sqlx::query("INSERT INTO automation_event_outbox (id, payload) VALUES (?, ?)")
        .bind(format!("drawer_artifact:{id}:{revision}"))
        .bind(json!({"type":"drawer_artifact_lifecycle","artifactId":id,"revision":revision,"paused":false,"deleted":false}).to_string())
        .execute(&mut *tx).await?;
    sqlx::query("UPDATE drawer_artifact_moves SET completed = 1 WHERE artifact_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    load(pool, id).await
}

/// Serialize with registration and put revocation and delivery in one transaction.
pub async fn reconcile(
    pool: &SqlitePool,
    id: Uuid,
    note: Option<&DrawerNote>,
) -> Result<StoredArtifact> {
    if pending_move(pool, id).await?.is_some() {
        bail!("Drawer artifact move is pending");
    }
    let mut tx = pool.begin().await?;
    let mut record: StoredArtifact = sqlx::query_as("SELECT * FROM drawer_artifacts WHERE id = ?")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    let workspace_state: Option<bool> = if let (Some(workspace), Some(session)) =
        (record.workspace_id, record.session_id)
    {
        sqlx::query_scalar("SELECT w.archived FROM workspaces w JOIN sessions s ON s.workspace_id = w.id WHERE w.id = ? AND s.id = ?")
            .bind(workspace).bind(session).fetch_optional(&mut *tx).await?
    } else {
        None
    };
    let linked = if record.workspace_id.is_some() {
        workspace_state.is_some()
    } else {
        note.is_some_and(|note| {
        Some(note.id) == record.note_id &&
        note.host_id == Some(record.host_id)
            && executors::logs::artifacts::markdown_candidates(&note.body).iter().any(|candidate|
                matches!(candidate, executors::logs::artifacts::ArtifactCandidate::File(path) if path.eq_ignore_ascii_case(&record.link())))
    })
    };
    // Only a gone note or owner change revokes an attached dashboard. A body
    // edit that drops the link, or an update from another host, pauses it so
    // restoring the line brings it back.
    let deleted = record.deleted
        || record.binding_version.is_empty()
        || if record.workspace_id.is_some() {
            workspace_state.is_none()
        } else {
            note.is_none_or(|note| note.owner_user_id != record.owner_id)
        }
        || (!record.attached && !linked);
    let archived = !linked
        || workspace_state == Some(true)
        || note.is_some_and(|note| note.archived_at.is_some());
    if !record.attached && !deleted {
        sqlx::query("UPDATE drawer_artifacts SET attached = 1 WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    if record.deleted != deleted || (!deleted && record.archived != archived) {
        record.revision += 1;
        record.archived = archived;
        record.deleted = deleted;
        sqlx::query("UPDATE drawer_artifacts SET revision = ?, archived = ?, deleted = ?, document = CASE WHEN ? THEN 'null' ELSE document END, channel_config = CASE WHEN ? THEN 'null' ELSE channel_config END WHERE id = ?")
            .bind(record.revision).bind(archived).bind(deleted).bind(deleted).bind(deleted).bind(id)
            .execute(&mut *tx).await?;
        let event = json!({"type":"drawer_artifact_lifecycle", "artifactId":id,
            "revision":record.revision, "paused":archived, "deleted":deleted});
        sqlx::query("INSERT INTO automation_event_outbox (id, payload) VALUES (?, ?)")
            .bind(format!("drawer_artifact:{id}:{}", record.revision))
            .bind(event.to_string())
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    load(pool, id).await
}

/// Only an authoritative, owner-scoped cloud list may declare a note deleted.
pub fn spawn(
    pool: SqlitePool,
    client: RemoteClient,
    shutdown: tokio_util::sync::CancellationToken,
) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(15));
        loop {
            tokio::select! {
                _ = shutdown.cancelled() => break,
                _ = interval.tick() => {
                    if let Err(error) = sync(&pool, &client).await {
                        tracing::debug!(%error, "Drawer artifact reconciliation deferred");
                    }
                }
            }
        }
    });
}

async fn sync(pool: &SqlitePool, client: &RemoteClient) -> Result<()> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM drawer_artifacts WHERE deleted = 0")
        .fetch_one(pool)
        .await?;
    if count == 0 {
        return Ok(());
    }
    let Some(owner) = client.notification_account().await else {
        return Ok(());
    };
    let client = client.for_account(owner);
    let host = client.current_host_id().await?;
    let _guard = LOCK.lock().await;
    let records: Vec<StoredArtifact> = sqlx::query_as(
        "SELECT * FROM drawer_artifacts WHERE deleted = 0 AND owner_id = ? AND host_id = ?",
    )
    .bind(owner)
    .bind(host)
    .fetch_all(pool)
    .await?;
    if records.is_empty() {
        return Ok(());
    }
    let notes = if records.iter().any(|record| record.note_id.is_some()) {
        client.list_drawer_notes().await?.drawer_notes
    } else {
        Vec::new()
    };
    for record in records {
        client.ensure_account().await?;
        if pending_move(pool, record.id).await?.is_some() {
            let _lifecycle = super::artifact_interactions::LIFECYCLE_LOCK.lock().await;
            if let Err(error) = resume_move(pool, &client, record.id).await {
                tracing::warn!(%error, "Drawer artifact move recovery deferred");
            }
            continue;
        }
        reconcile(
            pool,
            record.id,
            notes.iter().find(|note| Some(note.id) == record.note_id),
        )
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };

    use axum::{
        Json, Router,
        extract::OriginalUri,
        http::{HeaderMap, StatusCode},
        response::IntoResponse,
    };
    use chrono::{DateTime, Utc};
    use tokio::sync::RwLock;

    use super::*;
    use crate::services::{
        auth::AuthContext,
        oauth_credentials::{Credentials, OAuthCredentials},
    };

    // Synthetic JWTs: local claim decoding only, never real account credentials.
    const ACCOUNT_A: &str = "11111111-1111-4111-8111-111111111111";
    const TOKEN_A: &str = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJleHAiOjQxMDI0NDQ4MDB9.c3ludGhldGlj";
    const TOKEN_B: &str = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIyMjIyMjIyMi0yMjIyLTQyMjItODIyMi0yMjIyMjIyMjIyMjIiLCJleHAiOjQxMDI0NDQ4MDB9.c3ludGhldGlj";

    fn credentials(token: &str) -> Credentials {
        Credentials {
            access_token: Some(token.into()),
            refresh_token: token.into(),
            expires_at: Some(Utc::now() + chrono::Duration::hours(1)),
        }
    }

    #[derive(Clone, Copy)]
    enum Change {
        Account,
        Logout,
        Refresh,
        RoundTrip,
    }

    struct Cloud {
        client: RemoteClient,
        auth: AuthContext,
        calls: Arc<AtomicUsize>,
        server: tokio::task::JoinHandle<()>,
        _directory: tempfile::TempDir,
    }

    impl Drop for Cloud {
        fn drop(&mut self) {
            self.server.abort();
        }
    }

    impl Cloud {
        async fn new(
            record: &StoredArtifact,
            change_path: String,
            status: StatusCode,
            change: Change,
        ) -> Self {
            let directory = tempfile::tempdir().unwrap();
            let auth = AuthContext::new(
                Arc::new(OAuthCredentials::new(
                    directory.path().join("synthetic-auth.json"),
                )),
                Arc::new(RwLock::new(None)),
            );
            auth.save_credentials(&credentials(TOKEN_A)).await.unwrap();
            let saved = note(record);
            let hosts = json!({"hosts":[{"id":record.host_id,"owner_user_id":record.owner_id,"machine_id":"synthetic-machine","name":"Synthetic host","status":"online","created_at":"2030-01-01T00:00:00Z","updated_at":"2030-01-01T00:00:00Z","access_role":"owner","auth_mode":"account","auth_generation":1,"remote_access_enabled":true,"capabilities":[]}]});
            let handler_auth = auth.clone();
            let calls = Arc::new(AtomicUsize::new(0));
            let handler_calls = calls.clone();
            let changed = Arc::new(AtomicBool::new(false));
            let router =
                Router::new().fallback(move |OriginalUri(uri): OriginalUri, headers: HeaderMap| {
                    let (auth, calls, change_path, hosts, saved, changed) = (
                        handler_auth.clone(),
                        handler_calls.clone(),
                        change_path.clone(),
                        hosts.clone(),
                        saved.clone(),
                        changed.clone(),
                    );
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        if uri.path() == change_path && !changed.swap(true, Ordering::SeqCst) {
                            match change {
                                Change::Account => {
                                    auth.save_credentials(&credentials(TOKEN_B)).await.unwrap()
                                }
                                Change::Logout => auth.clear_credentials().await.unwrap(),
                                Change::Refresh => auth
                                    .save_credentials(&credentials(
                                        &TOKEN_A.replace("c3ludGhldGlj", "cm90YXRlZA"),
                                    ))
                                    .await
                                    .unwrap(),
                                Change::RoundTrip => {
                                    auth.save_credentials(&credentials(TOKEN_B)).await.unwrap();
                                    auth.save_credentials(&credentials(TOKEN_A)).await.unwrap();
                                }
                            }
                        }
                        if uri.path() == "/v1/hosts" {
                            return Json(hosts).into_response();
                        }
                        if uri.path() == "/v1/drawer_notes" {
                            let other_account = headers
                                .get("authorization")
                                .is_some_and(|header| header == &format!("Bearer {TOKEN_B}"));
                            let notes = if other_account || status == StatusCode::NOT_FOUND {
                                vec![]
                            } else {
                                vec![saved]
                            };
                            return Json(json!({"drawer_notes":notes})).into_response();
                        }
                        if uri.path() == "/v1/tokens/refresh" {
                            let token = TOKEN_A.replace("c3ludGhldGlj", "cm90YXRlZA");
                            return Json(json!({"access_token":token,"refresh_token":token}))
                                .into_response();
                        }
                        let body = if uri.path().ends_with("/artifact-link") {
                            json!({"data":saved,"txid":1})
                        } else {
                            json!(saved)
                        };
                        (status, Json(body)).into_response()
                    }
                });
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
            let client = RemoteClient::new(
                &format!("http://{address}"),
                auth.clone(),
                "synthetic-machine".into(),
            )
            .unwrap();
            Self {
                client,
                auth,
                calls,
                server,
                _directory: directory,
            }
        }
    }

    #[tokio::test]
    async fn changed_account_or_logout_during_sync_preserves_document_and_cleanup_outbox() {
        for path in ["/v1/hosts", "/v1/drawer_notes"] {
            for change in [Change::Account, Change::Logout] {
                let pool = database("sqlite::memory:").await;
                let mut record = record();
                record.owner_id = Uuid::parse_str(ACCOUNT_A).unwrap();
                insert(&pool, &record).await.unwrap();
                let cloud = Cloud::new(&record, path.into(), StatusCode::OK, change).await;
                let result = sync(&pool, &cloud.client).await;
                let after = load(&pool, record.id).await.unwrap();
                assert!(
                    !after.deleted,
                    "Changed account must never revoke the previous owner's dashboard"
                );
                assert_eq!(after.document, record.document);
                assert_eq!(after.channel_config, record.channel_config);
                assert!(events(&pool).await.is_empty());
                assert!(result.is_err());
                cloud
                    .auth
                    .save_credentials(&credentials(TOKEN_A))
                    .await
                    .unwrap();
                sync(&pool, &cloud.client).await.unwrap();
                let restored = load(&pool, record.id).await.unwrap();
                assert!(restored.attached && !restored.deleted);
                assert_eq!(restored.document, record.document);
                assert!(events(&pool).await.is_empty());
            }
        }
    }

    #[tokio::test]
    async fn late_note_reads_and_registration_acknowledgments_never_become_deletion_after_account_change()
     {
        for status in [
            StatusCode::OK,
            StatusCode::NOT_FOUND,
            StatusCode::SERVICE_UNAVAILABLE,
        ] {
            for change in [Change::Account, Change::Logout] {
                let mut record = record();
                record.owner_id = Uuid::parse_str(ACCOUNT_A).unwrap();
                for attach in [false, true] {
                    let path = format!(
                        "/v1/drawer_notes/{}{}",
                        record.note_id.unwrap(),
                        if attach { "/artifact-link" } else { "" }
                    );
                    let cloud = Cloud::new(&record, path, status, change).await;
                    let client = cloud.client.for_account(record.owner_id);
                    let error = if attach {
                        client
                            .attach_drawer_artifact(
                                record.note_id.unwrap(),
                                record.id,
                                record.host_id,
                            )
                            .await
                            .unwrap_err()
                    } else {
                        client
                            .drawer_note(record.note_id.unwrap())
                            .await
                            .unwrap_err()
                    };
                    assert!(matches!(
                        error,
                        super::super::remote_client::RemoteClientError::AccountChanged
                    ));
                    assert_eq!(
                        cloud.calls.load(Ordering::SeqCst),
                        1,
                        "Never retry a request using the replacement account"
                    );
                    match change {
                        Change::Account => assert_eq!(
                            cloud.auth.get_credentials().await.unwrap().refresh_token,
                            TOKEN_B
                        ),
                        Change::Logout => assert!(cloud.auth.get_credentials().await.is_none()),
                        _ => unreachable!(),
                    }
                }
            }
        }
    }

    #[tokio::test]
    async fn bound_client_rejects_another_accounts_access_token_before_sending() {
        let record = record();
        let cloud = Cloud::new(&record, String::new(), StatusCode::OK, Change::Refresh).await;
        let mixed = Credentials {
            access_token: Some(TOKEN_B.into()),
            ..credentials(TOKEN_A)
        };
        cloud.auth.save_credentials(&mixed).await.unwrap();
        let client = cloud
            .client
            .for_account(Uuid::parse_str(ACCOUNT_A).unwrap())
            .clone();
        assert!(matches!(
            client.drawer_note(record.note_id.unwrap()).await,
            Err(super::super::remote_client::RemoteClientError::AccountChanged)
        ));
        assert_eq!(cloud.calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            cloud.auth.get_credentials().await.unwrap().access_token,
            mixed.access_token
        );
    }

    #[tokio::test]
    async fn same_owner_rotation_and_authoritative_missing_notes_still_revoke_normally() {
        for change in [Change::Refresh, Change::RoundTrip] {
            let pool = database("sqlite::memory:").await;
            let mut record = record();
            record.owner_id = Uuid::parse_str(ACCOUNT_A).unwrap();
            insert(&pool, &record).await.unwrap();
            let cloud = Cloud::new(
                &record,
                "/v1/drawer_notes".into(),
                StatusCode::NOT_FOUND,
                change,
            )
            .await;
            sync(&pool, &cloud.client).await.unwrap();
            let after = load(&pool, record.id).await.unwrap();
            assert!(after.deleted);
            assert_eq!(after.document, "null");
            assert_eq!(events(&pool).await.len(), 1);
            let client = cloud.client.for_account(record.owner_id);
            let missing = Cloud::new(&record, String::new(), StatusCode::NOT_FOUND, change).await;
            assert!(
                missing
                    .client
                    .for_account(record.owner_id)
                    .drawer_note(record.note_id.unwrap())
                    .await
                    .unwrap()
                    .is_none()
            );
            assert!(client.ensure_account().await.is_ok());
        }
    }

    #[tokio::test]
    async fn pinned_requests_refresh_same_owner_tokens_but_never_clear_a_replacement_login() {
        for changed in [false, true] {
            let mut record = record();
            record.owner_id = Uuid::parse_str(ACCOUNT_A).unwrap();
            let cloud = Cloud::new(
                &record,
                if changed {
                    "/v1/tokens/refresh".into()
                } else {
                    String::new()
                },
                StatusCode::OK,
                Change::Account,
            )
            .await;
            let expired = Credentials {
                expires_at: Some(Utc::now() - chrono::Duration::hours(1)),
                ..credentials(TOKEN_A)
            };
            cloud.auth.save_credentials(&expired).await.unwrap();
            let result = cloud
                .client
                .for_account(record.owner_id)
                .drawer_note(record.note_id.unwrap())
                .await;
            if changed {
                assert!(matches!(
                    result,
                    Err(super::super::remote_client::RemoteClientError::AccountChanged)
                ));
                assert_eq!(cloud.calls.load(Ordering::SeqCst), 1);
                assert_eq!(
                    cloud.auth.get_credentials().await.unwrap().refresh_token,
                    TOKEN_B
                );
            } else {
                assert_eq!(result.unwrap().unwrap().owner_user_id, record.owner_id);
                assert_eq!(cloud.calls.load(Ordering::SeqCst), 2);
                assert_ne!(
                    cloud.auth.get_credentials().await.unwrap().refresh_token,
                    TOKEN_A
                );
            }
        }
    }

    fn record() -> StoredArtifact {
        StoredArtifact {
            id: Uuid::new_v4(),
            note_id: Some(Uuid::new_v4()),
            workspace_id: None,
            session_id: None,
            owner_id: Uuid::new_v4(),
            host_id: Uuid::new_v4(),
            channel_id: format!("synthetic_{}", Uuid::new_v4().simple()),
            document: "synthetic frozen HTML and dependencies".into(),
            channel_config: "synthetic publisher config".into(),
            binding_version: "synthetic-binding".into(),
            version: "synthetic-version".into(),
            revision: 1,
            archived: false,
            deleted: false,
            attached: false,
        }
    }

    fn frozen_record() -> StoredArtifact {
        let mut record = record();
        record.owner_id = Uuid::parse_str(ACCOUNT_A).unwrap();
        record.attached = true;
        let files = vec![
            DrawerArtifactFile {
                path: "dashboard.html".into(),
                mime: "text/html".into(),
                bytes: b"<html><link href='style.css'><body>synthetic</body></html>".to_vec(),
            },
            DrawerArtifactFile {
                path: "style.css".into(),
                mime: "text/css".into(),
                bytes: b"body { color: navy; }".to_vec(),
            },
            DrawerArtifactFile {
                path: "image.png".into(),
                mime: "image/png".into(),
                bytes: vec![0, 255, 13, 10],
            },
        ];
        record.channel_config = json!({"publishers":["synthetic-publisher"],"data_schema":{"type":"object","properties":{}}}).to_string();
        record.version =
            document_version(record.note_id.unwrap(), &files, &record.channel_config).unwrap();
        record.document = serde_json::to_string(&DrawerArtifactDocument {
            id: record.id,
            note_id: record.note_id,
            workspace_id: None,
            session_id: None,
            name: "Synthetic dashboard".into(),
            path: "dashboard.html".into(),
            version: record.version.clone(),
            files,
        })
        .unwrap();
        record
    }

    #[test]
    fn moving_links_preserves_prose_examples_and_other_artifacts() {
        let id = Uuid::new_v4();
        let target = Uuid::new_v4();
        let line = format!("[Synthetic](<drawer-artifacts/{id}> \"vibe-artifact\")");
        let body = format!("Original text\r\n```text\n{line}\n```\n{line}\n> {line}\nOther text");
        let (moved, attachment) = move_links(&body, id, target).unwrap();
        assert_eq!(attachment, line);
        assert_eq!(
            moved,
            format!(
                "Original text\r\n```text\n{line}\n```\n[Dashboard](/drawer?note={target}&artifact={id})\n> {line}\nOther text"
            )
        );
        assert!(!linked(&moved, id));
        assert!(move_links(&format!("```\n{line}\n```"), id, target).is_err());
    }

    #[test]
    fn recovery_redirects_only_its_forward_links_and_preserves_examples() {
        let id = Uuid::new_v4();
        let other = Uuid::new_v4();
        let host = Uuid::new_v4();
        let old = ArtifactOwner::Drawer {
            note_id: Uuid::new_v4(),
        };
        let target = ArtifactOwner::Workspace {
            workspace_id: Uuid::new_v4(),
            session_id: Uuid::new_v4(),
        };
        let original = format!("[Dashboard]({})", old.forward_href(host, id));
        let unrelated = format!("[Dashboard]({})", old.forward_href(host, other));
        let body = format!(
            "Original prose\n```\n{original}\n```\n{original}\n> {original}\n{unrelated}\n"
        );
        let changed = redirect_forward_links(&body, id, &[old], &target, host);
        assert_eq!(
            changed,
            format!(
                "Original prose\n```\n{original}\n```\n[Dashboard]({})\n> {original}\n{unrelated}\n",
                target.forward_href(host, id)
            )
        );
    }

    #[test]
    fn moving_back_does_not_revive_the_original_document_version() {
        let original = frozen_record();
        let first = moved_document(
            &original,
            &ArtifactOwner::Drawer {
                note_id: Uuid::new_v4(),
            },
        )
        .unwrap();
        let mut moved = original.clone();
        moved.note_id = first.note_id;
        moved.version = first.version.clone();
        moved.document = serde_json::to_string(&first).unwrap();
        let returned = moved_document(
            &moved,
            &ArtifactOwner::Drawer {
                note_id: original.note_id.unwrap(),
            },
        )
        .unwrap();
        assert_ne!(returned.version, original.version);
        let before: DrawerArtifactDocument = serde_json::from_str(&original.document).unwrap();
        assert_eq!(
            serde_json::to_value(returned.files).unwrap(),
            serde_json::to_value(before.files).unwrap()
        );
    }

    #[tokio::test]
    async fn all_transfer_directions_recover_and_survive_source_workspace_deletion() {
        transfer_direction_case(true, false).await;
        transfer_direction_case(false, false).await;
        transfer_direction_case(false, true).await;
    }

    async fn transfer_direction_case(recover_before_worker: bool, restore_source: bool) {
        let directory = tempfile::tempdir().unwrap();
        let pool = database("sqlite::memory:").await;
        let mut record = frozen_record();
        let mut first_note = note(&record);
        first_note.body = "Original note prose".into();
        let mut second_note = first_note.clone();
        second_note.id = Uuid::new_v4();
        let mut failed_note = first_note.clone();
        failed_note.id = Uuid::new_v4();
        let workspace_a = Uuid::new_v4();
        let session_a = Uuid::new_v4();
        let workspace_b = Uuid::new_v4();
        let session_b = Uuid::new_v4();
        let workspace_c = Uuid::new_v4();
        let session_c = Uuid::new_v4();
        for (workspace, session) in [
            (workspace_a, session_a),
            (workspace_b, session_b),
            (workspace_c, session_c),
        ] {
            sqlx::query("INSERT INTO workspaces (id, branch) VALUES (?, 'synthetic/portable')")
                .bind(workspace)
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO sessions (id, workspace_id) VALUES (?, ?)")
                .bind(session)
                .bind(workspace)
                .execute(&pool)
                .await
                .unwrap();
        }
        record.note_id = None;
        record.workspace_id = Some(workspace_a);
        record.session_id = Some(session_a);
        let mut document: DrawerArtifactDocument = serde_json::from_str(&record.document).unwrap();
        document.note_id = None;
        document.workspace_id = Some(workspace_a);
        document.session_id = Some(session_a);
        record.document = serde_json::to_string(&document).unwrap();
        let original_files = serde_json::to_value(&document.files).unwrap();
        let original_config = record.channel_config.clone();
        let channel = record.channel_id.clone();
        let legacy_scope = json!({"owner_id":record.owner_id,"owner_host":"synthetic-host", "workspace_id":workspace_a,"session_id":session_a});
        let notes = Arc::new(RwLock::new(vec![
            first_note.clone(),
            second_note.clone(),
            failed_note.clone(),
        ]));
        let worker = Arc::new(RwLock::new(
            json!({"scope":legacy_scope,"version":record.binding_version,"receipt":null,"count":0}),
        ));
        let fail_body = Arc::new(AtomicBool::new(true));
        let fail_worker = Arc::new(AtomicBool::new(!recover_before_worker));
        let router = Router::new().fallback({
        let (notes, worker) = (notes.clone(), worker.clone());
        move |OriginalUri(uri): OriginalUri, body: axum::body::Bytes| {
            let (notes, worker, channel, fail_body, fail_worker) = (notes.clone(), worker.clone(), channel.clone(), fail_body.clone(), fail_worker.clone());
            async move {
                if uri.path().ends_with("/transfer") {
                    let input: Value = serde_json::from_slice(&body).unwrap();
                    let mut worker = worker.write().await;
                    if worker["receipt"]["operation_id"] != input["operation_id"] || worker["receipt"]["previous_targets"] != input["previous_targets"] {
                        if worker["receipt"]["operation_id"] == input["operation_id"] {
                            assert_eq!(input["previous_targets"][0], worker["scope"]);
                            assert_eq!(input["version"], worker["receipt"]["version"]);
                        } else {
                            assert_eq!(input["scope"], worker["scope"]);
                            assert_eq!(input["version"], worker["version"]);
                        }
                        worker["scope"] = input["target_scope"].clone();
                        let count = worker["count"].as_u64().unwrap() + 1;
                        worker["count"] = json!(count);
                        worker["version"] = json!(format!("{count:064x}"));
                        worker["receipt"] = input;
                    } else { assert_eq!(input, worker["receipt"]); }
                    if fail_worker.swap(false, Ordering::SeqCst) { return axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response(); }
                    return Json(json!({"channel_id":channel,"version":worker["version"],"data_schema":{"type":"object","properties":{}},"actions":{}})).into_response();
                }
                let mut notes = notes.write().await;
                if uri.path().ends_with("/artifact-move") {
                    let input: Value = serde_json::from_slice(&body).unwrap();
                    let source = notes.iter().position(|note| uri.path() == format!("/v1/drawer_notes/{}/artifact-move", note.id)).unwrap();
                    let target = notes.iter().position(|note| json!(note.id) == input["target_note_id"]).unwrap();
                    assert_eq!(input["source_body"], notes[source].body);
                    assert_eq!(input["target_body"], notes[target].body);
                    notes[source].body = input["source_body_after"].as_str().unwrap().into();
                    notes[target].body = input["target_body_after"].as_str().unwrap().into();
                    return Json(json!({"data":notes[target],"txid":1})).into_response();
                }
                if uri.path().ends_with("/artifact-body") {
                    let input: Value = serde_json::from_slice(&body).unwrap();
                    let note = notes.iter_mut().find(|note| uri.path() == format!("/v1/drawer_notes/{}/artifact-body", note.id)).unwrap();
                    assert_eq!(input["before"], note.body);
                    note.body = input["after"].as_str().unwrap().into();
                    if fail_body.swap(false, Ordering::SeqCst) { return axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response(); }
                    return Json(json!({"data":note,"txid":1})).into_response();
                }
                let Some(note) = notes.iter().find(|note| uri.path() == format!("/v1/drawer_notes/{}", note.id)) else { return StatusCode::NOT_FOUND.into_response(); };
                Json(json!(note)).into_response()
            }
        }
    });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let auth = AuthContext::new(
            Arc::new(OAuthCredentials::new(
                directory.path().join("synthetic-auth.json"),
            )),
            Arc::new(RwLock::new(None)),
        );
        auth.save_credentials(&credentials(TOKEN_A)).await.unwrap();
        let client = RemoteClient::new(&url, auth, "synthetic-host".into())
            .unwrap()
            .for_account(record.owner_id);
        let execution = Uuid::new_v4();
        let destinations = [
            if restore_source {
                ArtifactOwner::Workspace {
                    workspace_id: workspace_a,
                    session_id: session_a,
                }
            } else {
                ArtifactOwner::Drawer {
                    note_id: first_note.id,
                }
            },
            ArtifactOwner::Drawer {
                note_id: second_note.id,
            },
            ArtifactOwner::Workspace {
                workspace_id: workspace_c,
                session_id: session_c,
            },
            ArtifactOwner::Workspace {
                workspace_id: workspace_b,
                session_id: session_b,
            },
            ArtifactOwner::Drawer {
                note_id: first_note.id,
            },
        ];
        for (index, target) in destinations.into_iter().enumerate() {
            let old_version = record.version.clone();
            if index == 0 {
                import_source(
                    &pool,
                    &record,
                    execution,
                    "synthetic-source",
                    ArtifactOwner::Drawer {
                        note_id: failed_note.id,
                    },
                    legacy_scope.clone(),
                    "synthetic-host",
                )
                .await
                .unwrap();
                for failure in 0..if recover_before_worker { 1 } else { 2 } {
                    assert!(
                        resume_move_to(&pool, &client, record.id, &url, "synthetic-token")
                            .await
                            .is_err()
                    );
                    assert_eq!(load(&pool, record.id).await.unwrap().version, old_version);
                    assert!(pending_move(&pool, record.id).await.unwrap().is_some());
                    if failure == 0 && !restore_source {
                        sqlx::query("DELETE FROM workspaces WHERE id = ?")
                            .bind(workspace_a)
                            .execute(&pool)
                            .await
                            .unwrap();
                    }
                }
                notes.write().await.retain(|note| note.id != failed_note.id);
                assert!(
                    resume_move_to(&pool, &client, record.id, &url, "synthetic-token")
                        .await
                        .is_err()
                );
                assert!(
                    retarget_transfer(&pool, &client, &record, target.clone(), 1)
                        .await
                        .is_err()
                );
                let mut foreign = first_note.clone();
                foreign.id = Uuid::new_v4();
                foreign.owner_user_id = Uuid::new_v4();
                let forbidden = ArtifactOwner::Drawer {
                    note_id: foreign.id,
                };
                notes.write().await.push(foreign.clone());
                assert!(
                    retarget_transfer(&pool, &client, &record, forbidden, 0)
                        .await
                        .is_err()
                );
                notes.write().await.retain(|note| note.id != foreign.id);
                assert!(
                    pending_move(&pool, record.id)
                        .await
                        .unwrap()
                        .unwrap()
                        .previous_targets
                        .is_empty()
                );
                retarget_transfer(&pool, &client, &record, target.clone(), 0)
                    .await
                    .unwrap();
            } else {
                prepare_transfer(
                    &pool,
                    &client,
                    &record,
                    target.clone(),
                    "synthetic-host",
                    None,
                )
                .await
                .unwrap();
            }
            record = resume_move_to(&pool, &client, record.id, &url, "synthetic-token")
                .await
                .unwrap();
            assert_eq!(record.artifact_owner().unwrap(), target);
            assert_ne!(record.version, old_version);
            assert_eq!(record.channel_config, original_config);
            assert!(!record.deleted && !record.archived && record.attached);
            let saved: DrawerArtifactDocument = serde_json::from_str(&record.document).unwrap();
            assert_eq!(saved.version, record.version);
            assert_eq!(
                (saved.note_id, saved.workspace_id, saved.session_id),
                target.columns()
            );
            assert_eq!(serde_json::to_value(saved.files).unwrap(), original_files);
            assert_eq!(worker.read().await["scope"], record.scope("synthetic-host"));
            assert!(pending_move(&pool, record.id).await.unwrap().is_none());
            if index == 3 {
                sqlx::query("DELETE FROM workspaces WHERE id = ?")
                    .bind(workspace_c)
                    .execute(&pool)
                    .await
                    .unwrap();
                let saved = reconcile(&pool, record.id, None).await.unwrap();
                assert!(!saved.deleted && !saved.archived);
                sqlx::query("UPDATE workspaces SET archived = 1 WHERE id = ?")
                    .bind(workspace_b)
                    .execute(&pool)
                    .await
                    .unwrap();
                let paused = reconcile(&pool, record.id, None).await.unwrap();
                assert!(paused.archived && !paused.deleted);
                assert_eq!(paused.document, record.document);
                sqlx::query("UPDATE workspaces SET archived = 0 WHERE id = ?")
                    .bind(workspace_b)
                    .execute(&pool)
                    .await
                    .unwrap();
                record = reconcile(&pool, record.id, None).await.unwrap();
                assert!(!record.archived && !record.deleted);
                assert!(
                    source_transferred(&pool, execution, "synthetic-source")
                        .await
                        .unwrap()
                );
            }
        }
        assert_eq!(
            worker.read().await["count"],
            if recover_before_worker { 5 } else { 6 }
        );
        assert!(
            notes
                .read()
                .await
                .iter()
                .all(|note| note.title == first_note.title)
        );
        server.abort();
    }

    #[tokio::test]
    async fn ownership_migration_keeps_legacy_documents_journals_and_foreign_keys() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let mut migrations = sqlx::migrate!("../db/migrations");
        migrations.migrations = std::borrow::Cow::Owned(
            migrations
                .iter()
                .filter(|migration| migration.version < 20261118010000)
                .cloned()
                .collect(),
        );
        migrations.run(&pool).await.unwrap();
        let record = frozen_record();
        sqlx::query("INSERT INTO drawer_artifacts (id, note_id, owner_id, host_id, channel_id, document, channel_config, version, binding_version, attached) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)")
            .bind(record.id).bind(record.note_id).bind(record.owner_id).bind(record.host_id).bind(&record.channel_id)
            .bind(&record.document).bind(&record.channel_config).bind(&record.version).bind(&record.binding_version).execute(&pool).await.unwrap();
        let target = Uuid::new_v4();
        sqlx::query("INSERT INTO drawer_artifact_moves (artifact_id, payload) VALUES (?, ?)")
            .bind(record.id).bind(json!({"operation_id":Uuid::new_v4(),"source":record.note_id,"target":target,"version":record.version,"owner_host":"synthetic-host"}).to_string()).execute(&pool).await.unwrap();
        let mut migration_tx = pool.begin().await.unwrap();
        sqlx::raw_sql(include_str!(
            "../../../db/migrations/20261118010000_artifact_owner_transfer.sql"
        ))
        .execute(&mut *migration_tx)
        .await
        .unwrap();
        migration_tx.commit().await.unwrap();
        let migrated = load(&pool, record.id).await.unwrap();
        assert_eq!(migrated.document, record.document);
        assert_eq!(migrated.channel_config, record.channel_config);
        assert_eq!(
            migrated.artifact_owner().unwrap(),
            ArtifactOwner::Drawer {
                note_id: record.note_id.unwrap()
            }
        );
        let pending = pending_move(&pool, record.id).await.unwrap().unwrap();
        assert_eq!(pending.target, ArtifactOwner::Drawer { note_id: target });
        assert!(
            sqlx::query("PRAGMA foreign_key_check")
                .fetch_all(&pool)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn move_rejects_foreign_archived_and_unlinked_notes_without_journaling() {
        let pool = database("sqlite::memory:").await;
        let record = frozen_record();
        insert(&pool, &record).await.unwrap();
        let source = note(&record);
        for invalid in 0..6 {
            let mut target = source.clone();
            target.id = Uuid::new_v4();
            match invalid {
                0 => target.owner_user_id = Uuid::new_v4(),
                1 => target.host_id = Some(Uuid::new_v4()),
                2 => target.archived_at = Some(target.created_at),
                3 => target.body = "```text".into(),
                4 => target.body = "x".repeat(64 * 1024),
                _ => target.id = source.id,
            }
            assert!(
                prepare_move(&pool, &record, &source, &target, "synthetic-host")
                    .await
                    .is_err()
            );
            assert!(pending_move(&pool, record.id).await.unwrap().is_none());
        }
        let mut target = source.clone();
        target.id = Uuid::new_v4();
        let mut unlinked = source.clone();
        unlinked.body.clear();
        assert!(
            prepare_move(&pool, &record, &unlinked, &target, "synthetic-host")
                .await
                .is_err()
        );
        assert_eq!(
            load(&pool, record.id).await.unwrap().document,
            record.document
        );
    }

    #[tokio::test]
    async fn move_recovers_lost_cloud_and_worker_responses_and_local_rollback_after_restart() {
        let directory = tempfile::tempdir().unwrap();
        let db_url = format!(
            "sqlite://{}",
            directory.path().join("synthetic.db").display()
        );
        let pool = database(&db_url).await;
        let record = frozen_record();
        insert(&pool, &record).await.unwrap();
        let source = note(&record);
        let mut target = source.clone();
        target.id = Uuid::new_v4();
        target.body = "Destination prose".into();
        reconcile(&pool, record.id, Some(&source)).await.unwrap();
        prepare_move(&pool, &record, &source, &target, "synthetic-host")
            .await
            .unwrap();
        assert!(reconcile(&pool, record.id, Some(&source)).await.is_err());
        let notes = Arc::new(RwLock::new(vec![source.clone(), target.clone()]));
        let handler_notes = notes.clone();
        let cloud_lost = Arc::new(AtomicBool::new(true));
        let worker_lost = Arc::new(AtomicBool::new(true));
        let moves = Arc::new(AtomicUsize::new(0));
        let handler_moves = moves.clone();
        let channel_id = record.channel_id.clone();
        let router = Router::new().fallback(move |OriginalUri(uri): OriginalUri, body: axum::body::Bytes| {
            let (notes, cloud_lost, worker_lost, moves, channel_id) = (
                handler_notes.clone(), cloud_lost.clone(), worker_lost.clone(), handler_moves.clone(), channel_id.clone());
            async move {
                if uri.path().ends_with("/artifact-move") {
                    let input: Value = serde_json::from_slice(&body).unwrap();
                    let mut notes = notes.write().await;
                    assert_eq!(input["source_body"], notes[0].body);
                    assert_eq!(input["target_body"], notes[1].body);
                    notes[0].body = input["source_body_after"].as_str().unwrap().into();
                    notes[1].body = input["target_body_after"].as_str().unwrap().into();
                    assert!(cloud_lost.swap(false, Ordering::SeqCst));
                    return StatusCode::SERVICE_UNAVAILABLE.into_response();
                }
                if uri.path().ends_with("/transfer") {
                    let input: Value = serde_json::from_slice(&body).unwrap();
                    assert_eq!(input["scope"]["kind"], "drawer");
                    moves.fetch_add(1, Ordering::SeqCst);
                    if worker_lost.swap(false, Ordering::SeqCst) {
                        return StatusCode::SERVICE_UNAVAILABLE.into_response();
                    }
                    return Json(json!({"channel_id":channel_id,"version":"moved-binding","data_schema":{"type":"object","properties":{}},"actions":{}})).into_response();
                }
                let notes = notes.read().await;
                let found = notes.iter().find(|note| uri.path() == format!("/v1/drawer_notes/{}", note.id)).unwrap();
                Json(json!(found)).into_response()
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let auth = AuthContext::new(
            Arc::new(OAuthCredentials::new(
                directory.path().join("synthetic-auth.json"),
            )),
            Arc::new(RwLock::new(None)),
        );
        auth.save_credentials(&credentials(TOKEN_A)).await.unwrap();
        let client = RemoteClient::new(&url, auth, "synthetic-host".into())
            .unwrap()
            .for_account(record.owner_id);
        // First the cloud acknowledgment is lost, then the worker acknowledgment.
        for _ in 0..2 {
            assert!(
                resume_move_to(&pool, &client, record.id, &url, "synthetic-token")
                    .await
                    .is_err()
            );
            assert_eq!(
                load(&pool, record.id).await.unwrap().document,
                record.document
            );
            assert!(pending_move(&pool, record.id).await.unwrap().is_some());
        }
        sqlx::query("ALTER TABLE automation_event_outbox RENAME TO synthetic_outbox")
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            resume_move_to(&pool, &client, record.id, &url, "synthetic-token")
                .await
                .is_err()
        );
        assert_eq!(
            load(&pool, record.id).await.unwrap().note_id,
            Some(source.id)
        );
        sqlx::query("ALTER TABLE synthetic_outbox RENAME TO automation_event_outbox")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
        let pool = database(&db_url).await;
        let moved = resume_move_to(&pool, &client, record.id, &url, "synthetic-token")
            .await
            .unwrap();
        assert_eq!(moved.note_id, Some(target.id));
        assert_eq!(moved.binding_version, "moved-binding");
        assert_eq!(moved.channel_id, record.channel_id);
        assert_eq!(moved.channel_config, record.channel_config);
        assert_eq!(moved.owner_id, record.owner_id);
        assert_eq!(moved.host_id, record.host_id);
        assert_eq!(moved.revision, record.revision + 1);
        assert!(!moved.archived && !moved.deleted);
        assert!(moved.attached);
        let before: DrawerArtifactDocument = serde_json::from_str(&record.document).unwrap();
        let after: DrawerArtifactDocument = serde_json::from_str(&moved.document).unwrap();
        assert_eq!(after.note_id, Some(target.id));
        assert_eq!(after.version, moved.version);
        assert_ne!(after.version, before.version);
        assert_eq!(after.path, before.path);
        assert_eq!(after.name, before.name);
        assert_eq!(
            serde_json::to_value(after.files).unwrap(),
            serde_json::to_value(before.files).unwrap()
        );
        assert!(pending_move(&pool, record.id).await.unwrap().is_none());
        assert_eq!(
            completed_move(&pool, record.id)
                .await
                .unwrap()
                .unwrap()
                .version,
            record.version
        );
        assert_eq!(events(&pool).await.len(), 1);
        assert_eq!(moves.load(Ordering::SeqCst), 3);
        assert!(!linked(&notes.read().await[0].body, record.id));
        assert!(linked(&notes.read().await[1].body, record.id));
        server.abort();
    }
    fn note(record: &StoredArtifact) -> DrawerNote {
        let now = DateTime::<Utc>::from_timestamp(1893456000, 0).unwrap();
        DrawerNote {
            id: record.note_id.unwrap(),
            owner_user_id: record.owner_id,
            host_id: Some(record.host_id),
            workspace_id: None,
            session_id: None,
            execution_id: None,
            title: "Synthetic dashboard".into(),
            body: format!("[Dashboard]({} \"vibe-artifact\")", record.link()),
            label: None,
            pinned: false,
            archived_at: None,
            user_seen_at: None,
            last_comment_at: None,
            created_at: now,
            updated_at: now,
        }
    }
    async fn database(url: &str) -> SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                url.parse::<sqlx::sqlite::SqliteConnectOptions>()
                    .unwrap()
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
        pool
    }
    async fn events(pool: &SqlitePool) -> Vec<Value> {
        sqlx::query_scalar::<_, String>("SELECT payload FROM automation_event_outbox WHERE json_extract(payload, '$.type') = 'drawer_artifact_lifecycle' ORDER BY id")
            .fetch_all(pool).await.unwrap().iter().map(|s|serde_json::from_str(s).unwrap()).collect()
    }
    #[tokio::test]
    async fn frozen_document_survives_source_archive_delete_and_database_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let url = format!(
            "sqlite://{}",
            temp.path().join("synthetic.sqlite").display()
        );
        let pool = database(&url).await;
        let record = record();
        insert(&pool, &record).await.unwrap();
        let workspace = Uuid::new_v4();
        sqlx::query("INSERT INTO workspaces (id, branch) VALUES (?, 'synthetic/source')")
            .bind(workspace)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE workspaces SET archived = 1 WHERE id = ?")
            .bind(workspace)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM workspaces WHERE id = ?")
            .bind(workspace)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            load(&pool, record.id).await.unwrap().document,
            record.document
        );
        pool.close().await;
        let pool = database(&url).await;
        let loaded = reconcile(&pool, record.id, Some(&note(&record)))
            .await
            .unwrap();
        assert!(loaded.attached && !loaded.archived && !loaded.deleted);
        assert_eq!(loaded.document, record.document);
        assert!(events(&pool).await.is_empty());
        pool.close().await;
    }
    #[tokio::test]
    async fn drawer_archive_restore_and_delete_are_durable_idempotent_and_erase_payloads() {
        let pool = database("sqlite::memory:").await;
        let record = record();
        insert(&pool, &record).await.unwrap();
        let mut note = note(&record);
        note.archived_at = Some(note.created_at);
        assert!(
            reconcile(&pool, record.id, Some(&note))
                .await
                .unwrap()
                .archived
        );
        reconcile(&pool, record.id, Some(&note)).await.unwrap();
        assert_eq!(events(&pool).await.len(), 1);
        note.archived_at = None;
        let resumed = reconcile(&pool, record.id, Some(&note)).await.unwrap();
        assert_eq!(resumed.revision, 3);
        assert!(!resumed.archived);
        assert_eq!(resumed.document, record.document);
        let deleted = reconcile(&pool, record.id, None).await.unwrap();
        assert!(deleted.deleted);
        assert_eq!(deleted.document, "null");
        assert_eq!(deleted.channel_config, "null");
        assert!(
            reconcile(&pool, record.id, Some(&note))
                .await
                .unwrap()
                .deleted
        );
        let events = events(&pool).await;
        assert_eq!(events.len(), 3);
        assert!(
            events
                .iter()
                .all(|e| e["artifactId"] == record.id.to_string())
        );
        assert_eq!(events[2]["deleted"], true);
    }
    #[tokio::test]
    async fn unavailable_outbox_rolls_back_the_revocation_and_can_be_retried() {
        let pool = database("sqlite::memory:").await;
        let record = record();
        insert(&pool, &record).await.unwrap();
        sqlx::query("ALTER TABLE automation_event_outbox RENAME TO synthetic_unavailable_outbox")
            .execute(&pool)
            .await
            .unwrap();
        assert!(reconcile(&pool, record.id, None).await.is_err());
        let loaded = load(&pool, record.id).await.unwrap();
        assert!(!loaded.deleted);
        assert_eq!(loaded.document, record.document);
        sqlx::query("ALTER TABLE synthetic_unavailable_outbox RENAME TO automation_event_outbox")
            .execute(&pool)
            .await
            .unwrap();
        assert!(reconcile(&pool, record.id, None).await.unwrap().deleted);
        assert_eq!(events(&pool).await.len(), 1);
    }
    #[tokio::test]
    async fn unfinished_registration_is_reconciled_without_replaying_actions() {
        let pool = database("sqlite::memory:").await;
        let linked = record();
        let abandoned = record();
        insert(&pool, &linked).await.unwrap();
        insert(&pool, &abandoned).await.unwrap();
        assert!(
            reconcile(&pool, linked.id, Some(&note(&linked)))
                .await
                .unwrap()
                .attached
        );
        let mut absent = note(&abandoned);
        absent.body.clear();
        assert!(
            reconcile(&pool, abandoned.id, Some(&absent))
                .await
                .unwrap()
                .deleted
        );
        assert_eq!(events(&pool).await.len(), 1);
        assert!(!load(&pool, linked.id).await.unwrap().deleted);
    }
    #[tokio::test]
    async fn quoted_example_is_not_a_dashboard_binding_but_bracketed_links_are() {
        let pool = database("sqlite::memory:").await;
        let quoted = record();
        let linked = record();
        insert(&pool, &quoted).await.unwrap();
        insert(&pool, &linked).await.unwrap();
        let mut example = note(&quoted);
        example.body = format!("```text\n{}\n```", example.body);
        assert!(
            reconcile(&pool, quoted.id, Some(&example))
                .await
                .unwrap()
                .deleted
        );
        let mut actual = note(&linked);
        actual.body = format!("[Dashboard](<{}> \"vibe-artifact\")", linked.link());
        assert!(
            !reconcile(&pool, linked.id, Some(&actual))
                .await
                .unwrap()
                .deleted
        );
        let uppercase = record();
        insert(&pool, &uppercase).await.unwrap();
        let mut actual = note(&uppercase);
        actual.body = format!(
            "[Dashboard](drawer-artifacts/{} \"vibe-artifact\")",
            uppercase.id.to_string().to_ascii_uppercase()
        );
        assert!(
            !reconcile(&pool, uppercase.id, Some(&actual))
                .await
                .unwrap()
                .deleted,
            "UUID casing accepted by the Drawer renderer must not revoke a dashboard"
        );
    }

    #[tokio::test]
    async fn owner_transfer_revokes_only_its_bound_dashboard() {
        let pool = database("sqlite::memory:").await;
        let bound = record();
        let other = record();
        insert(&pool, &bound).await.unwrap();
        insert(&pool, &other).await.unwrap();
        reconcile(&pool, bound.id, Some(&note(&bound)))
            .await
            .unwrap();
        let mut note = note(&bound);
        note.owner_user_id = Uuid::new_v4();
        assert!(
            reconcile(&pool, bound.id, Some(&note))
                .await
                .unwrap()
                .deleted
        );
        assert!(!load(&pool, other.id).await.unwrap().deleted);
    }

    #[tokio::test]
    async fn dropped_link_or_other_host_update_pauses_until_the_link_returns() {
        for moved_host in [false, true] {
            let pool = database("sqlite::memory:").await;
            let record = record();
            insert(&pool, &record).await.unwrap();
            let linked = note(&record);
            assert!(
                reconcile(&pool, record.id, Some(&linked))
                    .await
                    .unwrap()
                    .attached
            );
            let mut edited = linked.clone();
            if moved_host {
                edited.host_id = Some(Uuid::new_v4());
            } else {
                edited.body = "Rewritten report without the dashboard line".into();
            }
            let paused = reconcile(&pool, record.id, Some(&edited)).await.unwrap();
            assert!(paused.archived && !paused.deleted);
            assert_eq!(paused.document, record.document);
            let resumed = reconcile(&pool, record.id, Some(&linked)).await.unwrap();
            assert!(!resumed.archived && !resumed.deleted);
            let events = events(&pool).await;
            assert_eq!(events.len(), 2);
            assert!(events.iter().all(|e| e["deleted"] == false));
        }
    }

    #[test]
    fn dashboard_links_are_recognised_without_matching_workspace_files() {
        let id = Uuid::new_v4().to_string();
        assert!(is_link(&format!("drawer-artifacts/{id}")));
        assert!(is_link(&format!(
            "Drawer-Artifacts/{}",
            id.to_ascii_uppercase()
        )));
        for other in [
            format!("drawer-artifacts/{id}/extra"),
            format!("../drawer-artifacts/{id}"),
            "drawer-artifacts/not-an-id".into(),
            "drawer-artifacts/".into(),
            "reports/dashboard.html".into(),
        ] {
            assert!(!is_link(&other), "{other}");
        }
    }
}
