ALTER TABLE hosts
    ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'legacy_pairing'
        CHECK (auth_mode IN ('legacy_pairing', 'migrating', 'account')),
    ADD COLUMN auth_generation INTEGER NOT NULL DEFAULT 1 CHECK (auth_generation > 0),
    ADD COLUMN remote_access_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN deleted_at TIMESTAMPTZ;

-- Keep revoked rows so stale requests cannot recreate a grant at version zero.
CREATE TABLE host_access_grants (
    host_id UUID NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    PRIMARY KEY (host_id, user_id)
);

CREATE INDEX idx_host_access_grants_active_user
    ON host_access_grants(user_id, host_id) WHERE revoked_at IS NULL;

-- Shared by host discovery and relay authorization. Visibility does not imply
-- that a disabled, migrating, or unsupported host may accept connections.
CREATE FUNCTION host_access_role(p_host_id UUID, p_user_id UUID)
RETURNS TEXT
LANGUAGE SQL STABLE
AS $$
    SELECT CASE
        WHEN h.owner_user_id = p_user_id THEN 'owner'
        WHEN h.auth_mode = 'legacy_pairing' AND EXISTS (
            SELECT 1 FROM organization_member_metadata om
            WHERE om.organization_id = h.shared_with_organization_id
                AND om.user_id = p_user_id
        ) THEN 'member'
        WHEN h.auth_mode IN ('migrating', 'account') AND EXISTS (
            SELECT 1 FROM host_access_grants g
            WHERE g.host_id = h.id AND g.user_id = p_user_id AND g.revoked_at IS NULL
        ) THEN 'member'
    END
    FROM hosts h
    WHERE h.id = p_host_id AND h.deleted_at IS NULL
$$;
