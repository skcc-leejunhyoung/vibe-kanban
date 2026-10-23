-- Auto-merge failures that clear by themselves (another checkout's uncommitted
-- edits, a git lock) now wait and retry instead of blocking at once, and the
-- failure reason survives restarts.
ALTER TABLE vibe_runs ADD COLUMN last_error TEXT;
-- First failure of the current wait; NULL when the run is not waiting.
ALTER TABLE vibe_runs ADD COLUMN merge_wait_since TEXT;
ALTER TABLE vibe_runs ADD COLUMN merge_wait_attempts INTEGER NOT NULL DEFAULT 0;
-- When the waiting merge is tried again.
ALTER TABLE vibe_runs ADD COLUMN merge_retry_at TEXT;
