-- One Drawer note per automation target and owner: an issue (`issue:<id>`) or
-- a PR without one (`pr:<host>/<owner>/<repo>#<number>`). `POST
-- /drawer_notes/append` creates it on the first report and appends to it
-- afterwards, so coding, plan-check, review and merge reports of one issue
-- share a note. NULL = an ordinary note (manual create, the PR board).
ALTER TABLE drawer_notes ADD COLUMN target_key TEXT;

CREATE UNIQUE INDEX drawer_notes_owner_target
    ON drawer_notes (owner_user_id, target_key)
    WHERE target_key IS NOT NULL;
