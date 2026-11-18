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

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct DrawerArtifactFile {
    pub path: String,
    pub mime: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct DrawerArtifactDocument {
    pub id: Uuid,
    pub note_id: Uuid,
    pub name: String,
    pub path: String,
    pub version: String,
    pub files: Vec<DrawerArtifactFile>,
}

#[derive(Debug, Clone, FromRow)]
pub struct StoredArtifact {
    pub id: Uuid,
    pub note_id: Uuid,
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
    pub fn scope(&self, host: &str) -> Value {
        json!({"kind":"drawer", "owner_id":self.owner_id, "owner_host":host,
            "note_id":self.note_id, "artifact_id":self.id})
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
    if record.document.len() > MAX_DOCUMENT_BYTES {
        bail!("Drawer artifact exceeds 8 MiB snapshot limit");
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM drawer_artifacts WHERE deleted = 0")
        .fetch_one(pool)
        .await?;
    if count >= 128 {
        bail!("Too many Drawer artifacts");
    }
    sqlx::query("INSERT INTO drawer_artifacts (id, note_id, owner_id, host_id, channel_id, document, channel_config, version, binding_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(record.id).bind(record.note_id).bind(record.owner_id).bind(record.host_id)
        .bind(&record.channel_id).bind(&record.document).bind(&record.channel_config).bind(&record.version).bind(&record.binding_version)
        .execute(pool).await?;
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
    pub source: Uuid,
    pub target: Uuid,
    pub version: String,
    owner_host: String,
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
fn move_links(body: &str, id: Uuid, target: Uuid) -> Result<(String, String)> {
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
            result.push_str(&format!("[Dashboard](/drawer?note={target})"));
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

fn moved_document(record: &StoredArtifact, target: Uuid) -> Result<DrawerArtifactDocument> {
    let mut document: DrawerArtifactDocument = serde_json::from_str(&record.document)?;
    if document.id != record.id
        || document.note_id != record.note_id
        || document.version != record.version
    {
        bail!("Drawer document metadata does not match its binding");
    }
    document.note_id = target;
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
    if source.id != record.note_id
        || source.id == target.id
        || record.deleted
        || !record.attached
        || record.archived
    {
        bail!("Only an attached, active dashboard can move to another note");
    }
    moved_document(record, target.id)?;
    link_changes(record, source, target)?;
    let pending = PendingMove {
        operation_id: Uuid::new_v4(),
        source: source.id,
        target: target.id,
        version: record.version.clone(),
        owner_host: owner_host.into(),
    };
    let inserted = sqlx::query("INSERT INTO drawer_artifact_moves (artifact_id, payload) VALUES (?, ?) ON CONFLICT(artifact_id) DO UPDATE SET payload = excluded.payload, completed = 0 WHERE completed = 1")
        .bind(record.id).bind(serde_json::to_string(&pending)?).execute(pool).await?;
    if inserted.rows_affected() != 1 {
        bail!("Another Drawer move is already pending");
    }
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
        .ok_or_else(|| anyhow::anyhow!("No pending Drawer move"))?;
    let record = load(pool, id).await?;
    if record.note_id != pending.source || record.version != pending.version || record.deleted {
        bail!("Drawer move conflicts with the stored document");
    }
    // Validate the document before changing either external store.
    let document = moved_document(&record, pending.target)?;
    let source = client
        .drawer_note(pending.source)
        .await?
        .ok_or_else(|| anyhow::anyhow!("Source note is unavailable; move remains pending"))?;
    let target = client
        .drawer_note(pending.target)
        .await?
        .ok_or_else(|| anyhow::anyhow!("Target note is unavailable; move remains pending"))?;
    active_note(&record, &source)?;
    active_note(&record, &target)?;
    client.ensure_account().await?;
    // A lost cloud response is recoverable even if unrelated prose was edited later.
    if linked(&source.body, id) || !linked(&target.body, id) {
        // Retry against current prose; the cloud CAS still fences concurrent edits.
        let links = link_changes(&record, &source, &target)?;
        client
            .move_drawer_artifact_links(pending.source, &links)
            .await?;
    }
    client.ensure_account().await?;
    let mut response = reqwest::Client::new()
        .post(format!(
            "{}/api/artifact-channels/{}/move-drawer",
            url.trim_end_matches('/'),
            record.channel_id
        ))
        .timeout(std::time::Duration::from_secs(20))
        .bearer_auth(token)
        .json(
            &json!({"operation_id":pending.operation_id,"scope":record.scope(&pending.owner_host),
            "version":record.binding_version,"target_note_id":pending.target}),
        )
        .send()
        .await?;
    if !response.status().is_success() {
        bail!(
            "Automation move returned {}; move remains pending for retry",
            response.status()
        );
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if body.len() + chunk.len() > 128 * 1024 {
            bail!("Moved automation binding is too large");
        }
        body.extend_from_slice(&chunk);
    }
    let binding: super::artifact_interactions::ArtifactAutomationBinding =
        serde_json::from_slice(&body)?;
    if binding.channel_id != record.channel_id || binding.version.is_empty() {
        bail!("Invalid moved automation binding");
    }
    client.ensure_account().await?;
    let target = client
        .drawer_note(pending.target)
        .await?
        .ok_or_else(|| anyhow::anyhow!("Target note is unavailable; move remains pending"))?;
    active_note(&record, &target)?;
    if !linked(&target.body, id) {
        bail!("Target dashboard link changed; move remains pending");
    }
    client.ensure_account().await?;
    let mut tx = pool.begin().await?;
    let updated = sqlx::query("UPDATE drawer_artifacts SET note_id = ?, document = ?, version = ?, binding_version = ?, revision = revision + 1, archived = 0 WHERE id = ? AND note_id = ? AND version = ? AND deleted = 0")
        .bind(pending.target).bind(serde_json::to_string(&document)?).bind(&document.version)
        .bind(binding.version).bind(id).bind(pending.source).bind(&pending.version)
        .execute(&mut *tx).await?;
    if updated.rows_affected() != 1 {
        bail!("Drawer document changed during move");
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
    let linked = note.is_some_and(|note| {
        note.host_id == Some(record.host_id)
            && executors::logs::artifacts::markdown_candidates(&note.body).iter().any(|candidate|
                matches!(candidate, executors::logs::artifacts::ArtifactCandidate::File(path) if path.eq_ignore_ascii_case(&record.link())))
    });
    // Only a gone note or owner change revokes an attached dashboard. A body
    // edit that drops the link, or an update from another host, pauses it so
    // restoring the line brings it back.
    let deleted = record.deleted
        || record.binding_version.is_empty()
        || note.is_none_or(|note| note.owner_user_id != record.owner_id)
        || (!record.attached && !linked);
    let archived = !linked || note.is_some_and(|note| note.archived_at.is_some());
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
    let notes = client.list_drawer_notes().await?.drawer_notes;
    for record in records {
        client.ensure_account().await?;
        if pending_move(pool, record.id).await?.is_some() {
            if let Err(error) = resume_move(pool, &client, record.id).await {
                tracing::warn!(%error, "Drawer artifact move recovery deferred");
            }
            continue;
        }
        reconcile(
            pool,
            record.id,
            notes.iter().find(|note| note.id == record.note_id),
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
                        record.note_id,
                        if attach { "/artifact-link" } else { "" }
                    );
                    let cloud = Cloud::new(&record, path, status, change).await;
                    let client = cloud.client.for_account(record.owner_id);
                    let error = if attach {
                        client
                            .attach_drawer_artifact(record.note_id, record.id, record.host_id)
                            .await
                            .unwrap_err()
                    } else {
                        client.drawer_note(record.note_id).await.unwrap_err()
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
            client.drawer_note(record.note_id).await,
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
                    .drawer_note(record.note_id)
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
                .drawer_note(record.note_id)
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
            note_id: Uuid::new_v4(),
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
        record.version = document_version(record.note_id, &files, &record.channel_config).unwrap();
        record.document = serde_json::to_string(&DrawerArtifactDocument {
            id: record.id,
            note_id: record.note_id,
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
                "Original text\r\n```text\n{line}\n```\n[Dashboard](/drawer?note={target})\n> {line}\nOther text"
            )
        );
        assert!(!linked(&moved, id));
        assert!(move_links(&format!("```\n{line}\n```"), id, target).is_err());
    }

    #[test]
    fn moving_back_does_not_revive_the_original_document_version() {
        let original = frozen_record();
        let first = moved_document(&original, Uuid::new_v4()).unwrap();
        let mut moved = original.clone();
        moved.note_id = first.note_id;
        moved.version = first.version.clone();
        moved.document = serde_json::to_string(&first).unwrap();
        let returned = moved_document(&moved, original.note_id).unwrap();
        assert_ne!(returned.version, original.version);
        let before: DrawerArtifactDocument = serde_json::from_str(&original.document).unwrap();
        assert_eq!(
            serde_json::to_value(returned.files).unwrap(),
            serde_json::to_value(before.files).unwrap()
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
                if uri.path().ends_with("/move-drawer") {
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
        assert_eq!(load(&pool, record.id).await.unwrap().note_id, source.id);
        sqlx::query("ALTER TABLE synthetic_outbox RENAME TO automation_event_outbox")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
        let pool = database(&db_url).await;
        let moved = resume_move_to(&pool, &client, record.id, &url, "synthetic-token")
            .await
            .unwrap();
        assert_eq!(moved.note_id, target.id);
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
        assert_eq!(after.note_id, target.id);
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
            id: record.note_id,
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
