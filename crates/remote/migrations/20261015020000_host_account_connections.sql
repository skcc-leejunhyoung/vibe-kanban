ALTER TABLE users ADD COLUMN suspended_at TIMESTAMPTZ;
ALTER TABLE hosts
    ADD COLUMN transition_request_id UUID,
    ADD COLUMN capabilities TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN registered_at TIMESTAMPTZ;

CREATE TABLE host_credentials (
    id UUID PRIMARY KEY,
    host_id UUID NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    secret_hash TEXT NOT NULL UNIQUE,
    generation INTEGER NOT NULL,
    request_id UUID NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);
CREATE INDEX host_credentials_host ON host_credentials(host_id);

ALTER TABLE relay_browser_sessions
    ADD COLUMN public_key_b64 TEXT,
    ADD COLUMN grant_version INTEGER,
    ADD COLUMN host_generation INTEGER,
    ADD COLUMN expires_at TIMESTAMPTZ,
    ADD COLUMN lease_expires_at TIMESTAMPTZ;

CREATE TABLE host_access_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id UUID REFERENCES hosts(id) ON DELETE CASCADE,
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    target_id UUID,
    action TEXT NOT NULL,
    result TEXT NOT NULL,
    request_id TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX host_access_audit_host_time ON host_access_audit(host_id, created_at DESC);

CREATE OR REPLACE FUNCTION host_access_role(p_host_id UUID, p_user_id UUID)
RETURNS TEXT LANGUAGE SQL STABLE AS $$
    SELECT CASE
        WHEN h.owner_user_id = p_user_id THEN 'owner'
        WHEN h.auth_mode = 'legacy_pairing' AND EXISTS (
            SELECT 1 FROM organization_member_metadata om
            WHERE om.organization_id = h.shared_with_organization_id AND om.user_id = p_user_id
        ) THEN 'member'
        WHEN h.auth_mode IN ('migrating', 'account') AND EXISTS (
            SELECT 1 FROM host_access_grants g
            WHERE g.host_id = h.id AND g.user_id = p_user_id AND g.revoked_at IS NULL
        ) THEN 'member'
    END FROM hosts h
    JOIN users owner_account ON owner_account.id = h.owner_user_id AND owner_account.suspended_at IS NULL
    JOIN users account ON account.id = p_user_id AND account.suspended_at IS NULL
    WHERE h.id = p_host_id AND h.deleted_at IS NULL
$$;

-- One predicate for grant redemption, renewal and every Relay request. Versions
-- prevent an old approval becoming usable again after revoke/regrant or restart.
CREATE FUNCTION host_connection_allowed(p_connection_id UUID, p_host_id UUID)
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
          AND host_access_role(h.id, c.user_id) IS NOT NULL
          AND (h.owner_user_id = c.user_id AND c.grant_version = 0
               OR g.revoked_at IS NULL AND g.version = c.grant_version)
    )
$$;

-- Revocations and suspension must invalidate already issued connections even if
-- the account is later restored. This also covers administration outside the API.
CREATE FUNCTION suspend_host_account() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.suspended_at IS NOT NULL AND OLD.suspended_at IS NULL THEN
        UPDATE auth_sessions SET revoked_at = clock_timestamp()
          WHERE user_id = NEW.id AND revoked_at IS NULL;
        UPDATE hosts SET auth_generation = auth_generation + 1,
          remote_access_enabled = FALSE, updated_at = clock_timestamp()
          WHERE owner_user_id = NEW.id AND deleted_at IS NULL;
        UPDATE host_credentials SET revoked_at = clock_timestamp()
          WHERE host_id IN (SELECT id FROM hosts WHERE owner_user_id = NEW.id) AND revoked_at IS NULL;
        UPDATE relay_browser_sessions SET revoked_at = clock_timestamp()
          WHERE revoked_at IS NULL AND (user_id = NEW.id OR host_id IN (
              SELECT id FROM hosts WHERE owner_user_id = NEW.id));
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER users_suspend_host_access AFTER UPDATE OF suspended_at ON users
FOR EACH ROW EXECUTE FUNCTION suspend_host_account();
