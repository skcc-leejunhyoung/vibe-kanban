-- Record the boundaries of accepted reports independently of rendered Markdown.
CREATE TABLE drawer_report_receipts (
    note_id UUID NOT NULL REFERENCES drawer_notes(id) ON DELETE CASCADE,
    body_hash BYTEA NOT NULL,
    PRIMARY KEY (note_id, body_hash)
);
