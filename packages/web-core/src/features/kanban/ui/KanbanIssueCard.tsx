import { memo, useMemo, type MouseEvent } from 'react';
import { KanbanCard } from '@vibe/ui/components/KanbanBoard';
import {
  KanbanCardContent,
  type KanbanGithubIssue,
  type TagEditRenderProps,
} from '@vibe/ui/components/KanbanCardContent';
import {
  IssueWorkspaceCard,
  type WorkspaceWithStats,
} from '@vibe/ui/components/IssueWorkspaceCard';
import { SearchableTagDropdownContainer } from '@/shared/components/SearchableTagDropdownContainer';
import type { ResolvedRelationship } from '@/shared/lib/resolveRelationships';
import type { OrganizationMemberWithProfile } from 'shared/types';
import type {
  Issue,
  IssueTag,
  ProjectMilestone,
  PullRequest,
  Tag,
} from 'shared/remote-types';

export interface KanbanIssueCardProps {
  issue: Issue;
  index: number;
  projectId: string;
  isOpen: boolean;
  isSelected: boolean;
  isFocused: boolean;
  isMobile: boolean;
  dragDisabled: boolean;
  tags: Tag[];
  allTags: Tag[];
  issueTags: IssueTag[];
  assignees: OrganizationMemberWithProfile[];
  milestone: ProjectMilestone | undefined;
  pullRequests: PullRequest[];
  githubIssues: KanbanGithubIssue[];
  relationships: ResolvedRelationship[];
  workspaces: WorkspaceWithStats[];
  onCardClick: (issueId: string, e?: MouseEvent) => void;
  onPriorityClick: (issueId: string) => void;
  onAssigneeClick: (issueId: string) => void;
  onMoreActionsClick: (issueId: string) => void;
  onOpenInSplitPane: (url: string) => void;
  onTagToggle: (
    issueId: string,
    tagId: string,
    existingIssueTagId?: string
  ) => void;
  onCreateTag: (data: { name: string; color: string }) => string;
  onWorkspaceClick: (
    issueId: string,
    workspaceAttemptId: string,
    ownerHostId?: string | null
  ) => void;
  onCardRef: (issueId: string, node: HTMLDivElement | null) => void;
}

const renderTagEditor = ({
  allTags,
  selectedTagIds,
  onTagToggle,
  onCreateTag,
  trigger,
}: TagEditRenderProps<Tag>) => (
  <SearchableTagDropdownContainer
    tags={allTags}
    selectedTagIds={selectedTagIds}
    onTagToggle={onTagToggle}
    onCreateTag={onCreateTag}
    disabled={false}
    contentClassName=""
    trigger={trigger}
  />
);

/**
 * One kanban card. Memoized so that a shape update touching other issues (or
 * shapes the card doesn't show) leaves it alone: the container hands every
 * prop over from per-issue lookups that keep their identity while this
 * issue's rows are unchanged.
 */
export const KanbanIssueCard = memo(function KanbanIssueCard({
  issue,
  index,
  projectId,
  isOpen,
  isSelected,
  isFocused,
  isMobile,
  dragDisabled,
  tags,
  allTags,
  issueTags,
  assignees,
  milestone,
  pullRequests,
  githubIssues,
  relationships,
  workspaces,
  onCardClick,
  onPriorityClick,
  onAssigneeClick,
  onMoreActionsClick,
  onOpenInSplitPane,
  onTagToggle,
  onCreateTag,
  onWorkspaceClick,
  onCardRef,
}: KanbanIssueCardProps) {
  // A PR already visible under one of the issue's workspace cards is not
  // repeated at the issue level.
  const issuePullRequests = useMemo(() => {
    if (workspaces.length === 0) return pullRequests;
    const shown = new Set(workspaces.map((workspace) => workspace.id));
    return pullRequests.filter(
      (pr) => !pr.workspace_id || !shown.has(pr.workspace_id)
    );
  }, [pullRequests, workspaces]);

  const selectedTagIds = useMemo(
    () => issueTags.map((issueTag) => issueTag.tag_id),
    [issueTags]
  );

  return (
    <KanbanCard
      id={issue.id}
      name={issue.title}
      index={index}
      className="group scroll-mt-10"
      onClick={(e) => onCardClick(issue.id, e)}
      isOpen={isOpen}
      isMobile={isMobile}
      isSelected={isSelected}
      isFocused={isFocused}
      forwardedRef={(node) => onCardRef(issue.id, node)}
      dragDisabled={dragDisabled}
    >
      <KanbanCardContent
        displayId={issue.simple_id}
        title={issue.title}
        description={issue.description}
        priority={issue.priority}
        milestone={
          milestone
            ? { name: milestone.name, targetDate: milestone.target_date }
            : null
        }
        tags={tags}
        assignees={assignees}
        pullRequests={issuePullRequests}
        githubIssues={githubIssues}
        relationships={relationships}
        isSubIssue={!!issue.parent_issue_id}
        isMobile={isMobile}
        onPriorityClick={(e) => {
          e.stopPropagation();
          onPriorityClick(issue.id);
        }}
        onAssigneeClick={(e) => {
          e.stopPropagation();
          onAssigneeClick(issue.id);
        }}
        onOpenInNewTabClick={() =>
          onOpenInSplitPane(
            `/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issue.id)}`
          )
        }
        onMoreActionsClick={() => onMoreActionsClick(issue.id)}
        tagEditProps={{
          allTags,
          selectedTagIds,
          onTagToggle: (tagId) =>
            onTagToggle(
              issue.id,
              tagId,
              issueTags.find((issueTag) => issueTag.tag_id === tagId)?.id
            ),
          onCreateTag,
          renderTagEditor,
        }}
      />
      {workspaces.length > 0 && (
        <div className="mt-base flex flex-col gap-half">
          {workspaces.map((workspace) => (
            <IssueWorkspaceCard
              key={workspace.id}
              workspace={workspace}
              onClick={
                workspace.localWorkspaceId
                  ? () =>
                      onWorkspaceClick(
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
});
