'use client';

import type { MouseEvent } from 'react';
import { cn } from '../lib/cn';
import { KEYBOARD_CURSOR_RING } from '../lib/focus-ring';
import { Draggable } from '@hello-pangea/dnd';
import { DotsThreeIcon } from '@phosphor-icons/react';
import { PriorityIcon, type PriorityLevel } from './PriorityIcon';
import { StatusDot } from './StatusDot';
import { KanbanBadge } from './KanbanBadge';
import { KanbanAssignee, type KanbanAssigneeUser } from './KanbanAssignee';
import {
  RelationshipBadge,
  type RelationshipDisplayType,
} from './RelationshipBadge';
import { Checkbox } from './Checkbox';
import {
  IssueWorkspaceCard,
  type WorkspaceWithStats,
} from './IssueWorkspaceCard';

/**
 * Formats a date as a relative time string (e.g., "1d", "2h", "3m")
 */
function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays > 0) {
    return `${diffDays}d`;
  }
  if (diffHours > 0) {
    return `${diffHours}h`;
  }
  if (diffMinutes > 0) {
    return `${diffMinutes}m`;
  }
  return 'now';
}

const MAX_VISIBLE_TAGS = 2;

export interface IssueListRowIssue {
  id: string;
  simple_id: string;
  title: string;
  priority: PriorityLevel | null;
  created_at: string;
}

export interface IssueListRowTag {
  id: string;
  name: string;
  color: string;
}

export interface IssueListRowRelationship {
  relationshipId: string;
  displayType: RelationshipDisplayType;
  relatedIssueDisplayId: string;
}

export interface IssueListRowProps {
  issue: IssueListRowIssue;
  index: number;
  statusColor: string;
  tags: IssueListRowTag[];
  relationships?: IssueListRowRelationship[];
  assignees: KanbanAssigneeUser[];
  onClick: (e: MouseEvent) => void;
  isSelected: boolean;
  /** Keyboard-navigation cursor highlight (distinct from opened/checked). */
  isCursor?: boolean;
  isMultiSelectActive?: boolean;
  isChecked?: boolean;
  onCheckboxChange?: (checked: boolean) => void;
  /** Reports the row DOM node so the container can scroll it into view. */
  forwardedRef?: (node: HTMLDivElement | null) => void;
  /** Active workspaces linked to this issue, shown indented under the row. */
  workspaces?: WorkspaceWithStats[];
  onWorkspaceClick?: (issueId: string, workspace: WorkspaceWithStats) => void;
  /** Opens the issue actions menu (mirrors the kanban card's "…" button). */
  onMoreActionsClick?: (issueId: string) => void;
  className?: string;
}

export function IssueListRow({
  issue,
  index,
  statusColor,
  tags,
  relationships = [],
  assignees,
  onClick,
  isSelected,
  isCursor = false,
  isMultiSelectActive = false,
  isChecked = false,
  onCheckboxChange,
  forwardedRef,
  workspaces = [],
  onWorkspaceClick,
  onMoreActionsClick,
  className,
}: IssueListRowProps) {
  const showCheckbox = isMultiSelectActive || isChecked;
  const visibleTags = tags.slice(0, MAX_VISIBLE_TAGS);

  return (
    <Draggable draggableId={issue.id} index={index}>
      {(provided, snapshot) => (
        <div
          ref={(node) => {
            provided.innerRef(node);
            forwardedRef?.(node);
          }}
          {...provided.draggableProps}
          // The entire row is the drag handle — no separate grab affordance.
          {...provided.dragHandleProps}
          role="button"
          tabIndex={0}
          onClick={onClick}
          // Override the drag handle's keydown so keyboard DnD (space to lift)
          // doesn't shadow the board-level arrow navigation. Enter opens.
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onClick(e as unknown as MouseEvent);
            }
          }}
          className={cn(
            'group/row flex flex-col',
            'transition-colors cursor-pointer outline-none',
            isCursor && KEYBOARD_CURSOR_RING,
            snapshot.isDragging && 'bg-secondary shadow-lg cursor-grabbing',
            className
          )}
        >
          <div
            className={cn(
              'flex items-center justify-between gap-double px-double py-half',
              'transition-colors',
              !snapshot.isDragging && 'hover:bg-secondary',
              (isSelected || isChecked) && 'bg-secondary'
            )}
          >
            {/* Left side: Checkbox, Priority, ID, Status, Title */}
            <div className="flex items-center gap-double flex-1 min-w-0">
              {/* Multi-select checkbox — shown on hover or when selection is
                active. Pointer/touch starts are swallowed so grabbing the
                checkbox never begins a row drag. */}
              <div className="relative shrink-0 w-4 flex items-center justify-center">
                <div
                  className={cn(
                    'items-center justify-center',
                    showCheckbox ? 'flex' : 'hidden group-hover/row:flex'
                  )}
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                  onTouchStart={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <Checkbox
                    checked={isChecked}
                    onCheckedChange={(checked) => {
                      onCheckboxChange?.(checked);
                    }}
                  />
                </div>
              </div>
              <PriorityIcon priority={issue.priority} />
              <span className="font-ibm-plex-mono text-sm text-normal shrink-0">
                {issue.simple_id}
              </span>
              <StatusDot color={statusColor} />
              <span className="text-base text-high truncate">
                {issue.title}
              </span>
            </div>

            {/* Right side: Tags, Assignee, Age */}
            <div className="flex items-center gap-base shrink-0">
              {visibleTags.length > 0 && (
                <div className="flex items-center gap-half">
                  {visibleTags.map((tag) => (
                    <KanbanBadge
                      key={tag.id}
                      name={tag.name}
                      color={tag.color}
                    />
                  ))}
                </div>
              )}
              {relationships.length > 0 && (
                <div className="flex items-center gap-half">
                  {relationships.slice(0, 2).map((rel) => (
                    <RelationshipBadge
                      key={rel.relationshipId}
                      displayType={rel.displayType}
                      relatedIssueDisplayId={rel.relatedIssueDisplayId}
                      compact
                    />
                  ))}
                  {relationships.length > 2 && (
                    <span className="text-sm text-low">
                      +{relationships.length - 2}
                    </span>
                  )}
                </div>
              )}
              <KanbanAssignee assignees={assignees} />
              <span className="text-sm text-low w-5 text-right">
                {formatRelativeTime(issue.created_at)}
              </span>
              {/* Issue actions "…" — far right, on hover or when cursor-focused.
                  Pointer starts are swallowed so it never begins a row drag. */}
              {onMoreActionsClick && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onMoreActionsClick(issue.id);
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  onTouchStart={(e) => e.stopPropagation()}
                  className={cn(
                    'items-center justify-center size-icon-sm rounded-sm',
                    'text-low hover:text-normal hover:bg-panel transition-colors',
                    isCursor ? 'flex' : 'hidden group-hover/row:flex'
                  )}
                  aria-label="Issue actions"
                >
                  <DotsThreeIcon className="size-icon-xs" weight="bold" />
                </button>
              )}
            </div>
          </div>

          {/* Active workspaces linked to this issue. Pointer starts are
              swallowed so grabbing a workspace never begins a row drag; the
              card's own click opens the workspace (stops propagation). */}
          {workspaces.length > 0 && (
            <div
              className="flex flex-col gap-half pr-double pb-half pl-[3.25rem]"
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
            >
              {workspaces.map((workspace) => (
                <IssueWorkspaceCard
                  key={workspace.id}
                  workspace={workspace}
                  onClick={
                    workspace.localWorkspaceId
                      ? () => onWorkspaceClick?.(issue.id, workspace)
                      : undefined
                  }
                  showOwner={false}
                  showStatusBadge={false}
                  showNoPrText={false}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </Draggable>
  );
}
