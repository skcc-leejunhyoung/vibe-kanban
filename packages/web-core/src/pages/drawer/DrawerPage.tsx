import { useCallback } from 'react';
import { useRouter } from '@tanstack/react-router';
import { ArrowLeftIcon, TrayIcon } from '@phosphor-icons/react';
import { DrawerTab } from '@/shared/dialogs/quick-chat/DrawerTab';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useHasAppDestinationOverride } from '@/shared/hooks/useCurrentAppDestination';

/**
 * The Drawer as a page (`/drawer`, also a split pane): the board from the
 * Quick chat dialog's tab filling its container. Inside a pane the chrome
 * names the page; a full-page render (phones) gets its own title and a way
 * back. `initialNoteId` (`?note=`) opens one note (notifications and pushes
 * land here) and the note the user opens is written back to the URL, so a
 * reload or a shared link returns to it.
 */
export function DrawerPage({ initialNoteId }: { initialNoteId?: string }) {
  const router = useRouter();
  const appNavigation = useAppNavigation();
  const isInPane = useHasAppDestinationOverride();
  // Through the (pane-scoped) app navigation, so a split pane retargets itself
  // instead of the document; `replace` keeps note-to-note moves out of history.
  const handleSelectNote = useCallback(
    (noteId: string | null) =>
      appNavigation.goToDrawer(noteId ?? undefined, { replace: true }),
    [appNavigation]
  );
  // A push or a shared link opens the page in a fresh tab with nothing to go
  // back to; land on the workspaces then.
  const goBack = useCallback(() => {
    if (window.history.length > 1) router.history.back();
    else appNavigation.goToWorkspaces();
  }, [router, appNavigation]);
  return (
    <div className="flex h-full flex-col overflow-hidden">
      {!isInPane && (
        <div className="flex items-center gap-half border-b border-border px-base py-base">
          <button
            type="button"
            onClick={goBack}
            aria-label="Back"
            title="Back"
            className="flex items-center justify-center rounded-sm p-half text-low hover:bg-secondary hover:text-normal"
          >
            <ArrowLeftIcon size={18} />
          </button>
          <h1 className="flex items-center gap-base truncate text-xl font-medium text-high">
            <TrayIcon weight="fill" className="size-icon-base text-brand" />
            Drawer
          </h1>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden p-base">
        <DrawerTab
          variant="page"
          initialNoteId={initialNoteId ?? null}
          onSelectNote={handleSelectNote}
        />
      </div>
    </div>
  );
}
