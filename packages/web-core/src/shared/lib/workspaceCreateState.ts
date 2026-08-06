import type { CreateModeInitialState } from '@/shared/types/createMode';
import type { DraftWorkspaceData } from 'shared/types';
import { ScratchType } from 'shared/types';
import type { AppRuntime } from '@/shared/hooks/useAppRuntime';
import { scratchApi } from '@/shared/lib/api';
import { localStorageScratchUpdate } from '@/shared/hooks/useLocalStorageScratch';

interface WorkspaceDefaultsLike {
  preferredRepos?: CreateModeInitialState['preferredRepos'];
  project_id?: string | null;
}

interface LocalWorkspaceLike {
  id: string;
}

interface LinkedIssueSource {
  id: string;
  simple_id: string;
  title: string;
}

/** The GitHub link fields needed to drive the GitHub linked-branch mode. */
export interface GithubLinkedBranchSource {
  githubNodeId: string;
  repository: string;
}

interface GithubIssueLinkLike {
  issue_id: string;
  repository: string;
  github_node_id: string | null;
}

/**
 * Find the GitHub link for `issueId` (if any) and return the node id + repo
 * needed to create/reuse its linked branch. Skips links without a node id
 * (older rows synced before node ids were stored), which cannot be linked.
 */
export function resolveGithubLinkedBranchSource(
  githubIssueLinks: GithubIssueLinkLike[] | null | undefined,
  issueId: string
): GithubLinkedBranchSource | null {
  const link = githubIssueLinks?.find(
    (candidate) => candidate.issue_id === issueId && candidate.github_node_id
  );
  if (!link?.github_node_id) return null;
  return { githubNodeId: link.github_node_id, repository: link.repository };
}

export const DEFAULT_WORKSPACE_CREATE_DRAFT_ID =
  '00000000-0000-0000-0000-000000000001';

export function buildWorkspaceCreatePrompt(
  title: string | null | undefined,
  description: string | null | undefined
): string | null {
  const trimmedTitle = title?.trim();
  if (!trimmedTitle) return null;

  const trimmedDescription = description?.trim();
  return trimmedDescription
    ? `${trimmedTitle}\n\n${trimmedDescription}`
    : trimmedTitle;
}

export function buildLinkedIssueCreateState(
  issue: LinkedIssueSource | null | undefined,
  projectId: string,
  githubLink?: GithubLinkedBranchSource | null
): NonNullable<CreateModeInitialState['linkedIssue']> | null {
  if (!issue) return null;
  return {
    issueId: issue.id,
    simpleId: issue.simple_id,
    title: issue.title,
    remoteProjectId: projectId,
    githubNodeId: githubLink?.githubNodeId ?? null,
    githubRepository: githubLink?.repository ?? null,
  };
}

export function buildWorkspaceCreateInitialState(args: {
  prompt: string | null;
  defaults?: WorkspaceDefaultsLike | null;
  linkedIssue?: CreateModeInitialState['linkedIssue'];
  executorConfig?: CreateModeInitialState['executorConfig'];
}): CreateModeInitialState {
  return {
    initialPrompt: args.prompt,
    preferredRepos: args.defaults?.preferredRepos ?? null,
    project_id: args.defaults?.project_id ?? null,
    linkedIssue: args.linkedIssue ?? null,
    executorConfig: args.executorConfig ?? null,
  };
}

export function buildLocalWorkspaceIdSet(
  activeWorkspaces: LocalWorkspaceLike[],
  archivedWorkspaces: LocalWorkspaceLike[]
): Set<string> {
  return new Set([
    ...activeWorkspaces.map((workspace) => workspace.id),
    ...archivedWorkspaces.map((workspace) => workspace.id),
  ]);
}

export function toDraftWorkspaceData(
  initialState: CreateModeInitialState
): DraftWorkspaceData {
  const linkedIssue = initialState.linkedIssue;
  return {
    message: initialState.initialPrompt ?? '',
    repos:
      initialState.preferredRepos?.map((repo) => ({
        repo_id: repo.repo_id,
        target_branch: repo.target_branch ?? '',
        // Seeded drafts always start on an existing target branch.
        create_target_branch: false,
      })) ?? [],
    executor_config: initialState.executorConfig ?? null,
    linked_issue: linkedIssue
      ? {
          issue_id: linkedIssue.issueId,
          simple_id: linkedIssue.simpleId ?? '',
          title: linkedIssue.title ?? '',
          remote_project_id: linkedIssue.remoteProjectId,
          // Persist the GitHub link so the create route can offer the "GitHub
          // linked branch" target toggle (banner) for this issue.
          github_node_id: linkedIssue.githubNodeId ?? null,
          github_repository: linkedIssue.githubRepository ?? null,
        }
      : null,
    attachments: [],
    // Seeded drafts always start on the auto working branch.
    working_branch: null,
  };
}

export async function persistWorkspaceCreateDraft(
  initialState: CreateModeInitialState,
  draftId = DEFAULT_WORKSPACE_CREATE_DRAFT_ID,
  runtime: AppRuntime = 'local',
  hostId?: string | null,
  userId?: string | null
): Promise<string | null> {
  const draftData = toDraftWorkspaceData(initialState);
  const payload = {
    type: 'DRAFT_WORKSPACE' as const,
    data: draftData,
  };

  try {
    if (runtime === 'remote') {
      if (!userId) {
        throw new Error('Cannot persist a remote draft without a user');
      }
      const didPersist = localStorageScratchUpdate(
        userId,
        ScratchType.DRAFT_WORKSPACE,
        draftId,
        {
          payload,
        }
      );
      if (!didPersist) {
        throw new Error('Failed to persist create-workspace draft in storage');
      }
    } else {
      await scratchApi.update(
        ScratchType.DRAFT_WORKSPACE,
        draftId,
        {
          payload,
        },
        hostId
      );
    }
    return draftId;
  } catch (error) {
    console.error('Failed to persist create-workspace draft:', error);
    return null;
  }
}
