-- Existing sessions must authenticate again before granting host access.
ALTER TABLE auth_sessions ADD COLUMN authenticated_at TIMESTAMPTZ;
