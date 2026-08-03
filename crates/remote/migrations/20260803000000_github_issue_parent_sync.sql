ALTER TABLE github_issue_links
ADD COLUMN synced_parent_issue_id UUID REFERENCES issues(id) ON DELETE SET NULL;
