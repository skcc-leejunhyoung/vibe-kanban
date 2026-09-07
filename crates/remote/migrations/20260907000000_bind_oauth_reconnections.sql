-- NULL is an ordinary login. Only the authenticated reconnect endpoint binds
-- a user; deleting that user must delete the handoff, never turn it into login.
ALTER TABLE oauth_handoffs
    ADD COLUMN reconnect_user_id UUID REFERENCES users(id) ON DELETE CASCADE;
