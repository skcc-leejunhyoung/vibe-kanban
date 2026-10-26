import { useCallback } from 'react';
import { useRouter } from '@tanstack/react-router';
import { ArrowLeftIcon, TrayIcon } from '@phosphor-icons/react';
import { cn } from '@vibe/ui/lib/cn';
import { DrawerTab } from '@/shared/dialogs/quick-chat/DrawerTab';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useHasAppDestinationOverride } from '@/shared/hooks/useCurrentAppDestination';
import { usePaneNarrowerThan } from '@/shared/components/workspace-panes/PaneWidthContext';

/**
 * The Drawer as a page (`/drawer`, also a split pane): the same board as the
 * Quick chat dialog's tab, with the full width and height of its container.
 * `initialNoteId` (`?note=`) opens one note — notifications and pushes land
 * here — and the note the user opens is written back to the URL, so a reload
 * or a shared link returns to it.
 */
export function DrawerPage({ initialNoteId }: { initialNoteId?: string }) {
  const router = useRouter();
  const appNavigation = useAppNavigation();
  const isInPane = useHasAppDestinationOverride();
  const isNarrow = usePaneNarrowerThan(768);
  const showBack = isNarrow && !isInPane;
  // Through the (pane-scoped) app navigation, so a split pane retargets itself
  // instead of the document; `replace` keeps note-to-note moves out of history.
  const handleSelectNote = useCallback(
    (noteId: string | null) =>
      appNavigation.goToDrawer(noteId ?? undefined, { replace: true }),
    [appNavigation]
  );
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-half border-b border-border px-double py-base">
        <button
          type="button"
          onClick={() => router.history.back()}
          className={cn(
            'items-center justify-center rounded-sm p-half text-low hover:bg-secondary hover:text-normal',
            showBack ? 'flex' : 'hidden'
          )}
          aria-label="Back"
          title="Back"
        >
          <ArrowLeftIcon size={18} />
        </button>
        <h1 className="flex items-center gap-base truncate text-xl font-medium text-high">
          <TrayIcon weight="fill" className="size-icon-base text-brand" />
          Drawer
        </h1>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden px-double py-base">
        <DrawerTab
          variant="page"
          initialNoteId={initialNoteId ?? null}
          onSelectNote={handleSelectNote}
        />
      </div>
    </div>
  );
}
