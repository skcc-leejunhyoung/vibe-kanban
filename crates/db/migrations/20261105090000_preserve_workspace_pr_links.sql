-- A PR may have an author workspace and multiple review workspaces.
CREATE TABLE pull_requests_new (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id BLOB,
    repo_id BLOB,
    pr_url TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    pr_status TEXT NOT NULL DEFAULT 'open',
    target_branch_name TEXT NOT NULL,
    merged_at TEXT,
    merge_commit_sha TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    synced_at DATETIME,
    head_branch_name TEXT
);

INSERT INTO pull_requests_new
SELECT id, workspace_id, repo_id, pr_url, pr_number, pr_status,
       target_branch_name, merged_at, merge_commit_sha, created_at,
       updated_at, synced_at, head_branch_name
FROM pull_requests;

DROP TABLE pull_requests;
ALTER TABLE pull_requests_new RENAME TO pull_requests;

CREATE UNIQUE INDEX idx_pull_requests_workspace_url
    ON pull_requests(pr_url, IFNULL(workspace_id, X''));
CREATE INDEX idx_pull_requests_status ON pull_requests(pr_status);
CREATE INDEX idx_pull_requests_workspace_id ON pull_requests(workspace_id);
