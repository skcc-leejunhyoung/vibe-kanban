import { useMemo } from 'react';
import {
  KANBAN_ASSIGNEE_FILTER_VALUES,
  KANBAN_MILESTONE_FILTER_VALUES,
  type KanbanFilterState,
} from '@/shared/stores/useUiPreferencesStore';
import type {
  Issue,
  IssueAssignee,
  IssueRelationship,
  IssueTag,
  IssuePriority,
  IssueMilestone,
  ProjectMilestone,
} from 'shared/remote-types';
import { fuzzySearchMatchAny } from '@vibe/ui/lib/search';
import {
  evaluateNode,
  type IssueFilterFacts,
} from '@/shared/filters/filterTree';

type UseKanbanFiltersParams = {
  issues: Issue[];
  issueAssignees: IssueAssignee[];
  issueTags: IssueTag[];
  issueMilestones: IssueMilestone[];
  milestones: ProjectMilestone[];
  issueRelationships: IssueRelationship[];
  issuesById: Map<string, Issue>;
  doneStatusIds: Set<string>;
  filters: KanbanFilterState;
  showSubIssues: boolean;
  hideBlocked: boolean;
  currentUserId: string | null;
};

type UseKanbanFiltersResult = {
  filteredIssues: Issue[];
};

export const PRIORITY_ORDER: Record<IssuePriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export function matchesIssueSearch(
  issue: Pick<Issue, 'title' | 'description' | 'simple_id' | 'issue_number'>,
  query: string
): boolean {
  return fuzzySearchMatchAny(
    [
      issue.title,
      issue.description,
      issue.simple_id,
      String(issue.issue_number),
    ],
    query
  );
}

export function matchesMilestoneFilters(
  milestone:
    | Pick<ProjectMilestone, 'id' | 'target_date' | 'completed_at'>
    | undefined,
  selectedIds: string[],
  overdue: boolean,
  now = Date.now()
): boolean {
  const includeUnassigned = selectedIds.includes(
    KANBAN_MILESTONE_FILTER_VALUES.NONE
  );
  const actualIds = selectedIds.filter(
    (id) => id !== KANBAN_MILESTONE_FILTER_VALUES.NONE
  );
  if (
    selectedIds.length > 0 &&
    !(
      (!milestone && includeUnassigned) ||
      (milestone && actualIds.includes(milestone.id))
    )
  ) {
    return false;
  }
  if (!overdue) return true;
  return Boolean(
    milestone?.target_date &&
      !milestone.completed_at &&
      Date.parse(milestone.target_date) < now
  );
}

export function useKanbanFilters({
  issues,
  issueAssignees,
  issueTags,
  issueMilestones,
  milestones,
  issueRelationships,
  issuesById,
  doneStatusIds,
  filters,
  showSubIssues,
  hideBlocked,
  currentUserId,
}: UseKanbanFiltersParams): UseKanbanFiltersResult {
  // Create lookup maps for efficient filtering
  const assigneesByIssue = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const ia of issueAssignees) {
      if (!map[ia.issue_id]) {
        map[ia.issue_id] = [];
      }
      map[ia.issue_id].push(ia.user_id);
    }
    return map;
  }, [issueAssignees]);

  const tagsByIssue = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const it of issueTags) {
      if (!map[it.issue_id]) {
        map[it.issue_id] = [];
      }
      map[it.issue_id].push(it.tag_id);
    }
    return map;
  }, [issueTags]);

  const milestoneByIssue = useMemo(
    () =>
      new Map(
        issueMilestones.map((item) => [item.issue_id, item.milestone_id])
      ),
    [issueMilestones]
  );
  const milestonesById = useMemo(
    () => new Map(milestones.map((item) => [item.id, item])),
    [milestones]
  );

  // Filter issues
  const filteredIssues = useMemo(() => {
    let result = issues;

    // Filter sub-issues based on per-project preference
    if (!showSubIssues) {
      result = result.filter((issue) => issue.parent_issue_id === null);
    }

    const advancedFilter = filters.advancedFilter ?? null;

    // Set of issue ids blocked by an unresolved (non-done) blocker. Shared by
    // the `hideBlocked` toggle and the advanced `blocked` filter field.
    const blockedIssueIds = new Set<string>();
    if (hideBlocked || advancedFilter) {
      for (const r of issueRelationships) {
        if (r.relationship_type !== 'blocking') continue;
        const blockingIssue = issuesById.get(r.issue_id);
        if (blockingIssue == null) continue;
        if (!doneStatusIds.has(blockingIssue.status_id)) {
          blockedIssueIds.add(r.related_issue_id);
        }
      }
    }

    if (advancedFilter) {
      // Advanced mode: the nested tree supersedes the flat filter fields.
      const now = Date.now();
      const factsFor = (issue: Issue): IssueFilterFacts => {
        const milestoneId = milestoneByIssue.get(issue.id) ?? null;
        const milestone = milestoneId
          ? milestonesById.get(milestoneId)
          : undefined;
        const isMilestoneOverdue = Boolean(
          milestone?.target_date &&
            !milestone.completed_at &&
            Date.parse(milestone.target_date) < now
        );
        return {
          statusId: issue.status_id,
          priority: issue.priority,
          assigneeUserIds: assigneesByIssue[issue.id] ?? [],
          tagIds: tagsByIssue[issue.id] ?? [],
          milestoneId,
          isMilestoneOverdue,
          isBlocked: blockedIssueIds.has(issue.id),
          text: {
            title: issue.title,
            description: issue.description,
            simpleId: issue.simple_id,
            issueNumber: issue.issue_number,
          },
        };
      };
      result = result.filter((issue) =>
        evaluateNode(advancedFilter, factsFor(issue), { currentUserId })
      );
    } else {
      // Simple mode: flat fields, AND across categories / OR within each.

      // Text search (title + body + short ID)
      const query = filters.searchQuery.trim();
      if (query) {
        result = result.filter((issue) => matchesIssueSearch(issue, query));
      }

      // Priority filter (OR within)
      if (filters.priorities.length > 0) {
        result = result.filter(
          (issue) =>
            issue.priority !== null &&
            filters.priorities.includes(issue.priority)
        );
      }

      // Assignee filter (OR within)
      if (filters.assigneeIds.length > 0) {
        const includeUnassigned = filters.assigneeIds.includes(
          KANBAN_ASSIGNEE_FILTER_VALUES.UNASSIGNED
        );
        const selectedAssigneeIds = new Set(
          filters.assigneeIds.flatMap((assigneeId) => {
            if (assigneeId === KANBAN_ASSIGNEE_FILTER_VALUES.SELF) {
              return currentUserId ? [currentUserId] : [];
            }
            if (assigneeId === KANBAN_ASSIGNEE_FILTER_VALUES.UNASSIGNED) {
              return [];
            }
            return [assigneeId];
          })
        );

        result = result.filter((issue) => {
          const issueAssigneeIds = assigneesByIssue[issue.id] ?? [];

          // Check for 'unassigned' special case
          if (includeUnassigned) {
            if (issueAssigneeIds.length === 0) return true;
          }

          // Check if any of the issue's assignees match the filter
          return issueAssigneeIds.some((assigneeId) =>
            selectedAssigneeIds.has(assigneeId)
          );
        });
      }

      // Tags filter (OR within)
      if (filters.tagIds.length > 0) {
        result = result.filter((issue) => {
          const issueTagIds = tagsByIssue[issue.id] ?? [];
          return issueTagIds.some((tagId) => filters.tagIds.includes(tagId));
        });
      }

      if ((filters.milestoneIds ?? []).length > 0 || filters.overdue) {
        result = result.filter((issue) => {
          const milestoneId = milestoneByIssue.get(issue.id);
          const milestone = milestoneId
            ? milestonesById.get(milestoneId)
            : undefined;
          return matchesMilestoneFilters(
            milestone,
            filters.milestoneIds ?? [],
            filters.overdue ?? false
          );
        });
      }
    }

    // Hide blocked: filter out issues that are blocked by an unresolved issue.
    // Applied in both modes as an orthogonal board toggle.
    if (hideBlocked) {
      result = result.filter((issue) => !blockedIssueIds.has(issue.id));
    }

    // Note: Sorting is handled in KanbanContainer after grouping by status
    // so that sort order is applied within each column

    return result;
  }, [
    issues,
    filters,
    assigneesByIssue,
    tagsByIssue,
    milestoneByIssue,
    milestonesById,
    showSubIssues,
    hideBlocked,
    issueRelationships,
    issuesById,
    doneStatusIds,
    currentUserId,
  ]);

  return {
    filteredIssues,
  };
}
