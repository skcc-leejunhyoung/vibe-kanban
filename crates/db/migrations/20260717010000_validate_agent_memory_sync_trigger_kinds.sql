ALTER TABLE agent_memory_sync_logs RENAME TO agent_memory_sync_logs_old;

CREATE TABLE agent_memory_sync_logs (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
    phase TEXT NOT NULL,
    trigger_kind TEXT NOT NULL CHECK (
        length(trigger_kind) BETWEEN 1 AND 64
        AND (
            trigger_kind IN ('scheduled', 'manual', 'catch_up', 'global')
            OR (
                length(trigger_kind) = 20
                AND trigger_kind GLOB 'scheduled:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
            )
        )
    ),
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
FROM agent_memory_sync_logs_old
WHERE
    length(trigger_kind) BETWEEN 1 AND 64
    AND (
        trigger_kind IN ('scheduled', 'manual', 'catch_up', 'global')
        OR (
            length(trigger_kind) = 20
            AND trigger_kind GLOB 'scheduled:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        )
    );

DROP TABLE agent_memory_sync_logs_old;

CREATE INDEX idx_agent_memory_sync_logs_created_at
    ON agent_memory_sync_logs(created_at DESC);
CREATE INDEX idx_agent_memory_sync_logs_run_id
    ON agent_memory_sync_logs(run_id, created_at);
