import type { AppDestination } from '@/shared/lib/routes/appNavigation';
import {
  sameDestination,
  type WorkspacePaneDestination,
} from '@/shared/stores/useWorkspacePanesStore';

/**
 * An empty active pane has no content URL to mirror. Left alone, the address
 * bar keeps the previous pane's renderable URL, which the adopt effect then
 * treats as an external navigation and snaps the active pane back off the empty
 * one — breaking cmd+t / alt+tab focus. Park it on the bare grid route instead.
 */
export function shouldParkEmptyPaneUrl(
  activeDestination: WorkspacePaneDestination | null,
  urlDestination: AppDestination | null
): boolean {
  return activeDestination === null && urlDestination?.kind !== 'workspaces';
}

export function shouldAdoptDocumentDestination(
  documentDestination: WorkspacePaneDestination,
  activeDestination: WorkspacePaneDestination | null,
  previousActiveDestination: WorkspacePaneDestination | null | undefined
): boolean {
  if (sameDestination(documentDestination, activeDestination)) return false;
  return (
    previousActiveDestination === undefined ||
    sameDestination(previousActiveDestination, activeDestination)
  );
}
