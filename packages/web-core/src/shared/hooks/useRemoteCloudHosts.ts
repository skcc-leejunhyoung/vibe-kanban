import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AppBarHost, AppBarHostStatus } from '@vibe/ui/components/AppBar';
import type { PairRelayHostRequest, RelayPairedHost } from 'shared/types';
import type { RelayHost } from 'shared/remote-types';
import { relayApi } from '@/shared/lib/api';
import { listRelayHosts } from '@/shared/lib/remoteApi';
import { REMOTE_CLOUD_HOSTS_STATE_QUERY_KEY } from '@/shared/lib/relayHostQueryKeys';

export type RemoteCloudHostStatus = AppBarHostStatus;

export interface RemoteCloudHost {
  id: string;
  name: string;
  status: RemoteCloudHostStatus;
  pairedAt: string;
  lastUsedAt: string;
}

interface RemoteCloudHostsState {
  hosts: RemoteCloudHost[];
}

interface RemoteCloudHostDataSources {
  listPairedHosts: () => Promise<RelayPairedHost[]>;
  listCloudHosts: () => Promise<RelayHost[]>;
}

function normalizeRemoteCloudHostStatus(
  status: RelayHost['status'] | undefined
): RemoteCloudHostStatus {
  if (status === 'online' || status === 'offline' || status === 'unpaired') {
    return status;
  }

  return 'offline';
}

export async function fetchRemoteCloudHostsState(
  sources: RemoteCloudHostDataSources = {
    listPairedHosts: relayApi.listPairedRelayHosts,
    listCloudHosts: listRelayHosts,
  }
): Promise<RemoteCloudHostsState> {
  // A failed cloud lookup is not evidence that every paired host is offline.
  // Let React Query retain the last successful state and expose the request
  // error instead of replacing real host statuses with a fabricated fallback.
  const [pairedHosts, remoteHosts] = await Promise.all([
    sources.listPairedHosts(),
    sources.listCloudHosts(),
  ]);

  const remoteHostsById = new Map(remoteHosts.map((host) => [host.id, host]));

  const hosts = pairedHosts
    .map((host) => {
      const remoteHost = remoteHostsById.get(host.host_id);
      const status = normalizeRemoteCloudHostStatus(remoteHost?.status);
      const pairedAt = host.paired_at ?? '';

      return {
        id: host.host_id,
        name: remoteHost?.name ?? host.host_name ?? host.host_id,
        status,
        pairedAt,
        lastUsedAt: pairedAt,
      };
    })
    .sort((a, b) => b.pairedAt.localeCompare(a.pairedAt));

  return { hosts };
}

export function useRemoteCloudHostsState(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: REMOTE_CLOUD_HOSTS_STATE_QUERY_KEY,
    queryFn: () => fetchRemoteCloudHostsState(),
    staleTime: 30_000,
    refetchInterval: 30_000,
    enabled: options?.enabled ?? true,
  });
}

export function usePairRemoteCloudHostMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: PairRelayHostRequest) =>
      relayApi.pairRelayHost(payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: REMOTE_CLOUD_HOSTS_STATE_QUERY_KEY,
      });
    },
  });
}

export function useRemoveRemoteCloudHostMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (hostId: string) => relayApi.removePairedRelayHost(hostId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: REMOTE_CLOUD_HOSTS_STATE_QUERY_KEY,
      });
    },
  });
}

export function useRemoteCloudHostsAppBarModel(): {
  hosts: AppBarHost[];
  remoteHosts: RemoteCloudHost[];
} {
  const { data } = useRemoteCloudHostsState();

  const remoteHosts = data?.hosts ?? [];

  const hosts = useMemo<AppBarHost[]>(
    () =>
      remoteHosts.map((host) => ({
        id: host.id,
        name: host.name,
        status: host.status,
      })),
    [remoteHosts]
  );

  return {
    hosts,
    remoteHosts,
  };
}
