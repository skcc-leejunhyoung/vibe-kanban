-- Account-scoped settings for the remote web ("Remote" device in the settings
-- host picker). A single opaque Config blob per user, shared across every
-- remote-web session so preferences edit + save once and sync to all devices.
CREATE TABLE user_web_settings (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    settings JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
