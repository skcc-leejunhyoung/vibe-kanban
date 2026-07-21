import { useRef, useEffect, useCallback, useMemo } from 'react';
import { useParams } from '@tanstack/react-router';
import { create, useModal } from '@ebay/nice-modal-react';
import { defineModal } from '@/shared/lib/modals';
import { CommandDialog } from '@vibe/ui/components/Command';
import {
  CommandBar,
  type CommandBarGroupItem,
} from '@vibe/ui/components/CommandBar';
import { useActions } from '@/shared/hooks/useActions';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { useWorkspaceRecord } from '@/shared/hooks/useWorkspaceRecord';
import { IdeIcon } from '@/shared/components/IdeIcon';
import type { PageId, ResolvedGroupItem } from '@/shared/types/commandBar';
import {
  ActionTargetType,
  type ActionDefinition,
} from '@/shared/types/actions';
import { useActionVisibilityContext } from '@/shared/hooks/useActionVisibilityContext';
import type { SelectionPage } from './SelectionDialog';
import type { RepoSelectionResult } from './selections/repoSelection';
import { useCommandBarState } from './commandBar/useCommandBarState';
import { useResolvedPage } from './commandBar/useResolvedPage';
import { useIssueSelectionStore } from '@/shared/stores/useIssueSelectionStore';
import { useKeyboardShortcutsStore } from '@/shared/stores/useKeyboardShortcutsStore';
import { effectiveActionShortcut } from '@/shared/keyboard/registry';
import { KanbanIcon, StackIcon } from '@phosphor-icons/react';
import { fuzzySearchMatch } from '@vibe/ui/lib/search';

export interface CommandBarDialogProps {
  page?: PageId;
  workspaceId?: string;
  hostId?: string | null;
  repoId?: string;
  /** Issue context for kanban mode - projectId */
  projectId?: string;
  /** Issue context for kanban mode - selected issue IDs */
  issueIds?: string[];
}

function CommandBarContent({
  page,
  workspaceId,
  hostId,
  initialRepoId,
  propProjectId,
  propIssueIds,
}: {
  page: PageId;
  workspaceId?: string;
  hostId?: string | null;
  initialRepoId?: string;
  propProjectId?: string;
  propIssueIds?: string[];
}) {
  const modal = useModal();
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const { executeAction, getLabel, executorContext } = useActions();
  const { workspaceId: contextWorkspaceId, repos } = useWorkspaceContext();
  // Subscribe to keyboard overrides so command bar shortcut hints reflect rebinds.
  const overrides = useKeyboardShortcutsStore((s) => s.overrides);

  // Get issue context from props, multi-selection store, or route params
  const { projectId: routeProjectId, issueId: routeIssueId } = useParams({
    strict: false,
  });
  const multiSelectedIssueIds = useIssueSelectionStore(
    (s) => s.selectedIssueIds
  );

  // Effective issue context: props > multi-selection > route param
  const effectiveProjectId = propProjectId ?? routeProjectId;
  const effectiveIssueIds = useMemo(() => {
    if (propIssueIds) return propIssueIds;
    if (multiSelectedIssueIds.size > 0) return [...multiSelectedIssueIds];
    return routeIssueId ? [routeIssueId] : [];
  }, [propIssueIds, multiSelectedIssueIds, routeIssueId]);
  const visibilityContext = useActionVisibilityContext({
    projectId: effectiveProjectId,
    issueIds: effectiveIssueIds,
  });

  const effectiveWorkspaceId = workspaceId ?? contextWorkspaceId;
  // Fetch the *target* workspace record (host-scoped) so labels and visibility
  // reflect the workspace the menu was opened on, regardless of which
  // workspace — if any — is selected in the current route.
  const { data: workspace } = useWorkspaceRecord(effectiveWorkspaceId, {
    hostId,
  });

  // The command bar is always opened against a specific target workspace (e.g.
  // the three-dot menu on a workspace row). On list-only routes — such as the
  // mobile workspaces list — no workspace is selected in the route, so the
  // route-derived context reports `hasWorkspace: false` and would hide
  // workspace-target actions like Archive. Override the workspace fields from
  // the explicit target so those actions stay available.
  const effectiveVisibilityContext = useMemo(
    () =>
      effectiveWorkspaceId
        ? {
            ...visibilityContext,
            hasWorkspace: true,
            workspaceArchived:
              workspace?.archived ?? visibilityContext.workspaceArchived,
            isInPlace: workspace?.in_place ?? visibilityContext.isInPlace,
          }
        : visibilityContext,
    [
      effectiveWorkspaceId,
      visibilityContext,
      workspace?.archived,
      workspace?.in_place,
    ]
  );

  // State machine
  const { state, currentPage, canGoBack, dispatch } = useCommandBarState(page);

  // Reset state and capture focus when dialog opens
  useEffect(() => {
    if (modal.visible) {
      dispatch({ type: 'RESET', page });
      previousFocusRef.current = document.activeElement as HTMLElement;
    }
  }, [modal.visible, page, dispatch]);

  // Resolve current page to renderable data
  const resolvedPage = useResolvedPage(
    currentPage,
    state.search,
    effectiveVisibilityContext,
    workspace
  );
  const pageWithNavigationMatches = useMemo(() => {
    const query = state.search.trim().toLowerCase();
    if (currentPage !== 'root' || !query) return resolvedPage;

    const projectActions: ActionDefinition[] =
      executorContext.navigationProjects
        .filter((project) => fuzzySearchMatch(project.name, query))
        .map((project) => ({
          id: `goto-project-${project.id}`,
          label: `Project: ${project.name}`,
          icon: KanbanIcon,
          requiresTarget: ActionTargetType.NONE,
          execute: (ctx) => ctx.appNavigation.goToProject(project.id),
        }));

    const seenWorkspaceIds = new Set<string>();
    const workspaceActions: ActionDefinition[] =
      executorContext.activeWorkspaces
        .map((workspace) => ({
          id: `${workspace.hostId ?? 'local'}:${workspace.id}`,
          localWorkspaceId: workspace.id,
          hostId: workspace.hostId ?? null,
          name: workspace.name,
        }))
        .filter((workspace) => {
          if (seenWorkspaceIds.has(workspace.id)) return false;
          seenWorkspaceIds.add(workspace.id);
          return (
            workspace.name != null && fuzzySearchMatch(workspace.name, query)
          );
        })
        .map((workspace) => ({
          id: `goto-workspace-${workspace.id}`,
          label: `Workspace: ${workspace.name ?? workspace.localWorkspaceId}`,
          icon: StackIcon,
          requiresTarget: ActionTargetType.NONE,
          execute: (ctx) =>
            ctx.appNavigation.goToWorkspace(workspace.localWorkspaceId, {
              hostId: workspace.hostId,
            }),
        }));

    const navigationItems = [...projectActions, ...workspaceActions].map(
      (action) => ({ type: 'action' as const, action })
    );
    if (navigationItems.length === 0) return resolvedPage;

    return {
      ...resolvedPage,
      groups: [
        ...resolvedPage.groups,
        { label: 'Go directly to', items: navigationItems },
      ],
    };
  }, [currentPage, executorContext, resolvedPage, state.search]);

  // Handle item selection with side effects
  const handleSelect = useCallback(
    async (item: CommandBarGroupItem<ActionDefinition, PageId>) => {
      const effect = dispatch({
        type: 'SELECT_ITEM',
        item: item as ResolvedGroupItem,
      });
      if (effect.type !== 'execute') return;

      modal.hide();

      if (effect.action.requiresTarget === ActionTargetType.ISSUE) {
        executeAction(
          effect.action,
          undefined,
          effectiveProjectId,
          effectiveIssueIds
        );
      } else if (effect.action.requiresTarget === ActionTargetType.GIT) {
        // Resolve repoId: use initialRepoId, single repo, or show selection dialog
        let repoId: string | undefined = initialRepoId;
        if (!repoId && repos.length === 1) {
          repoId = repos[0].id;
        } else if (!repoId && repos.length > 1) {
          const { SelectionDialog } = await import('./SelectionDialog');
          const { buildRepoSelectionPages } = await import(
            './selections/repoSelection'
          );
          const result = await SelectionDialog.show({
            initialPageId: 'selectRepo',
            pages: buildRepoSelectionPages(repos) as Record<
              string,
              SelectionPage
            >,
          });
          if (result && typeof result === 'object' && 'repoId' in result) {
            repoId = (result as RepoSelectionResult).repoId;
          }
        }
        if (repoId) {
          executeAction(effect.action, effectiveWorkspaceId, repoId);
        }
      } else {
        executeAction(
          effect.action,
          effectiveWorkspaceId,
          undefined,
          undefined,
          hostId
        );
      }
    },
    [
      dispatch,
      modal,
      executeAction,
      effectiveWorkspaceId,
      effectiveProjectId,
      effectiveIssueIds,
      hostId,
      repos,
      initialRepoId,
    ]
  );

  // Restore focus when dialog closes (unless another dialog has taken focus)
  const handleCloseAutoFocus = useCallback((event: Event) => {
    event.preventDefault();
    // Don't restore focus if another dialog has taken over (e.g., action opened a new dialog)
    const activeElement = document.activeElement;
    const isInDialog = activeElement?.closest('[role="dialog"]');
    if (!isInDialog) {
      previousFocusRef.current?.focus();
    }
  }, []);

  return (
    <CommandDialog
      open={modal.visible}
      onOpenChange={(open) => !open && modal.hide()}
      onCloseAutoFocus={handleCloseAutoFocus}
    >
      <CommandBar
        page={pageWithNavigationMatches}
        canGoBack={canGoBack}
        onGoBack={() => dispatch({ type: 'GO_BACK' })}
        onSelect={handleSelect}
        getLabel={(action) =>
          getLabel(action, workspace, effectiveVisibilityContext)
        }
        getShortcut={(action) =>
          effectiveActionShortcut(action.id, action.shortcut, overrides)
        }
        search={state.search}
        onSearchChange={(query) => dispatch({ type: 'SEARCH_CHANGE', query })}
        renderSpecialActionIcon={(iconName) =>
          iconName === 'ide-icon' ? (
            <IdeIcon
              editorType={visibilityContext.editorType}
              className="h-4 w-4"
            />
          ) : null
        }
      />
    </CommandDialog>
  );
}

const CommandBarDialogImpl = create<CommandBarDialogProps>(
  ({
    page = 'root',
    workspaceId,
    hostId,
    repoId: initialRepoId,
    projectId: propProjectId,
    issueIds: propIssueIds,
  }) => (
    <CommandBarContent
      page={page}
      workspaceId={workspaceId}
      hostId={hostId}
      initialRepoId={initialRepoId}
      propProjectId={propProjectId}
      propIssueIds={propIssueIds}
    />
  )
);

export const CommandBarDialog = defineModal<CommandBarDialogProps | void, void>(
  CommandBarDialogImpl
);
