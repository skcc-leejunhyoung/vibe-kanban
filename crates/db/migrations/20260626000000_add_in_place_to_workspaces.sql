-- Add in_place flag for "quick chat" workspaces that run an agent directly in an
-- existing checkout instead of creating a fresh `vk/` worktree branch.
-- In-place workspaces set `container_ref` to the chosen folder, never materialize
-- a worktree, and are excluded from the destructive expiry/delete cleanup so they
-- can never remove the user's real repository or branch.
ALTER TABLE workspaces ADD COLUMN in_place BOOLEAN NOT NULL DEFAULT FALSE;
