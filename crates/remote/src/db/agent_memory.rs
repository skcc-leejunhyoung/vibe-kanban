use api_types::{
    AgentMemoryInboxResponse, AgentMemoryKind, AgentMemoryReceipt, AgentMemoryReceiptStatus,
    AgentMemoryScope, AgentMemorySnapshot, RecordAgentMemoryReceiptRequest,
    UpsertAgentMemorySnapshotRequest, UpsertAgentMemorySnapshotResponse,
};
use chrono::{DateTime, Utc};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

#[derive(FromRow)]
struct SnapshotRow {
    id: Uuid,
    source_host_id: Uuid,
    source_agent: String,
    scope: String,
    scope_key: String,
    revision: i64,
    content: String,
    content_hash: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl TryFrom<SnapshotRow> for AgentMemorySnapshot {
    type Error = anyhow::Error;

    fn try_from(row: SnapshotRow) -> Result<Self, Self::Error> {
        Ok(Self {
            id: row.id,
            source_host_id: row.source_host_id,
            source_agent: parse_agent(&row.source_agent)?,
            scope: parse_scope(&row.scope)?,
            scope_key: (!row.scope_key.is_empty()).then_some(row.scope_key),
            revision: row.revision,
            content: row.content,
            content_hash: row.content_hash,
            created_at: row.created_at,
            updated_at: row.updated_at,
        })
    }
}

const SNAPSHOT_COLUMNS: &str = "id, source_host_id, source_agent, scope, scope_key, revision, content, content_hash, created_at, updated_at";

pub async fn upsert_snapshot(
    pool: &PgPool,
    owner_user_id: Uuid,
    request: &UpsertAgentMemorySnapshotRequest,
) -> anyhow::Result<UpsertAgentMemorySnapshotResponse> {
    let scope_key = normalized_scope_key(request.scope, request.scope_key.as_deref())?;
    let agent = agent_name(request.source_agent);
    let scope = scope_name(request.scope);
    let id = Uuid::new_v4();

    let query = format!(
        "INSERT INTO agent_memory_snapshots \
         (id, owner_user_id, source_host_id, source_agent, scope, scope_key, content, content_hash) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
         ON CONFLICT (owner_user_id, source_host_id, source_agent, scope, scope_key) DO UPDATE SET \
           revision = agent_memory_snapshots.revision + 1, \
           content = EXCLUDED.content, content_hash = EXCLUDED.content_hash, updated_at = NOW() \
         WHERE agent_memory_snapshots.content_hash <> EXCLUDED.content_hash \
         RETURNING {SNAPSHOT_COLUMNS}"
    );
    let changed = sqlx::query_as::<_, SnapshotRow>(&query)
        .bind(id)
        .bind(owner_user_id)
        .bind(request.source_host_id)
        .bind(agent)
        .bind(scope)
        .bind(&scope_key)
        .bind(&request.content)
        .bind(&request.content_hash)
        .fetch_optional(pool)
        .await?;

    let (row, changed) = match changed {
        Some(row) => (row, true),
        None => {
            let query = format!(
                "SELECT {SNAPSHOT_COLUMNS} FROM agent_memory_snapshots \
                 WHERE owner_user_id = $1 AND source_host_id = $2 AND source_agent = $3 \
                 AND scope = $4 AND scope_key = $5"
            );
            let row = sqlx::query_as::<_, SnapshotRow>(&query)
                .bind(owner_user_id)
                .bind(request.source_host_id)
                .bind(agent)
                .bind(scope)
                .bind(&scope_key)
                .fetch_one(pool)
                .await?;
            (row, false)
        }
    };

    Ok(UpsertAgentMemorySnapshotResponse {
        snapshot: row.try_into()?,
        changed,
    })
}

pub async fn inbox(
    pool: &PgPool,
    owner_user_id: Uuid,
    target_host_id: Uuid,
    target_agent: AgentMemoryKind,
    scope: AgentMemoryScope,
    scope_key: Option<&str>,
) -> anyhow::Result<AgentMemoryInboxResponse> {
    let scope_key = normalized_scope_key(scope, scope_key)?;
    let query = format!(
        "SELECT {SNAPSHOT_COLUMNS} FROM agent_memory_snapshots s \
         LEFT JOIN agent_memory_receipts r ON r.snapshot_id = s.id \
           AND r.target_host_id = $2 AND r.target_agent = $3 \
         WHERE s.owner_user_id = $1 AND s.scope = $4 AND s.scope_key = $5 \
           AND NOT (s.source_host_id = $2 AND s.source_agent = $3) \
           AND (COALESCE(r.processed_revision, 0) < s.revision OR r.status = 'deferred') \
         ORDER BY s.updated_at ASC LIMIT 20"
    );
    let rows = sqlx::query_as::<_, SnapshotRow>(&query)
        .bind(owner_user_id)
        .bind(target_host_id)
        .bind(agent_name(target_agent))
        .bind(scope_name(scope))
        .bind(scope_key)
        .fetch_all(pool)
        .await?;

    Ok(AgentMemoryInboxResponse {
        snapshots: rows
            .into_iter()
            .map(TryInto::try_into)
            .collect::<anyhow::Result<_>>()?,
    })
}

pub async fn find_snapshot(
    pool: &PgPool,
    owner_user_id: Uuid,
    source_host_id: Uuid,
    source_agent: AgentMemoryKind,
    scope: AgentMemoryScope,
    scope_key: Option<&str>,
) -> anyhow::Result<Option<AgentMemorySnapshot>> {
    let scope_key = normalized_scope_key(scope, scope_key)?;
    let query = format!(
        "SELECT {SNAPSHOT_COLUMNS} FROM agent_memory_snapshots \
         WHERE owner_user_id = $1 AND source_host_id = $2 AND source_agent = $3 \
         AND scope = $4 AND scope_key = $5"
    );
    sqlx::query_as::<_, SnapshotRow>(&query)
        .bind(owner_user_id)
        .bind(source_host_id)
        .bind(agent_name(source_agent))
        .bind(scope_name(scope))
        .bind(scope_key)
        .fetch_optional(pool)
        .await?
        .map(TryInto::try_into)
        .transpose()
}

pub async fn record_receipt(
    pool: &PgPool,
    owner_user_id: Uuid,
    request: &RecordAgentMemoryReceiptRequest,
) -> anyhow::Result<Option<AgentMemoryReceipt>> {
    #[derive(FromRow)]
    struct ReceiptRow {
        snapshot_id: Uuid,
        target_host_id: Uuid,
        target_agent: String,
        processed_revision: i64,
        status: String,
        reason: Option<String>,
        processed_at: DateTime<Utc>,
    }

    let row = sqlx::query_as::<_, ReceiptRow>(
        "INSERT INTO agent_memory_receipts \
         (snapshot_id, target_host_id, target_agent, processed_revision, status, reason) \
         SELECT s.id, $3, $4, $5, $6, $7 FROM agent_memory_snapshots s \
         WHERE s.id = $1 AND s.owner_user_id = $2 AND s.revision >= $5 \
         ON CONFLICT (snapshot_id, target_host_id, target_agent) DO UPDATE SET \
           processed_revision = GREATEST(agent_memory_receipts.processed_revision, EXCLUDED.processed_revision), \
           status = EXCLUDED.status, reason = EXCLUDED.reason, processed_at = NOW() \
         WHERE agent_memory_receipts.processed_revision <= EXCLUDED.processed_revision \
         RETURNING snapshot_id, target_host_id, target_agent, processed_revision, status, reason, processed_at",
    )
    .bind(request.snapshot_id)
    .bind(owner_user_id)
    .bind(request.target_host_id)
    .bind(agent_name(request.target_agent))
    .bind(request.processed_revision)
    .bind(receipt_status_name(request.status))
    .bind(&request.reason)
    .fetch_optional(pool)
    .await?;

    row.map(|row| {
        Ok(AgentMemoryReceipt {
            snapshot_id: row.snapshot_id,
            target_host_id: row.target_host_id,
            target_agent: parse_agent(&row.target_agent)?,
            processed_revision: row.processed_revision,
            status: parse_receipt_status(&row.status)?,
            reason: row.reason,
            processed_at: row.processed_at,
        })
    })
    .transpose()
}

pub async fn host_belongs_to_user(
    pool: &PgPool,
    host_id: Uuid,
    user_id: Uuid,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM hosts WHERE id = $1 AND owner_user_id = $2)",
    )
    .bind(host_id)
    .bind(user_id)
    .fetch_one(pool)
    .await
}

fn normalized_scope_key(scope: AgentMemoryScope, key: Option<&str>) -> anyhow::Result<String> {
    match scope {
        AgentMemoryScope::UserGlobal => Ok(String::new()),
        AgentMemoryScope::Repository => key
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| anyhow::anyhow!("repository scope requires scope_key")),
    }
}

fn agent_name(agent: AgentMemoryKind) -> &'static str {
    match agent {
        AgentMemoryKind::ClaudeCode => "claude_code",
        AgentMemoryKind::Codex => "codex",
    }
}

fn scope_name(scope: AgentMemoryScope) -> &'static str {
    match scope {
        AgentMemoryScope::UserGlobal => "user_global",
        AgentMemoryScope::Repository => "repository",
    }
}

fn receipt_status_name(status: AgentMemoryReceiptStatus) -> &'static str {
    match status {
        AgentMemoryReceiptStatus::Accepted => "accepted",
        AgentMemoryReceiptStatus::Ignored => "ignored",
        AgentMemoryReceiptStatus::Deferred => "deferred",
    }
}

fn parse_agent(value: &str) -> anyhow::Result<AgentMemoryKind> {
    match value {
        "claude_code" => Ok(AgentMemoryKind::ClaudeCode),
        "codex" => Ok(AgentMemoryKind::Codex),
        _ => anyhow::bail!("unknown agent memory kind: {value}"),
    }
}

fn parse_scope(value: &str) -> anyhow::Result<AgentMemoryScope> {
    match value {
        "user_global" => Ok(AgentMemoryScope::UserGlobal),
        "repository" => Ok(AgentMemoryScope::Repository),
        _ => anyhow::bail!("unknown agent memory scope: {value}"),
    }
}

fn parse_receipt_status(value: &str) -> anyhow::Result<AgentMemoryReceiptStatus> {
    match value {
        "accepted" => Ok(AgentMemoryReceiptStatus::Accepted),
        "ignored" => Ok(AgentMemoryReceiptStatus::Ignored),
        "deferred" => Ok(AgentMemoryReceiptStatus::Deferred),
        _ => anyhow::bail!("unknown agent memory receipt status: {value}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repository_scope_requires_a_key() {
        assert!(normalized_scope_key(AgentMemoryScope::Repository, None).is_err());
        assert!(normalized_scope_key(AgentMemoryScope::Repository, Some(" ")).is_err());
        assert_eq!(
            normalized_scope_key(AgentMemoryScope::Repository, Some(" repo ")).unwrap(),
            "repo"
        );
    }

    #[test]
    fn global_scope_discards_a_key() {
        assert_eq!(
            normalized_scope_key(AgentMemoryScope::UserGlobal, Some("ignored")).unwrap(),
            ""
        );
    }
}
