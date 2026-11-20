-- Which agent session asked for an execution (vk CLI / MCP calls carry it).
-- Autopilot triage reads it to tell work the Autopilot dispatched from the
-- user's own work. Rows exist only for agent-requested executions.
CREATE TABLE execution_agent_origins (
    execution_id     BLOB PRIMARY KEY REFERENCES execution_processes(id) ON DELETE CASCADE,
    agent_session_id BLOB NOT NULL,
    created_at       TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);
