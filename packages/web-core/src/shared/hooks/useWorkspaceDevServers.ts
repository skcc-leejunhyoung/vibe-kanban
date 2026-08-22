import { useQuery } from '@tanstack/react-query';
import { workspacesApi } from '@/shared/lib/api';
import type { ExecutionProcess } from 'shared/types';
import { getHostRequestScopeQueryKey } from '@/shared/lib/hostRequestScope';
import { useHostId } from '@/shared/providers/HostIdProvider';

const EMPTY: ExecutionProcess[] = [];

export const workspaceDevServerKeys = {
  byWorkspace: (
    workspaceId: string | undefined,
    hostId: string | null = null
  ) =>
    [
      'workspaceDevServers',
      workspaceId,
      getHostRequestScopeQueryKey(hostId),
    ] as const,
};

/**
 * Dev server processes for a workspace across all of its sessions.
 *
 * Dev servers are conceptually workspace-scoped (the backend starts/stops them
 * per workspace), so the preview must keep showing the running dev server even
 * when the user switches between sessions within the same workspace. The
 * per-session execution-process stream cannot satisfy this, so we query the
 * workspace-level endpoint and poll for status changes.
 */
export function useWorkspaceDevServers(
  workspaceId: string | undefined
): ExecutionProcess[] {
  const hostId = useHostId();
  const { data } = useQuery({
    queryKey: workspaceDevServerKeys.byWorkspace(workspaceId, hostId),
    queryFn: () => workspacesApi.getDevServers(workspaceId as string, hostId),
    enabled: !!workspaceId,
    refetchInterval: 2500,
  });

  return data ?? EMPTY;
}
