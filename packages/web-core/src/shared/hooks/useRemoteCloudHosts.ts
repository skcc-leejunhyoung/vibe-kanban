import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AppBarHost, AppBarHostStatus } from '@vibe/ui/components/AppBar';
import type { PairRelayHostRequest, RelayPairedHost } from 'shared/types';
import type { RelayHost } from 'shared/remote-types';
import { relayApi } from '@/shared/lib/api';
import { useAppRuntime } from '@/shared/hooks/useAppRuntime';
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
const EMPTY_REMOTE_HOSTS: RemoteCloudHost[] = [];

interface RemoteCloudHostsState {
  hosts: RemoteCloudHost[];
}

interface RemoteCloudHostDataSources {
  listPairedHosts: () => Promise<RelayPairedHost[]>;
  listCloudHosts: () => Promise<RelayHost[]>;
  /** This machine's own cloud host id, which must not be listed as remote. */
  getSelfHostId?: () => Promise<string | null>;
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
  sources: RemoteCloudHostDataSources
): Promise<RemoteCloudHostsState> {
  // A failed authoritative lookup is an error. React Query retains the last
  // successful list instead of replacing account hosts with an empty result.
  const [cloud, paired, self] = await Promise.allSettled([
    sources.listCloudHosts(),
    sources.listPairedHosts(),
    sources.getSelfHostId?.() ?? null,
  ]);
  const selfHostId = self.status === 'fulfilled' ? self.value : null;
  if (cloud.status === 'rejected') throw cloud.reason;
  const remoteHostsById = new Map(cloud.value.map((host) => [host.id, host]));
  if (
    paired.status === 'rejected' &&
    !cloud.value.some((host) => host.auth_mode === 'account')
  )
    throw paired.reason;
  const pairedHosts = paired.status === 'fulfilled' ? paired.value : [];

  const hosts = pairedHosts
    .filter(
      (host) => remoteHostsById.get(host.host_id)?.auth_mode !== 'account'
    )
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

  for (const host of remoteHostsById.values()) {
    if (host.auth_mode === 'account' && host.id !== selfHostId)
      hosts.push({
        id: host.id,
        name: host.name,
        status: normalizeRemoteCloudHostStatus(
          host.remote_access_enabled ? host.status : 'offline'
        ),
        pairedAt: host.created_at,
        lastUsedAt: host.last_seen_at ?? host.created_at,
      });
  }

  return { hosts };
}

export function useRemoteCloudHostsState(options?: { enabled?: boolean }) {
  const runtime = useAppRuntime();
  return useQuery({
    queryKey: REMOTE_CLOUD_HOSTS_STATE_QUERY_KEY,
    queryFn: () =>
      fetchRemoteCloudHostsState({
        listPairedHosts: relayApi.listPairedRelayHosts,
        listCloudHosts: listRelayHosts,
        // Local web already shows this machine as itself; its own account
        // registration would otherwise list it a second time as remote.
        getSelfHostId:
          runtime === 'local' ? relayApi.getSelfRelayHostId : undefined,
      }),
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

  const remoteHosts = data?.hosts ?? EMPTY_REMOTE_HOSTS;

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
