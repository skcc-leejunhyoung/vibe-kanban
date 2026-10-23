-- Keep the notification as the only copy of its text. A reference lets agents
-- read it on demand through the existing owner-checked notification endpoint.
ALTER TABLE agent_events ADD COLUMN notification_id UUID
    REFERENCES notifications(id) ON DELETE CASCADE;

CREATE INDEX idx_agent_events_notification ON agent_events (notification_id)
    WHERE notification_id IS NOT NULL;

UPDATE agent_events e SET notification_id = n.id
FROM notifications n
WHERE e.kind = 'cloud.notification'
  AND e.data->>'id' = n.id::text
  AND e.owner_user_id = n.user_id;

DELETE FROM agent_events
WHERE kind = 'cloud.notification' AND notification_id IS NULL;

UPDATE agent_events e SET
    data = jsonb_build_object('id', n.id, 'type', n.notification_type),
    autopilot = COALESCE(n.payload->'autopilot' = 'true'::jsonb, FALSE)
FROM notifications n WHERE e.notification_id = n.id;

DROP INDEX idx_agent_events_autopilot_workspace;

CREATE OR REPLACE FUNCTION agent_events_from_notification() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    ws UUID;
BEGIN
    IF NEW.payload->>'workspace_id' ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$' THEN
        ws := (NEW.payload->>'workspace_id')::uuid;
    END IF;
    PERFORM pg_advisory_xact_lock(94838368587348);
    INSERT INTO agent_events
        (owner_user_id, host_id, host_cursor, kind, workspace_id, autopilot,
         notification_id, data, occurred_at)
    VALUES (
        NEW.user_id, NULL, 0, 'cloud.notification', ws,
        COALESCE(NEW.payload->'autopilot' = 'true'::jsonb, FALSE),
        NEW.id, jsonb_build_object('id', NEW.id, 'type', NEW.notification_type),
        NEW.created_at
    );
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'agent_events_from_notification: %', SQLERRM;
    RETURN NEW;
END $$;
