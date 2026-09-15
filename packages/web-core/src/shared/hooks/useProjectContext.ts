import { useContext } from 'react';
import { createHmrContext } from '@/shared/lib/hmrContext';
import type { InsertResult, MutationResult } from '@/shared/lib/electric/types';
import type { SyncError } from '@/shared/lib/electric/types';
import type { ProjectGithubIssueLink } from '@/shared/lib/electric/collections';
import type {
  Issue,
  ProjectStatus,
  Tag,
  IssueAssignee,
  IssueTag,
  ProjectMilestone,
  IssueMilestone,
  IssueRelationship,
  PullRequest,
  PullRequestIssue,
  GithubIssueLink,
  Workspace,
  CreateIssueRequest,
  UpdateIssueRequest,
  CreateProjectStatusRequest,
  UpdateProjectStatusRequest,
  CreateTagRequest,
  UpdateTagRequest,
  CreateIssueAssigneeRequest,
  CreateIssueTagRequest,
  CreateProjectMilestoneRequest,
  UpdateProjectMilestoneRequest,
  CreateIssueMilestoneRequest,
  CreateIssueRelationshipRequest,
  CreatePullRequestIssueRequest,
  CreateGithubIssueLinkRequest,
  UpdateGithubIssueLinkRequest,
} from 'shared/remote-types';

export type { ProjectGithubIssueLink };

/**
 * ProjectContext provides project-scoped data and mutations.
 *
 * Entities synced at project scope:
 * - Issues (data + mutations)
 * - ProjectStatuses (data + mutations)
 * - Tags (data + mutations)
 * - IssueAssignees (data + mutations)
 * - IssueTags (data + mutations)
 * - IssueRelationships (data + mutations)
 * - PullRequests (data only)
 * - PullRequestIssues (data + mutations)
 * - GithubIssueLinks (data + mutations; synced with the columns the UI reads,
 *   see `ProjectGithubIssueLink`)
 * - Workspaces (data only)
 *
 * Per-issue lookup helpers answer from maps rebuilt only when their source
 * shape changes and hand back the same array while an issue's rows are
 * unchanged, so consumers can memoize on their results.
 */
export interface ProjectContextValue {
  projectId: string;

  // Normalized data arrays
  issues: Issue[];
  statuses: ProjectStatus[];
  tags: Tag[];
  issueAssignees: IssueAssignee[];
  issueTags: IssueTag[];
  milestones: ProjectMilestone[];
  issueMilestones: IssueMilestone[];
  issueRelationships: IssueRelationship[];
  pullRequests: PullRequest[];
  pullRequestIssues: PullRequestIssue[];
  githubIssueLinks: ProjectGithubIssueLink[];
  workspaces: Workspace[];

  // Loading/error state
  isLoading: boolean;
  error: SyncError | null;
  retry: () => void;

  // Issue mutations
  insertIssue: (data: CreateIssueRequest) => InsertResult<Issue>;
  updateIssue: (
    id: string,
    changes: Partial<UpdateIssueRequest>
  ) => MutationResult;
  removeIssue: (id: string) => MutationResult;

  // Status mutations
  insertStatus: (
    data: CreateProjectStatusRequest
  ) => InsertResult<ProjectStatus>;
  updateStatus: (
    id: string,
    changes: Partial<UpdateProjectStatusRequest>
  ) => MutationResult;
  removeStatus: (id: string) => MutationResult;

  // Tag mutations
  insertTag: (data: CreateTagRequest) => InsertResult<Tag>;
  updateTag: (id: string, changes: Partial<UpdateTagRequest>) => MutationResult;
  removeTag: (id: string) => MutationResult;

  // IssueAssignee mutations
  insertIssueAssignee: (
    data: CreateIssueAssigneeRequest
  ) => InsertResult<IssueAssignee>;
  removeIssueAssignee: (id: string) => MutationResult;

  // IssueTag mutations
  insertIssueTag: (data: CreateIssueTagRequest) => InsertResult<IssueTag>;
  removeIssueTag: (id: string) => MutationResult;

  insertMilestone: (
    data: CreateProjectMilestoneRequest
  ) => InsertResult<ProjectMilestone>;
  updateMilestone: (
    id: string,
    changes: Partial<UpdateProjectMilestoneRequest>
  ) => MutationResult;
  removeMilestone: (id: string) => MutationResult;
  setIssueMilestone: (
    data: CreateIssueMilestoneRequest
  ) => InsertResult<IssueMilestone>;
  removeIssueMilestone: (id: string) => MutationResult;

  // IssueRelationship mutations
  insertIssueRelationship: (
    data: CreateIssueRelationshipRequest
  ) => InsertResult<IssueRelationship>;
  removeIssueRelationship: (id: string) => MutationResult;

  // PullRequestIssue mutations
  insertPullRequestIssue: (
    data: CreatePullRequestIssueRequest
  ) => InsertResult<PullRequestIssue>;
  removePullRequestIssue: (id: string) => MutationResult;

  insertGithubIssueLink: (
    data: CreateGithubIssueLinkRequest
  ) => InsertResult<GithubIssueLink>;
  updateGithubIssueLink: (
    id: string,
    changes: Partial<UpdateGithubIssueLinkRequest>
  ) => MutationResult;
  removeGithubIssueLink: (id: string) => MutationResult;

  // Lookup helpers
  getIssue: (issueId: string) => Issue | undefined;
  getIssuesForStatus: (statusId: string) => Issue[];
  getAssigneesForIssue: (issueId: string) => IssueAssignee[];
  getTagsForIssue: (issueId: string) => IssueTag[];
  getTagObjectsForIssue: (issueId: string) => Tag[];
  getMilestoneForIssue: (issueId: string) => ProjectMilestone | undefined;
  getRelationshipsForIssue: (issueId: string) => IssueRelationship[];
  getStatus: (statusId: string) => ProjectStatus | undefined;
  getTag: (tagId: string) => Tag | undefined;
  getPullRequestsForIssue: (issueId: string) => PullRequest[];
  getGithubIssueLinkForIssue: (
    issueId: string
  ) => ProjectGithubIssueLink | undefined;
  getWorkspacesForIssue: (issueId: string) => Workspace[];

  // Computed aggregations (Maps for O(1) lookup)
  issuesById: Map<string, Issue>;
  statusesById: Map<string, ProjectStatus>;
  tagsById: Map<string, Tag>;
}

export const ProjectContext = createHmrContext<ProjectContextValue | null>(
  'RemoteProjectContext',
  null
);

export function useProjectContext(): ProjectContextValue {
  const context = useContext(ProjectContext);
  if (!context) {
    throw new Error('useProjectContext must be used within a ProjectProvider');
  }
  return context;
}
