import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AppBarHost, AppBarHostStatus } from '@vibe/ui/components/AppBar';
import type { RelayHost } from 'shared/remote-types';
import type { PairedRelayHost } from '@/shared/lib/relayPairingStorage';
import { listPairedRelayHosts } from '@/shared/lib/relayPairingStorage';
import { listRelayHosts } from '@/shared/lib/remoteApi';
import { useAppRuntime } from '@/shared/hooks/useAppRuntime';
import { useRemoteCloudHostsState } from '@/shared/hooks/useRemoteCloudHosts';

const WORKSPACE_HOST_OPTIONS_RELAY_HOSTS_QUERY_KEY = [
  'workspace-host-options',
  'relay-hosts',
] as const;
const WORKSPACE_HOST_OPTIONS_PAIRED_HOSTS_QUERY_KEY = [
  'workspace-host-options',
  'paired-hosts',
] as const;

function mapRelayHostStatus(
  host: RelayHost,
  pairedHostIds: Set<string>
): AppBarHostStatus {
  if (!pairedHostIds.has(host.id)) {
    return 'unpaired';
  }

  return host.status === 'online' ? 'online' : 'offline';
}

/**
 * Build the relay host options shown to the remote (cloud) web app, joining
 * the relay cloud host list with the browser's IndexedDB pairings. Mirrors the
 * remote AppBar host switcher so both surfaces stay in sync.
 */
export function buildRelayHostOptions(
  relayHosts: RelayHost[],
  pairedHosts: PairedRelayHost[]
): AppBarHost[] {
  const pairedHostIds = new Set(pairedHosts.map((host) => host.host_id));

  return relayHosts.map((host) => ({
    id: host.id,
    name: host.name,
    status: mapRelayHostStatus(host, pairedHostIds),
  }));
}

/**
 * Host options for the "create workspace on…" picker.
 *
 * Local runtime lists the remote cloud hosts paired with this machine's
 * backend (`/api/relay-auth/client/hosts`). The remote (cloud) web app cannot
 * reach a local backend, so it reads the relay cloud host list (`/v1/hosts`)
 * joined with the browser's IndexedDB pairings — the same source the remote
 * AppBar host switcher uses.
 */
export function useWorkspaceHostOptions(): { hosts: AppBarHost[] } {
  const runtime = useAppRuntime();
  const isRemote = runtime === 'remote';

  const localHostsQuery = useRemoteCloudHostsState({ enabled: !isRemote });

  const relayHostsQuery = useQuery({
    queryKey: WORKSPACE_HOST_OPTIONS_RELAY_HOSTS_QUERY_KEY,
    queryFn: listRelayHosts,
    enabled: isRemote,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  const pairedHostsQuery = useQuery({
    queryKey: WORKSPACE_HOST_OPTIONS_PAIRED_HOSTS_QUERY_KEY,
    queryFn: async () => {
      try {
        return await listPairedRelayHosts();
      } catch (error) {
        console.error(
          'Failed to load paired relay hosts for workspace host picker',
          error
        );
        return [];
      }
    },
    enabled: isRemote,
    staleTime: 5_000,
    refetchInterval: 5_000,
  });

  const hosts = useMemo<AppBarHost[]>(() => {
    if (!isRemote) {
      return (localHostsQuery.data?.hosts ?? []).map((host) => ({
        id: host.id,
        name: host.name,
        status: host.status,
      }));
    }

    return buildRelayHostOptions(
      relayHostsQuery.data ?? [],
      pairedHostsQuery.data ?? []
    );
  }, [
    isRemote,
    localHostsQuery.data,
    relayHostsQuery.data,
    pairedHostsQuery.data,
  ]);

  return { hosts };
}
