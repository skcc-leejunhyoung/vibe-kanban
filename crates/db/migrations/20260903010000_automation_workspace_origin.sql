DROP TRIGGER automation_workspace_archived_outbox;

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
            'workspaceId', lower(substr(hex(NEW.id), 1, 8) || '-' || substr(hex(NEW.id), 9, 4) || '-' || substr(hex(NEW.id), 13, 4) || '-' || substr(hex(NEW.id), 17, 4) || '-' || substr(hex(NEW.id), 21, 12)),
            'originRoutineId', (
                SELECT json_extract(ep.executor_action, '$.automation_origin.routine_id')
                FROM sessions s
                JOIN execution_processes ep ON ep.session_id = s.id
                WHERE s.workspace_id = NEW.id
                  AND json_extract(ep.executor_action, '$.automation_origin.routine_id') IS NOT NULL
                ORDER BY ep.created_at
                LIMIT 1
            ),
            'routineChain', json(COALESCE((
                SELECT json_extract(ep.executor_action, '$.automation_origin.routine_chain')
                FROM sessions s
                JOIN execution_processes ep ON ep.session_id = s.id
                WHERE s.workspace_id = NEW.id
                  AND json_extract(ep.executor_action, '$.automation_origin.routine_id') IS NOT NULL
                ORDER BY ep.created_at
                LIMIT 1
            ), '[]'))
        )
    );
END;
