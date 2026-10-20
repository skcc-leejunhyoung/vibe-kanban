import { useQuery } from '@tanstack/react-query';
import { workspacesApi } from '@/shared/lib/api';
import { getHostRequestScopeQueryKey } from '@/shared/lib/hostRequestScope';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { WORKSPACE_GIT_BACKUP_POLL_MS } from '@/shared/lib/workspaceGitRefetch';
import { useAfterAgentTurnRefetch } from '@/shared/hooks/useAfterAgentTurnRefetch';

export const branchStatusKeys = {
  byWorkspace: (
    workspaceId: string | undefined,
    hostId: string | null = null
  ) =>
    ['branchStatus', workspaceId, getHostRequestScopeQueryKey(hostId)] as const,
};

/** `hostIdOverride` replaces the HostIdProvider host (e.g. the active split pane's). */
export function useBranchStatus(
  workspaceId?: string,
  hostIdOverride?: string | null
) {
  const contextHostId = useHostId();
  const hostId = hostIdOverride !== undefined ? hostIdOverride : contextHostId;
  const query = useQuery({
    queryKey: branchStatusKeys.byWorkspace(workspaceId, hostId),
    queryFn: () => workspacesApi.getBranchStatus(workspaceId!, hostId),
    enabled: !!workspaceId,
    // Backup only. Explicit git actions invalidate this key, uncommitted edits
    // arrive on the workspace diff stream, and the agent's auto-commit comes in
    // via useAfterAgentTurnRefetch below.
    refetchInterval: WORKSPACE_GIT_BACKUP_POLL_MS,
  });
  useAfterAgentTurnRefetch(!!workspaceId, query.refetch);
  return query;
}
