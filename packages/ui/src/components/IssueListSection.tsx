'use client';

import {
  useCallback,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';
import { Droppable } from '@hello-pangea/dnd';
import { CaretDownIcon, PlusIcon } from '@phosphor-icons/react';
import { StatusDot } from './StatusDot';
import { KanbanBadge } from './KanbanBadge';
import {
  IssueListRow,
  type IssueListRowIssue,
  type IssueListRowTag,
  type IssueListRowRelationship,
} from './IssueListRow';
import type { KanbanAssigneeUser } from './KanbanAssignee';
import type { WorkspaceWithStats } from './IssueWorkspaceCard';

export interface IssueListSectionStatus {
  id: string;
  name: string;
  color: string;
}

export interface IssueListSectionProps {
  status: IssueListSectionStatus;
  issueIds: string[];
  issueMap: Record<string, IssueListRowIssue>;
  issueAssigneesMap: Record<string, KanbanAssigneeUser[]>;
  getTagObjectsForIssue: (issueId: string) => IssueListRowTag[];
  getResolvedRelationshipsForIssue?: (
    issueId: string
  ) => IssueListRowRelationship[];
  onIssueClick: (issueId: string, e: MouseEvent) => void;
  selectedIssueId: string | null;
  selectedIssueIds?: Set<string>;
  /** Keyboard-navigation cursor (distinct from the opened issue). */
  cursorIssueId?: string | null;
  /** Reports each row's DOM node for scroll-into-view / focus management. */
  onRowRef?: (issueId: string, node: HTMLDivElement | null) => void;
  /** Whether this group header currently holds the keyboard focus. */
  isFocused?: boolean;
  /** Reports the header button's DOM node for scroll-into-view / focus. */
  onHeaderRef?: (statusId: string, node: HTMLButtonElement | null) => void;
  isMultiSelectActive?: boolean;
  onIssueCheckboxChange?: (issueId: string, checked: boolean) => void;
  /** Active workspaces linked to each issue, keyed by issue id. */
  workspacesByIssueId?: Map<string, WorkspaceWithStats[]>;
  onWorkspaceClick?: (issueId: string, workspace: WorkspaceWithStats) => void;
  /** Controlled expand/collapse. */
  isExpanded: boolean;
  onToggleExpanded: () => void;
  /**
   * Creates a new issue in this status from the inline "+ Add item" row.
   * When omitted the add row is not rendered.
   */
  onAddIssue?: (title: string) => void;
  className?: string;
}

export function IssueListSection({
  status,
  issueIds,
  issueMap,
  issueAssigneesMap,
  getTagObjectsForIssue,
  getResolvedRelationshipsForIssue,
  onIssueClick,
  selectedIssueId,
  selectedIssueIds,
  cursorIssueId,
  onRowRef,
  isFocused = false,
  onHeaderRef,
  isMultiSelectActive,
  onIssueCheckboxChange,
  workspacesByIssueId,
  onWorkspaceClick,
  isExpanded,
  onToggleExpanded,
  onAddIssue,
  className,
}: IssueListSectionProps) {
  return (
    <div className={cn('flex flex-col', className)}>
      {/* Section Header */}
      <button
        type="button"
        ref={(node) => onHeaderRef?.(status.id, node)}
        onClick={onToggleExpanded}
        className={cn(
          'flex items-center justify-between',
          'h-8 px-double py-base',
          'bg-panel border-y border-border',
          'cursor-pointer transition-colors outline-none',
          'hover:bg-secondary',
          isFocused && 'ring-1 ring-inset ring-brand'
        )}
      >
        <div className="flex items-center gap-base">
          <CaretDownIcon
            className={cn(
              'size-icon-xs text-low transition-transform',
              !isExpanded && '-rotate-90'
            )}
            weight="bold"
          />
          <StatusDot color={status.color} />
          <span className="text-base font-medium text-high">{status.name}</span>
        </div>
        <KanbanBadge name={String(issueIds.length)} />
      </button>

      {/* Section Content - Droppable area */}
      <Droppable droppableId={status.id}>
        {(provided) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className="flex flex-col min-h-8"
          >
            {isExpanded &&
              issueIds.map((issueId, index) => {
                const issue = issueMap[issueId];
                if (!issue) return null;

                return (
                  <IssueListRow
                    key={issue.id}
                    issue={issue}
                    index={index}
                    statusColor={status.color}
                    tags={getTagObjectsForIssue(issue.id)}
                    relationships={getResolvedRelationshipsForIssue?.(issue.id)}
                    assignees={issueAssigneesMap[issue.id] ?? []}
                    onClick={(e) => onIssueClick(issue.id, e)}
                    isSelected={selectedIssueId === issue.id}
                    isCursor={cursorIssueId === issue.id}
                    isMultiSelectActive={isMultiSelectActive}
                    isChecked={selectedIssueIds?.has(issue.id)}
                    onCheckboxChange={(checked) =>
                      onIssueCheckboxChange?.(issue.id, checked)
                    }
                    forwardedRef={(node) => onRowRef?.(issue.id, node)}
                    workspaces={workspacesByIssueId?.get(issue.id)}
                    onWorkspaceClick={onWorkspaceClick}
                  />
                );
              })}
            {provided.placeholder}
            {isExpanded && onAddIssue && (
              <IssueListAddRow onAddIssue={onAddIssue} />
            )}
          </div>
        )}
      </Droppable>
    </div>
  );
}

/**
 * Inline "+ Add item" row rendered at the bottom of an expanded group. Clicking
 * it swaps in a title input; pressing Enter creates the issue immediately (with
 * an empty body) and keeps the input open for rapid entry. Escape or blur exits.
 */
function IssueListAddRow({
  onAddIssue,
}: {
  onAddIssue: (title: string) => void;
}) {
  const { t } = useTranslation('common');
  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = useCallback(() => {
    const trimmed = title.trim();
    if (!trimmed) return;
    onAddIssue(trimmed);
    setTitle('');
    // Keep focus for rapid successive entry.
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [title, onAddIssue]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setTitle('');
        setIsEditing(false);
      }
    },
    [submit]
  );

  if (!isEditing) {
    return (
      <button
        type="button"
        onClick={() => {
          setIsEditing(true);
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
        className={cn(
          'group/add flex items-center gap-double px-double py-half',
          'text-low hover:bg-secondary hover:text-normal transition-colors'
        )}
      >
        <span className="shrink-0 w-4 flex items-center justify-center">
          <PlusIcon className="size-icon-xs" weight="bold" />
        </span>
        <span className="text-base">{t('kanban.addItem', 'Add item')}</span>
      </button>
    );
  }

  return (
    <div className="flex items-center gap-double px-double py-half bg-secondary">
      <span className="shrink-0 w-4 flex items-center justify-center text-low">
        <PlusIcon className="size-icon-xs" weight="bold" />
      </span>
      <input
        ref={inputRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          setTitle('');
          setIsEditing(false);
        }}
        placeholder={t('kanban.addItemPlaceholder', 'Issue title…')}
        className={cn(
          'flex-1 min-w-0 bg-transparent text-base text-high',
          'placeholder:text-low focus:outline-none'
        )}
      />
    </div>
  );
}
