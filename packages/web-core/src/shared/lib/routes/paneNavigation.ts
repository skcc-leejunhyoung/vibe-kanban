import {
  applyNavigationTransition,
  getDestinationHostId,
  resolveDestinationHostId,
  type AppDestination,
  type AppNavigation,
  type NavigationTransition,
} from '@/shared/lib/routes/appNavigation';
import {
  isPaneRenderableDestination,
  type WorkspacePaneDestination,
} from '@/shared/stores/useWorkspacePanesStore';

export interface PaneNavigationController {
  getDestination(): AppDestination;
  setDestination(destination: WorkspacePaneDestination): void;
}

/**
 * AppNavigation implementation for a split pane. Destinations the pane can
 * render itself (workspace, kanban, pull requests, notifications) stay inside
 * the pane; everything else delegates to the document-level navigation.
 */
export function createPaneAppNavigation(
  base: AppNavigation,
  controller: PaneNavigationController
): AppNavigation {
  const navigateTo = (
    destination: AppDestination,
    transition?: NavigationTransition,
    fallback?: () => void
  ) => {
    const resolved = applyNavigationTransition(destination, transition);
    if (isPaneRenderableDestination(resolved)) {
      if ('hostId' in resolved) {
        const currentHostId = getDestinationHostId(controller.getDestination());
        controller.setDestination({
          ...resolved,
          hostId: resolveDestinationHostId(resolved, currentHostId),
        });
      } else {
        controller.setDestination(resolved);
      }
      return;
    }
    fallback?.();
  };

  return {
    ...base,
    goToWorkspace: (workspaceId, transition) =>
      navigateTo({ kind: 'workspace', workspaceId }, transition, () =>
        base.goToWorkspace(workspaceId, transition)
      ),
    goToProject: (projectId, transition) =>
      navigateTo({ kind: 'project', projectId }, transition, () =>
        base.goToProject(projectId, transition)
      ),
    goToProjectIssue: (projectId, issueId, transition) =>
      navigateTo(
        { kind: 'project-issue', projectId, issueId },
        transition,
        () => base.goToProjectIssue(projectId, issueId, transition)
      ),
    goToProjectIssueWorkspace: (projectId, issueId, workspaceId, transition) =>
      navigateTo(
        {
          kind: 'project-issue-workspace',
          projectId,
          issueId,
          workspaceId,
          hostId: transition?.hostId,
        },
        transition,
        () =>
          base.goToProjectIssueWorkspace(
            projectId,
            issueId,
            workspaceId,
            transition
          )
      ),
    goToNotifications: (transition) =>
      navigateTo({ kind: 'notifications' }, transition, () =>
        base.goToNotifications(transition)
      ),
    goToPullRequests: (prUrl, transition) => {
      // A concrete PR deep-link carries state the pane page cannot receive
      // (search param); let the document route handle it.
      if (prUrl) {
        base.goToPullRequests(prUrl, transition);
        return;
      }
      navigateTo({ kind: 'pull-requests' }, transition, () =>
        base.goToPullRequests(prUrl, transition)
      );
    },
  };
}
