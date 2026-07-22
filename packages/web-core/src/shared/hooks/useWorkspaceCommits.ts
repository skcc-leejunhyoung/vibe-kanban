import { useQuery } from '@tanstack/react-query';
import type { WorkspaceCommit } from 'shared/types';
import { workspacesApi } from '@/shared/lib/api';

export const workspaceCommitsKey = (workspaceId: string | null | undefined) =>
  ['workspace-commits', workspaceId] as const;

/**
 * Fetches the commits a workspace branch added on top of its base branch,
 * newest first, across all of the workspace's repos.
 */
export function useWorkspaceCommits(
  workspaceId: string | null | undefined,
  enabled = true
) {
  return useQuery<WorkspaceCommit[]>({
    queryKey: workspaceCommitsKey(workspaceId),
    queryFn: () => workspacesApi.getCommits(workspaceId!),
    enabled: enabled && !!workspaceId,
    // Commits change as the agent works; keep it reasonably fresh but avoid
    // hammering on every focus.
    staleTime: 10_000,
    // Reconcile commits created, amended, rebased, or removed outside the UI.
    refetchInterval: enabled && workspaceId ? 5_000 : false,
  });
}
