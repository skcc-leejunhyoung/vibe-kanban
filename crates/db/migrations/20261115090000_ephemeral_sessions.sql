-- Throwaway one-shot sessions (PR title/description generation, spec intake).
-- Their runs skip normal finalize side effects (commit, vibe, notifications,
-- remote sync, queue drain) and the agent journal, and leftovers are reaped
-- on startup.
ALTER TABLE sessions ADD COLUMN ephemeral BOOLEAN NOT NULL DEFAULT FALSE;
