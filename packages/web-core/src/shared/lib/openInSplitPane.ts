import { useCallback } from 'react';
import { openExternalUrl } from '@vibe/ui/lib/open-url';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useAppRuntime, type AppRuntime } from '@/shared/hooks/useAppRuntime';
import { isMobileViewport } from '@/shared/hooks/useIsMobile';
import {
  isWorkspacesDestination,
  type AppNavigation,
} from '@/shared/lib/routes/appNavigation';
import { useWorkspacePanesStore } from '@/shared/stores/useWorkspacePanesStore';

/**
 * Set the visible pane count and make sure the pane grid (the workspaces
 * page) is on screen when more than one pane was requested.
 */
export function applyWorkspacePaneCount(
  total: number,
  appNavigation: AppNavigation
): void {
  useWorkspacePanesStore.getState().setPaneCount(total);
  if (total <= 1) return;
  const current = appNavigation.resolveFromPath(window.location.pathname);
  if (!isWorkspacesDestination(current)) {
    appNavigation.goToWorkspaces();
  }
}

/**
 * Open an app URL "to the side": workspace URLs go to an in-document split
 * pane on the workspaces page; anything else (or unsupported surfaces —
 * remote web, mobile) falls back to a new browser tab/window.
 */
export function openUrlInSplitPane(
  url: string,
  appNavigation: AppNavigation,
  appRuntime: AppRuntime
): void {
  const target = appNavigation.resolveFromPath(url);
  const { maxPanes, openWorkspacePane } = useWorkspacePanesStore.getState();
  if (
    appRuntime !== 'local' ||
    isMobileViewport() ||
    maxPanes < 2 ||
    target?.kind !== 'workspace'
  ) {
    openExternalUrl(url);
    return;
  }

  openWorkspacePane(target.workspaceId, target.hostId ?? null);
  const current = appNavigation.resolveFromPath(window.location.pathname);
  if (!isWorkspacesDestination(current)) {
    appNavigation.goToWorkspaces();
  }
}

export function useOpenInSplitPane(): (url: string) => void {
  const appRuntime = useAppRuntime();
  const appNavigation = useAppNavigation();

  return useCallback(
    (url: string) => openUrlInSplitPane(url, appNavigation, appRuntime),
    [appRuntime, appNavigation]
  );
}
