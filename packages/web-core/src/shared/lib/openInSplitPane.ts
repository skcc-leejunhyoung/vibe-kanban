import { useCallback, useMemo } from 'react';
import { openExternalUrl } from '@vibe/ui/lib/open-url';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useAppRuntime, type AppRuntime } from '@/shared/hooks/useAppRuntime';
import {
  useCurrentAppDestination,
  useHasAppDestinationOverride,
} from '@/shared/hooks/useCurrentAppDestination';
import { isMobileViewport, useIsMobile } from '@/shared/hooks/useIsMobile';
import {
  isWorkspacesDestination,
  type AppDestination,
  type AppNavigation,
} from '@/shared/lib/routes/appNavigation';
import {
  getActivePaneWorkspace,
  isPaneRenderableDestination,
  useWorkspacePanesStore,
  type WorkspacePaneDestination,
} from '@/shared/stores/useWorkspacePanesStore';

function paneGridAvailable(appRuntime: AppRuntime): boolean {
  return (
    appRuntime === 'local' &&
    !isMobileViewport() &&
    useWorkspacePanesStore.getState().maxPanes >= 2
  );
}

/** Make sure the pane grid (the workspaces page) is on screen. */
function ensurePaneGridVisible(appNavigation: AppNavigation): void {
  const current = appNavigation.resolveFromPath(window.location.pathname);
  if (!isWorkspacesDestination(current)) {
    appNavigation.goToWorkspaces();
  }
}

/**
 * Set the visible pane count and make sure the pane grid is on screen when
 * more than one pane was requested.
 */
export function applyWorkspacePaneCount(
  total: number,
  appNavigation: AppNavigation
): void {
  useWorkspacePanesStore.getState().setPaneCount(total);
  if (total <= 1) return;
  ensurePaneGridVisible(appNavigation);
}

/**
 * True when the pane grid is on screen right now (workspaces destination on a
 * supported surface) and a secondary pane is focused. Chrome interactions
 * target that pane; anything else behaves exactly as without splits.
 */
function isActivePaneTargeted(
  appNavigation: AppNavigation,
  appRuntime: AppRuntime
): boolean {
  if (useWorkspacePanesStore.getState().activePaneId === null) return false;
  if (!paneGridAvailable(appRuntime)) return false;
  return isWorkspacesDestination(
    appNavigation.resolveFromPath(window.location.pathname)
  );
}

/**
 * Route a destination to the active secondary pane when one is focused on the
 * visible pane grid; otherwise navigate the document. Used by app chrome
 * (app bar, notification bell) so "open project / pull requests /
 * notifications" lands in the selected pane.
 */
export function openDestinationForActivePane(
  destination: WorkspacePaneDestination,
  appNavigation: AppNavigation,
  appRuntime: AppRuntime,
  navigateDocument: () => void
): void {
  const { activePaneId, setPaneDestination } =
    useWorkspacePanesStore.getState();
  if (
    activePaneId !== null &&
    isActivePaneTargeted(appNavigation, appRuntime)
  ) {
    setPaneDestination(activePaneId, destination);
    return;
  }
  navigateDocument();
}

/**
 * The workspace document chrome should act on: the active secondary pane's
 * workspace while the pane grid is on screen, else null (act on the routed
 * primary as usual). Plain variant for action `execute` bodies.
 */
export function getChromeTargetWorkspace(
  appNavigation: AppNavigation,
  appRuntime: AppRuntime
): { workspaceId: string; hostId: string | null } | null {
  if (!isActivePaneTargeted(appNavigation, appRuntime)) return null;
  return getActivePaneWorkspace(useWorkspacePanesStore.getState());
}

/**
 * The active secondary pane's destination while the pane grid is on screen
 * and this hook runs in document scope (no destination override) — i.e. the
 * destination document chrome should reflect and act on. Null → chrome
 * behaves as without splits (routed primary).
 */
export function useChromeTargetDestination(): WorkspacePaneDestination | null {
  const appRuntime = useAppRuntime();
  const isMobile = useIsMobile();
  const hasDestinationOverride = useHasAppDestinationOverride();
  const destination = useCurrentAppDestination();
  const maxPanes = useWorkspacePanesStore((s) => s.maxPanes);
  const activePaneId = useWorkspacePanesStore((s) => s.activePaneId);
  const panes = useWorkspacePanesStore((s) => s.panes);

  if (
    hasDestinationOverride ||
    appRuntime !== 'local' ||
    isMobile ||
    maxPanes < 2 ||
    activePaneId === null ||
    !isWorkspacesDestination(destination)
  ) {
    return null;
  }
  return panes.find((pane) => pane.id === activePaneId)?.destination ?? null;
}

/** Reactive variant of {@link getChromeTargetWorkspace} for chrome components. */
export function useChromeTargetWorkspace(): {
  workspaceId: string;
  hostId: string | null;
} | null {
  const destination = useChromeTargetDestination();
  return useMemo(() => {
    if (destination?.kind !== 'workspace') return null;
    return {
      workspaceId: destination.workspaceId,
      hostId: destination.hostId ?? null,
    };
  }, [destination]);
}

/**
 * Open an app URL "to the side": pane-renderable URLs (workspace, kanban,
 * pull requests, notifications) go to an in-document split pane on the
 * workspaces page; anything else (or unsupported surfaces — remote web,
 * mobile) falls back to a new browser tab/window.
 */
export function openUrlInSplitPane(
  url: string,
  appNavigation: AppNavigation,
  appRuntime: AppRuntime
): void {
  const target: AppDestination | null = appNavigation.resolveFromPath(url);
  if (!paneGridAvailable(appRuntime) || !isPaneRenderableDestination(target)) {
    openExternalUrl(url);
    return;
  }

  useWorkspacePanesStore.getState().openPaneForDestination(target);
  ensurePaneGridVisible(appNavigation);
}

export function useOpenInSplitPane(): (url: string) => void {
  const appRuntime = useAppRuntime();
  const appNavigation = useAppNavigation();

  return useCallback(
    (url: string) => openUrlInSplitPane(url, appNavigation, appRuntime),
    [appRuntime, appNavigation]
  );
}
