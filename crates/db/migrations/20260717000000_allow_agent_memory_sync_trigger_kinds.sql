ALTER TABLE agent_memory_sync_logs RENAME TO agent_memory_sync_logs_old;

CREATE TABLE agent_memory_sync_logs (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
    phase TEXT NOT NULL,
    trigger_kind TEXT NOT NULL,
    repo_name TEXT,
    repo_path TEXT,
    agent_kind TEXT,
    message TEXT NOT NULL
);

INSERT INTO agent_memory_sync_logs (
    id,
    run_id,
    created_at,
    level,
    phase,
    trigger_kind,
    repo_name,
    repo_path,
    agent_kind,
    message
)
SELECT
    id,
    run_id,
    created_at,
    level,
    phase,
    trigger_kind,
    repo_name,
    repo_path,
    agent_kind,
    message
FROM agent_memory_sync_logs_old;

DROP TABLE agent_memory_sync_logs_old;

CREATE INDEX idx_agent_memory_sync_logs_created_at
    ON agent_memory_sync_logs(created_at DESC);
CREATE INDEX idx_agent_memory_sync_logs_run_id
    ON agent_memory_sync_logs(run_id, created_at);

UPDATE agent_memory_sync_state
SET
    last_finished_at = last_started_at,
    last_status = 'failed',
    last_error = 'memory synchronization was interrupted before completion'
WHERE last_status = 'running';
