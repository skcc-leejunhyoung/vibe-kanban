-- Existing body-only receipts are ambiguous. New receipts identify their format.
ALTER TABLE drawer_report_receipts ADD COLUMN receipt_version SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE drawer_report_receipts ADD COLUMN request_id UUID;
CREATE UNIQUE INDEX drawer_report_request_key ON drawer_report_receipts(note_id, request_id) WHERE request_id IS NOT NULL;
