-- Automatic expiry cleanup refuses to delete a workspace whose uncommitted
-- changes it cannot verify (the directory exists but `git status` fails, e.g.
-- after `git worktree prune` or a partial cleanup). Previously that surfaced as
-- an error every 30 minutes forever and the directory was never reclaimed.
-- Record the reason instead: NULL means eligible for automatic cleanup, a
-- non-NULL reason quarantines the workspace so the user deletes it explicitly.
ALTER TABLE workspaces ADD COLUMN cleanup_blocked_reason TEXT;
