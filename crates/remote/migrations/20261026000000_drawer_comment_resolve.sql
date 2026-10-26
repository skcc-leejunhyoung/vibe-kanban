-- A Drawer comment can be resolved (by the user or the Autopilot) once it is
-- handled; the thread folds consecutive resolved comments into one line.
-- NULL = open. Resolving is an UPDATE, so it never wakes the Autopilot (the
-- `drawer.comment` trigger fires on INSERT only).
ALTER TABLE drawer_comments ADD COLUMN resolved_at TIMESTAMPTZ;
