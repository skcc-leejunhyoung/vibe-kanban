-- Linked sources belong to the primary note's deletion and retention lifetime.
ALTER TABLE drawer_notes DROP CONSTRAINT drawer_notes_merged_into_id_fkey;
ALTER TABLE drawer_notes ADD CONSTRAINT drawer_notes_merged_into_id_fkey
    FOREIGN KEY (merged_into_id) REFERENCES drawer_notes(id) ON DELETE CASCADE;
