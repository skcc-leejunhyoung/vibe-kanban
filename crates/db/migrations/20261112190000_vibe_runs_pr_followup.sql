-- "Review and create PR": once the merge lands, the server pushes the target
-- branch and opens an AI-drafted draft PR by itself (phases `pushing` and
-- `creating_pr`) instead of leaving those steps to the browser tab that
-- started the review.
ALTER TABLE vibe_runs ADD COLUMN pr_requested INTEGER NOT NULL DEFAULT 0;
-- JSON `ExecutorConfig` picked when the run was started; NULL drafts the PR
-- with the workspace's latest one.
ALTER TABLE vibe_runs ADD COLUMN pr_executor_config TEXT;
-- The follow-up phase a blocked run stopped in; a retry resumes there. NULL for
-- every other block (a review verdict, a failed merge).
ALTER TABLE vibe_runs ADD COLUMN failed_phase TEXT;
