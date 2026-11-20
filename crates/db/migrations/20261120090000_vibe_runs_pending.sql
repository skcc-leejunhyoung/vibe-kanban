-- The latest `vibe.*` event (a turn's end, a merge or PR outcome) the
-- automation worker has not acted on yet, as JSON; NULL when nothing awaits.
ALTER TABLE vibe_runs ADD COLUMN pending TEXT;
