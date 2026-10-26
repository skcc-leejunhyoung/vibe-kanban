import { useCallback } from 'react';
import { DrawerTab } from '@/shared/dialogs/quick-chat/DrawerTab';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';

/**
 * The Drawer as a page (`/drawer`, also a split pane): the board from the
 * Quick chat dialog's tab filling its container — no title of its own, the
 * pane chrome and the app shell already name it. `initialNoteId` (`?note=`)
 * opens one note (notifications and pushes land here) and the note the user
 * opens is written back to the URL, so a reload or a shared link returns to it.
 */
export function DrawerPage({ initialNoteId }: { initialNoteId?: string }) {
  const appNavigation = useAppNavigation();
  // Through the (pane-scoped) app navigation, so a split pane retargets itself
  // instead of the document; `replace` keeps note-to-note moves out of history.
  const handleSelectNote = useCallback(
    (noteId: string | null) =>
      appNavigation.goToDrawer(noteId ?? undefined, { replace: true }),
    [appNavigation]
  );
  return (
    <div className="h-full overflow-hidden p-base">
      <DrawerTab
        variant="page"
        initialNoteId={initialNoteId ?? null}
        onSelectNote={handleSelectNote}
      />
    </div>
  );
}
