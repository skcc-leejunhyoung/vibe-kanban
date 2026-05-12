PRAGMA foreign_keys = ON;

CREATE TABLE pending_execution_starts (
    id                    BLOB PRIMARY KEY,
    execution_process_id  BLOB NOT NULL UNIQUE,
    workspace_id          BLOB NOT NULL,
    session_id            BLOB NOT NULL,
    task_id               BLOB NOT NULL,
    created_at            TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    last_checked_at       TEXT,
    FOREIGN KEY (execution_process_id) REFERENCES execution_processes(id) ON DELETE CASCADE
);

CREATE INDEX idx_pending_execution_starts_task_id ON pending_execution_starts(task_id);
