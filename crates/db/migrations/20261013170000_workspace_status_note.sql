-- Agent-written live summary of the workspace (the ```vibe-status block in an
-- assistant message). Plain text, at most 1000 visible characters.
ALTER TABLE workspaces ADD COLUMN status_note TEXT;
ALTER TABLE workspaces ADD COLUMN status_updated_at TEXT;
