-- Denormalize project_id onto the issue/PR join tables so ElectricSQL can sync
-- them with a simple, fully reactive `project_id = $1` shape instead of a
-- subquery (`issue_id IN (SELECT id FROM issues WHERE project_id = $1)`).
--
-- Electric evaluates a shape's WHERE against each replicated row's own columns;
-- it cannot resolve a cross-table subquery for incremental INSERTs, so rows
-- created after the shape was first snapshotted are silently dropped. This is
-- exactly the bug that broke review mode: a `pull_request_issues` link created
-- after the client subscribed never streamed in, so the PR appeared "unlinked".
--
-- Mirrors the fix already applied to `issue_tags`
-- (20260617020000_add_project_id_to_issue_tags.sql). The matching shape WHERE
-- changes in `shapes.rs` force Electric to re-snapshot, which self-heals
-- existing rows.

-- pull_request_issues
ALTER TABLE pull_request_issues
    ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE CASCADE;
UPDATE pull_request_issues x SET project_id = i.project_id
    FROM issues i WHERE x.issue_id = i.id;
ALTER TABLE pull_request_issues ALTER COLUMN project_id SET NOT NULL;
CREATE INDEX idx_pull_request_issues_project_id ON pull_request_issues (project_id);

-- issue_assignees
ALTER TABLE issue_assignees
    ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE CASCADE;
UPDATE issue_assignees x SET project_id = i.project_id
    FROM issues i WHERE x.issue_id = i.id;
ALTER TABLE issue_assignees ALTER COLUMN project_id SET NOT NULL;
CREATE INDEX idx_issue_assignees_project_id ON issue_assignees (project_id);

-- issue_followers
ALTER TABLE issue_followers
    ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE CASCADE;
UPDATE issue_followers x SET project_id = i.project_id
    FROM issues i WHERE x.issue_id = i.id;
ALTER TABLE issue_followers ALTER COLUMN project_id SET NOT NULL;
CREATE INDEX idx_issue_followers_project_id ON issue_followers (project_id);

-- issue_relationships (scoped by the source issue_id)
ALTER TABLE issue_relationships
    ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE CASCADE;
UPDATE issue_relationships x SET project_id = i.project_id
    FROM issues i WHERE x.issue_id = i.id;
ALTER TABLE issue_relationships ALTER COLUMN project_id SET NOT NULL;
CREATE INDEX idx_issue_relationships_project_id ON issue_relationships (project_id);
