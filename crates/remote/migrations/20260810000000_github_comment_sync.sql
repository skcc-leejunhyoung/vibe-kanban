-- Bidirectional GitHub issue-comment sync.
--
-- Identity mapping lives on issue_comments so the frontend (which already syncs
-- this table via Electric) can attribute imported comments without a join:
--   github_comment_id   = the GitHub comment id this row mirrors (TEXT identity
--                         key, never used for arithmetic; NULL = vibe-only)
--   github_author_login = the real GitHub author, shown in place of the sync
--                         bot user (NULL = native vibe comment)
ALTER TABLE issue_comments
    ADD COLUMN github_comment_id   TEXT,
    ADD COLUMN github_author_login TEXT;

-- One vibe comment per GitHub comment within an issue: the echo/dedup guard that
-- stops a mirrored comment from being re-imported as a duplicate.
CREATE UNIQUE INDEX idx_issue_comments_github_comment
    ON issue_comments (issue_id, github_comment_id)
    WHERE github_comment_id IS NOT NULL;

-- Per-link seeding cutoff: set to now() on a link's first comment reconcile so
-- pre-existing history on either side is never cross-posted. Only comments
-- created after this instant ever sync.
ALTER TABLE github_issue_links
    ADD COLUMN comments_synced_after TIMESTAMPTZ;
