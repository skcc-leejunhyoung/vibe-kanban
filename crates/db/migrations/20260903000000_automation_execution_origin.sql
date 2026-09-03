DROP TRIGGER automation_execution_completed_outbox;

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
            'sessionId', lower(substr(hex(NEW.session_id), 1, 8) || '-' || substr(hex(NEW.session_id), 9, 4) || '-' || substr(hex(NEW.session_id), 13, 4) || '-' || substr(hex(NEW.session_id), 17, 4) || '-' || substr(hex(NEW.session_id), 21, 12)),
            'originRoutineId', json_extract(NEW.executor_action, '$.automation_origin.routine_id'),
            'routineChain', json(COALESCE(json_extract(NEW.executor_action, '$.automation_origin.routine_chain'), '[]'))
        )
    );
END;
