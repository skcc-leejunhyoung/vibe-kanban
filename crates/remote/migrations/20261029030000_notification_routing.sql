-- Existing notifications remain user-visible and are never replayed.
ALTER TABLE notifications
    ADD COLUMN intent TEXT NOT NULL DEFAULT 'legacy' CHECK (intent IN ('legacy','raw_event','user_report')),
    ADD COLUMN routing_state TEXT NOT NULL DEFAULT 'user' CHECK (routing_state IN ('user','autopilot_pending','autopilot_claimed','autopilot_consumed')),
    ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    ADD COLUMN source_key TEXT;
CREATE UNIQUE INDEX notifications_source_key ON notifications(user_id,source_key) WHERE source_key IS NOT NULL;

CREATE TABLE notification_host_capabilities (
    host_id UUID PRIMARY KEY REFERENCES hosts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE autopilot_notification_leases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    host_id UUID NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    routine_id TEXT NOT NULL,
    instance_id UUID NOT NULL,
    kinds TEXT[] NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    UNIQUE(user_id,host_id,routine_id)
);
CREATE TABLE notification_dispatches (
    notification_id UUID PRIMARY KEY REFERENCES notifications(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    lease_id UUID NOT NULL REFERENCES autopilot_notification_leases(id) ON DELETE CASCADE,
    claim_token UUID,
    claim_expires_at TIMESTAMPTZ,
    pending_deadline TIMESTAMPTZ NOT NULL,
    handoff_deadline TIMESTAMPTZ NOT NULL,
    handoff_key TEXT,
    handoff JSONB,
    reason TEXT NOT NULL DEFAULT 'created'
);
CREATE TABLE notification_delivery_jobs (
    notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('web_push','host')),
    target_id UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','uncertain','cancelled')),
    attempt_token UUID,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(notification_id,revision,channel,target_id)
);
CREATE INDEX notification_jobs_pending ON notification_delivery_jobs(updated_at) WHERE status='pending';

CREATE FUNCTION route_notification() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected UUID;
BEGIN
    IF TG_OP='UPDATE' AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' THEN NEW.revision := OLD.revision+1; END IF;
    NEW.routing_state := 'user';
    -- Reports and self-generated events never become automation input.
    IF NEW.intent='raw_event' AND NOT COALESCE(NEW.payload->'autopilot'='true'::jsonb,FALSE)
      -- An older online host can still emit its own irreversible OS banner.
      AND NOT EXISTS (SELECT 1 FROM hosts h LEFT JOIN notification_host_capabilities c
        ON c.host_id=h.id AND c.user_id=NEW.user_id AND c.expires_at>NOW()
        WHERE h.owner_user_id=NEW.user_id AND h.deleted_at IS NULL AND h.status='online' AND c.host_id IS NULL) THEN
        SELECT l.id INTO selected FROM autopilot_notification_leases l
        JOIN notification_host_capabilities c ON c.host_id=l.host_id AND c.user_id=l.user_id AND c.expires_at>NOW()
        JOIN hosts h ON h.id=l.host_id AND h.owner_user_id=l.user_id AND h.deleted_at IS NULL
        WHERE l.user_id=NEW.user_id AND l.expires_at>NOW()
          AND ('cloud.notification'=ANY(l.kinds) OR NEW.notification_type::text=ANY(l.kinds))
        ORDER BY l.id LIMIT 1;
        IF selected IS NOT NULL THEN NEW.routing_state := 'autopilot_pending'; END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER notification_route BEFORE INSERT OR UPDATE OF created_at ON notifications FOR EACH ROW EXECUTE FUNCTION route_notification();

CREATE FUNCTION notification_routing_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected UUID;
BEGIN
    IF TG_OP='INSERT' OR NEW.revision<>OLD.revision THEN
        UPDATE notification_delivery_jobs SET status='cancelled',updated_at=NOW() WHERE notification_id=NEW.id AND status='pending';
        DELETE FROM notification_dispatches WHERE notification_id=NEW.id;
        IF NEW.routing_state='autopilot_pending' THEN
            SELECT l.id INTO selected FROM autopilot_notification_leases l
            JOIN notification_host_capabilities c ON c.host_id=l.host_id AND c.user_id=l.user_id AND c.expires_at>NOW()
            JOIN hosts h ON h.id=l.host_id AND h.owner_user_id=l.user_id AND h.deleted_at IS NULL
            WHERE l.user_id=NEW.user_id AND l.expires_at>NOW()
              AND ('cloud.notification'=ANY(l.kinds) OR NEW.notification_type::text=ANY(l.kinds)) ORDER BY l.id LIMIT 1;
            IF selected IS NULL THEN RAISE EXCEPTION 'notification lease disappeared'; END IF;
            INSERT INTO notification_dispatches(notification_id,revision,lease_id,pending_deadline,handoff_deadline)
            VALUES(NEW.id,NEW.revision,selected,NOW()+INTERVAL '120 seconds',NOW()+INTERVAL '20 minutes');
        END IF;
    END IF;
    IF NEW.routing_state='user' AND NOT NEW.seen AND NEW.dismissed_at IS NULL THEN
      IF TG_OP='INSERT' OR NEW.revision<>OLD.revision OR NEW.routing_state<>OLD.routing_state THEN
        INSERT INTO notification_delivery_jobs(notification_id,revision,channel,target_id)
        SELECT NEW.id,NEW.revision,'web_push',s.id FROM web_push_subscriptions s WHERE s.user_id=NEW.user_id AND COALESCE(NEW.payload->'remote_push_enabled'<>'false'::jsonb,TRUE)
        ON CONFLICT DO NOTHING;
        INSERT INTO notification_delivery_jobs(notification_id,revision,channel,target_id)
        SELECT NEW.id,NEW.revision,'host',c.host_id FROM notification_host_capabilities c
        WHERE c.user_id=NEW.user_id AND c.expires_at>NOW()
          AND (NEW.payload->>'host_id' IS NULL OR NEW.payload->>'host_id'=c.host_id::text) ON CONFLICT DO NOTHING;
      END IF;
    ELSE
        UPDATE notification_delivery_jobs SET status='cancelled',updated_at=NOW() WHERE notification_id=NEW.id AND status='pending';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER notification_outbox AFTER INSERT OR UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION notification_routing_outbox();

-- Held rows must never commit without the event used to claim them.
CREATE OR REPLACE FUNCTION agent_events_from_notification() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ws UUID;
BEGIN
    IF NEW.payload->>'workspace_id' ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$' THEN ws := (NEW.payload->>'workspace_id')::uuid; END IF;
    PERFORM pg_advisory_xact_lock(94838368587348);
    INSERT INTO agent_events(owner_user_id,host_id,host_cursor,kind,workspace_id,autopilot,notification_id,data,occurred_at)
    VALUES(NEW.user_id,NULL,0,'cloud.notification',ws,
        NEW.intent='user_report' OR COALESCE(NEW.payload->'autopilot'='true'::jsonb,FALSE),NEW.id,
        jsonb_build_object('id',NEW.id,'type',NEW.notification_type,'revision',NEW.revision,'intent',NEW.intent),NEW.created_at);
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    IF NEW.routing_state='autopilot_pending' THEN RAISE; END IF;
    RAISE WARNING 'agent_events_from_notification: %',SQLERRM; RETURN NEW;
END $$;
