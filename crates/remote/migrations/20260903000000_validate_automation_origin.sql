CREATE OR REPLACE FUNCTION enqueue_issue_created_automation_event()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO automation_event_outbox (id, payload)
    VALUES (
        'issue_created:' || NEW.id::text,
        jsonb_build_object(
            'id', NEW.id::text,
            'type', 'issue_created',
            'source', 'vibe',
            'issueId', NEW.id,
            'projectId', NEW.project_id,
            'title', NEW.title,
            'originRoutineId', CASE
                WHEN jsonb_typeof(NEW.extension_metadata -> 'origin_routine_id') = 'string'
                THEN NEW.extension_metadata ->> 'origin_routine_id'
                ELSE NULL
            END,
            'routineChain', CASE
                WHEN jsonb_typeof(NEW.extension_metadata -> 'routine_chain') = 'array'
                THEN NEW.extension_metadata -> 'routine_chain'
                ELSE '[]'::jsonb
            END
        )
    ) ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
