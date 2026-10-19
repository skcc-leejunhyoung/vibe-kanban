PRAGMA foreign_keys = ON;

-- Follow-ups queued for a session, so a server restart doesn't lose them. One
-- row per non-empty queue holding the whole queue (front first) as JSON,
-- written behind the in-memory queue by `QueuedMessageService`.
CREATE TABLE session_queued_messages (
    session_id  BLOB PRIMARY KEY,
    messages    TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
