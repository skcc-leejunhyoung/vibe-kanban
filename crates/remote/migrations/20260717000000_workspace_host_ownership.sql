ALTER TABLE workspaces
    ADD COLUMN host_id UUID REFERENCES hosts(id) ON DELETE RESTRICT;

CREATE INDEX idx_workspaces_host_id ON workspaces(host_id);

COMMENT ON COLUMN workspaces.host_id IS
    'Relay host that owns the local workspace. NULL only for legacy rows whose owner cannot be determined safely.';
