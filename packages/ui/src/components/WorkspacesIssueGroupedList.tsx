import type { MouseEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { KanbanBadge } from './KanbanBadge';
import { WorkspaceSummary } from './WorkspaceSummary';
import { CollapsibleSectionHeader } from './CollapsibleSectionHeader';
import type { WorkspacesSidebarWorkspace } from './WorkspacesSidebar';

// Re-exported so non-UI consumers (e.g. the web-core grouping helpers) can pull
// the row type from the same module as the grouped-list types.
export type { WorkspacesSidebarWorkspace };

export interface WorkspaceIssueGroupTag {
  id: string;
  name: string;
  /** Raw HSL triplet (e.g. "210 40% 50%") or null. */
  color: string | null;
}

export interface WorkspaceIssueGroupHeader {
  /** Short human id shown before the title (e.g. "#142" or "VK-12"). */
  displayId: string;
  title: string;
  projectName: string;
  /** Raw HSL triplet for the project dot, or null. */
  projectColor: string | null;
  statusName: string | null;
  /** Raw HSL triplet for the status badge dot, or null. */
  statusColor: string | null;
  tags: WorkspaceIssueGroupTag[];
}

export interface WorkspaceIssueGroup {
  /** Stable React key — issue id for real issues, a sentinel otherwise. */
  key: string;
  /**
   * null header → workspaces not linked to any issue; rendered as a plain
   * list without an issue heading.
   */
  header: WorkspaceIssueGroupHeader | null;
  workspaces: WorkspacesSidebarWorkspace[];
}

export interface WorkspaceIssueStatusSection {
  /** Stable key — status name, or a sentinel for unknown/unlinked. */
  key: string;
  label: string;
  groups: WorkspaceIssueGroup[];
}

export interface WorkspacesIssueGroupedListProps {
  /**
   * When provided, render collapsible status sections (issue + status mode).
   * When null, render `groups` as a flat list (issue mode only).
   */
  sections: WorkspaceIssueStatusSection[] | null;
  /** Flat issue groups, used when `sections` is null. */
  groups: WorkspaceIssueGroup[];
  selectedWorkspaceId: string | null;
  selectedWorkspaceHostId?: string | null;
  onSelectWorkspace: (
    id: string,
    hostId?: string | null,
    event?: MouseEvent<HTMLButtonElement>
  ) => void;
  onOpenWorkspaceActions: (workspaceId: string) => void;
  focusedWorkspaceId?: string | null;
  registerWorkspaceRef?: (id: string, node: HTMLDivElement | null) => void;
  /** Persist-key prefix for per-section collapse state. */
  sectionPersistPrefix: string;
  /** Optional draft/create-mode card rendered at the very top. */
  draftSlot?: ReactNode;
  /** Localized "no workspaces" label. */
  emptyLabel: string;
}

function WorkspaceRows({
  workspaces,
  selectedWorkspaceId,
  selectedWorkspaceHostId,
  onSelectWorkspace,
  onOpenWorkspaceActions,
  focusedWorkspaceId,
  registerWorkspaceRef,
}: {
  workspaces: WorkspacesSidebarWorkspace[];
  selectedWorkspaceId: string | null;
  selectedWorkspaceHostId?: string | null;
  onSelectWorkspace: (
    id: string,
    hostId?: string | null,
    event?: MouseEvent<HTMLButtonElement>
  ) => void;
  onOpenWorkspaceActions: (workspaceId: string) => void;
  focusedWorkspaceId?: string | null;
  registerWorkspaceRef?: (id: string, node: HTMLDivElement | null) => void;
}) {
  return (
    <>
      {workspaces.map((workspace) => (
        <WorkspaceSummary
          key={`${workspace.hostId ?? 'local'}:${workspace.id}`}
          name={workspace.name}
          hostPrimaryColor={workspace.hostPrimaryColor}
          workspaceId={workspace.id}
          filesChanged={workspace.filesChanged}
          linesAdded={workspace.linesAdded}
          linesRemoved={workspace.linesRemoved}
          isActive={
            selectedWorkspaceId === workspace.id &&
            selectedWorkspaceHostId === (workspace.hostId ?? null)
          }
          isFocused={
            focusedWorkspaceId ===
            `${workspace.hostId ?? 'local'}:${workspace.id}`
          }
          forwardedRef={
            registerWorkspaceRef
              ? (node) =>
                  registerWorkspaceRef(
                    `${workspace.hostId ?? 'local'}:${workspace.id}`,
                    node
                  )
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
          prNumber={workspace.prNumber}
          prUrl={workspace.prUrl}
          pullRequests={workspace.pullRequests}
          githubIssues={workspace.githubIssues}
          latestPrompt={workspace.latestPrompt}
          isInPlace={workspace.isInPlace}
          onOpenWorkspaceActions={onOpenWorkspaceActions}
          onClick={(event) =>
            onSelectWorkspace(workspace.id, workspace.hostId, event)
          }
        />
      ))}
    </>
  );
}

function IssueGroupBlock({
  group,
  selectedWorkspaceId,
  selectedWorkspaceHostId,
  onSelectWorkspace,
  onOpenWorkspaceActions,
  focusedWorkspaceId,
  registerWorkspaceRef,
}: {
  group: WorkspaceIssueGroup;
  selectedWorkspaceId: string | null;
  selectedWorkspaceHostId?: string | null;
  onSelectWorkspace: (
    id: string,
    hostId?: string | null,
    event?: MouseEvent<HTMLButtonElement>
  ) => void;
  onOpenWorkspaceActions: (workspaceId: string) => void;
  focusedWorkspaceId?: string | null;
  registerWorkspaceRef?: (id: string, node: HTMLDivElement | null) => void;
}) {
  const { header } = group;

  const rows = (
    <WorkspaceRows
      workspaces={group.workspaces}
      selectedWorkspaceId={selectedWorkspaceId}
      selectedWorkspaceHostId={selectedWorkspaceHostId}
      onSelectWorkspace={onSelectWorkspace}
      onOpenWorkspaceActions={onOpenWorkspaceActions}
      focusedWorkspaceId={focusedWorkspaceId}
      registerWorkspaceRef={registerWorkspaceRef}
    />
  );

  // Unlinked bucket: no issue heading, just the workspace rows.
  if (!header) {
    return <div className="flex flex-col gap-half">{rows}</div>;
  }

  return (
    <div className="mx-base rounded-sm border border-border/60 bg-panel/40 overflow-hidden">
      {/* Issue heading */}
      <div className="flex flex-col gap-half px-base py-half border-b border-border/60">
        {/* Project + display id */}
        <div className="flex items-center gap-half min-w-0 text-xs text-low">
          {header.projectColor && (
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: `hsl(${header.projectColor})` }}
            />
          )}
          <span className="truncate">{header.projectName}</span>
          <span className="text-low/50">·</span>
          <span className="font-ibm-plex-mono shrink-0">
            {header.displayId}
          </span>
        </div>

        {/* Title */}
        <span className="text-sm text-normal truncate">{header.title}</span>

        {/* Status + tags */}
        {(header.statusName || header.tags.length > 0) && (
          <div className="flex items-center gap-half flex-wrap">
            {header.statusName && (
              <KanbanBadge
                name={header.statusName}
                color={header.statusColor ?? undefined}
              />
            )}
            {header.tags.slice(0, 3).map((tag) => (
              <KanbanBadge
                key={tag.id}
                name={tag.name}
                color={tag.color ?? undefined}
              />
            ))}
            {header.tags.length > 3 && (
              <span className="text-xs text-low">
                +{header.tags.length - 3}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Workspaces nested inside the issue card */}
      <div className="flex flex-col gap-half py-half">{rows}</div>
    </div>
  );
}

export function WorkspacesIssueGroupedList({
  sections,
  groups,
  selectedWorkspaceId,
  selectedWorkspaceHostId,
  onSelectWorkspace,
  onOpenWorkspaceActions,
  focusedWorkspaceId,
  registerWorkspaceRef,
  sectionPersistPrefix,
  draftSlot,
  emptyLabel,
}: WorkspacesIssueGroupedListProps) {
  const { t } = useTranslation('common');

  const renderGroups = (items: WorkspaceIssueGroup[]) =>
    items.map((group) => (
      <IssueGroupBlock
        key={group.key}
        group={group}
        selectedWorkspaceId={selectedWorkspaceId}
        selectedWorkspaceHostId={selectedWorkspaceHostId}
        onSelectWorkspace={onSelectWorkspace}
        onOpenWorkspaceActions={onOpenWorkspaceActions}
        focusedWorkspaceId={focusedWorkspaceId}
        registerWorkspaceRef={registerWorkspaceRef}
      />
    ));

  // Status-accordion mode: one collapsible section per configured status.
  if (sections) {
    return (
      <div className="flex flex-col gap-base">
        {draftSlot}
        {sections.map((section) => {
          const count = section.groups.reduce(
            (sum, g) => sum + g.workspaces.length,
            0
          );
          return (
            <CollapsibleSectionHeader
              key={section.key}
              title={section.label}
              persistKey={`${sectionPersistPrefix}${section.key}`}
              defaultExpanded={true}
              headerExtra={<span className="text-xs text-low">{count}</span>}
            >
              <div className="flex flex-col gap-base py-half">
                {section.groups.length === 0 ? (
                  <span className="text-sm text-low opacity-60 pl-base">
                    {emptyLabel}
                  </span>
                ) : (
                  renderGroups(section.groups)
                )}
              </div>
            </CollapsibleSectionHeader>
          );
        })}
      </div>
    );
  }

  // Flat issue mode: just the issue groups, no status sections.
  return (
    <div className="flex flex-col gap-base">
      {draftSlot}
      {groups.length === 0 ? (
        <span className="text-sm text-low opacity-60 px-base">
          {t('workspaces.noWorkspaces', { defaultValue: emptyLabel })}
        </span>
      ) : (
        renderGroups(groups)
      )}
    </div>
  );
}
