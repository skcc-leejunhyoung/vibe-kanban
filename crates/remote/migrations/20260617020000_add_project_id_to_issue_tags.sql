-- Denormalize project_id onto issue_tags so ElectricSQL can sync this table
-- with a simple, fully reactive `project_id = $1` shape instead of a subquery
-- (`issue_id IN (SELECT id FROM issues WHERE project_id = $1)`). The subquery
-- shape was not reactive to issues created after the client subscribed, so tags
-- on freshly created issues never streamed to the client until a full reload.

ALTER TABLE issue_tags
    ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE CASCADE;

UPDATE issue_tags it
SET project_id = i.project_id
FROM issues i
WHERE it.issue_id = i.id;

ALTER TABLE issue_tags
    ALTER COLUMN project_id SET NOT NULL;

CREATE INDEX idx_issue_tags_project_id ON issue_tags (project_id);
