import { useRef, useEffect, useCallback, useMemo } from 'react';
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
import { useWorkspaceRepo } from '@/shared/hooks/useWorkspaceRepo';
import { useCurrentAppDestination } from '@/shared/hooks/useCurrentAppDestination';
import {
  useChromeTargetDestination,
  useChromeTargetWorkspace,
} from '@/shared/lib/openInSplitPane';
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
import {
  ArrowSquareOutIcon,
  KanbanIcon,
  StackIcon,
  StarIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { fuzzySearchMatch } from '@vibe/ui/lib/search';
import { openExternalUrl } from '@vibe/ui/lib/open-url';
import { splitPresetActions } from '@/shared/actions/splitPresetActions';
import { useWorkspacePanesStore } from '@/shared/stores/useWorkspacePanesStore';
import { resolveCommandBarIssueIds } from './commandBar/resolveCommandBarIssueIds';
import { resolveWorkspaceNavigationTargets } from './commandBar/workspaceNavigationTargets';
import {
  normalizeBookmarkUrl,
  useUrlBookmarksStore,
} from '@/shared/stores/useUrlBookmarksStore';

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
  hostId: hostIdProp,
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
  const restoreFocusOnCloseRef = useRef(true);
  const pendingAfterCloseRef = useRef<(() => void) | null>(null);
  const { executeAction, getLabel, executorContext } = useActions();
  const { workspaceId: contextRouteWorkspaceId, repos: contextRepos } =
    useWorkspaceContext();
  // Subscribe to keyboard overrides so command bar shortcut hints reflect rebinds.
  const overrides = useKeyboardShortcutsStore((s) => s.overrides);
  const maxSplitPanes = useWorkspacePanesStore((state) => state.maxPanes);
  const bookmarks = useUrlBookmarksStore((state) => state.bookmarks);

  // The command bar acts on the active split pane when one is focused: its
  // workspace becomes the implicit target and its destination supplies the
  // kanban issue context.
  const chromeTargetDestination = useChromeTargetDestination();
  const chromeTargetWorkspace = useChromeTargetWorkspace();
  const contextWorkspaceId =
    chromeTargetWorkspace?.workspaceId ?? contextRouteWorkspaceId;
  // An explicit prop (three-dot menu target) wins; otherwise workspace props
  // follow the active pane so its host scoping stays correct.
  const hostId =
    workspaceId !== undefined || hostIdProp !== undefined
      ? hostIdProp
      : chromeTargetWorkspace
        ? chromeTargetWorkspace.hostId
        : undefined;
  const { repos: chromeTargetRepos } = useWorkspaceRepo(
    chromeTargetWorkspace?.workspaceId,
    { enabled: !!chromeTargetWorkspace }
  );
  const repos = chromeTargetWorkspace ? chromeTargetRepos : contextRepos;

  // Issue context from the effective destination (active pane or document
  // route), not router params, so a focused kanban pane supplies it too.
  const documentDestination = useCurrentAppDestination();
  const effectiveDestination = chromeTargetDestination ?? documentDestination;
  const routeProjectId =
    effectiveDestination && 'projectId' in effectiveDestination
      ? effectiveDestination.projectId
      : undefined;
  const routeIssueId =
    effectiveDestination && 'issueId' in effectiveDestination
      ? effectiveDestination.issueId
      : undefined;
  const multiSelectedIssueIds = useIssueSelectionStore(
    (s) => s.selectedIssueIds
  );
  const cursorIssueId = useIssueSelectionStore((s) => s.cursorIssueId);

  // Effective issue context: props > multi-selection > opened issue > focused card
  const effectiveProjectId = propProjectId ?? routeProjectId;
  const effectiveIssueIds = useMemo(
    () =>
      resolveCommandBarIssueIds({
        explicitIssueIds: propIssueIds,
        selectedIssueIds: multiSelectedIssueIds,
        routeIssueId,
        cursorIssueId,
      }),
    [propIssueIds, multiSelectedIssueIds, routeIssueId, cursorIssueId]
  );
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
            isCurrentWorkspaceTarget:
              effectiveWorkspaceId === contextWorkspaceId &&
              (hostId === undefined ||
                hostId === executorContext.currentHostId),
            workspaceArchived:
              workspace?.archived ?? visibilityContext.workspaceArchived,
            isInPlace: workspace?.in_place ?? visibilityContext.isInPlace,
          }
        : visibilityContext,
    [
      effectiveWorkspaceId,
      contextWorkspaceId,
      executorContext.currentHostId,
      hostId,
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
      restoreFocusOnCloseRef.current = true;
      pendingAfterCloseRef.current = null;
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

    const workspaceActions: ActionDefinition[] =
      resolveWorkspaceNavigationTargets(
        executorContext.activeWorkspaces,
        executorContext.remoteWorkspaces
      )
        .filter(
          (workspace) =>
            workspace.name != null && fuzzySearchMatch(workspace.name, query)
        )
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

  const pageWithSplitPresets = useMemo(() => {
    if (currentPage !== 'root') return pageWithNavigationMatches;
    const query = state.search.trim().toLowerCase();
    const items = splitPresetActions
      .filter((action) => {
        const focusMatch = /^focusPane(\d)$/.exec(action.id);
        return !focusMatch || Number(focusMatch[1]) <= maxSplitPanes;
      })
      .filter(
        (action) =>
          !query ||
          fuzzySearchMatch(String(action.label), query) ||
          action.keywords?.some((keyword) => fuzzySearchMatch(keyword, query))
      )
      .map((action) => ({ type: 'action' as const, action }));
    if (items.length === 0) return pageWithNavigationMatches;
    return {
      ...pageWithNavigationMatches,
      groups: [
        ...pageWithNavigationMatches.groups,
        { label: 'Split screen', items },
      ],
    };
  }, [currentPage, maxSplitPanes, pageWithNavigationMatches, state.search]);

  const pageWithBookmarksAndUrl = useMemo(() => {
    const url = normalizeBookmarkUrl(state.search);
    if (currentPage !== 'root') {
      return pageWithSplitPresets;
    }

    const bookmarkItems = bookmarks.map((bookmark, index) => ({
      type: 'action' as const,
      action: {
        id: `open-bookmark-${index}`,
        label: bookmark.name,
        description: bookmark.url,
        icon: StarIcon,
        requiresTarget: ActionTargetType.NONE,
        execute: () => {
          openExternalUrl(bookmark.url);
        },
      } satisfies ActionDefinition,
    }));
    const groups =
      bookmarkItems.length > 0
        ? [
            ...pageWithSplitPresets.groups,
            { label: 'Bookmarks', items: bookmarkItems },
          ]
        : pageWithSplitPresets.groups;

    if (!url) {
      return { ...pageWithSplitPresets, groups };
    }

    const isBookmarked = bookmarks.some((bookmark) => bookmark.url === url);
    const bookmarkAction: ActionDefinition = {
      id: isBookmarked ? 'remove-bookmark' : 'add-bookmark',
      label: `${isBookmarked ? 'Remove' : 'Add'} bookmark: ${url}`,
      icon: isBookmarked ? TrashIcon : StarIcon,
      requiresTarget: ActionTargetType.NONE,
      executeAfterClose: !isBookmarked,
      execute: () => {
        const store = useUrlBookmarksStore.getState();
        if (isBookmarked) store.removeBookmark(url);
        else {
          const name = window.prompt('Bookmark name', new URL(url).hostname);
          if (name !== null) store.addBookmark(url, name);
        }
      },
    };
    const gotoAction: ActionDefinition = {
      id: 'goto-url',
      label: `Goto: ${url}`,
      icon: ArrowSquareOutIcon,
      requiresTarget: ActionTargetType.NONE,
      execute: () => {
        openExternalUrl(url);
      },
    };
    return {
      ...pageWithSplitPresets,
      groups: [
        ...groups,
        {
          label: 'Bookmark',
          items: [{ type: 'action' as const, action: bookmarkAction }],
        },
        {
          label: 'Open URL',
          items: [{ type: 'action' as const, action: gotoAction }],
        },
      ],
    };
  }, [bookmarks, currentPage, pageWithSplitPresets, state.search]);

  // Handle item selection with side effects
  const handleSelect = useCallback(
    async (item: CommandBarGroupItem<ActionDefinition, PageId>) => {
      const effect = dispatch({
        type: 'SELECT_ITEM',
        item: item as ResolvedGroupItem,
      });
      if (effect.type !== 'execute') return;

      restoreFocusOnCloseRef.current =
        effect.action.restoreFocusOnClose !== false;
      if (effect.action.executeAfterClose) {
        pendingAfterCloseRef.current = () => {
          void executeAction(
            effect.action,
            effectiveWorkspaceId,
            undefined,
            undefined,
            hostId
          );
        };
        modal.hide();
        return;
      }
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
    const pendingAction = pendingAfterCloseRef.current;
    pendingAfterCloseRef.current = null;
    if (pendingAction) {
      requestAnimationFrame(pendingAction);
      return;
    }
    if (!restoreFocusOnCloseRef.current) return;
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
        page={pageWithBookmarksAndUrl}
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
