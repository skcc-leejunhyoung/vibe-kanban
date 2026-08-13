import { useEffect, useRef } from 'react';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useCurrentAppDestination } from '@/shared/hooks/useCurrentAppDestination';
import { usePageTitle } from '@/shared/hooks/usePageTitle';
import { useWorkspaceRecord } from '@/shared/hooks/useWorkspaceRecord';
import { navigateDocumentTo } from '@/shared/lib/routes/paneNavigation';
import {
  isPaneRenderableDestination,
  sameDestination,
  useActivePaneWorkspace,
  useWorkspacePanesStore,
  type WorkspacePaneDestination,
} from '@/shared/stores/useWorkspacePanesStore';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { WorkspacesSidebarContainer } from './WorkspacesSidebarContainer';
import { WorkspacePaneGrid } from './WorkspacePaneGrid';
import { shouldAdoptDocumentDestination } from './workspacePaneNavigation';

/**
 * The desktop-local pane surface: the shared workspace list next to the pane
 * grid. Mounted once at the app-shell level for every grid route, so
 * switching the URL between grid destinations never remounts the panes.
 *
 * URL policy: the URL mirrors the active pane (replace-only); external
 * navigations (deep links, notifications, history) are adopted into the
 * active pane without changing the split structure.
 */
export function WorkspacePanesScreen() {
  const appNavigation = useAppNavigation();
  const documentDestination = useCurrentAppDestination();
  const isLeftSidebarVisible = useUiPreferencesStore(
    (s) => s.isLeftSidebarVisible
  );
  const ensurePane = useWorkspacePanesStore((s) => s.ensurePane);
  const adoptRouteDestination = useWorkspacePanesStore(
    (s) => s.adoptRouteDestination
  );
  const panes = useWorkspacePanesStore((s) => s.panes);
  const activePaneId = useWorkspacePanesStore((s) => s.activePaneId);
  const activeDestination =
    panes.find((pane) => pane.id === activePaneId)?.destination ?? null;
  const previousActiveDestinationRef = useRef<
    WorkspacePaneDestination | null | undefined
  >(undefined);
  const shouldAdoptDocument =
    isPaneRenderableDestination(documentDestination) &&
    shouldAdoptDocumentDestination(
      documentDestination,
      activeDestination,
      previousActiveDestinationRef.current
    );

  // Boot: the grid always shows at least one pane.
  useEffect(() => {
    ensurePane();
  }, [ensurePane]);

  // URL → store: adopt externally navigated destinations. Declared before the
  // mirror effect so a deep link wins over the persisted active pane on mount.
  useEffect(() => {
    if (!isPaneRenderableDestination(documentDestination)) return;
    if (!shouldAdoptDocument) return;
    adoptRouteDestination(documentDestination);
  }, [documentDestination, shouldAdoptDocument, adoptRouteDestination]);

  // Store → URL: mirror the active pane into the address bar (replace-only).
  useEffect(() => {
    if (shouldAdoptDocument) return;
    if (!activeDestination) return;
    const urlDestination = appNavigation.resolveFromPath(
      window.location.pathname
    );
    if (
      isPaneRenderableDestination(urlDestination) &&
      sameDestination(urlDestination, activeDestination)
    ) {
      return;
    }
    navigateDocumentTo(activeDestination, appNavigation, { replace: true });
  }, [activeDestination, appNavigation, shouldAdoptDocument]);

  useEffect(() => {
    previousActiveDestinationRef.current = activeDestination;
  }, [activeDestination]);

  // Page title follows the active pane's workspace.
  const activePaneWorkspace = useActivePaneWorkspace();
  const { data: activeWorkspaceRecord } = useWorkspaceRecord(
    activePaneWorkspace?.workspaceId,
    {
      enabled: !!activePaneWorkspace,
      hostId: activePaneWorkspace ? activePaneWorkspace.hostId : undefined,
    }
  );
  usePageTitle(activeWorkspaceRecord?.name);

  return (
    <div className="flex flex-1 min-h-0 h-full">
      {isLeftSidebarVisible && (
        <div className="w-[300px] shrink-0 h-full overflow-hidden">
          <WorkspacesSidebarContainer />
        </div>
      )}
      <div className="flex-1 min-w-0 h-full">
        <WorkspacePaneGrid />
      </div>
    </div>
  );
}
