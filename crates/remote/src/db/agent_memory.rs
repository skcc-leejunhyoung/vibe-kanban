use std::collections::{HashMap, HashSet};

use api_types::{
    AgentMemoryInboxResponse, AgentMemoryKind, AgentMemoryMutation,
    AgentMemoryMutationInboxResponse, AgentMemoryMutationOperation, AgentMemoryReceipt,
    AgentMemoryReceiptStatus, AgentMemoryScope, AgentMemorySnapshot, AgentMemorySyncJob,
    AgentMemorySyncSession, AgentMemorySyncSessionTarget, AgentMemorySyncTarget,
    CreateAgentMemoryMutationRequest, CreateAgentMemorySyncSessionRequest,
    RecordAgentMemoryMutationReceiptRequest, RecordAgentMemoryReceiptRequest,
    RegisterAgentMemorySyncTargetRequest, ReportAgentMemorySyncJobRequest,
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

#[derive(FromRow)]
struct MutationRow {
    id: Uuid,
    memory_id: Uuid,
    generation: i64,
    operation: String,
    scope: String,
    scope_key: String,
    match_text: String,
    replacement_text: Option<String>,
    created_at: DateTime<Utc>,
    receipt_count: i64,
}

impl TryFrom<MutationRow> for AgentMemoryMutation {
    type Error = anyhow::Error;

    fn try_from(row: MutationRow) -> Result<Self, Self::Error> {
        Ok(Self {
            id: row.id,
            memory_id: row.memory_id,
            generation: row.generation,
            operation: parse_mutation_operation(&row.operation)?,
            scope: parse_scope(&row.scope)?,
            scope_key: (!row.scope_key.is_empty()).then_some(row.scope_key),
            match_text: row.match_text,
            replacement_text: row.replacement_text,
            created_at: row.created_at,
            receipt_count: row.receipt_count,
        })
    }
}

const MUTATION_COLUMNS: &str = "m.id, m.memory_id, m.generation, m.operation, m.scope, m.scope_key, m.match_text, m.replacement_text, m.created_at, (SELECT COUNT(*) FROM agent_memory_mutation_receipts r WHERE r.mutation_id = m.id AND r.status = 'accepted') AS receipt_count";

#[derive(FromRow)]
struct MutationDeliveryState {
    id: Uuid,
    memory_id: Uuid,
    receipt_status: Option<String>,
}

fn select_mutation_deliveries(
    states: &[MutationDeliveryState],
    include_applied_guards: bool,
) -> Vec<Uuid> {
    let mut per_memory = HashMap::<Uuid, (Uuid, Option<Uuid>)>::new();
    for state in states {
        let entry = per_memory
            .entry(state.memory_id)
            .or_insert((state.id, None));
        entry.0 = state.id;
        if entry.1.is_none()
            && state
                .receipt_status
                .as_deref()
                .is_none_or(|status| status == "deferred")
        {
            entry.1 = Some(state.id);
        }
    }

    let selected = per_memory
        .into_values()
        .filter_map(|(latest, pending)| {
            pending.or_else(|| include_applied_guards.then_some(latest))
        })
        .collect::<HashSet<_>>();
    states
        .iter()
        .filter_map(|state| selected.contains(&state.id).then_some(state.id))
        .collect()
}

pub async fn create_mutation(
    pool: &PgPool,
    owner_user_id: Uuid,
    request: &CreateAgentMemoryMutationRequest,
) -> anyhow::Result<AgentMemoryMutation> {
    let memory_id = request.memory_id.unwrap_or_else(Uuid::new_v4);
    let scope_key = normalized_scope_key(request.scope, request.scope_key.as_deref())?;
    let mut transaction = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))")
        .bind(memory_id)
        .execute(&mut *transaction)
        .await?;
    let current: Option<(i64, String, String, String)> = sqlx::query_as(
        "SELECT generation, scope, scope_key, operation FROM agent_memory_mutations WHERE owner_user_id = $1 AND memory_id = $2 ORDER BY generation DESC LIMIT 1",
    )
    .bind(owner_user_id)
    .bind(memory_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let current_generation = current.as_ref().map(|row| row.0);
    if request.memory_id.is_some() && request.expected_generation != current_generation {
        anyhow::bail!("memory generation conflict");
    }
    if request.memory_id.is_none() && request.expected_generation.is_some() {
        anyhow::bail!("new memory mutation cannot have an expected generation");
    }
    if let Some((_, current_scope, current_scope_key, current_operation)) = &current {
        if current_scope != scope_name(request.scope) || current_scope_key != &scope_key {
            anyhow::bail!("memory mutation scope cannot change");
        }
        if current_operation == "delete" {
            anyhow::bail!("deleted memory cannot be changed without an explicit restore");
        }
    }
    let generation = current_generation.unwrap_or(0) + 1;
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_memory_mutations (id, owner_user_id, memory_id, generation, operation, scope, scope_key, match_text, replacement_text) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(id)
    .bind(owner_user_id)
    .bind(memory_id)
    .bind(generation)
    .bind(mutation_operation_name(request.operation))
    .bind(scope_name(request.scope))
    .bind(scope_key)
    .bind(request.match_text.trim())
    .bind(request.replacement_text.as_deref().map(str::trim))
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    find_mutation(pool, owner_user_id, id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("created mutation not found"))
}

pub async fn list_mutations(
    pool: &PgPool,
    owner_user_id: Uuid,
) -> anyhow::Result<Vec<AgentMemoryMutation>> {
    let query = format!(
        "SELECT {MUTATION_COLUMNS} FROM agent_memory_mutations m INNER JOIN (SELECT memory_id, MAX(generation) generation FROM agent_memory_mutations WHERE owner_user_id = $1 GROUP BY memory_id) latest ON latest.memory_id = m.memory_id AND latest.generation = m.generation WHERE m.owner_user_id = $1 ORDER BY m.created_at DESC LIMIT 200"
    );
    sqlx::query_as::<_, MutationRow>(&query)
        .bind(owner_user_id)
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(TryInto::try_into)
        .collect()
}

async fn find_mutation(
    pool: &PgPool,
    owner_user_id: Uuid,
    id: Uuid,
) -> anyhow::Result<Option<AgentMemoryMutation>> {
    let query = format!(
        "SELECT {MUTATION_COLUMNS} FROM agent_memory_mutations m WHERE m.owner_user_id = $1 AND m.id = $2"
    );
    sqlx::query_as::<_, MutationRow>(&query)
        .bind(owner_user_id)
        .bind(id)
        .fetch_optional(pool)
        .await?
        .map(TryInto::try_into)
        .transpose()
}

pub async fn mutation_inbox(
    pool: &PgPool,
    owner_user_id: Uuid,
    target_host_id: Uuid,
    target_agent: AgentMemoryKind,
    target_scope_key: &str,
    scope: AgentMemoryScope,
    scope_key: Option<&str>,
    include_applied_guards: bool,
) -> anyhow::Result<AgentMemoryMutationInboxResponse> {
    let scope_key = normalized_scope_key(scope, scope_key)?;
    let states = sqlx::query_as::<_, MutationDeliveryState>(
        "SELECT m.id, m.memory_id, receipt.status AS receipt_status \
         FROM agent_memory_mutations m \
         LEFT JOIN agent_memory_mutation_receipts receipt \
           ON receipt.mutation_id = m.id \
          AND receipt.target_host_id = $4 \
          AND receipt.target_agent = $5 \
          AND receipt.target_scope_key = $6 \
         WHERE m.owner_user_id = $1 AND m.scope = $2 AND m.scope_key = $3 \
         ORDER BY m.created_at ASC, m.generation ASC",
    )
    .bind(owner_user_id)
    .bind(scope_name(scope))
    .bind(&scope_key)
    .bind(target_host_id)
    .bind(agent_name(target_agent))
    .bind(target_scope_key)
    .fetch_all(pool)
    .await?;
    let mutation_ids = select_mutation_deliveries(&states, include_applied_guards);
    if mutation_ids.is_empty() {
        return Ok(AgentMemoryMutationInboxResponse {
            mutations: Vec::new(),
        });
    }
    let query = format!(
        "SELECT {MUTATION_COLUMNS} FROM agent_memory_mutations m \
         WHERE m.owner_user_id = $1 AND m.id = ANY($2) \
         ORDER BY m.created_at ASC"
    );
    let mutations = sqlx::query_as::<_, MutationRow>(&query)
        .bind(owner_user_id)
        .bind(mutation_ids)
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(TryInto::try_into)
        .collect::<anyhow::Result<_>>()?;
    Ok(AgentMemoryMutationInboxResponse { mutations })
}

pub async fn record_mutation_receipt(
    pool: &PgPool,
    owner_user_id: Uuid,
    request: &RecordAgentMemoryMutationReceiptRequest,
) -> anyhow::Result<bool> {
    let result = sqlx::query(
        "INSERT INTO agent_memory_mutation_receipts (mutation_id, target_host_id, target_agent, target_scope_key, status, reason) SELECT m.id, $3, $4, $5, $6, $7 FROM agent_memory_mutations m WHERE m.id = $1 AND m.owner_user_id = $2 ON CONFLICT (mutation_id, target_host_id, target_agent, target_scope_key) DO UPDATE SET status = EXCLUDED.status, reason = EXCLUDED.reason, processed_at = NOW()",
    )
    .bind(request.mutation_id)
    .bind(owner_user_id)
    .bind(request.target_host_id)
    .bind(agent_name(request.target_agent))
    .bind(request.target_scope_key.as_deref().unwrap_or(""))
    .bind(receipt_status_name(request.status))
    .bind(&request.reason)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

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

#[derive(FromRow)]
struct SyncTargetRow {
    host_id: Uuid,
    enabled: bool,
    agents: Vec<String>,
    repository_keys: Vec<String>,
    updated_at: DateTime<Utc>,
}

impl TryFrom<SyncTargetRow> for AgentMemorySyncTarget {
    type Error = anyhow::Error;

    fn try_from(row: SyncTargetRow) -> Result<Self, Self::Error> {
        Ok(Self {
            host_id: row.host_id,
            enabled: row.enabled,
            agents: row
                .agents
                .iter()
                .map(|agent| parse_agent(agent))
                .collect::<anyhow::Result<_>>()?,
            repository_keys: row.repository_keys,
            updated_at: row.updated_at,
        })
    }
}

#[derive(FromRow)]
struct SyncSessionRow {
    id: Uuid,
    status: String,
    round: i64,
    max_rounds: i64,
    target_count: i64,
    completed_count: i64,
    created_at: DateTime<Utc>,
    finished_at: Option<DateTime<Utc>>,
}

impl From<SyncSessionRow> for AgentMemorySyncSession {
    fn from(row: SyncSessionRow) -> Self {
        Self {
            id: row.id,
            status: row.status,
            round: row.round,
            max_rounds: row.max_rounds,
            target_count: row.target_count,
            completed_count: row.completed_count,
            created_at: row.created_at,
            finished_at: row.finished_at,
        }
    }
}

const SYNC_SESSION_COLUMNS: &str = "s.id, s.status, s.round, s.max_rounds, (SELECT COUNT(*) FROM agent_memory_sync_session_targets t WHERE t.session_id = s.id) AS target_count, (SELECT COUNT(*) FROM agent_memory_sync_session_targets t WHERE t.session_id = s.id AND t.status = 'completed') AS completed_count, s.created_at, s.finished_at";

pub async fn register_sync_target(
    pool: &PgPool,
    owner_user_id: Uuid,
    request: &RegisterAgentMemorySyncTargetRequest,
) -> anyhow::Result<AgentMemorySyncTarget> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 1))")
        .bind(owner_user_id)
        .execute(&mut *tx)
        .await?;
    let mut agents = request
        .agents
        .iter()
        .map(|agent| agent_name(*agent).to_string())
        .collect::<Vec<_>>();
    agents.sort();
    agents.dedup();
    let mut repository_keys = request
        .repository_keys
        .iter()
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
        .collect::<Vec<_>>();
    repository_keys.sort();
    repository_keys.dedup();
    let row = sqlx::query_as::<_, SyncTargetRow>(
        "INSERT INTO agent_memory_sync_targets (owner_user_id, host_id, enabled, agents, repository_keys) SELECT $1, h.id, $3, $4, $5 FROM hosts h WHERE h.id = $2 AND h.owner_user_id = $1 ON CONFLICT (owner_user_id, host_id) DO UPDATE SET enabled = EXCLUDED.enabled, agents = EXCLUDED.agents, repository_keys = EXCLUDED.repository_keys, updated_at = NOW() RETURNING host_id, enabled, agents, repository_keys, updated_at",
    )
    .bind(owner_user_id)
    .bind(request.host_id)
    .bind(request.enabled)
    .bind(agents)
    .bind(repository_keys)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| anyhow::anyhow!("host not found"))?;
    if request.enabled && !request.agents.is_empty() && !request.repository_keys.is_empty() {
        sqlx::query("INSERT INTO agent_memory_sync_session_targets (session_id, host_id, round, status) SELECT session.id, $2, session.round, 'pending' FROM agent_memory_sync_sessions session WHERE session.owner_user_id = $1 AND session.status = 'running' ON CONFLICT (session_id, host_id) DO NOTHING")
            .bind(owner_user_id)
            .bind(request.host_id)
            .execute(&mut *tx)
            .await?;
    } else {
        sqlx::query("DELETE FROM agent_memory_sync_session_targets target USING agent_memory_sync_sessions session WHERE target.session_id = session.id AND session.owner_user_id = $1 AND session.status = 'running' AND target.host_id = $2")
            .bind(owner_user_id)
            .bind(request.host_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE agent_memory_sync_sessions session SET status = 'partial', error = 'target opted out during synchronization', finished_at = NOW() WHERE session.owner_user_id = $1 AND session.status = 'running' AND NOT EXISTS (SELECT 1 FROM agent_memory_sync_session_targets target WHERE target.session_id = session.id AND target.status IN ('pending', 'running', 'waiting'))")
            .bind(owner_user_id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    row.try_into()
}

pub async fn create_sync_session(
    pool: &PgPool,
    owner_user_id: Uuid,
    request: &CreateAgentMemorySyncSessionRequest,
) -> anyhow::Result<AgentMemorySyncSession> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 1))")
        .bind(owner_user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM agent_memory_sync_session_targets target USING agent_memory_sync_sessions session, hosts host WHERE target.session_id = session.id AND host.id = target.host_id AND session.owner_user_id = $1 AND session.status = 'running' AND host.status <> 'online'")
        .bind(owner_user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE agent_memory_sync_sessions session SET status = 'partial', error = 'all targets went offline', finished_at = NOW() WHERE session.owner_user_id = $1 AND session.status = 'running' AND NOT EXISTS (SELECT 1 FROM agent_memory_sync_session_targets target WHERE target.session_id = session.id)")
        .bind(owner_user_id)
        .execute(&mut *tx)
        .await?;
    let query = format!(
        "SELECT {SYNC_SESSION_COLUMNS} FROM agent_memory_sync_sessions s WHERE s.owner_user_id = $1 AND s.status = 'running' LIMIT 1"
    );
    if let Some(row) = sqlx::query_as::<_, SyncSessionRow>(&query)
        .bind(owner_user_id)
        .fetch_optional(&mut *tx)
        .await?
    {
        tx.commit().await?;
        return Ok(row.into());
    }
    if request.trigger_kind.starts_with("scheduled:") {
        let query = format!(
            "SELECT {SYNC_SESSION_COLUMNS} FROM agent_memory_sync_sessions s WHERE s.owner_user_id = $1 AND s.trigger_kind = $2 ORDER BY s.created_at DESC LIMIT 1"
        );
        if let Some(row) = sqlx::query_as::<_, SyncSessionRow>(&query)
            .bind(owner_user_id)
            .bind(request.trigger_kind.trim())
            .fetch_optional(&mut *tx)
            .await?
        {
            tx.commit().await?;
            return Ok(row.into());
        }
    }
    let owned: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM hosts WHERE id = $1 AND owner_user_id = $2)",
    )
    .bind(request.requested_by_host_id)
    .bind(owner_user_id)
    .fetch_one(&mut *tx)
    .await?;
    if !owned {
        anyhow::bail!("requesting host not found");
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO agent_memory_sync_sessions (id, owner_user_id, requested_by_host_id, trigger_kind, status) VALUES ($1, $2, $3, $4, 'running')")
        .bind(id)
        .bind(owner_user_id)
        .bind(request.requested_by_host_id)
        .bind(request.trigger_kind.trim())
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO agent_memory_sync_session_targets (session_id, host_id, status) SELECT $1, t.host_id, 'pending' FROM agent_memory_sync_targets t INNER JOIN hosts h ON h.id = t.host_id WHERE t.owner_user_id = $2 AND t.enabled AND cardinality(t.agents) > 0 AND cardinality(t.repository_keys) > 0 AND h.status = 'online'")
        .bind(id)
        .bind(owner_user_id)
        .execute(&mut *tx)
        .await?;
    let target_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM agent_memory_sync_session_targets WHERE session_id = $1",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    if target_count == 0 {
        sqlx::query("UPDATE agent_memory_sync_sessions SET status = 'completed', finished_at = NOW() WHERE id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    let query =
        format!("SELECT {SYNC_SESSION_COLUMNS} FROM agent_memory_sync_sessions s WHERE s.id = $1");
    let row = sqlx::query_as::<_, SyncSessionRow>(&query)
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(row.into())
}

pub async fn latest_sync_session(
    pool: &PgPool,
    owner_user_id: Uuid,
) -> anyhow::Result<Option<AgentMemorySyncSession>> {
    let query = format!(
        "SELECT {SYNC_SESSION_COLUMNS} FROM agent_memory_sync_sessions s WHERE s.owner_user_id = $1 ORDER BY s.created_at DESC LIMIT 1"
    );
    let row = sqlx::query_as::<_, SyncSessionRow>(&query)
        .bind(owner_user_id)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(Into::into))
}

pub async fn list_sync_session_targets(
    pool: &PgPool,
    owner_user_id: Uuid,
    session_id: Uuid,
) -> anyhow::Result<Vec<AgentMemorySyncSessionTarget>> {
    #[derive(FromRow)]
    struct Row {
        host_id: Uuid,
        host_name: String,
        round: i64,
        status: String,
        attempts: i64,
        error: Option<String>,
        retry_at: Option<DateTime<Utc>>,
        updated_at: DateTime<Utc>,
    }
    Ok(sqlx::query_as::<_, Row>(
        "SELECT target.host_id, host.name AS host_name, target.round, target.status, target.attempts, target.error, target.retry_at, target.updated_at FROM agent_memory_sync_session_targets target INNER JOIN agent_memory_sync_sessions session ON session.id = target.session_id INNER JOIN hosts host ON host.id = target.host_id WHERE target.session_id = $1 AND session.owner_user_id = $2 ORDER BY host.name, target.host_id",
    )
    .bind(session_id)
    .bind(owner_user_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|row| AgentMemorySyncSessionTarget {
        host_id: row.host_id,
        host_name: row.host_name,
        round: row.round,
        status: row.status,
        attempts: row.attempts,
        error: row.error,
        retry_at: row.retry_at,
        updated_at: row.updated_at,
    })
    .collect())
}

pub async fn claim_sync_job(
    pool: &PgPool,
    owner_user_id: Uuid,
    host_id: Uuid,
) -> anyhow::Result<Option<AgentMemorySyncJob>> {
    #[derive(FromRow)]
    struct Row {
        session_id: Uuid,
        round: i64,
        max_rounds: i64,
        trigger_kind: String,
    }
    sqlx::query("DELETE FROM agent_memory_sync_session_targets target USING agent_memory_sync_sessions session, hosts host WHERE target.session_id = session.id AND host.id = target.host_id AND session.owner_user_id = $1 AND session.status = 'running' AND host.status <> 'online'")
        .bind(owner_user_id)
        .execute(pool)
        .await?;
    sqlx::query("UPDATE agent_memory_sync_sessions session SET status = 'partial', error = 'no online targets remain', finished_at = NOW() WHERE session.owner_user_id = $1 AND session.status = 'running' AND NOT EXISTS (SELECT 1 FROM agent_memory_sync_session_targets target WHERE target.session_id = session.id AND target.status IN ('pending', 'running', 'waiting'))")
        .bind(owner_user_id)
        .execute(pool)
        .await?;
    let row = sqlx::query_as::<_, Row>(
        "UPDATE agent_memory_sync_session_targets t SET status = 'running', attempts = attempts + 1, retry_at = NULL, updated_at = NOW() FROM agent_memory_sync_sessions s WHERE t.session_id = s.id AND s.owner_user_id = $1 AND t.host_id = $2 AND s.status = 'running' AND t.round = s.round AND (t.status = 'pending' OR (t.status = 'waiting' AND t.retry_at <= NOW()) OR (t.status = 'running' AND t.updated_at < NOW() - INTERVAL '20 minutes')) RETURNING s.id AS session_id, s.round, s.max_rounds, s.trigger_kind",
    )
    .bind(owner_user_id)
    .bind(host_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|row| AgentMemorySyncJob {
        session_id: row.session_id,
        round: row.round,
        max_rounds: row.max_rounds,
        trigger_kind: row.trigger_kind,
    }))
}

pub async fn report_sync_job(
    pool: &PgPool,
    owner_user_id: Uuid,
    request: &ReportAgentMemorySyncJobRequest,
) -> anyhow::Result<AgentMemorySyncSession> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 2))")
        .bind(request.session_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 1))")
        .bind(owner_user_id)
        .execute(&mut *tx)
        .await?;
    let updated = sqlx::query("UPDATE agent_memory_sync_session_targets t SET status = $5, error = $6, retry_at = $7, updated_at = NOW() FROM agent_memory_sync_sessions s WHERE t.session_id = $1 AND t.host_id = $2 AND t.round = $3 AND s.id = t.session_id AND s.owner_user_id = $4 AND s.status = 'running'")
        .bind(request.session_id)
        .bind(request.host_id)
        .bind(request.round)
        .bind(owner_user_id)
        .bind(if request.succeeded {
            "completed"
        } else if request.retry_at.is_some() {
            "waiting"
        } else {
            "failed"
        })
        .bind(&request.error)
        .bind(request.retry_at)
        .execute(&mut *tx)
        .await?;
    if updated.rows_affected() == 0 {
        anyhow::bail!("stale or unknown sync job");
    }
    sqlx::query("DELETE FROM agent_memory_sync_session_targets target USING hosts host WHERE target.session_id = $1 AND host.id = target.host_id AND host.status <> 'online'")
        .bind(request.session_id)
        .execute(&mut *tx)
        .await?;
    let unsettled: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_memory_sync_session_targets WHERE session_id = $1 AND status IN ('pending', 'running', 'waiting')")
        .bind(request.session_id)
        .fetch_one(&mut *tx)
        .await?;
    if unsettled == 0 {
        let (round, max_rounds): (i64, i64) = sqlx::query_as(
            "SELECT round, max_rounds FROM agent_memory_sync_sessions WHERE id = $1",
        )
        .bind(request.session_id)
        .fetch_one(&mut *tx)
        .await?;
        let failures: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_memory_sync_session_targets WHERE session_id = $1 AND status = 'failed'")
            .bind(request.session_id)
            .fetch_one(&mut *tx)
            .await?;
        let pending: bool =
            sync_session_has_pending(&mut tx, owner_user_id, request.session_id).await?;
        if failures == 0 && !pending {
            sqlx::query("UPDATE agent_memory_sync_sessions SET status = 'completed', finished_at = NOW() WHERE id = $1")
                .bind(request.session_id)
                .execute(&mut *tx)
                .await?;
        } else if round < max_rounds {
            sqlx::query("UPDATE agent_memory_sync_sessions SET round = round + 1 WHERE id = $1")
                .bind(request.session_id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("UPDATE agent_memory_sync_session_targets SET round = round + 1, status = 'pending', error = NULL, retry_at = NULL, updated_at = NOW() WHERE session_id = $1")
                .bind(request.session_id)
                .execute(&mut *tx)
                .await?;
        } else {
            sqlx::query("UPDATE agent_memory_sync_sessions SET status = 'partial', error = 'targets did not converge before max rounds', finished_at = NOW() WHERE id = $1")
                .bind(request.session_id)
                .execute(&mut *tx)
                .await?;
        }
    }
    let query = format!(
        "SELECT {SYNC_SESSION_COLUMNS} FROM agent_memory_sync_sessions s WHERE s.id = $1 AND s.owner_user_id = $2"
    );
    let row = sqlx::query_as::<_, SyncSessionRow>(&query)
        .bind(request.session_id)
        .bind(owner_user_id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(row.into())
}

async fn sync_session_has_pending(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    owner_user_id: Uuid,
    session_id: Uuid,
) -> anyhow::Result<bool> {
    sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM agent_memory_sync_session_targets st INNER JOIN agent_memory_sync_targets target ON target.owner_user_id = $1 AND target.host_id = st.host_id CROSS JOIN LATERAL unnest(target.agents) agent CROSS JOIN LATERAL unnest(target.repository_keys) repo_key INNER JOIN agent_memory_snapshots snapshot ON snapshot.owner_user_id = $1 AND snapshot.scope = 'repository' AND snapshot.scope_key = repo_key AND NOT (snapshot.source_host_id = st.host_id AND snapshot.source_agent = agent) LEFT JOIN agent_memory_receipts receipt ON receipt.snapshot_id = snapshot.id AND receipt.target_host_id = st.host_id AND receipt.target_agent = agent WHERE st.session_id = $2 AND (receipt.snapshot_id IS NULL OR receipt.processed_revision < snapshot.revision OR receipt.status = 'deferred')) OR EXISTS(SELECT 1 FROM agent_memory_sync_session_targets st INNER JOIN agent_memory_sync_targets target ON target.owner_user_id = $1 AND target.host_id = st.host_id CROSS JOIN LATERAL unnest(target.agents) agent CROSS JOIN LATERAL unnest(target.repository_keys) repo_key INNER JOIN agent_memory_mutations mutation ON mutation.owner_user_id = $1 AND (mutation.scope = 'user_global' OR (mutation.scope = 'repository' AND mutation.scope_key = repo_key)) LEFT JOIN agent_memory_mutation_receipts receipt ON receipt.mutation_id = mutation.id AND receipt.target_host_id = st.host_id AND receipt.target_agent = agent AND receipt.target_scope_key = repo_key WHERE st.session_id = $2 AND (receipt.mutation_id IS NULL OR receipt.status = 'deferred'))",
    )
    .bind(owner_user_id)
    .bind(session_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(Into::into)
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

fn mutation_operation_name(operation: AgentMemoryMutationOperation) -> &'static str {
    match operation {
        AgentMemoryMutationOperation::Update => "update",
        AgentMemoryMutationOperation::Delete => "delete",
    }
}

fn parse_mutation_operation(value: &str) -> anyhow::Result<AgentMemoryMutationOperation> {
    match value {
        "update" => Ok(AgentMemoryMutationOperation::Update),
        "delete" => Ok(AgentMemoryMutationOperation::Delete),
        _ => anyhow::bail!("unknown memory mutation operation: {value}"),
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

    fn delivery_state(
        id: Uuid,
        memory_id: Uuid,
        receipt_status: Option<&str>,
    ) -> MutationDeliveryState {
        MutationDeliveryState {
            id,
            memory_id,
            receipt_status: receipt_status.map(str::to_string),
        }
    }

    #[test]
    fn mutation_delivery_advances_offline_hosts_one_generation_at_a_time() {
        let memory_id = Uuid::new_v4();
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();

        assert_eq!(
            select_mutation_deliveries(
                &[
                    delivery_state(first, memory_id, None),
                    delivery_state(second, memory_id, None),
                ],
                true,
            ),
            vec![first]
        );
        assert_eq!(
            select_mutation_deliveries(
                &[
                    delivery_state(first, memory_id, Some("accepted")),
                    delivery_state(second, memory_id, None),
                ],
                true,
            ),
            vec![second]
        );
    }

    #[test]
    fn mutation_delivery_keeps_latest_guard_active_after_catch_up() {
        let memory_id = Uuid::new_v4();
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();

        assert_eq!(
            select_mutation_deliveries(
                &[
                    delivery_state(first, memory_id, Some("accepted")),
                    delivery_state(second, memory_id, Some("ignored")),
                ],
                true,
            ),
            vec![second]
        );
    }

    #[test]
    fn pending_mutation_delivery_excludes_applied_latest_guard() {
        let memory_id = Uuid::new_v4();
        let latest = Uuid::new_v4();

        assert!(
            select_mutation_deliveries(
                &[delivery_state(latest, memory_id, Some("ignored"))],
                false,
            )
            .is_empty()
        );
        assert_eq!(
            select_mutation_deliveries(
                &[delivery_state(latest, memory_id, Some("deferred"))],
                false,
            ),
            vec![latest]
        );
    }

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
