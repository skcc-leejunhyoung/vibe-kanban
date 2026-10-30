-- Retain only a revocation counter so unarchiving cannot revive old inputs.
CREATE TABLE artifact_workspace_epochs (
    workspace_id BLOB PRIMARY KEY NOT NULL,
    epoch INTEGER NOT NULL
);

CREATE TRIGGER artifact_workspace_archived
AFTER UPDATE OF archived ON workspaces
WHEN OLD.archived = 0 AND NEW.archived = 1
BEGIN
    INSERT INTO artifact_workspace_epochs (workspace_id, epoch) VALUES (NEW.id, 1)
    ON CONFLICT(workspace_id) DO UPDATE SET epoch = epoch + 1;
    INSERT INTO automation_event_outbox (id, payload)
    SELECT 'artifact_workspace:' || lower(hex(NEW.id)) || ':' || epoch,
        json_object('id', 'artifact_workspace:' || lower(hex(NEW.id)) || ':' || epoch,
            'type', 'artifact_scope_ended', 'source', 'vibe',
            'workspaceId', lower(substr(hex(NEW.id),1,8)||'-'||substr(hex(NEW.id),9,4)||'-'||substr(hex(NEW.id),13,4)||'-'||substr(hex(NEW.id),17,4)||'-'||substr(hex(NEW.id),21,12)),
            'epoch', epoch, 'deleted', json('false'))
    FROM artifact_workspace_epochs WHERE workspace_id = NEW.id;
END;

CREATE TRIGGER artifact_workspace_deleted
BEFORE DELETE ON workspaces
BEGIN
    INSERT INTO artifact_workspace_epochs (workspace_id, epoch) VALUES (OLD.id, 1)
    ON CONFLICT(workspace_id) DO UPDATE SET epoch = epoch + 1;
    INSERT INTO automation_event_outbox (id, payload)
    SELECT 'artifact_workspace:' || lower(hex(OLD.id)) || ':' || epoch,
        json_object('id', 'artifact_workspace:' || lower(hex(OLD.id)) || ':' || epoch,
            'type', 'artifact_scope_ended', 'source', 'vibe',
            'workspaceId', lower(substr(hex(OLD.id),1,8)||'-'||substr(hex(OLD.id),9,4)||'-'||substr(hex(OLD.id),13,4)||'-'||substr(hex(OLD.id),17,4)||'-'||substr(hex(OLD.id),21,12)),
            'epoch', epoch, 'deleted', json('true'))
    FROM artifact_workspace_epochs WHERE workspace_id = OLD.id;
END;

CREATE TRIGGER artifact_session_deleted
BEFORE DELETE ON sessions
BEGIN
    INSERT OR IGNORE INTO automation_event_outbox (id, payload)
    VALUES ('artifact_session:' || lower(hex(OLD.id)),
        json_object('id', 'artifact_session:' || lower(hex(OLD.id)),
            'type', 'artifact_scope_ended', 'source', 'vibe',
            'workspaceId', lower(substr(hex(OLD.workspace_id),1,8)||'-'||substr(hex(OLD.workspace_id),9,4)||'-'||substr(hex(OLD.workspace_id),13,4)||'-'||substr(hex(OLD.workspace_id),17,4)||'-'||substr(hex(OLD.workspace_id),21,12)),
            'sessionId', lower(substr(hex(OLD.id),1,8)||'-'||substr(hex(OLD.id),9,4)||'-'||substr(hex(OLD.id),13,4)||'-'||substr(hex(OLD.id),17,4)||'-'||substr(hex(OLD.id),21,12)),
            'deleted', json('true')));
END;

-- Existing archives also revoke bindings created before this migration.
INSERT INTO artifact_workspace_epochs SELECT id, 1 FROM workspaces WHERE archived = 1;
INSERT INTO automation_event_outbox (id, payload)
SELECT 'artifact_workspace:' || lower(hex(workspace_id)) || ':1',
    json_object('id', 'artifact_workspace:' || lower(hex(workspace_id)) || ':1',
        'type', 'artifact_scope_ended', 'source', 'vibe',
        'workspaceId', lower(substr(hex(workspace_id),1,8)||'-'||substr(hex(workspace_id),9,4)||'-'||substr(hex(workspace_id),13,4)||'-'||substr(hex(workspace_id),17,4)||'-'||substr(hex(workspace_id),21,12)),
        'epoch', 1, 'deleted', json('false'))
FROM artifact_workspace_epochs;
