CREATE TABLE agent_memory_mutations (
    id UUID PRIMARY KEY,
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    memory_id UUID NOT NULL,
    generation BIGINT NOT NULL CHECK (generation > 0),
    operation TEXT NOT NULL CHECK (operation IN ('update', 'delete')),
    scope TEXT NOT NULL CHECK (scope IN ('user_global', 'repository')),
    scope_key TEXT NOT NULL DEFAULT '',
    match_text TEXT NOT NULL,
    replacement_text TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT agent_memory_mutation_scope_key CHECK (
        (scope = 'user_global' AND scope_key = '') OR
        (scope = 'repository' AND scope_key <> '')
    ),
    CONSTRAINT agent_memory_mutation_payload CHECK (
        (operation = 'update' AND replacement_text IS NOT NULL AND replacement_text <> '') OR
        (operation = 'delete' AND replacement_text IS NULL)
    ),
    UNIQUE (owner_user_id, memory_id, generation)
);

CREATE TABLE agent_memory_mutation_receipts (
    mutation_id UUID NOT NULL REFERENCES agent_memory_mutations(id) ON DELETE CASCADE,
    target_host_id UUID NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    target_agent TEXT NOT NULL CHECK (target_agent IN ('claude_code', 'codex')),
    target_scope_key TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('accepted', 'ignored', 'deferred')),
    reason TEXT,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (mutation_id, target_host_id, target_agent, target_scope_key)
);

CREATE INDEX idx_agent_memory_mutations_owner_scope
    ON agent_memory_mutations(owner_user_id, scope, scope_key, created_at DESC);
CREATE INDEX idx_agent_memory_mutation_receipts_target
    ON agent_memory_mutation_receipts(target_host_id, target_agent, processed_at);
