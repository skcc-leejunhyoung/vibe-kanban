-- Keep interrupted cross-store moves recoverable without copying snapshots.
CREATE TABLE drawer_artifact_moves (
    artifact_id BLOB PRIMARY KEY NOT NULL REFERENCES drawer_artifacts(id),
    payload TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0
);
