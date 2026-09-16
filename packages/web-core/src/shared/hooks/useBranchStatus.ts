import { useQuery } from '@tanstack/react-query';
import { workspacesApi } from '@/shared/lib/api';
import { getHostRequestScopeQueryKey } from '@/shared/lib/hostRequestScope';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { WORKSPACE_GIT_BACKUP_POLL_MS } from '@/shared/lib/workspaceGitRefetch';

export const branchStatusKeys = {
  byWorkspace: (
    workspaceId: string | undefined,
    hostId: string | null = null
  ) =>
    ['branchStatus', workspaceId, getHostRequestScopeQueryKey(hostId)] as const,
};

export function useBranchStatus(workspaceId?: string) {
  const hostId = useHostId();
  return useQuery({
    queryKey: branchStatusKeys.byWorkspace(workspaceId, hostId),
    queryFn: () => workspacesApi.getBranchStatus(workspaceId!, hostId),
    enabled: !!workspaceId,
    // Backup only. Git state moves on commits/pushes/merges, which either run
    // through a mutation that invalidates this key or show up on the workspace
    // diff stream (see WorkspaceProvider's git-event refetch).
    refetchInterval: WORKSPACE_GIT_BACKUP_POLL_MS,
  });
}
