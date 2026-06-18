PRAGMA foreign_keys = ON;

-- Wakeups a coding agent scheduled for itself (claude `ScheduleWakeup` ->
-- `session_crons`). The agent ends its turn; a background watcher resumes the
-- session with `prompt` once `next_fire_at` passes, mirroring the CLI's
-- "the harness re-invokes you when the wakeup fires" contract.
CREATE TABLE scheduled_resumes (
    id            BLOB PRIMARY KEY,
    session_id    BLOB NOT NULL,
    cron_id       TEXT NOT NULL,
    prompt        TEXT NOT NULL,
    schedule      TEXT NOT NULL,
    recurring     INTEGER NOT NULL DEFAULT 0,
    next_fire_at  TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    created_at    TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Watcher polls pending rows whose fire time has passed.
CREATE INDEX idx_scheduled_resumes_due ON scheduled_resumes(status, next_fire_at);
-- A cron reported on every Stop hook must only ever register once per session.
CREATE UNIQUE INDEX idx_scheduled_resumes_session_cron ON scheduled_resumes(session_id, cron_id);
