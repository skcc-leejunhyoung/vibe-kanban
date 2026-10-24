-- The Drawer: notes the Autopilot writes for its user, with a comment thread.
-- Synced to clients through Electric (owner-scoped shapes); a user comment
-- joins the agent-event stream as `drawer.comment` so the Autopilot is woken
-- to answer it. Archived notes are pruned after 90 days.
CREATE TABLE drawer_notes (
    id UUID PRIMARY KEY,
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    host_id UUID REFERENCES hosts(id) ON DELETE SET NULL,
    workspace_id UUID,
    session_id UUID,
    execution_id UUID,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    label TEXT,
    pinned BOOLEAN NOT NULL DEFAULT FALSE,
    archived_at TIMESTAMPTZ,
    user_seen_at TIMESTAMPTZ,
    last_comment_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_drawer_notes_owner ON drawer_notes (owner_user_id, archived_at);

CREATE TABLE drawer_comments (
    id UUID PRIMARY KEY,
    note_id UUID NOT NULL REFERENCES drawer_notes(id) ON DELETE CASCADE,
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    author TEXT NOT NULL CHECK (author IN ('user', 'autopilot')),
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_drawer_comments_note ON drawer_comments (note_id, created_at);
CREATE INDEX idx_drawer_comments_owner ON drawer_comments (owner_user_id);

SELECT electric_sync_table('public', 'drawer_notes');
SELECT electric_sync_table('public', 'drawer_comments');

-- A comment wakes the Autopilot through the central stream. The Autopilot's
-- own replies are tagged like its other events, so automation drops them.
CREATE FUNCTION agent_events_from_drawer_comment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    note drawer_notes%ROWTYPE;
BEGIN
    SELECT * INTO note FROM drawer_notes WHERE id = NEW.note_id;
    PERFORM pg_advisory_xact_lock(94838368587348); -- AGENT_EVENTS_LOCK
    INSERT INTO agent_events
        (owner_user_id, host_id, host_cursor, kind, workspace_id, session_id,
         autopilot, data, occurred_at)
    VALUES (
        NEW.owner_user_id, NULL, 0, 'drawer.comment', note.workspace_id, note.session_id,
        NEW.author = 'autopilot',
        jsonb_build_object(
            'note_id', NEW.note_id,
            'comment_id', NEW.id,
            'author', NEW.author,
            'title', left(note.title, 120) || ': ' || left(NEW.body, 500)
        ),
        NEW.created_at
    );
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'agent_events_from_drawer_comment: %', SQLERRM;
    RETURN NEW;
END $$;

CREATE TRIGGER drawer_comments_to_agent_events
    AFTER INSERT ON drawer_comments
    FOR EACH ROW EXECUTE FUNCTION agent_events_from_drawer_comment();
