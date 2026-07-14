CREATE TABLE agent_memory_snapshots (
    id UUID PRIMARY KEY,
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_host_id UUID NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    source_agent TEXT NOT NULL CHECK (source_agent IN ('claude_code', 'codex')),
    scope TEXT NOT NULL CHECK (scope IN ('user_global', 'repository')),
    scope_key TEXT NOT NULL DEFAULT '',
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT agent_memory_repository_scope_key CHECK (
        (scope = 'user_global' AND scope_key = '') OR
        (scope = 'repository' AND scope_key <> '')
    ),
    UNIQUE (owner_user_id, source_host_id, source_agent, scope, scope_key)
);

CREATE TABLE agent_memory_receipts (
    snapshot_id UUID NOT NULL REFERENCES agent_memory_snapshots(id) ON DELETE CASCADE,
    target_host_id UUID NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    target_agent TEXT NOT NULL CHECK (target_agent IN ('claude_code', 'codex')),
    processed_revision BIGINT NOT NULL CHECK (processed_revision > 0),
    status TEXT NOT NULL CHECK (status IN ('accepted', 'ignored', 'deferred')),
    reason TEXT,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (snapshot_id, target_host_id, target_agent)
);

CREATE INDEX idx_agent_memory_snapshots_owner_scope
    ON agent_memory_snapshots(owner_user_id, scope, scope_key);
CREATE INDEX idx_agent_memory_receipts_target
    ON agent_memory_receipts(target_host_id, target_agent, processed_revision);
