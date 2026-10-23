-- The user's notifications (task completed, PR comments, review requests) join
-- the agent-event stream as `cloud.notification`, so the Autopilot is woken by
-- them like by host events. They come from this server, so they carry no host.
-- One posted for an Autopilot workspace (its own `vk notify send`) is tagged
-- like that workspace's host events, so automation skips it.
ALTER TABLE agent_events ALTER COLUMN host_id DROP NOT NULL;

CREATE INDEX idx_agent_events_autopilot_workspace
    ON agent_events (workspace_id) WHERE autopilot;

CREATE FUNCTION agent_events_from_notification() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    ws UUID;
BEGIN
    IF NEW.payload->>'workspace_id' ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$' THEN
        ws := (NEW.payload->>'workspace_id')::uuid;
    END IF;
    -- Same lock as host pushes, so cursors stay in commit order.
    PERFORM pg_advisory_xact_lock(94838368587348); -- AGENT_EVENTS_LOCK (0x5641_4745_4e54)
    INSERT INTO agent_events
        (owner_user_id, host_id, host_cursor, kind, workspace_id, autopilot, data, occurred_at)
    VALUES (
        NEW.user_id, NULL, 0, 'cloud.notification', ws,
        ws IS NOT NULL AND EXISTS (
            SELECT 1 FROM agent_events e WHERE e.workspace_id = ws AND e.autopilot
        ),
        jsonb_build_object(
            'id', NEW.id,
            'type', NEW.notification_type,
            'payload', NEW.payload
        ),
        NEW.created_at
    );
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    -- Never fail the notification itself over its stream copy.
    RAISE WARNING 'agent_events_from_notification: %', SQLERRM;
    RETURN NEW;
END $$;

-- Re-raised notifications (merged within a minute) bump created_at.
CREATE TRIGGER notifications_to_agent_events
    AFTER INSERT OR UPDATE OF created_at ON notifications
    FOR EACH ROW EXECUTE FUNCTION agent_events_from_notification();
