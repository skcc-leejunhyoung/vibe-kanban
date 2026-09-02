CREATE TABLE automation_event_outbox (
    id TEXT PRIMARY KEY NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
