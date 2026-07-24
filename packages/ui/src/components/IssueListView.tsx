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

export interface IssueListViewProps {
  statuses: IssueListSectionStatus[];
  items: Record<string, string[]>;
  issueMap: Record<string, IssueListRowIssue>;
  issueAssigneesMap: Record<string, KanbanAssigneeUser[]>;
  getTagObjectsForIssue: (issueId: string) => IssueListRowTag[];
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
  isMultiSelectActive?: boolean;
  onIssueCheckboxChange?: (issueId: string, checked: boolean) => void;
  /** Status IDs that are currently collapsed (default: expanded). */
  collapsedStatusIds?: Set<string>;
  onToggleStatusCollapsed?: (statusId: string) => void;
  /** Creates an issue in a status from that group's inline "+ Add item" row. */
  onAddIssue?: (statusId: string, title: string) => void;
  className?: string;
}

export function IssueListView({
  statuses,
  items,
  issueMap,
  issueAssigneesMap,
  getTagObjectsForIssue,
  getResolvedRelationshipsForIssue,
  onIssueClick,
  selectedIssueId,
  selectedIssueIds,
  cursorIssueId,
  onRowRef,
  isMultiSelectActive,
  onIssueCheckboxChange,
  collapsedStatusIds,
  onToggleStatusCollapsed,
  onAddIssue,
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
          getResolvedRelationshipsForIssue={getResolvedRelationshipsForIssue}
          onIssueClick={onIssueClick}
          selectedIssueId={selectedIssueId}
          selectedIssueIds={selectedIssueIds}
          cursorIssueId={cursorIssueId}
          onRowRef={onRowRef}
          isMultiSelectActive={isMultiSelectActive}
          onIssueCheckboxChange={onIssueCheckboxChange}
          isExpanded={!collapsedStatusIds?.has(status.id)}
          onToggleExpanded={() => onToggleStatusCollapsed?.(status.id)}
          onAddIssue={
            onAddIssue ? (title) => onAddIssue(status.id, title) : undefined
          }
        />
      ))}
    </div>
  );
}
