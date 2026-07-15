use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum AgentMemoryKind {
    ClaudeCode,
    Codex,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum AgentMemoryScope {
    UserGlobal,
    Repository,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum AgentMemoryReceiptStatus {
    Accepted,
    Ignored,
    Deferred,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum AgentMemoryMutationOperation {
    Update,
    Delete,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentMemorySnapshot {
    pub id: Uuid,
    pub source_host_id: Uuid,
    pub source_agent: AgentMemoryKind,
    pub scope: AgentMemoryScope,
    pub scope_key: Option<String>,
    pub revision: i64,
    pub content: String,
    pub content_hash: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct UpsertAgentMemorySnapshotRequest {
    pub source_host_id: Uuid,
    pub source_agent: AgentMemoryKind,
    pub scope: AgentMemoryScope,
    pub scope_key: Option<String>,
    pub content: String,
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct UpsertAgentMemorySnapshotResponse {
    pub snapshot: AgentMemorySnapshot,
    pub changed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentMemoryInboxResponse {
    pub snapshots: Vec<AgentMemorySnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct RecordAgentMemoryReceiptRequest {
    pub snapshot_id: Uuid,
    pub target_host_id: Uuid,
    pub target_agent: AgentMemoryKind,
    pub processed_revision: i64,
    pub status: AgentMemoryReceiptStatus,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentMemoryReceipt {
    pub snapshot_id: Uuid,
    pub target_host_id: Uuid,
    pub target_agent: AgentMemoryKind,
    pub processed_revision: i64,
    pub status: AgentMemoryReceiptStatus,
    pub reason: Option<String>,
    pub processed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentMemoryMutation {
    pub id: Uuid,
    pub memory_id: Uuid,
    #[ts(type = "number")]
    pub generation: i64,
    pub operation: AgentMemoryMutationOperation,
    pub scope: AgentMemoryScope,
    pub scope_key: Option<String>,
    pub match_text: String,
    pub replacement_text: Option<String>,
    pub created_at: DateTime<Utc>,
    #[ts(type = "number")]
    pub receipt_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct CreateAgentMemoryMutationRequest {
    pub memory_id: Option<Uuid>,
    #[ts(type = "number | null")]
    pub expected_generation: Option<i64>,
    pub operation: AgentMemoryMutationOperation,
    pub scope: AgentMemoryScope,
    pub scope_key: Option<String>,
    pub match_text: String,
    pub replacement_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentMemoryMutationInboxResponse {
    pub mutations: Vec<AgentMemoryMutation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct RecordAgentMemoryMutationReceiptRequest {
    pub mutation_id: Uuid,
    pub target_host_id: Uuid,
    pub target_agent: AgentMemoryKind,
    pub target_scope_key: Option<String>,
    pub status: AgentMemoryReceiptStatus,
    pub reason: Option<String>,
}
