import { WorkspacesSidebarContainer } from './WorkspacesSidebarContainer';
import { useIsMobile } from '@/shared/hooks/useIsMobile';

/**
 * Host-neutral workspace landing page for surfaces without the pane grid
 * (mobile, remote web). Desktop local renders WorkspacePanesScreen from the
 * app shell instead of this page.
 *
 * Keeping the real sidebar mounted here preserves its list state, prefetching,
 * and global Ctrl+Tab bindings before a concrete workspace has been selected.
 */
export function WorkspacesListPage() {
  const isMobile = useIsMobile();

  if (isMobile) {
    return <WorkspacesSidebarContainer isStandalonePage />;
  }

  return (
    <div className="flex h-full min-h-0 flex-1">
      <div className="w-[300px] shrink-0 overflow-hidden">
        <WorkspacesSidebarContainer isStandalonePage />
      </div>
      <div className="flex min-w-0 flex-1 items-center justify-center bg-primary px-double text-center text-sm text-low">
        Select a workspace from the list or create a new one.
      </div>
    </div>
  );
}
