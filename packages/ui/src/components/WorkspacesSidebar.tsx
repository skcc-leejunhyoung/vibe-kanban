import type { ReactNode, Ref } from 'react';
import { useCallback, useMemo, useRef } from 'react';
import {
  PlusIcon,
  ArrowLeftIcon,
  ArchiveIcon,
  StackIcon,
  CardsIcon,
  SpinnerIcon,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';
import { InputField } from './InputField';
import { WorkspaceSummary } from './WorkspaceSummary';
import type { AppBarHostStatus } from './AppBar';
import {
  CollapsibleSectionHeader,
  type SectionAction,
} from './CollapsibleSectionHeader';
import {
  WorkspacesIssueGroupedList,
  type WorkspaceIssueGroup,
  type WorkspaceIssueStatusSection,
} from './WorkspacesIssueGroupedList';

export type WorkspaceLayoutMode = 'flat' | 'accordion';

export interface WorkspacesSidebarWorkspace {
  id: string;
  name: string;
  filesChanged?: number;
  linesAdded?: number;
  linesRemoved?: number;
  isRunning?: boolean;
  isPinned?: boolean;
  hasPendingApproval?: boolean;
  hasRunningDevServer?: boolean;
  hasUnseenActivity?: boolean;
  /** Total items in the agent's latest TODO list (running workspaces only). */
  todoTotal?: number;
  /** Completed items in the agent's latest TODO list (running only). */
  todoCompleted?: number;
  latestProcessCompletedAt?: string;
  latestProcessStatus?: 'running' | 'completed' | 'failed' | 'killed';
  prStatus?: 'open' | 'merged' | 'closed' | 'unknown';
  /** Most recent prompt sent in this workspace (what it's working on) */
  latestPrompt?: string;
  /** Quick-chat ("in-place") workspace — runs in an existing checkout. */
  isInPlace?: boolean;
}

export interface WorkspacesSidebarPersistKeys {
  raisedHand: string;
  notRunning: string;
  running: string;
}

const DEFAULT_PERSIST_KEYS: WorkspacesSidebarPersistKeys = {
  raisedHand: 'workspaces-sidebar-raised-hand',
  notRunning: 'workspaces-sidebar-not-running',
  running: 'workspaces-sidebar-running',
};

export interface WorkspacesSidebarProps {
  workspaces: WorkspacesSidebarWorkspace[];
  totalWorkspacesCount: number;
  archivedWorkspaces?: WorkspacesSidebarWorkspace[];
  isLoading?: boolean;
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  onAddWorkspace?: () => void;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  /** Whether we're in create mode */
  isCreateMode?: boolean;
  /** Title extracted from draft message (only shown when isCreateMode and non-empty) */
  draftTitle?: string;
  /** Handler to navigate back to create mode */
  onSelectCreate?: () => void;
  /** Whether to show archived workspaces */
  showArchive?: boolean;
  /** Handler for toggling archive view */
  onShowArchiveChange?: (show: boolean) => void;
  /** Layout mode for active workspaces */
  layoutMode?: WorkspaceLayoutMode;
  /** Handler for toggling layout mode */
  onToggleLayoutMode?: () => void;
  /** Whether the issue-grouped view is active */
  isIssueGrouped?: boolean;
  /** Handler for toggling the issue-grouped view */
  onToggleIssueGrouped?: () => void;
  /** Flat issue groups (issue mode, layout = flat) */
  issueGroups?: WorkspaceIssueGroup[];
  /** Status sections (issue mode, layout = accordion); null = flat issue mode */
  issueSections?: WorkspaceIssueStatusSection[] | null;
  /** Persist-key prefix for issue status sections */
  issueSectionPersistPrefix?: string;
  /** Handler to load more workspaces on scroll */
  onLoadMore?: () => void;
  /** Whether there are more workspaces to load */
  hasMoreWorkspaces?: boolean;
  /** Controls rendered beside the search input */
  searchControls?: ReactNode;
  /** Callback for opening workspace actions */
  onOpenWorkspaceActions?: (workspaceId: string) => void;
  /** Keyboard navigation cursor (arrow/vim key focus) */
  focusedWorkspaceId?: string | null;
  /** Register a row's DOM node for scroll-into-view during keyboard nav */
  registerWorkspaceRef?: (id: string, node: HTMLDivElement | null) => void;
  /**
   * Ref for the sidebar root, used to scope arrow-key navigation to the list:
   * the hotkeys only fire while keyboard focus is inside this container.
   */
  keyboardNavRef?: Ref<HTMLDivElement>;
  /** Persist keys for collapsible sections */
  persistKeys?: WorkspacesSidebarPersistKeys;
  activeRemoteHost?: {
    name: string;
    status: AppBarHostStatus;
  } | null;
  onOpenRemoteHostSettings?: () => void;
  /** Enlarge the header action buttons (group / issue / add) for touch. */
  isMobile?: boolean;
}

/** Coarse activity status used for sections and the status filter. */
export type WorkspaceActivityStatus = 'running' | 'attention' | 'idle';

/**
 * Classify one workspace into a coarse activity bucket. Needs attention wins
 * (pending approval, or unseen activity while not running); otherwise running,
 * otherwise idle. Single source of truth for categorizeWorkspaces and the
 * status filter so the sidebar sections and filter always agree.
 */
export function getWorkspaceActivityStatus(ws: {
  isRunning?: boolean;
  hasPendingApproval?: boolean;
  hasUnseenActivity?: boolean;
}): WorkspaceActivityStatus {
  if (ws.hasPendingApproval || (ws.hasUnseenActivity && !ws.isRunning)) {
    return 'attention';
  }
  if (ws.isRunning) return 'running';
  return 'idle';
}

/**
 * Split workspaces into accordion sections in display order
 * (Needs attention → Running → Idle). Exported so containers can derive the
 * same flat ordering for keyboard navigation.
 */
export function categorizeWorkspaces(
  workspaces: WorkspacesSidebarWorkspace[]
): {
  raisedHandWorkspaces: WorkspacesSidebarWorkspace[];
  runningWorkspaces: WorkspacesSidebarWorkspace[];
  idleWorkspaces: WorkspacesSidebarWorkspace[];
} {
  const raisedHandWorkspaces: WorkspacesSidebarWorkspace[] = [];
  const runningWorkspaces: WorkspacesSidebarWorkspace[] = [];
  const idleWorkspaces: WorkspacesSidebarWorkspace[] = [];
  for (const ws of workspaces) {
    const status = getWorkspaceActivityStatus(ws);
    if (status === 'attention') raisedHandWorkspaces.push(ws);
    else if (status === 'running') runningWorkspaces.push(ws);
    else idleWorkspaces.push(ws);
  }
  return { raisedHandWorkspaces, runningWorkspaces, idleWorkspaces };
}

function WorkspaceList({
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  onOpenWorkspaceActions,
  focusedWorkspaceId,
  registerWorkspaceRef,
}: {
  workspaces: WorkspacesSidebarWorkspace[];
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  onOpenWorkspaceActions: (workspaceId: string) => void;
  focusedWorkspaceId?: string | null;
  registerWorkspaceRef?: (id: string, node: HTMLDivElement | null) => void;
}) {
  return (
    <>
      {workspaces.map((workspace) => (
        <WorkspaceSummary
          key={workspace.id}
          name={workspace.name}
          workspaceId={workspace.id}
          filesChanged={workspace.filesChanged}
          linesAdded={workspace.linesAdded}
          linesRemoved={workspace.linesRemoved}
          isActive={selectedWorkspaceId === workspace.id}
          isFocused={focusedWorkspaceId === workspace.id}
          forwardedRef={
            registerWorkspaceRef
              ? (node) => registerWorkspaceRef(workspace.id, node)
              : undefined
          }
          isRunning={workspace.isRunning}
          isPinned={workspace.isPinned}
          hasPendingApproval={workspace.hasPendingApproval}
          hasRunningDevServer={workspace.hasRunningDevServer}
          hasUnseenActivity={workspace.hasUnseenActivity}
          todoTotal={workspace.todoTotal}
          todoCompleted={workspace.todoCompleted}
          latestProcessCompletedAt={workspace.latestProcessCompletedAt}
          latestProcessStatus={workspace.latestProcessStatus}
          prStatus={workspace.prStatus}
          isInPlace={workspace.isInPlace}
          onOpenWorkspaceActions={onOpenWorkspaceActions}
          onClick={() => onSelectWorkspace(workspace.id)}
        />
      ))}
    </>
  );
}

export function WorkspacesSidebar({
  workspaces,
  totalWorkspacesCount,
  archivedWorkspaces = [],
  isLoading = false,
  selectedWorkspaceId,
  onSelectWorkspace,
  onAddWorkspace,
  searchQuery,
  onSearchChange,
  isCreateMode = false,
  draftTitle,
  onSelectCreate,
  showArchive = false,
  onShowArchiveChange,
  layoutMode = 'flat',
  onToggleLayoutMode,
  isIssueGrouped = false,
  onToggleIssueGrouped,
  issueGroups = [],
  issueSections = null,
  issueSectionPersistPrefix = 'workspaces-issue-status-',
  onLoadMore,
  hasMoreWorkspaces = false,
  searchControls,
  onOpenWorkspaceActions,
  focusedWorkspaceId = null,
  registerWorkspaceRef,
  keyboardNavRef,
  persistKeys = DEFAULT_PERSIST_KEYS,
  activeRemoteHost = null,
  onOpenRemoteHostSettings,
  isMobile = false,
}: WorkspacesSidebarProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const handleOpenWorkspaceActions = useCallback(
    (workspaceId: string) => {
      onOpenWorkspaceActions?.(workspaceId);
    },
    [onOpenWorkspaceActions]
  );

  // Handle scroll to load more
  const handleScroll = () => {
    if (!hasMoreWorkspaces || !onLoadMore) return;

    const container = scrollContainerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    // Load more when scrolled within 100px of the bottom
    if (scrollHeight - scrollTop - clientHeight < 100) {
      onLoadMore();
    }
  };

  // Categorize workspaces for accordion layout
  const { raisedHandWorkspaces, idleWorkspaces, runningWorkspaces } = useMemo(
    () => categorizeWorkspaces(workspaces),
    [workspaces]
  );

  // Draft/create-mode placeholder card, shared across layouts.
  const draftCard = draftTitle ? (
    <WorkspaceSummary
      name={draftTitle}
      isActive={isCreateMode}
      isDraft={true}
      onClick={onSelectCreate}
    />
  ) : null;

  const headerActions: SectionAction[] = [
    {
      icon: StackIcon,
      onClick: () => onToggleLayoutMode?.(),
      isActive: layoutMode === 'accordion',
    },
    {
      icon: CardsIcon,
      onClick: () => onToggleIssueGrouped?.(),
      isActive: isIssueGrouped,
    },
    {
      icon: PlusIcon,
      onClick: () => onAddWorkspace?.(),
    },
  ];

  return (
    <div
      ref={keyboardNavRef}
      // tabIndex=-1 lets a click on empty sidebar space (not a row) focus this
      // container, turning on arrow-key navigation: the useHotkeys ref only
      // fires while keyboard focus is inside here. It stays out of the Tab
      // order; outline-none hides the native focus ring.
      tabIndex={-1}
      className="w-full h-full bg-secondary flex flex-col outline-none"
    >
      {/* Header + Search */}
      <div className="flex flex-col gap-base">
        <CollapsibleSectionHeader
          title={t('common:workspaces.title')}
          collapsible={false}
          actions={headerActions}
          largeActions={isMobile}
          className="border-b"
        />
        {!isLoading && (
          <div className="px-base flex items-stretch gap-half">
            <div className="flex-1 min-w-0">
              <InputField
                variant="search"
                value={searchQuery}
                onChange={onSearchChange}
                placeholder={t('common:workspaces.searchPlaceholder')}
              />
            </div>
            {searchControls}
          </div>
        )}

        {activeRemoteHost && (
          <div className="px-base">
            <div className="rounded-sm border border-border bg-panel/60 px-base py-half flex items-center justify-between gap-base">
              <div className="min-w-0">
                <p className="text-xs text-low uppercase tracking-wide">
                  {t('common:workspaces.remoteHostLabel', {
                    defaultValue: 'Remote host',
                  })}
                </p>
                <p className="text-sm text-high truncate">
                  {activeRemoteHost.name}
                </p>
              </div>
              <div className="flex items-center gap-half shrink-0">
                <span
                  className={cn(
                    'inline-flex h-2.5 w-2.5 rounded-full',
                    activeRemoteHost.status === 'online'
                      ? 'bg-success'
                      : activeRemoteHost.status === 'offline'
                        ? 'bg-low'
                        : 'bg-warning'
                  )}
                  aria-hidden="true"
                />
                {onOpenRemoteHostSettings && (
                  <button
                    type="button"
                    onClick={onOpenRemoteHostSettings}
                    className="text-xs text-brand hover:underline"
                  >
                    {t('common:workspaces.remoteHostManage', {
                      defaultValue: 'Manage',
                    })}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Scrollable workspace list */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto py-base"
      >
        {isLoading ? (
          <div className="flex h-full min-h-[220px] items-center justify-center px-base">
            <div className="flex items-center justify-center text-low">
              <SpinnerIcon className="size-6 animate-spin" weight="bold" />
            </div>
          </div>
        ) : showArchive ? (
          /* Archived workspaces view */
          <div className="flex flex-col gap-base">
            <span className="text-sm font-medium text-low px-base">
              {t('common:workspaces.archived')}
            </span>
            {archivedWorkspaces.length === 0 ? (
              <span className="text-sm text-low opacity-60 px-base">
                {t('common:workspaces.noArchived')}
              </span>
            ) : (
              archivedWorkspaces.map((workspace) => (
                <WorkspaceSummary
                  summary
                  key={workspace.id}
                  name={workspace.name}
                  workspaceId={workspace.id}
                  filesChanged={workspace.filesChanged}
                  linesAdded={workspace.linesAdded}
                  linesRemoved={workspace.linesRemoved}
                  isActive={selectedWorkspaceId === workspace.id}
                  isFocused={focusedWorkspaceId === workspace.id}
                  forwardedRef={
                    registerWorkspaceRef
                      ? (node) => registerWorkspaceRef(workspace.id, node)
                      : undefined
                  }
                  isRunning={workspace.isRunning}
                  isPinned={workspace.isPinned}
                  hasPendingApproval={workspace.hasPendingApproval}
                  hasRunningDevServer={workspace.hasRunningDevServer}
                  hasUnseenActivity={workspace.hasUnseenActivity}
                  todoTotal={workspace.todoTotal}
                  todoCompleted={workspace.todoCompleted}
                  latestProcessCompletedAt={workspace.latestProcessCompletedAt}
                  latestProcessStatus={workspace.latestProcessStatus}
                  prStatus={workspace.prStatus}
                  isInPlace={workspace.isInPlace}
                  onOpenWorkspaceActions={handleOpenWorkspaceActions}
                  onClick={() => onSelectWorkspace(workspace.id)}
                />
              ))
            )}
          </div>
        ) : isIssueGrouped ? (
          /* Issue-grouped view (optionally split into status sections) */
          <WorkspacesIssueGroupedList
            sections={layoutMode === 'accordion' ? issueSections : null}
            groups={issueGroups}
            selectedWorkspaceId={selectedWorkspaceId}
            onSelectWorkspace={onSelectWorkspace}
            onOpenWorkspaceActions={handleOpenWorkspaceActions}
            focusedWorkspaceId={focusedWorkspaceId}
            registerWorkspaceRef={registerWorkspaceRef}
            sectionPersistPrefix={issueSectionPersistPrefix}
            draftSlot={draftCard}
            emptyLabel={t('common:workspaces.noWorkspaces')}
          />
        ) : layoutMode === 'accordion' ? (
          /* Accordion layout view */
          <div className="flex flex-col gap-base">
            {/* Needs Attention section */}
            <CollapsibleSectionHeader
              title={t('common:workspaces.needsAttention')}
              persistKey={persistKeys.raisedHand}
              defaultExpanded={true}
            >
              <div className="flex flex-col gap-base py-half">
                {draftTitle && (
                  <WorkspaceSummary
                    name={draftTitle}
                    isActive={isCreateMode}
                    isDraft={true}
                    onClick={onSelectCreate}
                  />
                )}
                {raisedHandWorkspaces.length === 0 && !draftTitle ? (
                  <span className="text-sm text-low opacity-60 pl-base">
                    {t('common:workspaces.noWorkspaces')}
                  </span>
                ) : (
                  <WorkspaceList
                    workspaces={raisedHandWorkspaces}
                    selectedWorkspaceId={selectedWorkspaceId}
                    onSelectWorkspace={onSelectWorkspace}
                    onOpenWorkspaceActions={handleOpenWorkspaceActions}
                    focusedWorkspaceId={focusedWorkspaceId}
                    registerWorkspaceRef={registerWorkspaceRef}
                  />
                )}
              </div>
            </CollapsibleSectionHeader>

            {/* Running section */}
            <CollapsibleSectionHeader
              title={t('common:workspaces.running')}
              persistKey={persistKeys.running}
              defaultExpanded={true}
            >
              <div className="flex flex-col gap-base py-half">
                {runningWorkspaces.length === 0 ? (
                  <span className="text-sm text-low opacity-60 pl-base">
                    {t('common:workspaces.noWorkspaces')}
                  </span>
                ) : (
                  <WorkspaceList
                    workspaces={runningWorkspaces}
                    selectedWorkspaceId={selectedWorkspaceId}
                    onSelectWorkspace={onSelectWorkspace}
                    onOpenWorkspaceActions={handleOpenWorkspaceActions}
                    focusedWorkspaceId={focusedWorkspaceId}
                    registerWorkspaceRef={registerWorkspaceRef}
                  />
                )}
              </div>
            </CollapsibleSectionHeader>

            {/* Idle section */}
            <CollapsibleSectionHeader
              title={t('common:workspaces.idle')}
              persistKey={persistKeys.notRunning}
              defaultExpanded={true}
            >
              <div className="flex flex-col gap-base py-half">
                {idleWorkspaces.length === 0 ? (
                  <span className="text-sm text-low opacity-60 pl-base">
                    {t('common:workspaces.noWorkspaces')}
                  </span>
                ) : (
                  <WorkspaceList
                    workspaces={idleWorkspaces}
                    selectedWorkspaceId={selectedWorkspaceId}
                    onSelectWorkspace={onSelectWorkspace}
                    onOpenWorkspaceActions={handleOpenWorkspaceActions}
                    focusedWorkspaceId={focusedWorkspaceId}
                    registerWorkspaceRef={registerWorkspaceRef}
                  />
                )}
              </div>
            </CollapsibleSectionHeader>
          </div>
        ) : (
          /* Active workspaces flat view */
          <div className="flex flex-col gap-base">
            <div className="flex items-center justify-between px-base">
              <span className="text-sm font-medium text-low">
                {t('common:workspaces.active')}
              </span>
              <span className="text-xs text-low">{totalWorkspacesCount}</span>
            </div>
            {draftTitle && (
              <WorkspaceSummary
                name={draftTitle}
                isActive={isCreateMode}
                isDraft={true}
                onClick={onSelectCreate}
              />
            )}
            {workspaces.map((workspace) => (
              <WorkspaceSummary
                key={workspace.id}
                name={workspace.name}
                workspaceId={workspace.id}
                filesChanged={workspace.filesChanged}
                linesAdded={workspace.linesAdded}
                linesRemoved={workspace.linesRemoved}
                isActive={selectedWorkspaceId === workspace.id}
                isFocused={focusedWorkspaceId === workspace.id}
                forwardedRef={
                  registerWorkspaceRef
                    ? (node) => registerWorkspaceRef(workspace.id, node)
                    : undefined
                }
                isRunning={workspace.isRunning}
                isPinned={workspace.isPinned}
                hasPendingApproval={workspace.hasPendingApproval}
                hasRunningDevServer={workspace.hasRunningDevServer}
                hasUnseenActivity={workspace.hasUnseenActivity}
                todoTotal={workspace.todoTotal}
                todoCompleted={workspace.todoCompleted}
                latestProcessCompletedAt={workspace.latestProcessCompletedAt}
                latestProcessStatus={workspace.latestProcessStatus}
                prStatus={workspace.prStatus}
                isInPlace={workspace.isInPlace}
                onOpenWorkspaceActions={handleOpenWorkspaceActions}
                onClick={() => onSelectWorkspace(workspace.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Fixed footer toggle - only show if there are archived workspaces */}
      <div className="border-t border-primary p-base">
        <button
          onClick={() => onShowArchiveChange?.(!showArchive)}
          className="w-full flex items-center gap-base text-sm text-low hover:text-normal transition-colors duration-100"
        >
          {showArchive ? (
            <>
              <ArrowLeftIcon className="size-icon-xs" />
              <span>{t('common:workspaces.backToActive')}</span>
            </>
          ) : (
            <>
              <ArchiveIcon className="size-icon-xs" />
              <span>{t('common:workspaces.viewArchive')}</span>
              <span className="ml-auto text-xs bg-tertiary px-1.5 py-0.5 rounded">
                {archivedWorkspaces.length}
              </span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
