-- Searchable index of normalized conversation entries, extracted once per
-- execution process when its logs become immutable (process exit / backfill).
CREATE TABLE session_message_index (
    session_id    BLOB NOT NULL,
    execution_id  BLOB NOT NULL,
    entry_index   INTEGER NOT NULL,
    entry_type    TEXT NOT NULL,
    tool_name     TEXT,
    content       TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    PRIMARY KEY (execution_id, entry_index),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (execution_id) REFERENCES execution_processes(id) ON DELETE CASCADE
);

CREATE INDEX idx_session_message_index_session_id ON session_message_index(session_id);

-- Marker of executions already extracted (including ones that yielded zero
-- indexable entries), so the startup backfill never rescans them.
CREATE TABLE session_message_index_state (
    execution_id  BLOB PRIMARY KEY NOT NULL,
    indexed_at    TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    FOREIGN KEY (execution_id) REFERENCES execution_processes(id) ON DELETE CASCADE
);
