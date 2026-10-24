import { describe, expect, it } from 'vitest';
import type { DrawerNote } from 'shared/remote-types';
import { isDrawerNoteUnread, splitDrawerNotes } from './drawer';

function note(overrides: Partial<DrawerNote> & { id: string }): DrawerNote {
  return {
    owner_user_id: 'u',
    host_id: null,
    workspace_id: null,
    session_id: null,
    execution_id: null,
    title: overrides.id,
    body: '',
    label: null,
    pinned: false,
    archived_at: null,
    user_seen_at: null,
    last_comment_at: null,
    created_at: '2026-10-24T00:00:00Z',
    updated_at: '2026-10-24T00:00:00Z',
    ...overrides,
  };
}

describe('drawer notes', () => {
  it('is unread until opened after the last edit or comment', () => {
    expect(isDrawerNoteUnread(note({ id: 'new' }))).toBe(true);
    expect(
      isDrawerNoteUnread(
        note({ id: 'seen', user_seen_at: '2026-10-24T01:00:00Z' })
      )
    ).toBe(false);
    expect(
      isDrawerNoteUnread(
        note({
          id: 'edited',
          user_seen_at: '2026-10-24T01:00:00Z',
          updated_at: '2026-10-24T02:00:00Z',
        })
      )
    ).toBe(true);
    expect(
      isDrawerNoteUnread(
        note({
          id: 'commented',
          user_seen_at: '2026-10-24T01:00:00Z',
          last_comment_at: '2026-10-24T03:00:00Z',
        })
      )
    ).toBe(true);
    // Archived notes never count as unread.
    expect(
      isDrawerNoteUnread(
        note({ id: 'gone', archived_at: '2026-10-24T05:00:00Z' })
      )
    ).toBe(false);
  });

  it('splits inbox and archive, pinned first then most recent activity', () => {
    const { inbox, archived, unreadCount } = splitDrawerNotes([
      note({ id: 'old', updated_at: '2026-10-20T00:00:00Z' }),
      note({
        id: 'pinned',
        pinned: true,
        updated_at: '2026-10-19T00:00:00Z',
        user_seen_at: '2026-10-19T01:00:00Z',
      }),
      note({
        id: 'commented',
        updated_at: '2026-10-21T00:00:00Z',
        last_comment_at: '2026-10-23T00:00:00Z',
      }),
      note({ id: 'archived-a', archived_at: '2026-10-22T00:00:00Z' }),
      note({ id: 'archived-b', archived_at: '2026-10-23T00:00:00Z' }),
    ]);
    expect(inbox.map((n) => n.id)).toEqual(['pinned', 'commented', 'old']);
    expect(archived.map((n) => n.id)).toEqual(['archived-b', 'archived-a']);
    expect(unreadCount).toBe(2);
  });
});
