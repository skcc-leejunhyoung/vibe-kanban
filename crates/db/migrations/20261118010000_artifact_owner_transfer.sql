-- An artifact belongs to exactly one Drawer note or workspace session.
CREATE TABLE drawer_artifacts_new (
    id BLOB PRIMARY KEY NOT NULL,
    note_id BLOB,
    workspace_id BLOB,
    session_id BLOB,
    owner_id BLOB NOT NULL,
    host_id BLOB NOT NULL,
    channel_id TEXT NOT NULL UNIQUE,
    document TEXT NOT NULL,
    channel_config TEXT NOT NULL,
    version TEXT NOT NULL,
    binding_version TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 1,
    archived INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    attached INTEGER NOT NULL DEFAULT 0,
    CHECK ((note_id IS NOT NULL AND workspace_id IS NULL AND session_id IS NULL)
        OR (note_id IS NULL AND workspace_id IS NOT NULL AND session_id IS NOT NULL))
);
INSERT INTO drawer_artifacts_new (id, note_id, owner_id, host_id, channel_id, document,
    channel_config, version, binding_version, revision, archived, deleted, attached)
SELECT id, note_id, owner_id, host_id, channel_id, document, channel_config, version,
    binding_version, revision, archived, deleted, attached FROM drawer_artifacts;

CREATE TABLE drawer_artifact_moves_new (
    artifact_id BLOB PRIMARY KEY NOT NULL REFERENCES drawer_artifacts_new(id),
    payload TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0
);
INSERT INTO drawer_artifact_moves_new SELECT artifact_id,
    json_set(payload,
        '$.source', json_object('kind', 'drawer', 'note_id', json_extract(payload, '$.source')),
        '$.target', json_object('kind', 'drawer', 'note_id', json_extract(payload, '$.target'))),
    completed FROM drawer_artifact_moves;
DROP TABLE drawer_artifact_moves;
DROP TABLE drawer_artifacts;
ALTER TABLE drawer_artifacts_new RENAME TO drawer_artifacts;
ALTER TABLE drawer_artifact_moves_new RENAME TO drawer_artifact_moves;
CREATE INDEX drawer_artifacts_owner ON drawer_artifacts(owner_id, deleted);
CREATE INDEX drawer_artifacts_workspace ON drawer_artifacts(workspace_id, session_id, deleted);

-- Tombstones survive source cleanup and prevent the old execution rebinding it.
CREATE TABLE artifact_transfer_sources (
    execution_id BLOB NOT NULL,
    source_artifact_id TEXT NOT NULL,
    artifact_id BLOB NOT NULL UNIQUE REFERENCES drawer_artifacts(id),
    PRIMARY KEY (execution_id, source_artifact_id)
);
