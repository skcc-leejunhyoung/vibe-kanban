-- "Autopilot": the host's always-on watcher agent. An in-place, pinned
-- workspace with exactly one session that automation routines address as
-- `target: autopilot` instead of by session id. At most one active
-- (non-archived) Autopilot per host; archiving it pauses it.
ALTER TABLE workspaces ADD COLUMN autopilot BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX idx_workspaces_single_active_autopilot
    ON workspaces(autopilot) WHERE autopilot = TRUE AND archived = FALSE;
