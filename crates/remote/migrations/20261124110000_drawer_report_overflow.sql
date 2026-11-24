-- Keep subsequent reports in the note's comment stream once its body is full.
ALTER TABLE drawer_notes ADD COLUMN report_overflow BOOLEAN NOT NULL DEFAULT FALSE;
