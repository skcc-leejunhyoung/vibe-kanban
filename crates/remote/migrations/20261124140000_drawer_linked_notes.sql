-- Preserve source note IDs, comments and artifact scope when targets converge.
ALTER TABLE drawer_notes ADD COLUMN merged_into_id UUID REFERENCES drawer_notes(id) ON DELETE SET NULL;
CREATE INDEX drawer_notes_merged_into ON drawer_notes(merged_into_id) WHERE merged_into_id IS NOT NULL;
