ALTER TABLE agent_memory_sync_session_targets
    ADD COLUMN retry_at TIMESTAMPTZ;

ALTER TABLE agent_memory_sync_session_targets
    DROP CONSTRAINT agent_memory_sync_session_targets_status_check;

ALTER TABLE agent_memory_sync_session_targets
    ADD CONSTRAINT agent_memory_sync_session_targets_status_check
    CHECK (status IN ('pending', 'running', 'waiting', 'completed', 'failed'));

CREATE INDEX idx_agent_memory_sync_session_targets_retry
    ON agent_memory_sync_session_targets(retry_at)
    WHERE status = 'waiting';
