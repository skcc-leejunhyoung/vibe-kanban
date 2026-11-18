-- NULL marks legacy runs that must confirm their PR bases before resuming.
ALTER TABLE vibe_runs ADD COLUMN pr_bases TEXT;
