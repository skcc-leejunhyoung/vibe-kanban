-- Electric shapes must filter on columns from the replicated row itself.
ALTER TABLE issue_comment_reactions ADD COLUMN issue_id UUID REFERENCES issues(id) ON DELETE CASCADE;
UPDATE issue_comment_reactions r SET issue_id = c.issue_id
FROM issue_comments c WHERE r.comment_id = c.id;
ALTER TABLE issue_comment_reactions ALTER COLUMN issue_id SET NOT NULL;
CREATE INDEX idx_issue_comment_reactions_issue_id ON issue_comment_reactions (issue_id);
