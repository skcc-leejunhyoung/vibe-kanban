-- Drawer dashboards have no foreign key to a workspace, session or execution.
CREATE TABLE drawer_artifacts (
    id BLOB PRIMARY KEY NOT NULL,
    note_id BLOB NOT NULL,
    owner_id BLOB NOT NULL,
    host_id BLOB NOT NULL,
    channel_id TEXT NOT NULL UNIQUE,
    document TEXT NOT NULL,
    channel_config TEXT NOT NULL,
    binding_version TEXT NOT NULL DEFAULT '',
    version TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    archived INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    attached INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX drawer_artifacts_owner ON drawer_artifacts(owner_id, deleted);
