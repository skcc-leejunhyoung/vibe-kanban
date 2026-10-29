CREATE TABLE notification_dispatch_outbox (
    source_key TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
