-- A PR can be shared by author and review workspaces, including across issues.
ALTER TABLE pull_request_issues ADD COLUMN is_explicit BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE pull_request_workspaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pull_request_id UUID NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    UNIQUE (pull_request_id, workspace_id),
    FOREIGN KEY (pull_request_id, issue_id)
        REFERENCES pull_request_issues(pull_request_id, issue_id) ON DELETE CASCADE
);
CREATE INDEX idx_pull_request_workspaces_workspace ON pull_request_workspaces(workspace_id);
CREATE INDEX idx_pull_request_workspaces_project ON pull_request_workspaces(project_id);

INSERT INTO pull_request_workspaces (pull_request_id, workspace_id, issue_id, project_id)
SELECT p.id, w.id, w.issue_id, p.project_id
FROM pull_requests p
JOIN workspaces w ON w.id = p.workspace_id AND w.project_id = p.project_id
JOIN pull_request_issues pri ON pri.pull_request_id = p.id AND pri.issue_id = w.issue_id;

-- Preserve the legacy single-workspace projection for older clients.
CREATE FUNCTION refresh_pull_request_workspace_projection() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE pull_requests SET workspace_id = NEW.workspace_id, updated_at = NOW()
        WHERE id = NEW.pull_request_id AND workspace_id IS NULL;
    ELSE
        -- Do not acquire another workspace's FK lock while deleting this one.
        UPDATE pull_requests SET workspace_id = NULL, updated_at = NOW()
        WHERE id = OLD.pull_request_id AND workspace_id = OLD.workspace_id;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER pull_request_workspace_projection
AFTER INSERT OR DELETE ON pull_request_workspaces
FOR EACH ROW EXECUTE FUNCTION refresh_pull_request_workspace_projection();

SELECT electric_sync_table('public', 'pull_request_workspaces');
