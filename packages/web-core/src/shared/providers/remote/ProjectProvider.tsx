import { useMemo, useCallback, type ReactNode } from 'react';
import { useShape } from '@/shared/integrations/electric/hooks';
import {
  groupBy,
  useGroupedBy,
  useStableGroups,
} from '@/shared/lib/stableGroups';
import {
  PROJECT_ISSUES_SHAPE,
  PROJECT_PROJECT_STATUSES_SHAPE,
  PROJECT_TAGS_SHAPE,
  PROJECT_MILESTONES_SHAPE,
  PROJECT_ISSUE_MILESTONES_SHAPE,
  PROJECT_ISSUE_ASSIGNEES_SHAPE,
  PROJECT_ISSUE_TAGS_SHAPE,
  PROJECT_ISSUE_RELATIONSHIPS_SHAPE,
  PROJECT_PULL_REQUESTS_SHAPE,
  PROJECT_PULL_REQUEST_ISSUES_SHAPE,
  PROJECT_GITHUB_ISSUE_LINKS_SHAPE,
  PROJECT_WORKSPACES_SHAPE,
  ISSUE_MUTATION,
  PROJECT_STATUS_MUTATION,
  TAG_MUTATION,
  PROJECT_MILESTONE_MUTATION,
  ISSUE_MILESTONE_MUTATION,
  ISSUE_ASSIGNEE_MUTATION,
  ISSUE_TAG_MUTATION,
  ISSUE_RELATIONSHIP_MUTATION,
  PULL_REQUEST_ISSUE_MUTATION,
  GITHUB_ISSUE_LINK_MUTATION,
  type Issue,
  type IssueRelationship,
  type ProjectStatus,
  type PullRequest,
  type Tag,
  type ProjectMilestone,
  type Workspace,
} from 'shared/remote-types';
import {
  ProjectContext,
  type ProjectContextValue,
  type ProjectGithubIssueLink,
} from '@/shared/hooks/useProjectContext';

interface ProjectProviderProps {
  projectId: string;
  children: ReactNode;
}

/** Shared result for lookups with no rows, so callers can memoize on it. */
const EMPTY: never[] = [];

const byIssueId = (row: { issue_id: string | null }) => row.issue_id;
const byStatusId = (row: Issue) => row.status_id;
const byRelatedIssueIds = (row: IssueRelationship) => [
  row.issue_id,
  row.related_issue_id,
];

export function ProjectProvider({ projectId, children }: ProjectProviderProps) {
  const params = useMemo(() => ({ project_id: projectId }), [projectId]);
  const enabled = Boolean(projectId);

  // Shape subscriptions (with mutations where needed). Issue followers are
  // not subscribed: nothing in the UI reads them.
  const issuesResult = useShape(PROJECT_ISSUES_SHAPE, params, {
    enabled,
    mutation: ISSUE_MUTATION,
  });
  const statusesResult = useShape(PROJECT_PROJECT_STATUSES_SHAPE, params, {
    enabled,
    mutation: PROJECT_STATUS_MUTATION,
  });
  const tagsResult = useShape(PROJECT_TAGS_SHAPE, params, {
    enabled,
    mutation: TAG_MUTATION,
  });
  const milestonesResult = useShape(PROJECT_MILESTONES_SHAPE, params, {
    enabled,
    mutation: PROJECT_MILESTONE_MUTATION,
  });
  const issueMilestonesResult = useShape(
    PROJECT_ISSUE_MILESTONES_SHAPE,
    params,
    { enabled, mutation: ISSUE_MILESTONE_MUTATION }
  );
  const issueAssigneesResult = useShape(PROJECT_ISSUE_ASSIGNEES_SHAPE, params, {
    enabled,
    mutation: ISSUE_ASSIGNEE_MUTATION,
  });
  const issueTagsResult = useShape(PROJECT_ISSUE_TAGS_SHAPE, params, {
    enabled,
    mutation: ISSUE_TAG_MUTATION,
  });
  const issueRelationshipsResult = useShape(
    PROJECT_ISSUE_RELATIONSHIPS_SHAPE,
    params,
    { enabled, mutation: ISSUE_RELATIONSHIP_MUTATION }
  );
  const pullRequestsResult = useShape(PROJECT_PULL_REQUESTS_SHAPE, params, {
    enabled,
  });
  const pullRequestIssuesResult = useShape(
    PROJECT_PULL_REQUEST_ISSUES_SHAPE,
    params,
    { enabled, mutation: PULL_REQUEST_ISSUE_MUTATION }
  );
  const githubIssueLinksResult = useShape(
    PROJECT_GITHUB_ISSUE_LINKS_SHAPE,
    params,
    { enabled, mutation: GITHUB_ISSUE_LINK_MUTATION }
  );
  const workspacesResult = useShape(PROJECT_WORKSPACES_SHAPE, params, {
    enabled,
  });

  // Board readiness depends on core kanban data only.
  // Other project-scoped shapes hydrate opportunistically after render.
  const isLoading = issuesResult.isLoading || statusesResult.isLoading;

  // First error found
  const error =
    issuesResult.error ||
    statusesResult.error ||
    tagsResult.error ||
    milestonesResult.error ||
    issueMilestonesResult.error ||
    issueAssigneesResult.error ||
    issueTagsResult.error ||
    issueRelationshipsResult.error ||
    pullRequestsResult.error ||
    pullRequestIssuesResult.error ||
    githubIssueLinksResult.error ||
    workspacesResult.error ||
    null;

  // Combined retry
  const retry = useCallback(() => {
    issuesResult.retry();
    statusesResult.retry();
    tagsResult.retry();
    milestonesResult.retry();
    issueMilestonesResult.retry();
    issueAssigneesResult.retry();
    issueTagsResult.retry();
    issueRelationshipsResult.retry();
    pullRequestsResult.retry();
    pullRequestIssuesResult.retry();
    githubIssueLinksResult.retry();
    workspacesResult.retry();
  }, [
    issuesResult,
    statusesResult,
    tagsResult,
    milestonesResult,
    issueMilestonesResult,
    issueAssigneesResult,
    issueTagsResult,
    issueRelationshipsResult,
    pullRequestsResult,
    pullRequestIssuesResult,
    githubIssueLinksResult,
    workspacesResult,
  ]);

  // Computed Maps for O(1) lookup
  const issuesById = useMemo(() => {
    const map = new Map<string, Issue>();
    for (const issue of issuesResult.data) {
      map.set(issue.id, issue);
    }
    return map;
  }, [issuesResult.data]);

  const statusesById = useMemo(() => {
    const map = new Map<string, ProjectStatus>();
    for (const status of statusesResult.data) {
      map.set(status.id, status);
    }
    return map;
  }, [statusesResult.data]);

  const tagsById = useMemo(() => {
    const map = new Map<string, Tag>();
    for (const tag of tagsResult.data) {
      map.set(tag.id, tag);
    }
    return map;
  }, [tagsResult.data]);

  const milestonesById = useMemo(() => {
    const map = new Map<string, ProjectMilestone>();
    for (const milestone of milestonesResult.data)
      map.set(milestone.id, milestone);
    return map;
  }, [milestonesResult.data]);

  // Per-issue groups, rebuilt only when their own shape changes.
  const issuesByStatusId = useGroupedBy(issuesResult.data, byStatusId);
  const assigneesByIssueId = useGroupedBy(issueAssigneesResult.data, byIssueId);
  const issueTagsByIssueId = useGroupedBy(issueTagsResult.data, byIssueId);
  const issueMilestonesByIssueId = useGroupedBy(
    issueMilestonesResult.data,
    byIssueId
  );
  const relationshipsByIssueId = useGroupedBy(
    issueRelationshipsResult.data,
    byRelatedIssueIds
  );
  const workspacesByIssueId = useGroupedBy(workspacesResult.data, byIssueId);

  const tagObjectsByIssueId = useStableGroups(
    useMemo(() => {
      const map = new Map<string, Tag[]>();
      for (const [issueId, links] of issueTagsByIssueId) {
        map.set(
          issueId,
          links
            .map((link) => tagsById.get(link.tag_id))
            .filter((tag): tag is Tag => tag !== undefined)
        );
      }
      return map;
    }, [issueTagsByIssueId, tagsById])
  );

  const milestoneByIssueId = useMemo(() => {
    const map = new Map<string, ProjectMilestone>();
    for (const [issueId, links] of issueMilestonesByIssueId) {
      const milestone = milestonesById.get(links[0].milestone_id);
      if (milestone) map.set(issueId, milestone);
    }
    return map;
  }, [issueMilestonesByIssueId, milestonesById]);

  // Pull requests per issue, in pull_requests order (matching the previous
  // filter-based lookup).
  const pullRequestsByIssueId = useStableGroups(
    useMemo(() => {
      const linksByPullRequestId = groupBy(
        pullRequestIssuesResult.data,
        (link) => link.pull_request_id
      );
      const map = new Map<string, PullRequest[]>();
      for (const pr of pullRequestsResult.data) {
        for (const link of linksByPullRequestId.get(pr.id) ?? EMPTY) {
          const prs = map.get(link.issue_id);
          if (!prs) map.set(link.issue_id, [pr]);
          else if (!prs.includes(pr)) prs.push(pr);
        }
      }
      return map;
    }, [pullRequestIssuesResult.data, pullRequestsResult.data])
  );

  // An issue maps to at most one GitHub issue link (UNIQUE(issue_id)).
  const githubIssueLinkByIssueId = useMemo(() => {
    const map = new Map<string, ProjectGithubIssueLink>();
    for (const link of githubIssueLinksResult.data) {
      if (!map.has(link.issue_id)) map.set(link.issue_id, link);
    }
    return map;
  }, [githubIssueLinksResult.data]);

  // Lookup helpers
  const getIssue = useCallback(
    (issueId: string) => issuesById.get(issueId),
    [issuesById]
  );

  const getIssuesForStatus = useCallback(
    (statusId: string): Issue[] => issuesByStatusId.get(statusId) ?? EMPTY,
    [issuesByStatusId]
  );

  const getAssigneesForIssue = useCallback(
    (issueId: string) => assigneesByIssueId.get(issueId) ?? EMPTY,
    [assigneesByIssueId]
  );

  const getTagsForIssue = useCallback(
    (issueId: string) => issueTagsByIssueId.get(issueId) ?? EMPTY,
    [issueTagsByIssueId]
  );

  const getTagObjectsForIssue = useCallback(
    (issueId: string): Tag[] => tagObjectsByIssueId.get(issueId) ?? EMPTY,
    [tagObjectsByIssueId]
  );

  const getMilestoneForIssue = useCallback(
    (issueId: string) => milestoneByIssueId.get(issueId),
    [milestoneByIssueId]
  );

  const getRelationshipsForIssue = useCallback(
    (issueId: string) => relationshipsByIssueId.get(issueId) ?? EMPTY,
    [relationshipsByIssueId]
  );

  const getStatus = useCallback(
    (statusId: string) => statusesById.get(statusId),
    [statusesById]
  );

  const getTag = useCallback(
    (tagId: string) => tagsById.get(tagId),
    [tagsById]
  );

  const getPullRequestsForIssue = useCallback(
    (issueId: string): PullRequest[] =>
      pullRequestsByIssueId.get(issueId) ?? EMPTY,
    [pullRequestsByIssueId]
  );

  const getGithubIssueLinkForIssue = useCallback(
    (issueId: string) => githubIssueLinkByIssueId.get(issueId),
    [githubIssueLinkByIssueId]
  );

  const getWorkspacesForIssue = useCallback(
    (issueId: string): Workspace[] => workspacesByIssueId.get(issueId) ?? EMPTY,
    [workspacesByIssueId]
  );

  const value = useMemo<ProjectContextValue>(
    () => ({
      projectId,

      // Data
      issues: issuesResult.data,
      statuses: statusesResult.data,
      tags: tagsResult.data,
      issueAssignees: issueAssigneesResult.data,
      issueTags: issueTagsResult.data,
      milestones: milestonesResult.data,
      issueMilestones: issueMilestonesResult.data,
      issueRelationships: issueRelationshipsResult.data,
      pullRequests: pullRequestsResult.data,
      pullRequestIssues: pullRequestIssuesResult.data,
      githubIssueLinks: githubIssueLinksResult.data,
      workspaces: workspacesResult.data,

      // Loading/error
      isLoading,
      error,
      retry,

      // Issue mutations
      insertIssue: issuesResult.insert,
      updateIssue: issuesResult.update,
      removeIssue: issuesResult.remove,

      // Status mutations
      insertStatus: statusesResult.insert,
      updateStatus: statusesResult.update,
      removeStatus: statusesResult.remove,

      // Tag mutations
      insertTag: tagsResult.insert,
      updateTag: tagsResult.update,
      removeTag: tagsResult.remove,

      // IssueAssignee mutations
      insertIssueAssignee: issueAssigneesResult.insert,
      removeIssueAssignee: issueAssigneesResult.remove,

      // IssueTag mutations
      insertIssueTag: issueTagsResult.insert,
      removeIssueTag: issueTagsResult.remove,

      insertMilestone: milestonesResult.insert,
      updateMilestone: milestonesResult.update,
      removeMilestone: milestonesResult.remove,
      setIssueMilestone: issueMilestonesResult.insert,
      removeIssueMilestone: issueMilestonesResult.remove,

      // IssueRelationship mutations
      insertIssueRelationship: issueRelationshipsResult.insert,
      removeIssueRelationship: issueRelationshipsResult.remove,

      // PullRequestIssue mutations
      insertPullRequestIssue: pullRequestIssuesResult.insert,
      removePullRequestIssue: pullRequestIssuesResult.remove,

      insertGithubIssueLink: githubIssueLinksResult.insert,
      updateGithubIssueLink: githubIssueLinksResult.update,
      removeGithubIssueLink: githubIssueLinksResult.remove,

      // Lookup helpers
      getIssue,
      getIssuesForStatus,
      getAssigneesForIssue,
      getTagsForIssue,
      getTagObjectsForIssue,
      getMilestoneForIssue,
      getRelationshipsForIssue,
      getStatus,
      getTag,
      getPullRequestsForIssue,
      getGithubIssueLinkForIssue,
      getWorkspacesForIssue,

      // Computed aggregations
      issuesById,
      statusesById,
      tagsById,
    }),
    // useShape results are memoized, so each only changes with its own
    // data / loading / error / mutation helpers.
    [
      projectId,
      issuesResult,
      statusesResult,
      tagsResult,
      issueAssigneesResult,
      issueTagsResult,
      milestonesResult,
      issueMilestonesResult,
      issueRelationshipsResult,
      pullRequestsResult,
      pullRequestIssuesResult,
      githubIssueLinksResult,
      workspacesResult,
      isLoading,
      error,
      retry,
      getIssue,
      getIssuesForStatus,
      getAssigneesForIssue,
      getTagsForIssue,
      getTagObjectsForIssue,
      getMilestoneForIssue,
      getRelationshipsForIssue,
      getStatus,
      getTag,
      getPullRequestsForIssue,
      getGithubIssueLinkForIssue,
      getWorkspacesForIssue,
      issuesById,
      statusesById,
      tagsById,
    ]
  );

  return (
    <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
  );
}
