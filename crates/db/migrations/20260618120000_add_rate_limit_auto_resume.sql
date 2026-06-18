PRAGMA foreign_keys = ON;

-- Per-session toggle for usage-based auto-resume. Defaults from the agent's
-- `auto_resume_on_limit` setting at session creation; can be flipped per
-- session from the workspace chat UI. The background watcher only acts on
-- sessions where this is enabled.
ALTER TABLE sessions ADD COLUMN auto_resume_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Schedule of sessions that were interrupted because their usage rate limit was
-- reached. A background watcher polls these rows and, once `resume_at` has
-- passed (and the session still has auto-resume enabled), sends a follow-up
-- (`resume_prompt`, e.g. "continue") to resume the session automatically.
-- One pending resume per session (session_id UNIQUE); a newer interruption
-- replaces the previous schedule.
CREATE TABLE pending_rate_limit_resumes (
    id                    BLOB PRIMARY KEY,
    session_id            BLOB NOT NULL UNIQUE,
    execution_process_id  BLOB NOT NULL,
    resume_at             TEXT NOT NULL,
    resume_prompt         TEXT NOT NULL DEFAULT 'continue',
    created_at            TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    last_checked_at       TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (execution_process_id) REFERENCES execution_processes(id) ON DELETE CASCADE
);

CREATE INDEX idx_pending_rate_limit_resumes_resume_at ON pending_rate_limit_resumes(resume_at);
