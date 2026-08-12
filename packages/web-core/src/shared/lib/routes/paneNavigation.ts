import {
  applyNavigationTransition,
  getDestinationHostId,
  resolveDestinationHostId,
  type AppDestination,
  type AppNavigation,
  type NavigationTransition,
} from '@/shared/lib/routes/appNavigation';

export interface PaneNavigationController {
  getDestination(): AppDestination;
  setDestination(destination: AppDestination): void;
}

/**
 * AppNavigation implementation for a split pane. Workspace navigation stays
 * inside the pane (updates pane state); every other destination delegates to
 * the document-level navigation, since panes only render workspace views.
 */
export function createPaneAppNavigation(
  base: AppNavigation,
  controller: PaneNavigationController
): AppNavigation {
  const goToWorkspace = (
    workspaceId: string,
    transition?: NavigationTransition
  ) => {
    const destination = applyNavigationTransition(
      { kind: 'workspace', workspaceId },
      transition
    );
    const currentHostId = getDestinationHostId(controller.getDestination());
    controller.setDestination({
      kind: 'workspace',
      workspaceId,
      hostId: resolveDestinationHostId(destination, currentHostId),
    });
  };

  return {
    ...base,
    goToWorkspace,
  };
}
