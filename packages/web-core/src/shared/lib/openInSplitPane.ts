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
  type AppDestination,
  type AppNavigation,
} from '@/shared/lib/routes/appNavigation';
import {
  getActivePaneWorkspace,
  isPaneGridDestination,
  isPaneRenderableDestination,
  useWorkspacePanesStore,
  type WorkspacePaneDestination,
} from '@/shared/stores/useWorkspacePanesStore';

function paneGridAvailable(appRuntime: AppRuntime): boolean {
  return appRuntime === 'local' && !isMobileViewport();
}

/** Make sure the pane grid is on screen. */
export function ensurePaneGridVisible(appNavigation: AppNavigation): void {
  const current = appNavigation.resolveFromPath(window.location.pathname);
  if (!isPaneGridDestination(current)) {
    appNavigation.goToWorkspaces();
  }
}

/** Split: a new empty pane at the right edge, on a visible grid. */
export function openNewPane(appNavigation: AppNavigation): void {
  useWorkspacePanesStore.getState().appendPane();
  ensurePaneGridVisible(appNavigation);
}

/** Open a destination in a newly appended pane, if this surface has room. */
export function openDestinationInNewPane(
  destination: WorkspacePaneDestination,
  appNavigation: AppNavigation,
  appRuntime: AppRuntime
): boolean {
  if (!paneGridAvailable(appRuntime)) return false;

  const before = useWorkspacePanesStore.getState().panes.length;
  useWorkspacePanesStore.getState().appendPane();
  const { panes, activePaneId, setPaneDestination } =
    useWorkspacePanesStore.getState();
  if (panes.length === before || activePaneId === null) return false;

  setPaneDestination(activePaneId, destination);
  ensurePaneGridVisible(appNavigation);
  return true;
}

/** Show the workspace picker in the active pane, or navigate normally. */
export function openWorkspacesForActivePane(
  appNavigation: AppNavigation,
  appRuntime: AppRuntime,
  navigateDocument: () => void
): void {
  if (!isActivePaneTargeted(appNavigation, appRuntime)) {
    navigateDocument();
    return;
  }
  const { activePaneId, clearPaneDestination, focusActivePane } =
    useWorkspacePanesStore.getState();
  if (activePaneId !== null) {
    clearPaneDestination(activePaneId);
    focusActivePane();
    appNavigation.goToWorkspaces();
  }
}

/** Close the focused pane — only while the grid is actually on screen. */
export function closeActivePane(appNavigation: AppNavigation): void {
  const current = appNavigation.resolveFromPath(window.location.pathname);
  if (!isPaneGridDestination(current)) return;
  const { activePaneId, closePane } = useWorkspacePanesStore.getState();
  if (activePaneId !== null) closePane(activePaneId);
}

/** Focus the pane at a position (0-based) — only while the grid is visible. */
export function focusPaneAt(index: number, appNavigation: AppNavigation): void {
  const current = appNavigation.resolveFromPath(window.location.pathname);
  if (!isPaneGridDestination(current)) return;
  useWorkspacePanesStore.getState().focusPaneAt(index);
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
  return isPaneGridDestination(
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
 * True while the pane grid is the visible surface and this hook runs in
 * document scope — i.e. chrome and the workspace list should target the
 * active pane (even one showing the empty picker).
 */
export function useIsPaneGridTargeted(): boolean {
  const appRuntime = useAppRuntime();
  const isMobile = useIsMobile();
  const hasDestinationOverride = useHasAppDestinationOverride();
  const destination = useCurrentAppDestination();
  const activePaneId = useWorkspacePanesStore((s) => s.activePaneId);

  return (
    !hasDestinationOverride &&
    appRuntime === 'local' &&
    !isMobile &&
    activePaneId !== null &&
    isPaneGridDestination(destination)
  );
}

/**
 * The active pane's destination while the pane grid is on screen and this
 * hook runs in document scope — what document chrome should reflect and act
 * on. Null → chrome behaves as without the grid.
 */
export function useChromeTargetDestination(): WorkspacePaneDestination | null {
  const targeted = useIsPaneGridTargeted();
  const activePaneId = useWorkspacePanesStore((s) => s.activePaneId);
  const panes = useWorkspacePanesStore((s) => s.panes);

  if (!targeted) return null;
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
