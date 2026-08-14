import {
  useMemo,
  useCallback,
  useState,
  useEffect,
  useRef,
  type MouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectContext } from '@/shared/hooks/useProjectContext';
import { useOrgContext } from '@/shared/hooks/useOrgContext';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { useActions } from '@/shared/hooks/useActions';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useWorkspaceHostMap } from '@/shared/hooks/useWorkspaceHostMap';
import { useIsMobile, useIsTouchDevice } from '@/shared/hooks/useIsMobile';
import { usePaneNarrowerThan } from '@/shared/components/workspace-panes/PaneWidthContext';
import { cn } from '@/shared/lib/utils';
import { useCurrentKanbanRouteState } from '@/shared/hooks/useCurrentKanbanRouteState';
import {
  useUiPreferencesStore,
  buildDefaultProjectViews,
  DEFAULT_PROJECT_VIEW_IDS,
  DEFAULT_KANBAN_FILTER_STATE,
  DEFAULT_KANBAN_SHOW_WORKSPACES,
  DEFAULT_KANBAN_HIDE_BLOCKED,
  KANBAN_ASSIGNEE_FILTER_VALUES,
  type KanbanFilterState,
  type KanbanSortField,
  type KanbanViewMode,
  type KanbanProjectViewPreferences,
} from '@/shared/stores/useUiPreferencesStore';
import {
  areAdvancedFiltersEqual,
  isAdvancedFilterActive,
  type AdvancedFilter,
} from '@/shared/filters/filterTree';
import { useProjectViewSwitcherStore } from '@/shared/stores/useProjectViewSwitcherStore';
import {
  useKanbanFilters,
  PRIORITY_ORDER,
} from '../model/hooks/useKanbanFilters';
import {
  bulkUpdateIssues,
  type BulkUpdateIssueItem,
} from '@/shared/lib/remoteApi';
import { PlusIcon, DotsThreeIcon } from '@phosphor-icons/react';
import { Actions } from '@/shared/actions';
import {
  buildKanbanIssueComposerKey,
  closeKanbanIssueComposer,
  openKanbanIssueComposer,
  type ProjectIssueCreateOptions,
  useKanbanIssueComposer,
} from '@/shared/stores/useKanbanIssueComposerStore';
import type { OrganizationMemberWithProfile } from 'shared/types';
import {
  KanbanProvider,
  KanbanBoard,
  KanbanCard,
  KanbanCards,
  KanbanHeader,
  type DropResult,
} from '@vibe/ui/components/KanbanBoard';
import { ConfirmDialog } from '@vibe/ui/components/ConfirmDialog';
import {
  KanbanCardContent,
  type KanbanGithubIssue,
} from '@vibe/ui/components/KanbanCardContent';
import {
  IssueWorkspaceCard,
  type WorkspaceWithStats,
  type WorkspacePr,
} from '@vibe/ui/components/IssueWorkspaceCard';
import { resolveRelationshipsForIssue } from '@/shared/lib/resolveRelationships';
import { KanbanFilterBar } from '@vibe/ui/components/KanbanFilterBar';
import { ViewNavTabs } from '@vibe/ui/components/ViewNavTabs';
import { IssueListView } from '@vibe/ui/components/IssueListView';
import { CommandBarDialog } from '@/shared/dialogs/command-bar/CommandBarDialog';
import { KanbanFiltersDialog } from '@/shared/dialogs/kanban/KanbanFiltersDialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@vibe/ui/components/Dropdown';
import { SearchableTagDropdownContainer } from '@/shared/components/SearchableTagDropdownContainer';
import type { IssuePriority } from 'shared/remote-types';
import { useIssueMultiSelect } from '@/shared/hooks/useIssueMultiSelect';
import { useIssueSelectionStore } from '@/shared/stores/useIssueSelectionStore';
import { useHotkeys } from 'react-hotkeys-hook';
import {
  Scope,
  useKeyNavUp,
  useKeyNavDown,
  useKeyNavLeft,
  useKeyNavRight,
} from '@/shared/keyboard';
import { BulkActionBarContainer } from './BulkActionBarContainer';
import { shouldStartBoardNavigation } from '../model/shouldStartBoardNavigation';
import { useOpenInSplitPane } from '@/shared/lib/openInSplitPane';
import { COMMAND_PALETTE_EVENT } from '@/shared/lib/commandPaletteEvents';

const areStringSetsEqual = (left: string[], right: string[]): boolean => {
  if (left.length !== right.length) {
    return false;
  }

  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
};

const areKanbanFiltersEqual = (
  left: KanbanFilterState,
  right: KanbanFilterState
): boolean => {
  // Sort is orthogonal to filter mode and always applies.
  if (
    left.sortField !== right.sortField ||
    left.sortDirection !== right.sortDirection
  ) {
    return false;
  }

  // An advanced tree only counts once it has an effective condition, so merely
  // switching the Simple/Advanced toggle (empty tree) doesn't read as "filtered".
  const leftAdvanced = isAdvancedFilterActive(left.advancedFilter)
    ? (left.advancedFilter ?? null)
    : null;
  const rightAdvanced = isAdvancedFilterActive(right.advancedFilter)
    ? (right.advancedFilter ?? null)
    : null;

  // When either side is in effective advanced mode, the tree is the sole filter
  // identity — flat fields are superseded and must not affect equality.
  if (leftAdvanced || rightAdvanced) {
    return areAdvancedFiltersEqual(leftAdvanced, rightAdvanced);
  }

  if (left.searchQuery.trim() !== right.searchQuery.trim()) {
    return false;
  }
  if (!areStringSetsEqual(left.priorities, right.priorities)) {
    return false;
  }
  if (!areStringSetsEqual(left.assigneeIds, right.assigneeIds)) {
    return false;
  }
  if (!areStringSetsEqual(left.tagIds, right.tagIds)) {
    return false;
  }
  if (!areStringSetsEqual(left.milestoneIds ?? [], right.milestoneIds ?? [])) {
    return false;
  }
  return (left.overdue ?? false) === (right.overdue ?? false);
};

function LoadingState() {
  const { t } = useTranslation('common');
  return (
    <div className="flex items-center justify-center h-full">
      <p className="text-low">{t('states.loading')}</p>
    </div>
  );
}

/**
 * KanbanContainer displays the kanban board using data from ProjectContext and OrgContext.
 * Must be rendered within both OrgProvider and ProjectProvider.
 */
export function KanbanContainer() {
  const isMobileViewport = useIsMobile();
  const isNarrowPane = usePaneNarrowerThan(768);
  const isMobile = isMobileViewport || isNarrowPane;
  // Touch devices (incl. iPadOS, which can spoof a desktop UA/viewport) need the
  // explicit multi-select toggle since there is no Cmd/Shift+Click affordance.
  const isTouch = useIsTouchDevice();
  const { t } = useTranslation('common');
  const appNavigation = useAppNavigation();
  const openInSplitPane = useOpenInSplitPane();
  const routeState = useCurrentKanbanRouteState();

  // Get data from contexts (set up by WorkspacesLayout)
  const {
    projectId,
    issues,
    statuses,
    tags,
    issueAssignees,
    issueTags,
    milestones,
    issueMilestones,
    issueRelationships,
    getTagObjectsForIssue,
    getMilestoneForIssue,
    getTagsForIssue,
    getPullRequestsForIssue,
    getWorkspacesForIssue,
    getRelationshipsForIssue,
    issuesById,
    insertIssue,
    insertIssueAssignee,
    insertIssueTag,
    removeIssueTag,
    insertTag,
    pullRequests,
    githubIssueLinks,
    isLoading: projectLoading,
  } = useProjectContext();

  const {
    projects,
    membersWithProfilesById,
    isLoading: orgLoading,
  } = useOrgContext();
  const { activeWorkspaces } = useWorkspaceContext();
  const { userId } = useAuth();
  const workspaceHostMap = useWorkspaceHostMap();

  // Get project name by finding the project matching current projectId
  const projectName = projects.find((p) => p.id === projectId)?.name ?? '';

  const selectedKanbanIssueId = routeState.issueId;
  const issueComposerKey = useMemo(
    () => buildKanbanIssueComposerKey(routeState.hostId, projectId),
    [routeState.hostId, projectId]
  );
  const issueComposer = useKanbanIssueComposer(issueComposerKey);
  const isIssueComposerOpen = issueComposer !== null;
  const openIssue = useCallback(
    (issueId: string) => {
      if (isIssueComposerOpen) {
        closeKanbanIssueComposer(issueComposerKey);
      }

      appNavigation.goToProjectIssue(projectId, issueId);
    },
    [isIssueComposerOpen, issueComposerKey, appNavigation, projectId]
  );
  const startCreate = useCallback(
    (options?: ProjectIssueCreateOptions) => {
      openKanbanIssueComposer(issueComposerKey, options);
    },
    [issueComposerKey]
  );

  // Get setter and executor from ActionsContext
  const {
    setDefaultCreateStatusId,
    executeAction,
    openPrioritySelection,
    openAssigneeSelection,
  } = useActions();
  const openProjectsGuide = useCallback(() => {
    executeAction(Actions.ProjectsGuide);
  }, [executeAction]);

  // --- Active project view --------------------------------------------------
  const activeViewSelection = useUiPreferencesStore(
    (s) => s.kanbanProjectViewSelections[projectId]
  );
  const storedProjectViews = useUiPreferencesStore(
    (s) => s.projectViewsById[projectId]
  );
  const setKanbanProjectView = useUiPreferencesStore(
    (s) => s.setKanbanProjectView
  );
  const projectViewPreferencesById = useUiPreferencesStore(
    (s) => s.kanbanProjectViewPreferences[projectId]
  );
  const setKanbanProjectViewPreferences = useUiPreferencesStore(
    (s) => s.setKanbanProjectViewPreferences
  );
  const clearKanbanProjectViewPreferences = useUiPreferencesStore(
    (s) => s.clearKanbanProjectViewPreferences
  );

  // Sort all statuses for grouping and default-view derivation.
  const sortedStatuses = useMemo(
    () => [...statuses].sort((a, b) => a.sort_order - b.sort_order),
    [statuses]
  );

  // Effective views: user-defined when present, else built-in defaults derived
  // from the project's statuses (Active / All / one per hidden status).
  const projectViews = useMemo(() => {
    if (storedProjectViews && storedProjectViews.length > 0) {
      return storedProjectViews;
    }
    return buildDefaultProjectViews(sortedStatuses, {
      active: t('kanban.viewTabs.active', 'Active'),
      all: t('kanban.viewTabs.all', 'All'),
    });
  }, [storedProjectViews, sortedStatuses, t]);

  const activeViewId = useMemo(() => {
    const requested = activeViewSelection?.activeViewId;
    if (requested && projectViews.some((v) => v.id === requested)) {
      return requested;
    }
    return projectViews[0]?.id ?? DEFAULT_PROJECT_VIEW_IDS.ACTIVE;
  }, [activeViewSelection, projectViews]);

  const activeView = useMemo(
    () => projectViews.find((v) => v.id === activeViewId) ?? projectViews[0],
    [projectViews, activeViewId]
  );

  // The view's configured default (edited in project settings) and the
  // transient toolbar override layered on top of it. The toolbar never mutates
  // the saved view default; "Clear filters" drops the override to reveal it.
  const viewDefaultFilters = activeView?.filters ?? DEFAULT_KANBAN_FILTER_STATE;
  const viewDefaultShowSubIssues = activeView?.showSubIssues ?? true;
  const viewDefaultShowWorkspaces =
    activeView?.showWorkspaces ?? DEFAULT_KANBAN_SHOW_WORKSPACES;
  const viewDefaultHideBlocked =
    activeView?.hideBlocked ?? DEFAULT_KANBAN_HIDE_BLOCKED;

  const viewOverride = projectViewPreferencesById?.[activeViewId];
  const kanbanFilters = viewOverride?.filters ?? viewDefaultFilters;
  const showSubIssues = viewOverride?.showSubIssues ?? viewDefaultShowSubIssues;
  const showWorkspaces =
    viewOverride?.showWorkspaces ?? viewDefaultShowWorkspaces;
  const hideBlocked = viewOverride?.hideBlocked ?? viewDefaultHideBlocked;
  const kanbanViewMode: KanbanViewMode =
    activeView?.layout === 'table' ? 'list' : 'kanban';

  // Active filters == the current state diverges from this view's own default,
  // so switching to a view with configured defaults doesn't read as "filtered".
  const hasActiveFilters = useMemo(
    () =>
      !areKanbanFiltersEqual(kanbanFilters, viewDefaultFilters) ||
      showSubIssues !== viewDefaultShowSubIssues ||
      showWorkspaces !== viewDefaultShowWorkspaces ||
      hideBlocked !== viewDefaultHideBlocked,
    [
      kanbanFilters,
      viewDefaultFilters,
      showSubIssues,
      viewDefaultShowSubIssues,
      showWorkspaces,
      viewDefaultShowWorkspaces,
      hideBlocked,
      viewDefaultHideBlocked,
    ]
  );
  const shouldAnimateCreateButton = issues.length === 0;

  // Toolbar edits write a transient per-view override (a full snapshot of the
  // current effective state plus the patch), leaving the saved view definition
  // untouched. Clearing removes the override.
  const updateViewOverride = useCallback(
    (patch: Partial<KanbanProjectViewPreferences>) => {
      setKanbanProjectViewPreferences(projectId, activeViewId, {
        filters: kanbanFilters,
        showSubIssues,
        showWorkspaces,
        hideBlocked,
        ...patch,
      });
    },
    [
      projectId,
      activeViewId,
      kanbanFilters,
      showSubIssues,
      showWorkspaces,
      hideBlocked,
      setKanbanProjectViewPreferences,
    ]
  );
  const updateActiveViewFilters = useCallback(
    (patch: Partial<KanbanFilterState>) => {
      updateViewOverride({ filters: { ...kanbanFilters, ...patch } });
    },
    [updateViewOverride, kanbanFilters]
  );

  // Compute resolved status IDs for the blocked filter.
  // A blocking issue is considered resolved when it's in:
  // - The last visible status (rightmost kanban column, e.g. "Done")
  // - Any hidden status (terminal states like "Cancelled" that don't appear as columns)
  const doneStatusIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of statuses) {
      if (s.hidden) ids.add(s.id);
    }
    const sorted = statuses
      .filter((s) => !s.hidden)
      .sort((a, b) => a.sort_order - b.sort_order);
    const lastVisible = sorted[sorted.length - 1];
    if (lastVisible) ids.add(lastVisible.id);
    return ids;
  }, [statuses]);

  const { filteredIssues } = useKanbanFilters({
    issues,
    issueAssignees,
    issueTags,
    milestones,
    issueMilestones,
    issueRelationships,
    issuesById,
    doneStatusIds,
    filters: kanbanFilters,
    showSubIssues,
    hideBlocked,
    currentUserId: userId,
  });

  const setKanbanSearchQuery = useCallback(
    (searchQuery: string) => updateActiveViewFilters({ searchQuery }),
    [updateActiveViewFilters]
  );

  const setKanbanPriorities = useCallback(
    (priorities: IssuePriority[]) => updateActiveViewFilters({ priorities }),
    [updateActiveViewFilters]
  );

  const setKanbanAssignees = useCallback(
    (assigneeIds: string[]) => updateActiveViewFilters({ assigneeIds }),
    [updateActiveViewFilters]
  );

  const setKanbanTags = useCallback(
    (tagIds: string[]) => updateActiveViewFilters({ tagIds }),
    [updateActiveViewFilters]
  );

  const setKanbanMilestones = useCallback(
    (milestoneIds: string[]) => updateActiveViewFilters({ milestoneIds }),
    [updateActiveViewFilters]
  );

  const setKanbanOverdue = useCallback(
    (overdue: boolean) => updateActiveViewFilters({ overdue }),
    [updateActiveViewFilters]
  );

  const setKanbanAdvancedFilter = useCallback(
    (advancedFilter: AdvancedFilter | null) =>
      updateActiveViewFilters({ advancedFilter }),
    [updateActiveViewFilters]
  );

  const setKanbanSort = useCallback(
    (sortField: KanbanSortField, sortDirection: 'asc' | 'desc') =>
      updateActiveViewFilters({ sortField, sortDirection }),
    [updateActiveViewFilters]
  );

  const setShowSubIssues = useCallback(
    (show: boolean) => updateViewOverride({ showSubIssues: show }),
    [updateViewOverride]
  );

  const setShowWorkspaces = useCallback(
    (show: boolean) => updateViewOverride({ showWorkspaces: show }),
    [updateViewOverride]
  );

  const setHideBlocked = useCallback(
    (hide: boolean) => updateViewOverride({ hideBlocked: hide }),
    [updateViewOverride]
  );

  // Reset the active view to its configured default by dropping the override.
  const clearKanbanFilters = useCallback(
    () => clearKanbanProjectViewPreferences(projectId, activeViewId),
    [clearKanbanProjectViewPreferences, projectId, activeViewId]
  );

  const handleKanbanProjectViewChange = useCallback(
    (viewId: string) => setKanbanProjectView(projectId, viewId),
    [projectId, setKanbanProjectView]
  );

  // Publish the current project's views so the command palette "Select view"
  // action can list and switch them without the Electric project context.
  const setViewSwitcherState = useProjectViewSwitcherStore(
    (s) => s.setSwitcherState
  );
  const clearViewSwitcher = useProjectViewSwitcherStore((s) => s.clear);
  useEffect(() => {
    setViewSwitcherState({
      projectId,
      views: projectViews.map((v) => ({
        id: v.id,
        name: v.name,
        layout: v.layout,
      })),
      activeViewId,
    });
    return () => clearViewSwitcher();
  }, [
    projectId,
    projectViews,
    activeViewId,
    setViewSwitcherState,
    clearViewSwitcher,
  ]);

  // Track when drag-drop sync is in progress to prevent flicker
  const isSyncingRef = useRef(false);

  // Ordered status groups shown by the active view. `groupStatusIds` picks an
  // explicit ordered subset; otherwise fall back to the default grouping
  // (kanban: non-hidden columns; table: every status).
  const groupStatuses = useMemo(() => {
    if (activeView?.groupStatusIds) {
      const byId = new Map(sortedStatuses.map((s) => [s.id, s]));
      return activeView.groupStatusIds
        .map((id) => byId.get(id))
        .filter((s): s is (typeof sortedStatuses)[number] => Boolean(s));
    }
    return kanbanViewMode === 'kanban'
      ? sortedStatuses.filter((s) => !s.hidden)
      : sortedStatuses;
  }, [activeView, sortedStatuses, kanbanViewMode]);

  // Kanban columns and table sections are both the active view's group list.
  const visibleStatuses = groupStatuses;
  const listViewStatuses = groupStatuses;

  // Map status ID to 1-based column index for sort_order calculation
  const statusColumnIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    groupStatuses.forEach((status, index) => {
      map.set(status.id, index + 1);
    });
    return map;
  }, [groupStatuses]);

  const defaultCreateStatusId = useMemo(
    () => groupStatuses[0]?.id ?? sortedStatuses[0]?.id,
    [groupStatuses, sortedStatuses]
  );

  // Update default create status for command bar based on current tab
  useEffect(() => {
    setDefaultCreateStatusId(defaultCreateStatusId);
  }, [defaultCreateStatusId, setDefaultCreateStatusId]);

  const createAssigneeIds = useMemo(() => {
    const assigneeIds = new Set<string>();

    for (const assigneeId of kanbanFilters.assigneeIds) {
      if (assigneeId === KANBAN_ASSIGNEE_FILTER_VALUES.UNASSIGNED) {
        continue;
      }

      if (assigneeId === KANBAN_ASSIGNEE_FILTER_VALUES.SELF) {
        if (userId) {
          assigneeIds.add(userId);
        }
        continue;
      }

      assigneeIds.add(assigneeId);
    }

    return [...assigneeIds];
  }, [kanbanFilters.assigneeIds, userId]);

  // Inline "+ Add item" (list view): create an issue at the bottom of the group
  // with an empty body. Assignees mirror the active filter so the new issue
  // stays visible in filtered views (matching the create-composer behavior).
  const handleInlineAddIssue = useCallback(
    (statusId: string, title: string) => {
      const statusIssues = issues.filter((i) => i.status_id === statusId);
      const maxSortOrder =
        statusIssues.length > 0
          ? Math.max(...statusIssues.map((i) => i.sort_order))
          : 0;
      const { persisted } = insertIssue({
        project_id: projectId,
        status_id: statusId,
        title,
        description: '',
        priority: null,
        sort_order: maxSortOrder + 1,
        start_date: null,
        target_date: null,
        completed_at: null,
        parent_issue_id: null,
        parent_issue_sort_order: null,
        extension_metadata: {},
      });
      if (createAssigneeIds.length > 0) {
        persisted
          .then((syncedIssue) => {
            createAssigneeIds.forEach((assigneeUserId) =>
              insertIssueAssignee({
                issue_id: syncedIssue.id,
                user_id: assigneeUserId,
              })
            );
          })
          .catch((err) =>
            console.error('Failed to assign inline-created issue:', err)
          );
      }
    },
    [issues, insertIssue, insertIssueAssignee, projectId, createAssigneeIds]
  );

  // Track items as arrays of IDs grouped by status
  const [items, setItems] = useState<Record<string, string[]>>({});
  const [isFiltersDialogOpen, setIsFiltersDialogOpen] = useState(false);

  // Collapsed status sections in the list view. Lifted out of IssueListSection
  // so keyboard left/right can toggle them, and persisted per-project through
  // the UI-preferences scratch (remembered across reloads/devices).
  const collapsedGroups = useUiPreferencesStore(
    (s) => s.collapsedGroupsByProject[projectId]
  );
  const setCollapsedGroups = useUiPreferencesStore((s) => s.setCollapsedGroups);
  const collapsedStatusIds = useMemo(
    () => new Set(collapsedGroups ?? []),
    [collapsedGroups]
  );
  const toggleStatusCollapsed = useCallback(
    (statusId: string) => {
      const next = new Set(collapsedStatusIds);
      if (next.has(statusId)) next.delete(statusId);
      else next.add(statusId);
      setCollapsedGroups(projectId, [...next]);
    },
    [collapsedStatusIds, projectId, setCollapsedGroups]
  );

  // Sync items from filtered issues when they change
  useEffect(() => {
    // Skip rebuild during drag-drop sync to prevent flicker
    if (isSyncingRef.current) {
      return;
    }

    const { sortField, sortDirection } = kanbanFilters;
    const grouped: Record<string, string[]> = {};

    for (const status of statuses) {
      // Filter issues for this status
      let statusIssues = filteredIssues.filter(
        (i) => i.status_id === status.id
      );

      // Sort within column based on user preference
      statusIssues = [...statusIssues].sort((a, b) => {
        let comparison = 0;
        switch (sortField) {
          case 'priority':
            comparison =
              (a.priority ? PRIORITY_ORDER[a.priority] : Infinity) -
              (b.priority ? PRIORITY_ORDER[b.priority] : Infinity);
            break;
          case 'created_at':
            comparison =
              new Date(a.created_at).getTime() -
              new Date(b.created_at).getTime();
            break;
          case 'updated_at':
            comparison =
              new Date(a.updated_at).getTime() -
              new Date(b.updated_at).getTime();
            break;
          case 'title':
            comparison = a.title.localeCompare(b.title);
            break;
          case 'sort_order':
          default:
            comparison = a.sort_order - b.sort_order;
        }
        return sortDirection === 'desc' ? -comparison : comparison;
      });

      grouped[status.id] = statusIssues.map((i) => i.id);
    }
    setItems(grouped);
  }, [filteredIssues, statuses, kanbanFilters]);

  // Create a lookup map for issue data
  const issueMap = useMemo(() => {
    const map: Record<string, (typeof issues)[0]> = {};
    for (const issue of issues) {
      map[issue.id] = issue;
    }
    return map;
  }, [issues]);

  // Create a lookup map for issue assignees (issue_id -> OrganizationMemberWithProfile[])
  const issueAssigneesMap = useMemo(() => {
    const map: Record<string, OrganizationMemberWithProfile[]> = {};
    for (const assignee of issueAssignees) {
      const member = membersWithProfilesById.get(assignee.user_id);
      if (member) {
        if (!map[assignee.issue_id]) {
          map[assignee.issue_id] = [];
        }
        map[assignee.issue_id].push(member);
      }
    }
    return map;
  }, [issueAssignees, membersWithProfilesById]);

  const membersWithProfiles = useMemo(
    () => [...membersWithProfilesById.values()],
    [membersWithProfilesById]
  );

  const localWorkspacesById = useMemo(() => {
    const map = new Map<string, (typeof activeWorkspaces)[number]>();

    for (const workspace of activeWorkspaces) {
      map.set(workspace.id, workspace);
    }

    return map;
  }, [activeWorkspaces]);

  const openIssueWorkspace = useCallback(
    async (
      issueId: string,
      workspaceAttemptId: string,
      ownerHostId?: string | null
    ) => {
      const hostId = ownerHostId ?? workspaceHostMap.get(workspaceAttemptId);
      if (!localWorkspacesById.has(workspaceAttemptId) && !hostId) {
        // The workspace lives on a paired host that is offline, or whose host
        // map hasn't finished its first poll — tell the user instead of the
        // click silently doing nothing.
        await ConfirmDialog.show({
          title: t('workspaces.hostUnavailableTitle'),
          message: t('workspaces.hostUnavailableMessage'),
          confirmText: t('common:ok'),
          showCancelButton: false,
        });
        return;
      }
      appNavigation.goToProjectIssueWorkspace(
        projectId,
        issueId,
        workspaceAttemptId,
        { hostId }
      );
    },
    [appNavigation, projectId, workspaceHostMap, localWorkspacesById, t]
  );

  // Open a workspace from a table-row workspace card (mirrors the kanban card).
  const handleListWorkspaceClick = useCallback(
    (issueId: string, workspace: WorkspaceWithStats) => {
      if (!workspace.localWorkspaceId) return;
      void openIssueWorkspace(
        issueId,
        workspace.localWorkspaceId,
        workspace.hostId
      );
    },
    [openIssueWorkspace]
  );

  const prsByWorkspaceId = useMemo(() => {
    const map = new Map<string, WorkspacePr[]>();

    for (const pr of pullRequests) {
      if (!pr.workspace_id) continue;

      const prs = map.get(pr.workspace_id) ?? [];
      prs.push({
        number: pr.number,
        url: pr.url,
        status: pr.status as 'open' | 'merged' | 'closed',
      });
      map.set(pr.workspace_id, prs);
    }

    return map;
  }, [pullRequests]);

  const githubIssuesByIssueId = useMemo(() => {
    const map = new Map<string, KanbanGithubIssue[]>();
    for (const link of githubIssueLinks) {
      const list = map.get(link.issue_id) ?? [];
      list.push({
        id: link.id,
        number: link.number,
        repository: link.repository,
        url: link.url,
      });
      map.set(link.issue_id, list);
    }
    return map;
  }, [githubIssueLinks]);

  const workspacesByIssueId = useMemo(() => {
    if (!showWorkspaces) {
      return new Map<string, WorkspaceWithStats[]>();
    }

    const map = new Map<string, WorkspaceWithStats[]>();

    for (const issue of issues) {
      const nonArchivedWorkspaces = getWorkspacesForIssue(issue.id)
        // Show every linked, non-archived workspace — including ones that live
        // on a paired host and therefore have no local counterpart on this
        // machine. This mirrors the issue detail view; previously the board
        // additionally required `localWorkspacesById.has(...)`, which silently
        // hid remote-host workspaces from the cards.
        .filter(
          (workspace) => !workspace.archived && !!workspace.local_workspace_id
        )
        .map((workspace) => {
          const localWorkspace = workspace.local_workspace_id
            ? localWorkspacesById.get(workspace.local_workspace_id)
            : undefined;

          return {
            id: workspace.id,
            localWorkspaceId: workspace.local_workspace_id,
            hostId: workspace.host_id,
            name: workspace.name,
            archived: workspace.archived,
            filesChanged: workspace.files_changed ?? 0,
            linesAdded: workspace.lines_added ?? 0,
            linesRemoved: workspace.lines_removed ?? 0,
            prs: prsByWorkspaceId.get(workspace.id) ?? [],
            owner: membersWithProfilesById.get(workspace.owner_user_id) ?? null,
            updatedAt: workspace.updated_at,
            isOwnedByCurrentUser: workspace.owner_user_id === userId,
            isRunning: localWorkspace?.isRunning,
            hasPendingApproval: localWorkspace?.hasPendingApproval,
            hasRunningDevServer: localWorkspace?.hasRunningDevServer,
            hasUnseenActivity: localWorkspace?.hasUnseenActivity,
            todoTotal: localWorkspace?.todoTotal,
            todoCompleted: localWorkspace?.todoCompleted,
            latestProcessCompletedAt: localWorkspace?.latestProcessCompletedAt,
            latestProcessStatus: localWorkspace?.latestProcessStatus,
          };
        });

      if (nonArchivedWorkspaces.length > 0) {
        map.set(issue.id, nonArchivedWorkspaces);
      }
    }

    return map;
  }, [
    showWorkspaces,
    issues,
    getWorkspacesForIssue,
    localWorkspacesById,
    prsByWorkspaceId,
    membersWithProfilesById,
    userId,
  ]);

  // Calculate sort_order based on column index and issue position
  // Formula: 1000 * [COLUMN_INDEX] + [ISSUE_INDEX] (both 1-based)
  const calculateSortOrder = useCallback(
    (statusId: string, issueIndex: number): number => {
      const columnIndex = statusColumnIndexMap.get(statusId) ?? 1;
      return 1000 * columnIndex + (issueIndex + 1);
    },
    [statusColumnIndexMap]
  );

  // Simple onDragEnd handler - the library handles all visual movement
  const handleDragEnd = useCallback(
    (result: DropResult) => {
      const { source, destination } = result;

      // Dropped outside a valid droppable
      if (!destination) return;

      // No movement
      if (
        source.droppableId === destination.droppableId &&
        source.index === destination.index
      ) {
        return;
      }

      const isManualSort = kanbanFilters.sortField === 'sort_order';

      // Block within-column reordering when not in manual sort mode
      // (cross-column moves are always allowed for status changes)
      if (source.droppableId === destination.droppableId && !isManualSort) {
        return;
      }

      const sourceId = source.droppableId;
      const destId = destination.droppableId;
      const isCrossColumn = sourceId !== destId;

      // Update local state and capture new items for bulk update
      let newItems: Record<string, string[]> = {};
      setItems((prev) => {
        const sourceItems = [...(prev[sourceId] ?? [])];
        const [moved] = sourceItems.splice(source.index, 1);

        if (!isCrossColumn) {
          // Within-column reorder
          sourceItems.splice(destination.index, 0, moved);
          newItems = { ...prev, [sourceId]: sourceItems };
        } else {
          // Cross-column move
          const destItems = [...(prev[destId] ?? [])];
          destItems.splice(destination.index, 0, moved);
          newItems = {
            ...prev,
            [sourceId]: sourceItems,
            [destId]: destItems,
          };
        }
        return newItems;
      });

      // Build bulk updates for all issues in affected columns
      const updates: BulkUpdateIssueItem[] = [];

      // Always update destination column
      const destIssueIds = newItems[destId] ?? [];
      destIssueIds.forEach((issueId, index) => {
        updates.push({
          id: issueId,
          changes: {
            status_id: destId,
            sort_order: calculateSortOrder(destId, index),
          },
        });
      });

      // Update source column if cross-column move
      if (isCrossColumn) {
        const sourceIssueIds = newItems[sourceId] ?? [];
        sourceIssueIds.forEach((issueId, index) => {
          updates.push({
            id: issueId,
            changes: {
              sort_order: calculateSortOrder(sourceId, index),
            },
          });
        });
      }

      // Perform bulk update
      isSyncingRef.current = true;
      bulkUpdateIssues(updates)
        .catch((err) => {
          console.error('Failed to bulk update sort order:', err);
        })
        .finally(() => {
          // Delay clearing flag to let Electric sync complete
          setTimeout(() => {
            isSyncingRef.current = false;
          }, 500);
        });
    },
    [kanbanFilters.sortField, calculateSortOrder]
  );

  // Multi-select support
  const {
    selectedIssueIds,
    isSelectionMode,
    isMultiSelectActive,
    enterSelectionMode,
    handleIssueClick,
    handleCheckboxChange,
    clearSelection,
  } = useIssueMultiSelect();
  const setOrderedIssueIds = useIssueSelectionStore(
    (s) => s.setOrderedIssueIds
  );
  const setAnchor = useIssueSelectionStore((s) => s.setAnchor);

  // Keyboard navigation cursor lives in the selection store as cursorIssueId so
  // it stays in sync with Shift+Arrow range selection (which extends from the
  // cursor). Distinct from the opened issue (selectedKanbanIssueId). Card DOM
  // nodes are tracked for scroll-into-view.
  const cursorIssueId = useIssueSelectionStore((s) => s.cursorIssueId);
  const focusCursor = useIssueSelectionStore((s) => s.focusCursor);
  const cardRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const issueListRef = useRef<HTMLDivElement>(null);

  // List rows register into the same cardRefs map used by kanban cards so the
  // shared scroll-into-view/focus effect works in both views (only one view is
  // mounted at a time).
  const registerRowRef = useCallback(
    (issueId: string, node: HTMLDivElement | null) => {
      if (node) cardRefs.current.set(issueId, node);
      else cardRefs.current.delete(issueId);
    },
    []
  );

  // List-view group headers and "+ Add item" rows are keyboard-focusable too
  // (distinct from the issue cursor). `nonIssueFocus` marks which one holds
  // focus; when set, the issue cursor is blurred. This is what lets Left move
  // onto a header (and Right re-open a collapsed group) and arrow keys reach
  // the add row. `editingAddStatusId` tracks which add row is in input mode.
  const [nonIssueFocus, setNonIssueFocus] = useState<{
    kind: 'header' | 'add';
    statusId: string;
  } | null>(null);
  const [editingAddStatusId, setEditingAddStatusId] = useState<string | null>(
    null
  );
  const focusedSectionId =
    nonIssueFocus?.kind === 'header' ? nonIssueFocus.statusId : null;
  const focusedAddStatusId =
    nonIssueFocus?.kind === 'add' ? nonIssueFocus.statusId : null;
  const blurCursor = useIssueSelectionStore((s) => s.blurCursor);
  const sectionRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());
  const addRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());
  const registerSectionRef = useCallback(
    (statusId: string, node: HTMLButtonElement | null) => {
      if (node) sectionRefs.current.set(statusId, node);
      else sectionRefs.current.delete(statusId);
    },
    []
  );
  const registerAddRef = useCallback(
    (statusId: string, node: HTMLButtonElement | null) => {
      if (node) addRefs.current.set(statusId, node);
      else addRefs.current.delete(statusId);
    },
    []
  );
  const focusSection = useCallback(
    (statusId: string) => {
      setNonIssueFocus({ kind: 'header', statusId });
      blurCursor();
    },
    [blurCursor]
  );
  const focusAddRow = useCallback(
    (statusId: string) => {
      setNonIssueFocus({ kind: 'add', statusId });
      blurCursor();
    },
    [blurCursor]
  );

  // Whether keyboard focus is currently inside the board. Arrow/Enter
  // navigation is scoped to this so it doesn't hijack arrow-key scrolling or
  // Enter while the user works in the open issue panel — mirroring the
  // focus-scoped workspace sidebar list.
  const [isBoardFocused, setIsBoardFocused] = useState(false);
  useEffect(() => {
    const focusSearch = () => searchInputRef.current?.focus();
    window.addEventListener(
      COMMAND_PALETTE_EVENT.focusIssueSearch,
      focusSearch
    );
    return () =>
      window.removeEventListener(
        COMMAND_PALETTE_EVENT.focusIssueSearch,
        focusSearch
      );
  }, []);

  // Ordered issue IDs used for keyboard navigation and range selection. In the
  // list view, issues inside a collapsed group are excluded so up/down never
  // lands on a hidden row.
  const orderedIssueIds = useMemo(() => {
    if (kanbanViewMode === 'kanban') {
      return visibleStatuses.flatMap((status) => items[status.id] ?? []);
    }
    return listViewStatuses
      .filter((status) => !collapsedStatusIds.has(status.id))
      .flatMap((status) => items[status.id] ?? []);
  }, [
    kanbanViewMode,
    visibleStatuses,
    listViewStatuses,
    items,
    collapsedStatusIds,
  ]);

  // Move the issue cursor, clearing any focused group header / add row.
  const focusIssue = useCallback(
    (issueId: string) => {
      setNonIssueFocus(null);
      focusCursor(issueId);
    },
    [focusCursor]
  );

  // Ordered focusable rows for the list view: each group header, then its
  // issues, then its "+ Add item" row (issues/add omitted for collapsed
  // groups). Headers are always present so keyboard nav can reach — and
  // Right-arrow can re-open — a collapsed group.
  const listFocusables = useMemo<
    (
      | { type: 'header'; statusId: string }
      | { type: 'issue'; issueId: string }
      | { type: 'add'; statusId: string }
    )[]
  >(() => {
    if (kanbanViewMode === 'kanban') return [];
    const out: (
      | { type: 'header'; statusId: string }
      | { type: 'issue'; issueId: string }
      | { type: 'add'; statusId: string }
    )[] = [];
    for (const status of listViewStatuses) {
      out.push({ type: 'header', statusId: status.id });
      if (!collapsedStatusIds.has(status.id)) {
        for (const id of items[status.id] ?? []) {
          out.push({ type: 'issue', issueId: id });
        }
        out.push({ type: 'add', statusId: status.id });
      }
    }
    return out;
  }, [kanbanViewMode, listViewStatuses, collapsedStatusIds, items]);

  const handleSearchKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key !== 'Enter' || orderedIssueIds.length === 0) return;
      event.preventDefault();
      // Enter from search moves the keyboard cursor onto the first issue in
      // both the board and the list.
      setIsBoardFocused(true);
      focusIssue(orderedIssueIds[0]);
    },
    [focusIssue, orderedIssueIds]
  );

  // Enter/leave the inline "+ Add item" input for a group. Entering keeps the
  // add row keyboard-focused; leaving with `refocus` (Escape) returns focus to
  // the add-row button so arrow keys resume and Enter re-enters.
  const handleStartAddEditing = useCallback(
    (statusId: string) => {
      setIsBoardFocused(true);
      focusAddRow(statusId);
      setEditingAddStatusId(statusId);
    },
    [focusAddRow]
  );
  const handleStopAddEditing = useCallback(
    (statusId: string, refocus: boolean) => {
      setEditingAddStatusId((cur) => (cur === statusId ? null : cur));
      if (refocus) {
        setIsBoardFocused(true);
        focusAddRow(statusId);
      }
    },
    [focusAddRow]
  );

  // Keep the store's ordered IDs in sync
  useEffect(() => {
    setOrderedIssueIds(orderedIssueIds, selectedKanbanIssueId);
  }, [orderedIssueIds, selectedKanbanIssueId, setOrderedIssueIds]);

  // Clear multi-selection, keyboard cursor, and any focused header/add row when
  // the project or view mode changes (clearSelection resets cursorIssueId too).
  useEffect(() => {
    clearSelection();
    setNonIssueFocus(null);
    setEditingAddStatusId(null);
  }, [projectId, kanbanViewMode, clearSelection]);

  // Keep anchor in sync with the currently opened issue (e.g. from URL on
  // page load) so Shift/Cmd+Click on another issue includes it.
  useEffect(() => {
    if (selectedKanbanIssueId) {
      setAnchor(selectedKanbanIssueId);
    }
  }, [selectedKanbanIssueId, setAnchor]);

  const handleCardClick = useCallback(
    (issueId: string, e?: MouseEvent) => {
      // A click inside the board means it owns focus; enable arrow/Enter
      // navigation even if the card's drag handle didn't emit a focus event.
      setIsBoardFocused(true);
      // Clicking an issue moves focus onto it, so drop any focused header/add row.
      setNonIssueFocus(null);

      // In explicit selection mode (mobile/touch), any tap toggles selection
      // instead of opening the issue. Modifier-key handling stays in the hook.
      if (isSelectionMode) {
        if (e) {
          handleIssueClick(issueId, e);
        } else {
          handleCheckboxChange(issueId);
        }
        return;
      }

      if (e && (e.metaKey || e.ctrlKey || e.shiftKey)) {
        handleIssueClick(issueId, e);
      } else {
        if (selectedIssueIds.size > 0) {
          clearSelection();
        }
        // Set as anchor so Shift+Click from this issue works. setAnchor also
        // moves the cursor, keeping the keyboard focus ring in sync with clicks.
        setAnchor(issueId);
        openIssue(issueId);
      }
    },
    [
      isSelectionMode,
      openIssue,
      handleIssueClick,
      handleCheckboxChange,
      selectedIssueIds.size,
      clearSelection,
      setAnchor,
    ]
  );

  // --- Keyboard arrow-key navigation across cards --------------------------
  // Columns of issue IDs for 2D grid movement (kanban view only).
  const focusColumns = useMemo(
    () => visibleStatuses.map((status) => items[status.id] ?? []),
    [visibleStatuses, items]
  );

  const isKanbanView = kanbanViewMode === 'kanban';

  const moveFocus = useCallback(
    (direction: 'up' | 'down' | 'left' | 'right') => {
      // --- List view: navigate group headers + issues + add rows ------------
      // Up/Down step through the flat focusables (headers, issues, and each
      // group's "+ Add item" row). Left/Right on a header collapse/expand it;
      // Left on an issue or add row moves focus up to its header. This lets the
      // user reach a collapsed group's header and re-open it with Right.
      if (!isKanbanView) {
        const focusables = listFocusables;
        if (focusables.length === 0) return;

        const applyFocus = (f: (typeof focusables)[number]) => {
          if (f.type === 'header') focusSection(f.statusId);
          else if (f.type === 'add') focusAddRow(f.statusId);
          else focusIssue(f.issueId);
        };

        const cursor = cursorIssueId ?? selectedKanbanIssueId;
        const currentIndex = focusedSectionId
          ? focusables.findIndex(
              (f) => f.type === 'header' && f.statusId === focusedSectionId
            )
          : focusedAddStatusId
            ? focusables.findIndex(
                (f) => f.type === 'add' && f.statusId === focusedAddStatusId
              )
            : cursor
              ? focusables.findIndex(
                  (f) => f.type === 'issue' && f.issueId === cursor
                )
              : -1;

        if (direction === 'up' || direction === 'down') {
          if (currentIndex === -1) {
            applyFocus(
              direction === 'up'
                ? focusables[focusables.length - 1]
                : focusables[0]
            );
            return;
          }
          const next =
            direction === 'down' ? currentIndex + 1 : currentIndex - 1;
          if (next < 0 || next >= focusables.length) return;
          applyFocus(focusables[next]);
          return;
        }

        // left / right
        if (focusedSectionId) {
          if (direction === 'left') {
            if (!collapsedStatusIds.has(focusedSectionId)) {
              toggleStatusCollapsed(focusedSectionId);
            }
          } else if (collapsedStatusIds.has(focusedSectionId)) {
            toggleStatusCollapsed(focusedSectionId); // expand
          } else {
            const first = (items[focusedSectionId] ?? [])[0];
            if (first) focusIssue(first); // step into the first child issue
          }
          return;
        }

        // An add row is focused: Left moves to its group header; Right no-op.
        if (focusedAddStatusId) {
          if (direction === 'left') focusSection(focusedAddStatusId);
          return;
        }

        // An issue is focused: Left moves to its group header; Right is a no-op.
        if (direction === 'left') {
          const statusId =
            cursor && issueMap[cursor]
              ? issueMap[cursor].status_id
              : listViewStatuses[0]?.id;
          if (statusId) focusSection(statusId);
        }
        return;
      }

      // --- Board (kanban) view ----------------------------------------------
      const start = cursorIssueId ?? selectedKanbanIssueId;

      if (direction === 'up' || direction === 'down') {
        const ids = orderedIssueIds;
        if (ids.length === 0) return;
        const index = start ? ids.indexOf(start) : -1;
        if (index === -1) {
          focusCursor(direction === 'up' ? ids[ids.length - 1] : ids[0]);
          return;
        }
        const nextIndex = direction === 'down' ? index + 1 : index - 1;
        if (nextIndex < 0 || nextIndex >= ids.length) return;
        focusCursor(ids[nextIndex]);
        return;
      }

      // left / right: jump between columns in the 2D grid.
      const columns = focusColumns;
      if (!columns.some((column) => column.length > 0)) return;

      let col = -1;
      let row = -1;
      if (start) {
        for (let c = 0; c < columns.length; c++) {
          const r = columns[c].indexOf(start);
          if (r !== -1) {
            col = c;
            row = r;
            break;
          }
        }
      }

      if (col === -1) {
        const firstCol = columns.findIndex((column) => column.length > 0);
        focusCursor(columns[firstCol][0]);
        return;
      }

      const step = direction === 'right' ? 1 : -1;
      for (let c = col + step; c >= 0 && c < columns.length; c += step) {
        if (columns[c].length > 0) {
          const nextRow = Math.min(row, columns[c].length - 1);
          focusCursor(columns[c][nextRow]);
          return;
        }
      }
    },
    [
      isKanbanView,
      listFocusables,
      focusedSectionId,
      focusedAddStatusId,
      focusSection,
      focusAddRow,
      focusIssue,
      collapsedStatusIds,
      toggleStatusCollapsed,
      items,
      issueMap,
      listViewStatuses,
      orderedIssueIds,
      focusColumns,
      cursorIssueId,
      selectedKanbanIssueId,
      focusCursor,
    ]
  );

  const navOptions = useMemo(
    () => ({
      scope: Scope.KANBAN,
      // Keep the listeners available in both the board and list views so an
      // otherwise-unfocused project page can enter it on its first arrow key.
      // The callback decides whether the view owns that key before preventing
      // the browser default.
      enabled: true,
    }),
    []
  );
  const moveFocusFromKeyboard = useCallback(
    (direction: 'up' | 'down' | 'left' | 'right', event?: KeyboardEvent) => {
      const activeElement =
        typeof document === 'undefined' ? null : document.activeElement;
      const shouldNavigate = shouldStartBoardNavigation({
        isBoardFocused,
        isDocumentUnfocused:
          activeElement === null ||
          activeElement.tagName === 'BODY' ||
          activeElement.tagName === 'HTML',
        isPaneFocused:
          activeElement instanceof HTMLElement &&
          activeElement.hasAttribute('data-workspace-pane'),
        isTextEditing:
          activeElement instanceof HTMLElement &&
          (activeElement.isContentEditable ||
            ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeElement.tagName)),
      });
      if (!shouldNavigate) return;

      event?.preventDefault();
      if (!isBoardFocused) setIsBoardFocused(true);
      moveFocus(direction);
    },
    [isBoardFocused, cursorIssueId, selectedKanbanIssueId, moveFocus]
  );
  useKeyNavUp((event) => moveFocusFromKeyboard('up', event), navOptions);
  useKeyNavDown((event) => moveFocusFromKeyboard('down', event), navOptions);
  useKeyNavLeft((event) => moveFocusFromKeyboard('left', event), navOptions);
  useKeyNavRight((event) => moveFocusFromKeyboard('right', event), navOptions);

  // Enter opens the focused card (same behavior as a plain click). When the
  // focused card is already open, let Enter behave normally so it doesn't
  // hijack keystrokes inside the issue panel.
  useHotkeys(
    'enter',
    (e) => {
      // A focused group header toggles collapse on Enter.
      if (focusedSectionId) {
        e.preventDefault();
        toggleStatusCollapsed(focusedSectionId);
        return;
      }
      // A focused "+ Add item" row enters its input on Enter.
      if (focusedAddStatusId) {
        e.preventDefault();
        setEditingAddStatusId(focusedAddStatusId);
        return;
      }
      if (!cursorIssueId || cursorIssueId === selectedKanbanIssueId) return;
      e.preventDefault();
      handleCardClick(cursorIssueId);
    },
    {
      scopes: [Scope.KANBAN],
      enabled:
        isBoardFocused &&
        (!!cursorIssueId || !!focusedSectionId || !!focusedAddStatusId),
      enableOnFormTags: false,
    },
    [
      cursorIssueId,
      selectedKanbanIssueId,
      handleCardClick,
      isBoardFocused,
      focusedSectionId,
      focusedAddStatusId,
      toggleStatusCollapsed,
    ]
  );

  // As focus moves, scroll the focused header/add-row/issue into view. While
  // the board owns focus, also move real DOM focus onto it so the focus-scoped
  // arrow/Enter hotkeys stay active. Never pull focus when the board isn't
  // focused (e.g. on load with the issue panel open). A focused group header or
  // add row takes precedence over the issue cursor; while an add row is being
  // edited, its input owns focus so we leave it alone.
  useEffect(() => {
    if (focusedAddStatusId) {
      if (editingAddStatusId === focusedAddStatusId) return;
      const node = addRefs.current.get(focusedAddStatusId);
      if (!node) return;
      if (isBoardFocused) node.focus({ preventScroll: true });
      node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return;
    }
    if (focusedSectionId) {
      const node = sectionRefs.current.get(focusedSectionId);
      if (!node) return;
      if (isBoardFocused) node.focus({ preventScroll: true });
      node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return;
    }
    if (!cursorIssueId) return;
    const node = cardRefs.current.get(cursorIssueId);
    if (!node) return;
    if (isBoardFocused) node.focus({ preventScroll: true });
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [
    cursorIssueId,
    focusedSectionId,
    focusedAddStatusId,
    editingAddStatusId,
    isBoardFocused,
  ]);

  const handleToggleSelectionMode = useCallback(() => {
    if (isSelectionMode) {
      clearSelection();
    } else {
      enterSelectionMode();
    }
  }, [isSelectionMode, clearSelection, enterSelectionMode]);

  const handleAddTask = useCallback(
    (statusId?: string) => {
      const createPayload = {
        statusId: statusId ?? defaultCreateStatusId,
        ...(createAssigneeIds.length > 0
          ? { assigneeIds: createAssigneeIds }
          : {}),
      };
      startCreate(createPayload);
    },
    [createAssigneeIds, defaultCreateStatusId, startCreate]
  );

  // Inline editing callbacks for kanban cards
  // When multi-select is active, apply to all selected issues
  const handleCardPriorityClick = useCallback(
    (issueId: string) => {
      const ids =
        isMultiSelectActive && selectedIssueIds.size > 0
          ? [...selectedIssueIds]
          : [issueId];
      openPrioritySelection(projectId, ids);
    },
    [projectId, openPrioritySelection, selectedIssueIds, isMultiSelectActive]
  );

  const handleCardAssigneeClick = useCallback(
    (issueId: string) => {
      const ids =
        isMultiSelectActive && selectedIssueIds.size > 0
          ? [...selectedIssueIds]
          : [issueId];
      openAssigneeSelection(projectId, ids);
    },
    [projectId, openAssigneeSelection, selectedIssueIds, isMultiSelectActive]
  );

  const handleCardMoreActionsClick = useCallback(
    (issueId: string) => {
      const ids =
        isMultiSelectActive && selectedIssueIds.size > 0
          ? [...selectedIssueIds]
          : [issueId];
      CommandBarDialog.show({
        page: 'issueActions',
        projectId,
        issueIds: ids,
      });
    },
    [projectId, selectedIssueIds, isMultiSelectActive]
  );

  const handleCardTagToggle = useCallback(
    (issueId: string, tagId: string) => {
      const currentIssueTags = getTagsForIssue(issueId);
      const existing = currentIssueTags.find((it) => it.tag_id === tagId);
      if (existing) {
        removeIssueTag(existing.id);
      } else {
        insertIssueTag({ issue_id: issueId, tag_id: tagId });
      }
    },
    [getTagsForIssue, insertIssueTag, removeIssueTag]
  );

  const getResolvedRelationshipsForIssue = useCallback(
    (issueId: string) =>
      resolveRelationshipsForIssue(
        issueId,
        getRelationshipsForIssue(issueId),
        issuesById
      ),
    [getRelationshipsForIssue, issuesById]
  );

  const handleCreateTag = useCallback(
    (data: { name: string; color: string }): string => {
      const { data: newTag } = insertTag({
        project_id: projectId,
        name: data.name,
        color: data.color,
      });
      return newTag.id;
    },
    [insertTag, projectId]
  );

  const isLoading = projectLoading || orgLoading;

  if (isLoading) {
    return <LoadingState />;
  }

  return (
    <div className="flex flex-col h-full space-y-base">
      <div
        className={cn(
          'px-double pt-double space-y-base',
          isMobile && 'px-base pt-base'
        )}
      >
        <div className="flex items-center gap-half">
          <h2 className={cn('text-2xl font-medium', isMobile && 'text-lg')}>
            {projectName}
          </h2>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="p-half rounded-sm text-low hover:text-normal hover:bg-secondary transition-colors"
                aria-label="Project menu"
              >
                <DotsThreeIcon className="size-icon-sm" weight="bold" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={openProjectsGuide}>
                {t('kanban.openProjectsGuide', 'Projects guide')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => executeAction(Actions.ProjectSettings)}
              >
                {t('kanban.editProjectSettings', 'Edit project settings')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div
          className={cn(
            'flex items-start gap-base',
            isMobile ? 'flex-col' : 'flex-wrap'
          )}
        >
          <ViewNavTabs
            views={projectViews}
            activeViewId={activeViewId}
            onSelect={handleKanbanProjectViewChange}
          />
          <KanbanFilterBar
            isFiltersDialogOpen={isFiltersDialogOpen}
            onFiltersDialogOpenChange={setIsFiltersDialogOpen}
            tags={tags}
            users={membersWithProfiles}
            projectId={projectId}
            currentUserId={userId}
            filters={kanbanFilters}
            showSubIssues={showSubIssues}
            showWorkspaces={showWorkspaces}
            hasActiveFilters={hasActiveFilters}
            onSearchQueryChange={setKanbanSearchQuery}
            searchInputRef={searchInputRef}
            onSearchKeyDown={handleSearchKeyDown}
            onPrioritiesChange={setKanbanPriorities}
            onAssigneesChange={setKanbanAssignees}
            onTagsChange={setKanbanTags}
            onSortChange={setKanbanSort}
            onShowSubIssuesChange={setShowSubIssues}
            onShowWorkspacesChange={setShowWorkspaces}
            hideBlocked={hideBlocked}
            onHideBlockedChange={setHideBlocked}
            onClearFilters={clearKanbanFilters}
            onCreateIssue={handleAddTask}
            shouldAnimateCreateButton={shouldAnimateCreateButton}
            renderFiltersDialog={(props) => (
              <KanbanFiltersDialog
                {...props}
                filters={kanbanFilters}
                statuses={statuses}
                milestones={milestones}
                onMilestonesChange={setKanbanMilestones}
                onOverdueChange={setKanbanOverdue}
                onAdvancedFilterChange={setKanbanAdvancedFilter}
              />
            )}
            isMobile={isMobile}
            isSelectionMode={isSelectionMode}
            onToggleSelectionMode={
              isMobile || isTouch ? handleToggleSelectionMode : undefined
            }
          />
        </div>
      </div>

      {kanbanViewMode === 'kanban' ? (
        visibleStatuses.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-low">{t('kanban.noVisibleStatuses')}</p>
          </div>
        ) : (
          <div
            // tabIndex=-1 lets a click on empty board space (column gaps,
            // padding, area below short columns — anything that isn't a card)
            // focus this scroll container, so arrow/Enter navigation turns on
            // there too, not only when a card receives focus. It stays out of
            // the Tab order; outline-none hides the native focus ring in favor
            // of the per-card focus ring.
            tabIndex={-1}
            className="flex-1 overflow-x-auto px-double outline-none"
            onFocus={() => setIsBoardFocused(true)}
            onBlur={(e) => {
              // Only blur when focus leaves the board entirely, not when moving
              // between cards within it.
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                setIsBoardFocused(false);
              }
            }}
          >
            <KanbanProvider onDragEnd={handleDragEnd}>
              {visibleStatuses.map((status) => {
                const issueIds = items[status.id] ?? [];

                return (
                  <KanbanBoard key={status.id}>
                    <KanbanHeader>
                      <div className="border-t sticky border-b top-0 z-20 mb-px flex shrink-0 items-center justify-between gap-2 p-base bg-secondary">
                        <div className="flex items-center gap-2">
                          <div
                            className="h-2 w-2 rounded-full shrink-0"
                            style={{ backgroundColor: `hsl(${status.color})` }}
                          />
                          <p className="m-0 text-sm">{status.name}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleAddTask(status.id)}
                          className="p-half rounded-sm text-low hover:text-normal hover:bg-secondary transition-colors"
                          aria-label="Add task"
                        >
                          <PlusIcon className="size-icon-xs" weight="bold" />
                        </button>
                      </div>
                    </KanbanHeader>
                    <KanbanCards id={status.id}>
                      {issueIds.map((issueId, index) => {
                        const issue = issueMap[issueId];
                        if (!issue) return null;
                        const issueWorkspaces =
                          workspacesByIssueId.get(issue.id) ?? [];
                        const workspaceIdsShownOnCard = new Set(
                          issueWorkspaces.map((workspace) => workspace.id)
                        );
                        const issueCardPullRequests = getPullRequestsForIssue(
                          issue.id
                        ).filter((pr) => {
                          if (!pr.workspace_id) {
                            return true;
                          }

                          // If this PR is already visible under a workspace card,
                          // do not render it again at the issue level.
                          return !workspaceIdsShownOnCard.has(pr.workspace_id);
                        });

                        return (
                          <KanbanCard
                            key={issue.id}
                            id={issue.id}
                            name={issue.title}
                            index={index}
                            className="group scroll-mt-10"
                            onClick={(e) => handleCardClick(issue.id, e)}
                            isOpen={selectedKanbanIssueId === issue.id}
                            isMobile={isMobile}
                            isSelected={selectedIssueIds.has(issue.id)}
                            isFocused={cursorIssueId === issue.id}
                            forwardedRef={(node) => {
                              if (node) cardRefs.current.set(issue.id, node);
                              else cardRefs.current.delete(issue.id);
                            }}
                            dragDisabled={isMultiSelectActive}
                          >
                            <KanbanCardContent
                              displayId={issue.simple_id}
                              title={issue.title}
                              description={issue.description}
                              priority={issue.priority}
                              milestone={(() => {
                                const milestone = getMilestoneForIssue(
                                  issue.id
                                );
                                return milestone
                                  ? {
                                      name: milestone.name,
                                      targetDate: milestone.target_date,
                                    }
                                  : null;
                              })()}
                              tags={getTagObjectsForIssue(issue.id)}
                              assignees={issueAssigneesMap[issue.id] ?? []}
                              pullRequests={issueCardPullRequests}
                              githubIssues={
                                githubIssuesByIssueId.get(issue.id) ?? []
                              }
                              relationships={resolveRelationshipsForIssue(
                                issue.id,
                                getRelationshipsForIssue(issue.id),
                                issuesById
                              )}
                              isSubIssue={!!issue.parent_issue_id}
                              isMobile={isMobile}
                              onPriorityClick={(e) => {
                                e.stopPropagation();
                                handleCardPriorityClick(issue.id);
                              }}
                              onAssigneeClick={(e) => {
                                e.stopPropagation();
                                handleCardAssigneeClick(issue.id);
                              }}
                              onOpenInNewTabClick={() =>
                                openInSplitPane(
                                  `/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issue.id)}`
                                )
                              }
                              onMoreActionsClick={() =>
                                handleCardMoreActionsClick(issue.id)
                              }
                              tagEditProps={{
                                allTags: tags,
                                selectedTagIds: getTagsForIssue(issue.id).map(
                                  (it) => it.tag_id
                                ),
                                onTagToggle: (tagId) =>
                                  handleCardTagToggle(issue.id, tagId),
                                onCreateTag: handleCreateTag,
                                renderTagEditor: ({
                                  allTags,
                                  selectedTagIds,
                                  onTagToggle,
                                  onCreateTag,
                                  trigger,
                                }) => (
                                  <SearchableTagDropdownContainer
                                    tags={allTags}
                                    selectedTagIds={selectedTagIds}
                                    onTagToggle={onTagToggle}
                                    onCreateTag={onCreateTag}
                                    disabled={false}
                                    contentClassName=""
                                    trigger={trigger}
                                  />
                                ),
                              }}
                            />
                            {issueWorkspaces.length > 0 && (
                              <div className="mt-base flex flex-col gap-half">
                                {issueWorkspaces.map((workspace) => (
                                  <IssueWorkspaceCard
                                    key={workspace.id}
                                    workspace={workspace}
                                    onClick={
                                      workspace.localWorkspaceId
                                        ? () =>
                                            openIssueWorkspace(
                                              issue.id,
                                              workspace.localWorkspaceId!,
                                              workspace.hostId
                                            )
                                        : undefined
                                    }
                                    showOwner={false}
                                    showStatusBadge={false}
                                    showNoPrText={false}
                                    compact={isMobile}
                                  />
                                ))}
                              </div>
                            )}
                          </KanbanCard>
                        );
                      })}
                    </KanbanCards>
                  </KanbanBoard>
                );
              })}
            </KanbanProvider>
          </div>
        )
      ) : (
        <div
          ref={issueListRef}
          // tabIndex=-1 lets clicks on empty list space claim focus so
          // arrow/Enter navigation turns on there too (mirrors the board).
          tabIndex={-1}
          className="flex-1 overflow-y-auto px-double outline-none"
          onFocus={() => setIsBoardFocused(true)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setIsBoardFocused(false);
            }
          }}
        >
          <KanbanProvider onDragEnd={handleDragEnd} className="!block !w-full">
            <IssueListView
              statuses={listViewStatuses}
              items={items}
              issueMap={issueMap}
              issueAssigneesMap={issueAssigneesMap}
              getTagObjectsForIssue={getTagObjectsForIssue}
              getMilestoneForIssue={(issueId) => {
                const milestone = getMilestoneForIssue(issueId);
                return milestone
                  ? { name: milestone.name, targetDate: milestone.target_date }
                  : undefined;
              }}
              getResolvedRelationshipsForIssue={
                getResolvedRelationshipsForIssue
              }
              onIssueClick={handleCardClick}
              selectedIssueId={selectedKanbanIssueId}
              selectedIssueIds={selectedIssueIds}
              cursorIssueId={cursorIssueId}
              onRowRef={registerRowRef}
              focusedSectionId={focusedSectionId}
              onHeaderRef={registerSectionRef}
              isMultiSelectActive={isMultiSelectActive}
              onIssueCheckboxChange={handleCheckboxChange}
              workspacesByIssueId={workspacesByIssueId}
              onWorkspaceClick={handleListWorkspaceClick}
              onMoreActionsClick={handleCardMoreActionsClick}
              collapsedStatusIds={collapsedStatusIds}
              onToggleStatusCollapsed={toggleStatusCollapsed}
              onAddIssue={handleInlineAddIssue}
              focusedAddStatusId={focusedAddStatusId}
              editingAddStatusId={editingAddStatusId}
              onStartAddEditing={handleStartAddEditing}
              onStopAddEditing={handleStopAddEditing}
              onAddRowRef={registerAddRef}
            />
          </KanbanProvider>
        </div>
      )}

      {isMultiSelectActive && selectedIssueIds.size > 0 && (
        <BulkActionBarContainer projectId={projectId} />
      )}
    </div>
  );
}
