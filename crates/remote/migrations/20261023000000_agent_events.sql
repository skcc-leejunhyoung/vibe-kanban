-- Host agent-journal events, pushed by every host and read back as one
-- stream by the owner's automation (the Autopilot's wake-up source). Rows
-- are short-lived: pruned after a few days.
CREATE TABLE agent_events (
    id BIGSERIAL PRIMARY KEY,
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    host_id UUID NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    host_cursor BIGINT NOT NULL,
    kind TEXT NOT NULL,
    workspace_id UUID,
    session_id UUID,
    execution_id UUID,
    autopilot BOOLEAN NOT NULL DEFAULT FALSE,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (host_id, host_cursor)
);

CREATE INDEX idx_agent_events_owner_cursor ON agent_events (owner_user_id, id);
CREATE INDEX idx_agent_events_created_at ON agent_events (created_at);
