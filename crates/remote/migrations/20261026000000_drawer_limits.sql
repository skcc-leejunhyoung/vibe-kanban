-- Size caps for the Drawer, mirrored by the route checks (`routes/drawer.rs`).
-- NOT VALID: rows written before the caps stay readable instead of failing
-- the migration; every new insert or update is checked.
ALTER TABLE drawer_notes
    ADD CONSTRAINT drawer_notes_title_length CHECK (char_length(title) <= 200) NOT VALID,
    ADD CONSTRAINT drawer_notes_body_length CHECK (octet_length(body) <= 65536) NOT VALID,
    ADD CONSTRAINT drawer_notes_label_length CHECK (char_length(label) <= 40) NOT VALID;

ALTER TABLE drawer_comments
    ADD CONSTRAINT drawer_comments_body_length CHECK (octet_length(body) <= 16384) NOT VALID;
