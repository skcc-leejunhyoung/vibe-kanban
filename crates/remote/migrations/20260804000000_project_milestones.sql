CREATE TABLE project_milestones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    start_date TIMESTAMPTZ,
    target_date TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    source_repository TEXT,
    source_number INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT project_milestones_name_unique UNIQUE (project_id, name),
    CONSTRAINT project_milestones_source_unique UNIQUE (project_id, source_repository, source_number)
);

CREATE TABLE issue_milestones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    milestone_id UUID NOT NULL REFERENCES project_milestones(id) ON DELETE CASCADE,
    CONSTRAINT issue_milestones_issue_unique UNIQUE (issue_id)
);

CREATE INDEX idx_project_milestones_project_id ON project_milestones(project_id);
CREATE INDEX idx_issue_milestones_project_id ON issue_milestones(project_id);
CREATE INDEX idx_issue_milestones_milestone_id ON issue_milestones(milestone_id);

ALTER TABLE project_milestones REPLICA IDENTITY FULL;
ALTER TABLE issue_milestones REPLICA IDENTITY FULL;
SELECT electric_sync_table('public', 'project_milestones');
SELECT electric_sync_table('public', 'issue_milestones');
