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
  // Enumerate from the local pairing list, which is available without the
  // cloud. The cloud `/v1/hosts` response only *decorates* status. A failed
  // cloud lookup (auth expiry, dev-origin CORS, ...) is not evidence that every
  // paired host is offline, so keep the paired hosts and fall back to an
  // optimistic `online` status: the relay data plane usually still works when
  // only the auth layer fails, and marking them online keeps their workspaces
  // hydrating instead of vanishing from the sidebar/picker/snapshots.
  // ponytail: optimistic online costs a 15s failed snapshot poll per genuinely
  // offline host *during a cloud outage only*; acceptable for that narrow case.
  const pairedHosts = await sources.listPairedHosts();

  let remoteHostsById = new Map<string, RelayHost>();
  let cloudReachable = true;
  try {
    const remoteHosts = await sources.listCloudHosts();
    remoteHostsById = new Map(remoteHosts.map((host) => [host.id, host]));
  } catch (error) {
    cloudReachable = false;
    console.warn(
      'Cloud host status lookup failed; keeping paired hosts',
      error
    );
  }

  const hosts = pairedHosts
    .map((host) => {
      const remoteHost = remoteHostsById.get(host.host_id);
      const status = cloudReachable
        ? normalizeRemoteCloudHostStatus(remoteHost?.status)
        : 'online';
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
