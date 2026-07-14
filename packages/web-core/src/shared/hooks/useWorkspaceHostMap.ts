import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { workspacesApi } from '@/shared/lib/api';
import { useRemoteCloudHostsState } from '@/shared/hooks/useRemoteCloudHosts';

/** Maps workspace IDs to the paired host that owns them. Local IDs are omitted. */
export function useWorkspaceHostMap(): Map<string, string> {
  const { data } = useRemoteCloudHostsState();
  const onlineHosts = useMemo(
    () => (data?.hosts ?? []).filter((host) => host.status === 'online'),
    [data?.hosts]
  );
  const queries = useQueries({
    queries: onlineHosts.map((host) => ({
      queryKey: ['host-workspaces', host.id],
      queryFn: () => workspacesApi.getAllWorkspaces(host.id),
      staleTime: 15_000,
      refetchInterval: 15_000,
    })),
  });

  return useMemo(() => {
    const result = new Map<string, string>();
    queries.forEach((query, index) => {
      const hostId = onlineHosts[index]?.id;
      if (!hostId) return;
      for (const workspace of query.data ?? []) {
        result.set(workspace.id, hostId);
      }
    });
    return result;
  }, [onlineHosts, queries]);
}
