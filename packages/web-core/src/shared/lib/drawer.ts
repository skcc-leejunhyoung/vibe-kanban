import type { DrawerNote } from 'shared/remote-types';

/** The moment the note last changed for the reader: an edit or a comment. */
export function drawerNoteActivityAt(note: DrawerNote): number {
  const updated = new Date(note.updated_at).getTime();
  const commented = note.last_comment_at
    ? new Date(note.last_comment_at).getTime()
    : 0;
  return Math.max(updated, commented);
}

/** Unread = the user has not opened the note since its last edit or comment. */
export function isDrawerNoteUnread(note: DrawerNote): boolean {
  if (note.archived_at) return false;
  if (!note.user_seen_at) return true;
  return new Date(note.user_seen_at).getTime() < drawerNoteActivityAt(note);
}

/** Pinned first, then most recently active. */
export function sortDrawerNotes(notes: DrawerNote[]): DrawerNote[] {
  return [...notes].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return drawerNoteActivityAt(b) - drawerNoteActivityAt(a);
  });
}

export function splitDrawerNotes(notes: DrawerNote[]): {
  inbox: DrawerNote[];
  archived: DrawerNote[];
  unreadCount: number;
} {
  const inbox = sortDrawerNotes(notes.filter((note) => !note.archived_at));
  const archived = [...notes]
    .filter((note) => note.archived_at)
    .sort(
      (a, b) =>
        new Date(b.archived_at ?? 0).getTime() -
        new Date(a.archived_at ?? 0).getTime()
    );
  return {
    inbox,
    archived,
    unreadCount: inbox.filter(isDrawerNoteUnread).length,
  };
}
