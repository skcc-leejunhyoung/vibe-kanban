ALTER TABLE agent_memory_snapshots
    ADD COLUMN entry_set_hash TEXT;

CREATE TABLE agent_memory_entries (
    entry_key TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (entry_key = content_hash)
);

CREATE TABLE agent_memory_snapshot_entries (
    snapshot_id UUID NOT NULL REFERENCES agent_memory_snapshots(id) ON DELETE CASCADE,
    entry_key TEXT NOT NULL REFERENCES agent_memory_entries(entry_key),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (snapshot_id, entry_key),
    UNIQUE (snapshot_id, ordinal)
);

CREATE INDEX idx_agent_memory_snapshot_entries_entry_key
    ON agent_memory_snapshot_entries(entry_key);
