CREATE TABLE agent_memory_sync_logs (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
    phase TEXT NOT NULL,
    trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('scheduled', 'manual')),
    repo_name TEXT,
    repo_path TEXT,
    agent_kind TEXT,
    message TEXT NOT NULL
);

CREATE INDEX idx_agent_memory_sync_logs_created_at
    ON agent_memory_sync_logs(created_at DESC);
CREATE INDEX idx_agent_memory_sync_logs_run_id
    ON agent_memory_sync_logs(run_id, created_at);
