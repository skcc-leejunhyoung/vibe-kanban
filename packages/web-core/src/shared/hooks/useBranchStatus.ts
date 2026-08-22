import { useQuery } from '@tanstack/react-query';
import { workspacesApi } from '@/shared/lib/api';
import { getHostRequestScopeQueryKey } from '@/shared/lib/hostRequestScope';
import { useHostId } from '@/shared/providers/HostIdProvider';

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
    refetchInterval: 5000,
  });
}
