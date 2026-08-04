ALTER TABLE project_milestones
    DROP CONSTRAINT project_milestones_name_unique;

ALTER TABLE github_issue_links
    ADD COLUMN synced_milestone_id UUID REFERENCES project_milestones(id) ON DELETE SET NULL,
    ADD COLUMN synced_github_milestone_number INTEGER;
