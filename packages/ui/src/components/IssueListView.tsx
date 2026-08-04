'use client';

import type { MouseEvent } from 'react';
import { cn } from '../lib/cn';
import type { KanbanAssigneeUser } from './KanbanAssignee';
import {
  IssueListSection,
  type IssueListSectionStatus,
} from './IssueListSection';
import type {
  IssueListRowIssue,
  IssueListRowRelationship,
  IssueListRowTag,
} from './IssueListRow';
import type { WorkspaceWithStats } from './IssueWorkspaceCard';

export interface IssueListViewProps {
  statuses: IssueListSectionStatus[];
  items: Record<string, string[]>;
  issueMap: Record<string, IssueListRowIssue>;
  issueAssigneesMap: Record<string, KanbanAssigneeUser[]>;
  getTagObjectsForIssue: (issueId: string) => IssueListRowTag[];
  getMilestoneForIssue?: (
    issueId: string
  ) => { name: string; targetDate?: string | null } | undefined;
  getResolvedRelationshipsForIssue?: (
    issueId: string
  ) => IssueListRowRelationship[];
  onIssueClick: (issueId: string, e: MouseEvent) => void;
  selectedIssueId: string | null;
  selectedIssueIds?: Set<string>;
  /** Keyboard-navigation cursor. */
  cursorIssueId?: string | null;
  /** Reports each row's DOM node for scroll-into-view. */
  onRowRef?: (issueId: string, node: HTMLDivElement | null) => void;
  /** Status id whose group header currently holds the keyboard focus. */
  focusedSectionId?: string | null;
  /** Reports each group header's DOM node for scroll-into-view / focus. */
  onHeaderRef?: (statusId: string, node: HTMLButtonElement | null) => void;
  isMultiSelectActive?: boolean;
  onIssueCheckboxChange?: (issueId: string, checked: boolean) => void;
  /** Active workspaces linked to each issue, keyed by issue id. */
  workspacesByIssueId?: Map<string, WorkspaceWithStats[]>;
  onWorkspaceClick?: (issueId: string, workspace: WorkspaceWithStats) => void;
  /** Opens the issue actions menu for a row's "…" button. */
  onMoreActionsClick?: (issueId: string) => void;
  /** Status IDs that are currently collapsed (default: expanded). */
  collapsedStatusIds?: Set<string>;
  onToggleStatusCollapsed?: (statusId: string) => void;
  /** Creates an issue in a status from that group's inline "+ Add item" row. */
  onAddIssue?: (statusId: string, title: string) => void;
  /** Status id whose "+ Add item" row currently holds keyboard focus. */
  focusedAddStatusId?: string | null;
  /** Status id whose "+ Add item" row is currently in edit (input) mode. */
  editingAddStatusId?: string | null;
  /** Enter edit mode for a status's add row. */
  onStartAddEditing?: (statusId: string) => void;
  /** Leave edit mode; `refocus` keeps the add-row button keyboard-focused. */
  onStopAddEditing?: (statusId: string, refocus: boolean) => void;
  /** Reports each add-row button's DOM node for scroll-into-view / focus. */
  onAddRowRef?: (statusId: string, node: HTMLButtonElement | null) => void;
  className?: string;
}

export function IssueListView({
  statuses,
  items,
  issueMap,
  issueAssigneesMap,
  getTagObjectsForIssue,
  getMilestoneForIssue,
  getResolvedRelationshipsForIssue,
  onIssueClick,
  selectedIssueId,
  selectedIssueIds,
  cursorIssueId,
  onRowRef,
  focusedSectionId,
  onHeaderRef,
  isMultiSelectActive,
  onIssueCheckboxChange,
  workspacesByIssueId,
  onWorkspaceClick,
  onMoreActionsClick,
  collapsedStatusIds,
  onToggleStatusCollapsed,
  onAddIssue,
  focusedAddStatusId,
  editingAddStatusId,
  onStartAddEditing,
  onStopAddEditing,
  onAddRowRef,
  className,
}: IssueListViewProps) {
  return (
    <div className={cn('flex flex-col h-full overflow-y-auto', className)}>
      {statuses.map((status) => (
        <IssueListSection
          key={status.id}
          status={status}
          issueIds={items[status.id] ?? []}
          issueMap={issueMap}
          issueAssigneesMap={issueAssigneesMap}
          getTagObjectsForIssue={getTagObjectsForIssue}
          getMilestoneForIssue={getMilestoneForIssue}
          getResolvedRelationshipsForIssue={getResolvedRelationshipsForIssue}
          onIssueClick={onIssueClick}
          selectedIssueId={selectedIssueId}
          selectedIssueIds={selectedIssueIds}
          cursorIssueId={cursorIssueId}
          onRowRef={onRowRef}
          isFocused={focusedSectionId === status.id}
          onHeaderRef={onHeaderRef}
          isMultiSelectActive={isMultiSelectActive}
          onIssueCheckboxChange={onIssueCheckboxChange}
          workspacesByIssueId={workspacesByIssueId}
          onWorkspaceClick={onWorkspaceClick}
          onMoreActionsClick={onMoreActionsClick}
          isExpanded={!collapsedStatusIds?.has(status.id)}
          onToggleExpanded={() => onToggleStatusCollapsed?.(status.id)}
          onAddIssue={
            onAddIssue ? (title) => onAddIssue(status.id, title) : undefined
          }
          addRowFocused={focusedAddStatusId === status.id}
          addRowEditing={editingAddStatusId === status.id}
          onStartAddEditing={
            onStartAddEditing ? () => onStartAddEditing(status.id) : undefined
          }
          onStopAddEditing={
            onStopAddEditing
              ? (refocus) => onStopAddEditing(status.id, refocus)
              : undefined
          }
          onAddRowRef={
            onAddRowRef ? (node) => onAddRowRef(status.id, node) : undefined
          }
        />
      ))}
    </div>
  );
}
