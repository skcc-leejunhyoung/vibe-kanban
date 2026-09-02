CREATE TABLE automation_action_receipts (
    idempotency_key TEXT PRIMARY KEY NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'succeeded')),
    response TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER automation_workspace_archived_outbox
AFTER UPDATE OF archived ON workspaces
WHEN OLD.archived = 0 AND NEW.archived = 1
BEGIN
    INSERT OR IGNORE INTO automation_event_outbox (id, payload)
    VALUES (
        'workspace_archived:' || lower(hex(NEW.id)),
        json_object(
            'id', lower(substr(hex(NEW.id), 1, 8) || '-' || substr(hex(NEW.id), 9, 4) || '-' || substr(hex(NEW.id), 13, 4) || '-' || substr(hex(NEW.id), 17, 4) || '-' || substr(hex(NEW.id), 21, 12)),
            'type', 'workspace_archived',
            'source', 'vibe',
            'workspaceId', lower(substr(hex(NEW.id), 1, 8) || '-' || substr(hex(NEW.id), 9, 4) || '-' || substr(hex(NEW.id), 13, 4) || '-' || substr(hex(NEW.id), 17, 4) || '-' || substr(hex(NEW.id), 21, 12))
        )
    );
END;

CREATE TRIGGER automation_execution_completed_outbox
AFTER UPDATE OF status ON execution_processes
WHEN OLD.status <> 'completed' AND NEW.status = 'completed'
BEGIN
    INSERT OR IGNORE INTO automation_event_outbox (id, payload)
    VALUES (
        'execution_completed:' || lower(hex(NEW.id)),
        json_object(
            'id', lower(substr(hex(NEW.id), 1, 8) || '-' || substr(hex(NEW.id), 9, 4) || '-' || substr(hex(NEW.id), 13, 4) || '-' || substr(hex(NEW.id), 17, 4) || '-' || substr(hex(NEW.id), 21, 12)),
            'type', 'execution_completed',
            'source', 'vibe',
            'executionProcessId', lower(substr(hex(NEW.id), 1, 8) || '-' || substr(hex(NEW.id), 9, 4) || '-' || substr(hex(NEW.id), 13, 4) || '-' || substr(hex(NEW.id), 17, 4) || '-' || substr(hex(NEW.id), 21, 12)),
            'sessionId', lower(substr(hex(NEW.session_id), 1, 8) || '-' || substr(hex(NEW.session_id), 9, 4) || '-' || substr(hex(NEW.session_id), 13, 4) || '-' || substr(hex(NEW.session_id), 17, 4) || '-' || substr(hex(NEW.session_id), 21, 12))
        )
    );
END;
