CREATE INDEX IF NOT EXISTS idx_workspaces_ephemeral_archived_updated
    ON workspaces (ephemeral, archived, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_execution_processes_run_reason_dropped_session_created
    ON execution_processes (run_reason, dropped, session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_execution_processes_session_run_reason_dropped_created
    ON execution_processes (session_id, run_reason, dropped, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_coding_agent_turns_execution_created_prompt
    ON coding_agent_turns (execution_process_id, created_at DESC, id DESC)
    WHERE prompt IS NOT NULL;
