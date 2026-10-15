ALTER TABLE hosts ADD COLUMN preview_ports INTEGER[] NOT NULL DEFAULT '{}',
                  ADD COLUMN preview_ports_updated_at TIMESTAMPTZ;
CREATE TABLE host_preview_sessions (
    id UUID PRIMARY KEY,
    host_id UUID NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    connection_id UUID NOT NULL REFERENCES relay_browser_sessions(id) ON DELETE CASCADE,
    port INTEGER NOT NULL CHECK (port BETWEEN 1024 AND 65535),
    app_origin TEXT NOT NULL,
    exchange_hash TEXT NOT NULL UNIQUE,
    exchange_expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    cookie_hash TEXT UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX host_preview_sessions_connection ON host_preview_sessions(connection_id);

CREATE OR REPLACE FUNCTION host_connection_allowed(p_connection_id UUID, p_host_id UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM relay_browser_sessions c
        JOIN auth_sessions s ON s.id = c.auth_session_id AND s.user_id = c.user_id
        JOIN hosts h ON h.id = c.host_id
        LEFT JOIN host_access_grants g ON g.host_id = h.id AND g.user_id = c.user_id
        WHERE c.id = p_connection_id AND h.id = p_host_id
          AND c.revoked_at IS NULL AND s.revoked_at IS NULL
          AND COALESCE(s.last_used_at, s.created_at) > clock_timestamp() - INTERVAL '365 days'
          AND h.deleted_at IS NULL AND h.remote_access_enabled AND h.auth_mode = 'account'
          AND c.host_generation = h.auth_generation
          AND c.expires_at > clock_timestamp()
          AND (c.public_key_b64 <> '' OR EXISTS (
              SELECT 1 FROM host_preview_sessions p WHERE p.connection_id=c.id
                AND p.expires_at>clock_timestamp()
                AND p.port=ANY(h.preview_ports)
                AND h.preview_ports_updated_at>clock_timestamp()-INTERVAL '40 seconds'
          ))
          AND host_access_role(h.id, c.user_id) IS NOT NULL
          AND (h.owner_user_id = c.user_id AND c.grant_version = 0
               OR g.revoked_at IS NULL AND g.version = c.grant_version)
    )
$$;
