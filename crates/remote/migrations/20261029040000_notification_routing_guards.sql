-- Keep the decision for each revision, including a superseded handoff.
ALTER TABLE notification_dispatches DROP CONSTRAINT notification_dispatches_pkey;
ALTER TABLE notification_dispatches ADD PRIMARY KEY(notification_id,revision);

-- A retry on one host must not resolve to a different host's alert.
DROP INDEX notifications_source_key;
CREATE UNIQUE INDEX notifications_source_key ON notifications
    (user_id,(COALESCE(payload->>'host_id','')),source_key) WHERE source_key IS NOT NULL;

CREATE OR REPLACE FUNCTION notification_routing_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected UUID;
BEGIN
    IF TG_OP='INSERT' OR NEW.revision<>OLD.revision THEN
        UPDATE notification_delivery_jobs SET status='cancelled',updated_at=NOW()
        WHERE notification_id=NEW.id AND status='pending';
        IF TG_OP='UPDATE' THEN
            UPDATE notification_dispatches SET reason='superseded'
            WHERE notification_id=NEW.id AND revision=OLD.revision;
        END IF;
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
