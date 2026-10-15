ALTER TABLE auth_sessions ADD COLUMN device_label TEXT;
ALTER TABLE hosts ADD COLUMN relay_connection_id UUID,
                  ADD COLUMN relay_lease_until TIMESTAMPTZ;
