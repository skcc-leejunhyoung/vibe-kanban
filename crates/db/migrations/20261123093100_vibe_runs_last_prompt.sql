-- The kind of the prompt the automation worker last sent into the run
-- (`plan_review`, `continue`, ...), reported with the turn it started and
-- cleared there; NULL for a turn nobody prompted (the first, a person's).
ALTER TABLE vibe_runs ADD COLUMN last_prompt TEXT;
