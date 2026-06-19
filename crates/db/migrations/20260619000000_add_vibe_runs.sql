PRAGMA foreign_keys = ON;

-- Per-workspace orchestration state for the fully-automated `vibe` workflow.
-- One row per vibe-tagged workspace run; drives the coding → review → merge
-- state machine and bounds the auto-retry loops. Authoritative phase lives
-- here (cloud tags only mirror it for human visibility).
CREATE TABLE vibe_runs (
    workspace_id       BLOB PRIMARY KEY,
    task_id            BLOB NOT NULL,
    phase              TEXT NOT NULL DEFAULT 'coding',
    review_session_id  BLOB,
    coding_turns       INTEGER NOT NULL DEFAULT 0,
    review_turns       INTEGER NOT NULL DEFAULT 0,
    merge_retries      INTEGER NOT NULL DEFAULT 0,
    -- Canonical token (done/blocked/continue/approve) parsed from the agent's
    -- full, untruncated final message at coding completion; consumed and
    -- cleared by the next finalize. Avoids the 4096-char summary truncation
    -- dropping a trailing VIBE_RESULT line.
    last_result        TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX idx_vibe_runs_task_id ON vibe_runs(task_id);
