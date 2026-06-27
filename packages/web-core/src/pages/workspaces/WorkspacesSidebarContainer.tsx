import {
  useState,
  useMemo,
  useCallback,
  useEffect,
  useRef,
  type RefObject,
} from 'react';
import { useParams } from '@tanstack/react-router';
import { useHotkeys } from 'react-hotkeys-hook';
import { useTranslation } from 'react-i18next';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { useScratch } from '@/shared/hooks/useScratch';
import { ScratchType, type DraftWorkspaceData } from 'shared/types';
import { splitMessageToTitleDescription } from '@/shared/lib/string';
import { cn } from '@/shared/lib/utils';
import { useIsMobile } from '@/shared/hooks/useIsMobile';
import {
  PERSIST_KEYS,
  usePersistedExpanded,
  useUiPreferencesStore,
  useWorkspaceGroupMode,
  useWorkspaceIssueStatuses,
} from '@/shared/stores/useUiPreferencesStore';
import { useWorkspaceIssueGrouping } from '@/shared/hooks/useWorkspaceIssueGrouping';
import {
  groupWorkspacesByIssue,
  bucketIssueGroupsByStatus,
} from '@/shared/lib/workspaceIssueGrouping';
import { useWorkspaceSortFilter } from '@/shared/hooks/useWorkspaceSortFilter';
import {
  WorkspacesSortDialog,
  WorkspacesFilterDialog,
} from './WorkspacesSortFilterDialogs';
import { CommandBarDialog } from '@/shared/dialogs/command-bar/CommandBarDialog';
import { SettingsDialog } from '@/shared/dialogs/settings/SettingsDialog';
import {
  WorkspacesSidebar,
  categorizeWorkspaces,
  type WorkspacesSidebarPersistKeys,
} from '@vibe/ui/components/WorkspacesSidebar';
import { IconButton } from '@vibe/ui/components/IconButton';
import {
  FunnelIcon,
  SortAscendingIcon,
  SortDescendingIcon,
} from '@phosphor-icons/react';
import { useRemoteCloudHostsAppBarModel } from '@/shared/hooks/useRemoteCloudHosts';

export type WorkspaceLayoutMode = 'flat' | 'accordion';

// Fixed UUID for the universal workspace draft (same as in useCreateModeState.ts)
const DRAFT_WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';

const PAGE_SIZE = 50;

interface WorkspacesSidebarContainerProps {
  onScrollToBottom?: (behavior?: 'auto' | 'smooth') => void;
  /**
   * Override workspace selection. Remote mobile navigates to a workspace route
   * instead of switching the mobile tab; when provided, the default
   * select-then-switch-tab behaviour is skipped.
   */
  onSelectWorkspaceOverride?: (id: string) => void;
  /** Override the add-workspace action (remote mobile routes to create). */
  onAddWorkspaceOverride?: () => void;
}

export function WorkspacesSidebarContainer({
  onScrollToBottom = () => {},
  onSelectWorkspaceOverride,
  onAddWorkspaceOverride,
}: WorkspacesSidebarContainerProps) {
  const {
    workspaceId: selectedWorkspaceId,
    activeWorkspaces,
    archivedWorkspaces,
    isWorkspacesListLoading,
    isCreateMode,
    selectWorkspace,
    navigateToCreate,
  } = useWorkspaceContext();

  const isMobile = useIsMobile();
  const { hosts: remoteCloudHosts } = useRemoteCloudHostsAppBarModel();
  const { hostId: routeHostId } = useParams({ strict: false });
  const setMobileActiveTab = useUiPreferencesStore((s) => s.setMobileActiveTab);
  const mobileActiveTab = useUiPreferencesStore((s) => s.mobileActiveTab);
  const [searchQuery, setSearchQuery] = useState('');
  const [showArchive, setShowArchive] = usePersistedExpanded(
    PERSIST_KEYS.workspacesSidebarArchived,
    false
  );
  const [isAccordionLayout, setAccordionLayout] = usePersistedExpanded(
    PERSIST_KEYS.workspacesSidebarAccordionLayout,
    true
  );
  const [isSortDialogOpen, setIsSortDialogOpen] = useState(false);
  const [isFilterDialogOpen, setIsFilterDialogOpen] = useState(false);
  const { t } = useTranslation('common');
  const sortDialogTitle = t('kanban.workspaceSidebar.sortButtonTitle');
  const filterDialogTitle = t('kanban.workspaceSidebar.filterButtonTitle');

  const layoutMode: WorkspaceLayoutMode = isAccordionLayout
    ? 'accordion'
    : 'flat';
  const toggleLayoutMode = () => setAccordionLayout(!isAccordionLayout);

  // Issue-grouped view: groups workspaces under their linked remote issue.
  const { mode: groupMode, toggle: toggleGroupMode } = useWorkspaceGroupMode();
  const [issueStatusNames] = useWorkspaceIssueStatuses();
  const isIssueGrouped = groupMode === 'issue';
  const workspaceIssueMeta = useWorkspaceIssueGrouping(isIssueGrouped);

  // Shared workspace sort/filter model (project options + filter/sort pipeline).
  const sortFilter = useWorkspaceSortFilter();
  const { filterAndSort } = sortFilter;

  // Pagination state for infinite scroll
  const [displayLimit, setDisplayLimit] = useState(PAGE_SIZE);

  // Reset display limit when search, filter, or sort state changes. Keyed on
  // the raw filter/sort values (not filterAndSort) so background changes to
  // remote project metadata don't reset the user's scroll position.
  useEffect(() => {
    setDisplayLimit(PAGE_SIZE);
  }, [
    searchQuery,
    showArchive,
    sortFilter.filter.projectIds,
    sortFilter.filter.prFilter,
    sortFilter.sort.sortBy,
    sortFilter.sort.sortOrder,
  ]);

  const isSearching = searchQuery.length > 0;

  // Apply sidebar filters (project + PR) + search, then sort.
  const sortedActiveWorkspaces = useMemo(
    () => filterAndSort(activeWorkspaces, searchQuery),
    [filterAndSort, activeWorkspaces, searchQuery]
  );

  const sortedArchivedWorkspaces = useMemo(
    () => filterAndSort(archivedWorkspaces, searchQuery),
    [filterAndSort, archivedWorkspaces, searchQuery]
  );

  // Apply pagination (only when not searching)
  const paginatedActiveWorkspaces = useMemo(
    () =>
      isSearching
        ? sortedActiveWorkspaces
        : sortedActiveWorkspaces.slice(0, displayLimit),
    [sortedActiveWorkspaces, displayLimit, isSearching]
  );

  const paginatedArchivedWorkspaces = useMemo(
    () =>
      isSearching
        ? sortedArchivedWorkspaces
        : sortedArchivedWorkspaces.slice(0, displayLimit),
    [sortedArchivedWorkspaces, displayLimit, isSearching]
  );

  // Issue-grouped structures (only computed in issue mode). The status sections
  // are only used when the accordion layout is also active.
  const issueGroups = useMemo(
    () =>
      isIssueGrouped
        ? groupWorkspacesByIssue(paginatedActiveWorkspaces, workspaceIssueMeta)
        : [],
    [isIssueGrouped, paginatedActiveWorkspaces, workspaceIssueMeta]
  );

  const issueSections = useMemo(
    () =>
      isIssueGrouped && isAccordionLayout
        ? bucketIssueGroupsByStatus(issueGroups, issueStatusNames, {
            unknown: t('workspaces.unknownStatus'),
            unlinked: t('workspaces.unlinkedIssues'),
          })
        : null,
    [isIssueGrouped, isAccordionLayout, issueGroups, issueStatusNames, t]
  );

  // Check if there are more workspaces to load
  const hasMoreWorkspaces = showArchive
    ? sortedArchivedWorkspaces.length > displayLimit
    : sortedActiveWorkspaces.length > displayLimit;

  // Handle scroll to load more
  const handleLoadMore = useCallback(() => {
    if (!isSearching && hasMoreWorkspaces) {
      setDisplayLimit((prev) => prev + PAGE_SIZE);
    }
  }, [isSearching, hasMoreWorkspaces]);

  // Read persisted draft for sidebar placeholder
  const { scratch: draftScratch } = useScratch(
    ScratchType.DRAFT_WORKSPACE,
    DRAFT_WORKSPACE_ID
  );

  // Extract draft title from persisted scratch
  const persistedDraftTitle = useMemo(() => {
    const scratchData: DraftWorkspaceData | undefined =
      draftScratch?.payload?.type === 'DRAFT_WORKSPACE'
        ? draftScratch.payload.data
        : undefined;

    if (!scratchData?.message?.trim()) return undefined;
    const { title } = splitMessageToTitleDescription(
      scratchData.message.trim()
    );
    return title || 'New Workspace';
  }, [draftScratch]);

  // Handle workspace selection - scroll to bottom if re-selecting same workspace
  const handleSelectWorkspace = useCallback(
    (id: string) => {
      if (onSelectWorkspaceOverride) {
        onSelectWorkspaceOverride(id);
        return;
      }
      if (id === selectedWorkspaceId) {
        onScrollToBottom();
      } else {
        selectWorkspace(id);
      }
      if (isMobile) {
        setMobileActiveTab('chat');
      }
    },
    [
      onSelectWorkspaceOverride,
      selectedWorkspaceId,
      selectWorkspace,
      onScrollToBottom,
      isMobile,
      setMobileActiveTab,
    ]
  );

  // --- Keyboard arrow-key navigation across the workspace list ------------
  const [focusedWorkspaceId, setFocusedWorkspaceId] = useState<string | null>(
    null
  );
  const workspaceRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const registerWorkspaceRef = useCallback(
    (id: string, node: HTMLDivElement | null) => {
      if (node) workspaceRefs.current.set(id, node);
      else workspaceRefs.current.delete(id);
    },
    []
  );

  // Flat list of workspace IDs in display order, so up/down navigation matches
  // what the user sees (archive view, accordion sections, or the flat list).
  const displayedWorkspaceIds = useMemo(() => {
    if (showArchive) {
      return paginatedArchivedWorkspaces.map((w) => w.id);
    }
    if (isIssueGrouped) {
      // Follow the issue-grouped display order (status sections when present,
      // otherwise the flat issue groups).
      const source = issueSections
        ? issueSections.flatMap((s) => s.groups)
        : issueGroups;
      return source.flatMap((g) => g.workspaces.map((w) => w.id));
    }
    if (layoutMode === 'accordion') {
      const { raisedHandWorkspaces, runningWorkspaces, idleWorkspaces } =
        categorizeWorkspaces(paginatedActiveWorkspaces);
      return [
        ...raisedHandWorkspaces,
        ...runningWorkspaces,
        ...idleWorkspaces,
      ].map((w) => w.id);
    }
    return paginatedActiveWorkspaces.map((w) => w.id);
  }, [
    showArchive,
    isIssueGrouped,
    issueSections,
    issueGroups,
    layoutMode,
    paginatedActiveWorkspaces,
    paginatedArchivedWorkspaces,
  ]);

  const moveWorkspaceFocus = useCallback(
    (delta: 1 | -1) => {
      // Only navigate to rows that are actually rendered. Collapsed accordion
      // sections unmount their rows (CollapsibleSectionHeader renders children
      // only while expanded), so an id without a live DOM node would move the
      // cursor onto an invisible workspace.
      const ids = displayedWorkspaceIds.filter((id) =>
        workspaceRefs.current.has(id)
      );
      if (ids.length === 0) return;
      // Start from the cursor, falling back to the open workspace, then either
      // end depending on direction.
      const current = focusedWorkspaceId ?? selectedWorkspaceId ?? null;
      const currentIndex = current ? ids.indexOf(current) : -1;
      const nextIndex =
        currentIndex === -1
          ? delta === 1
            ? 0
            : ids.length - 1
          : currentIndex + delta;
      if (nextIndex < 0 || nextIndex >= ids.length) return;
      setFocusedWorkspaceId(ids[nextIndex]);
    },
    [displayedWorkspaceIds, focusedWorkspaceId, selectedWorkspaceId]
  );

  // Only active while the list is on screen (always on desktop; on mobile only
  // while the workspaces tab shows). enableOnFormTags:false keeps arrow keys
  // working normally inside the search box and other inputs.
  const isListVisible = !isMobile || mobileActiveTab === 'workspaces';

  // Arrow-key navigation is scoped to the sidebar via the ref returned by
  // useHotkeys: it only fires while keyboard focus is inside this container.
  // Clicking the inner button or arrow-navigating (which moves DOM focus onto
  // the row container) keeps focus inside the sidebar; this leaves arrow-key
  // scrolling intact when the user is working in the main/right panels.
  // enableOnFormTags:false additionally exempts the search input. The cast
  // aligns react-hotkeys-hook's RefObject<T | null> return (React 19 ref
  // typing) with the RefObject<T> shape @types/react 18 expects.
  const keyboardNavRef = useHotkeys<HTMLDivElement>(
    ['up', 'down', 'enter'],
    (e) => {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveWorkspaceFocus(-1);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveWorkspaceFocus(1);
      } else if (e.key === 'Enter') {
        if (!focusedWorkspaceId) return;
        // The focused row is a non-interactive container (focus lives on it,
        // not the inner button), so this hotkey is the only Enter handler.
        // handleSelectWorkspace already no-ops into a scroll-to-bottom when the
        // cursor is on the already-open workspace.
        e.preventDefault();
        handleSelectWorkspace(focusedWorkspaceId);
      }
    },
    { enabled: isListVisible, enableOnFormTags: false },
    [
      moveWorkspaceFocus,
      focusedWorkspaceId,
      handleSelectWorkspace,
      isListVisible,
    ]
  ) as RefObject<HTMLDivElement>;

  // When the cursor MOVES (user navigation), move real DOM focus onto the row
  // so the cursor and keyboard focus stay in lockstep: this keeps the
  // sidebar-scoped hotkeys active and makes native Enter agree with the cursor
  // (the row container is non-interactive, so Enter is handled solely by the
  // hotkey). Keyed on focusedWorkspaceId only, so background list updates don't
  // steal focus from elsewhere on the page.
  useEffect(() => {
    if (!focusedWorkspaceId) return;
    const node = workspaceRefs.current.get(focusedWorkspaceId);
    if (!node) return;
    node.focus({ preventScroll: true });
    node.scrollIntoView({ block: 'nearest' });
  }, [focusedWorkspaceId]);

  // Drop the cursor if its row stops being rendered (collapsed section,
  // filtered out, or removed) so it can't point at an invisible workspace.
  useEffect(() => {
    if (!focusedWorkspaceId) return;
    if (!workspaceRefs.current.has(focusedWorkspaceId)) {
      setFocusedWorkspaceId(null);
    }
  }, [focusedWorkspaceId, displayedWorkspaceIds]);

  const handleAddWorkspace = useCallback(() => {
    if (onAddWorkspaceOverride) {
      onAddWorkspaceOverride();
      return;
    }
    navigateToCreate();
    if (isMobile) {
      setMobileActiveTab('chat');
    }
  }, [onAddWorkspaceOverride, navigateToCreate, isMobile, setMobileActiveTab]);

  const handleOpenWorkspaceActions = useCallback((workspaceId: string) => {
    CommandBarDialog.show({
      page: 'workspaceActions',
      workspaceId,
    });
  }, []);

  const sidebarPersistKeys: WorkspacesSidebarPersistKeys = {
    raisedHand: PERSIST_KEYS.workspacesSidebarRaisedHand,
    notRunning: PERSIST_KEYS.workspacesSidebarNotRunning,
    running: PERSIST_KEYS.workspacesSidebarRunning,
  };

  const searchControls = (
    <>
      <div className="shrink-0">
        <div className="flex items-stretch">
          <IconButton
            icon={
              sortFilter.sort.sortOrder === 'asc'
                ? SortAscendingIcon
                : SortDescendingIcon
            }
            onClick={() => setIsSortDialogOpen(true)}
            aria-label={sortDialogTitle}
            title={sortDialogTitle}
            className={cn(
              '!h-cta !px-half !py-0',
              sortFilter.hasNonDefaultSort && 'text-brand hover:text-brand'
            )}
            iconClassName="size-icon-lg"
          />
          <IconButton
            icon={FunnelIcon}
            onClick={() => setIsFilterDialogOpen(true)}
            aria-label={filterDialogTitle}
            title={filterDialogTitle}
            className="!h-cta !px-half !py-0"
            iconClassName={cn(
              'size-icon-lg',
              sortFilter.hasActiveFilters && 'text-brand'
            )}
          />
        </div>
      </div>

      <WorkspacesSortDialog
        open={isSortDialogOpen}
        onOpenChange={setIsSortDialogOpen}
        sortBy={sortFilter.sort.sortBy}
        sortOrder={sortFilter.sort.sortOrder}
        onSortByChange={sortFilter.sort.setSortBy}
        onSortOrderChange={sortFilter.sort.setSortOrder}
      />

      <WorkspacesFilterDialog
        open={isFilterDialogOpen}
        onOpenChange={setIsFilterDialogOpen}
        projectOptions={sortFilter.projectOptions}
        projectIds={sortFilter.filter.projectIds}
        prFilter={sortFilter.filter.prFilter}
        statusFilters={sortFilter.filter.statusFilters}
        hasActiveFilters={sortFilter.hasActiveFilters}
        onProjectFilterChange={sortFilter.filter.setProjectFilter}
        onPrFilterChange={sortFilter.filter.setPrFilter}
        onStatusFilterChange={sortFilter.filter.setStatusFilter}
        onClearFilters={sortFilter.filter.clearFilters}
      />
    </>
  );

  const activeRemoteHost = useMemo(() => {
    if (remoteCloudHosts.length === 0 || !routeHostId) {
      return null;
    }

    return remoteCloudHosts.find((host) => host.id === routeHostId) ?? null;
  }, [routeHostId, remoteCloudHosts]);

  const handleOpenRemoteHostSettings = useCallback(() => {
    void SettingsDialog.show({
      initialSection: 'relay',
      ...(routeHostId ? { initialState: { hostId: routeHostId } } : {}),
    });
  }, [routeHostId]);

  return (
    <WorkspacesSidebar
      workspaces={paginatedActiveWorkspaces}
      totalWorkspacesCount={activeWorkspaces.length}
      archivedWorkspaces={paginatedArchivedWorkspaces}
      isLoading={isWorkspacesListLoading}
      selectedWorkspaceId={selectedWorkspaceId ?? null}
      onSelectWorkspace={handleSelectWorkspace}
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      onAddWorkspace={handleAddWorkspace}
      isCreateMode={isCreateMode}
      draftTitle={persistedDraftTitle}
      onSelectCreate={navigateToCreate}
      showArchive={showArchive}
      onShowArchiveChange={setShowArchive}
      layoutMode={layoutMode}
      onToggleLayoutMode={toggleLayoutMode}
      isIssueGrouped={isIssueGrouped}
      onToggleIssueGrouped={toggleGroupMode}
      issueGroups={issueGroups}
      issueSections={issueSections}
      onLoadMore={handleLoadMore}
      hasMoreWorkspaces={hasMoreWorkspaces && !isSearching}
      searchControls={searchControls}
      onOpenWorkspaceActions={handleOpenWorkspaceActions}
      focusedWorkspaceId={focusedWorkspaceId}
      registerWorkspaceRef={registerWorkspaceRef}
      keyboardNavRef={keyboardNavRef}
      persistKeys={sidebarPersistKeys}
      activeRemoteHost={activeRemoteHost}
      onOpenRemoteHostSettings={handleOpenRemoteHostSettings}
      isMobile={isMobile}
    />
  );
}
