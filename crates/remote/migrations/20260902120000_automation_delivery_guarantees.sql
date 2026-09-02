CREATE TABLE automation_action_receipts (
    idempotency_key TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'succeeded')),
    response JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
            'originRoutineId', NEW.extension_metadata ->> 'origin_routine_id',
            'routineChain', COALESCE(NEW.extension_metadata -> 'routine_chain', '[]'::jsonb)
        )
    ) ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER automation_issue_created_outbox
AFTER INSERT ON issues
FOR EACH ROW EXECUTE FUNCTION enqueue_issue_created_automation_event();
