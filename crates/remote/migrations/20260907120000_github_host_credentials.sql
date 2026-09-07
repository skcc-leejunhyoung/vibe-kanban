-- A GitHub CLI login uploaded from one of the user's hosts. It carries the
-- CLI app's organization approvals and scopes, so /v1/github/* prefers it
-- over the Vibe OAuth app token whenever it exists.
CREATE TABLE github_host_credentials (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    github_user_id TEXT NOT NULL,
    github_login TEXT NOT NULL,
    scopes TEXT[] NOT NULL DEFAULT '{}',
    encrypted_token TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
