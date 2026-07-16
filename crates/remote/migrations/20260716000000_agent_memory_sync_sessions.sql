CREATE TABLE agent_memory_sync_targets (
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    host_id UUID NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    agents TEXT[] NOT NULL DEFAULT '{}',
    repository_keys TEXT[] NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_user_id, host_id)
);

CREATE TABLE agent_memory_sync_sessions (
    id UUID PRIMARY KEY,
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    requested_by_host_id UUID NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    trigger_kind TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'partial', 'failed')),
    round BIGINT NOT NULL DEFAULT 1 CHECK (round > 0),
    max_rounds BIGINT NOT NULL DEFAULT 5 CHECK (max_rounds > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    error TEXT
);

CREATE UNIQUE INDEX idx_agent_memory_sync_one_running_session
    ON agent_memory_sync_sessions(owner_user_id)
    WHERE status = 'running';

CREATE TABLE agent_memory_sync_session_targets (
    session_id UUID NOT NULL REFERENCES agent_memory_sync_sessions(id) ON DELETE CASCADE,
    host_id UUID NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    round BIGINT NOT NULL DEFAULT 1 CHECK (round > 0),
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    attempts BIGINT NOT NULL DEFAULT 0,
    error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (session_id, host_id)
);

CREATE INDEX idx_agent_memory_sync_session_targets_pending
    ON agent_memory_sync_session_targets(host_id, status, updated_at);
