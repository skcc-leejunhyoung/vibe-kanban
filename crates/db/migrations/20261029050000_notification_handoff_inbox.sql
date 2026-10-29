CREATE TABLE notification_handoff_inbox (
    handoff_key TEXT PRIMARY KEY,
    owner_user_id BLOB NOT NULL,
    session_id BLOB NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    message_id BLOB NOT NULL UNIQUE,
    request TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','queued','rejected')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
