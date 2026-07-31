CREATE TABLE github_issue_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    repository TEXT NOT NULL,
    number INTEGER NOT NULL,
    url TEXT NOT NULL,
    github_node_id TEXT,
    project_item_id TEXT,
    github_state TEXT NOT NULL DEFAULT 'open',
    github_updated_at TIMESTAMPTZ,
    last_synced_vibe_updated_at TIMESTAMPTZ,
    synced_title TEXT,
    synced_description TEXT,
    synced_vibe_status_id UUID REFERENCES project_statuses(id) ON DELETE SET NULL,
    synced_github_status_option_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT github_issue_links_issue_unique UNIQUE (issue_id),
    CONSTRAINT github_issue_links_external_unique UNIQUE (project_id, repository, number)
);

CREATE INDEX idx_github_issue_links_project_id
    ON github_issue_links (project_id);

ALTER TABLE github_issue_links REPLICA IDENTITY FULL;
SELECT electric_sync_table('public', 'github_issue_links');
