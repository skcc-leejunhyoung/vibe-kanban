CREATE TABLE agent_memory_sync_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_scheduled_local_date TEXT,
    last_started_at TEXT,
    last_finished_at TEXT,
    last_status TEXT,
    last_error TEXT
);

INSERT INTO agent_memory_sync_state (id) VALUES (1);
