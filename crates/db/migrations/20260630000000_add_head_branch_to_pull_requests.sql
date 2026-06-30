-- Track the PR's head (source) branch so a PR can originate from a branch other
-- than the workspace's own work branch (e.g. an intermediate "feature" branch in
-- a three-branch workflow: work branch -> feature branch -> base via PR).
--
-- NULL means "the workspace's work branch" (legacy rows), preserving the original
-- behavior where every PR's head was `workspace.branch`.
ALTER TABLE pull_requests ADD COLUMN head_branch_name TEXT;
