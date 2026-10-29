-- Older workers cannot promise to check ownership at durable queue acceptance.
ALTER TABLE autopilot_notification_leases ADD COLUMN protocol INTEGER NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION route_notification() RETURNS trigger LANGUAGE plpgsql AS $$
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
        WHERE l.user_id=NEW.user_id AND l.expires_at>NOW() AND l.protocol=2
          AND ('cloud.notification'=ANY(l.kinds) OR NEW.notification_type::text=ANY(l.kinds))
        ORDER BY l.id LIMIT 1;
        IF selected IS NOT NULL THEN NEW.routing_state := 'autopilot_pending'; END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION notification_routing_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected UUID;
BEGIN
    IF TG_OP='INSERT' OR NEW.revision<>OLD.revision THEN
        UPDATE notification_delivery_jobs SET status='cancelled',updated_at=NOW()
        WHERE notification_id=NEW.id AND status='pending';
        IF TG_OP='UPDATE' THEN
            UPDATE notification_dispatches SET reason='superseded'
            WHERE notification_id=NEW.id AND revision=OLD.revision AND reason<>'queue_accepted';
        END IF;
        IF NEW.routing_state='autopilot_pending' THEN
            SELECT l.id INTO selected FROM autopilot_notification_leases l
            JOIN notification_host_capabilities c ON c.host_id=l.host_id AND c.user_id=l.user_id AND c.expires_at>NOW()
            JOIN hosts h ON h.id=l.host_id AND h.owner_user_id=l.user_id AND h.deleted_at IS NULL
            WHERE l.user_id=NEW.user_id AND l.expires_at>NOW() AND l.protocol=2
              AND ('cloud.notification'=ANY(l.kinds) OR NEW.notification_type::text=ANY(l.kinds)) ORDER BY l.id LIMIT 1;
            IF selected IS NULL THEN RAISE EXCEPTION 'notification lease disappeared'; END IF;
            INSERT INTO notification_dispatches(notification_id,revision,lease_id,pending_deadline,handoff_deadline)
            VALUES(NEW.id,NEW.revision,selected,NOW()+INTERVAL '120 seconds',NOW()+INTERVAL '20 minutes');
        END IF;
    END IF;
    IF NEW.routing_state='user' AND NOT NEW.seen AND NEW.dismissed_at IS NULL THEN
      IF TG_OP='INSERT' OR NEW.revision<>OLD.revision OR NEW.routing_state<>OLD.routing_state THEN
        INSERT INTO notification_delivery_jobs(notification_id,revision,channel,target_id)
        SELECT NEW.id,NEW.revision,'web_push',s.id FROM web_push_subscriptions s
        WHERE s.user_id=NEW.user_id AND COALESCE(NEW.payload->'remote_push_enabled'<>'false'::jsonb,TRUE)
        ON CONFLICT DO NOTHING;
        INSERT INTO notification_delivery_jobs(notification_id,revision,channel,target_id)
        SELECT NEW.id,NEW.revision,'host',c.host_id FROM notification_host_capabilities c
        WHERE c.user_id=NEW.user_id AND c.expires_at>NOW()
          AND (NEW.payload->>'host_id' IS NULL OR NEW.payload->>'host_id'=c.host_id::text) ON CONFLICT DO NOTHING;
      END IF;
    ELSE
        UPDATE notification_delivery_jobs SET status='cancelled',updated_at=NOW()
        WHERE notification_id=NEW.id AND status='pending';
    END IF;
    RETURN NEW;
END $$;
