import { useQuery } from '@tanstack/react-query';
import { workspacesApi } from '@/shared/lib/api';
import { getHostRequestScopeQueryKey } from '@/shared/lib/hostRequestScope';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { WORKSPACE_GIT_BACKUP_POLL_MS } from '@/shared/lib/workspaceGitRefetch';
import { useAgentTurnGitRefetch } from '@/shared/hooks/useAgentTurnGitRefetch';

export const branchStatusKeys = {
  byWorkspace: (
    workspaceId: string | undefined,
    hostId: string | null = null
  ) =>
    ['branchStatus', workspaceId, getHostRequestScopeQueryKey(hostId)] as const,
};

export function useBranchStatus(workspaceId?: string) {
  const hostId = useHostId();
  const query = useQuery({
    queryKey: branchStatusKeys.byWorkspace(workspaceId, hostId),
    queryFn: () => workspacesApi.getBranchStatus(workspaceId!, hostId),
    enabled: !!workspaceId,
    // Backup only. Explicit git actions invalidate this key, uncommitted edits
    // arrive on the workspace diff stream, and the agent's auto-commit comes in
    // via useAgentTurnGitRefetch below.
    refetchInterval: WORKSPACE_GIT_BACKUP_POLL_MS,
  });
  useAgentTurnGitRefetch(!!workspaceId, query.refetch);
  return query;
}
