import { useQuery } from '@tanstack/react-query';
import type { WorkspaceCommit } from 'shared/types';
import { workspacesApi } from '@/shared/lib/api';
import { getHostRequestScopeQueryKey } from '@/shared/lib/hostRequestScope';
import { useHostId } from '@/shared/providers/HostIdProvider';

export const workspaceCommitsKey = (
  workspaceId: string | null | undefined,
  hostId: string | null
) =>
  [
    'workspace-commits',
    getHostRequestScopeQueryKey(hostId),
    workspaceId,
  ] as const;

/**
 * Fetches the commits a workspace branch added on top of its base branch,
 * newest first, across all of the workspace's repos.
 */
export function useWorkspaceCommits(
  workspaceId: string | null | undefined,
  enabled = true
) {
  const hostId = useHostId();

  return useQuery<WorkspaceCommit[]>({
    queryKey: workspaceCommitsKey(workspaceId, hostId),
    queryFn: () => workspacesApi.getCommits(workspaceId!, hostId),
    enabled: enabled && !!workspaceId,
    // Commits change as the agent works; keep it reasonably fresh but avoid
    // hammering on every focus.
    staleTime: 10_000,
    // Reconcile commits created, amended, rebased, or removed outside the UI.
    refetchInterval: enabled && workspaceId ? 5_000 : false,
  });
}
