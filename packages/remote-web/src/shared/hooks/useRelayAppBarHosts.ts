import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AppBarHost } from "@vibe/ui/components/AppBar";
import type { RelayHost } from "shared/remote-types";
import { listPairedRelayHosts } from "@/shared/lib/relayPairingStorage";
import { listRelayHosts } from "@/shared/lib/remoteApi";
import {
  RELAY_REMOTE_HOSTS_QUERY_KEY,
  RELAY_REMOTE_PAIRED_HOSTS_QUERY_KEY,
} from "@/shared/lib/relayHostQueryKeys";

interface UseRelayAppBarHostsResult {
  hosts: AppBarHost[];
  isLoading: boolean;
}

function mapRelayHostStatus(
  host: RelayHost,
  pairedHostIds: Set<string>,
): AppBarHost["status"] {
  if (!pairedHostIds.has(host.id)) {
    return "unpaired";
  }

  return host.status === "online" ? "online" : "offline";
}

export function useRelayAppBarHosts(
  enabled: boolean,
): UseRelayAppBarHostsResult {
  const hostsQuery = useQuery({
    queryKey: RELAY_REMOTE_HOSTS_QUERY_KEY,
    queryFn: listRelayHosts,
    enabled,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  const pairedHostsQuery = useQuery({
    queryKey: RELAY_REMOTE_PAIRED_HOSTS_QUERY_KEY,
    queryFn: async () => {
      try {
        return await listPairedRelayHosts();
      } catch (error) {
        console.error("Failed to load paired relay hosts for app bar", error);
        return [];
      }
    },
    enabled,
    staleTime: 5_000,
    refetchInterval: 5_000,
  });

  const hosts = useMemo<AppBarHost[]>(() => {
    if (!enabled) {
      return [];
    }

    const relayHosts = hostsQuery.data ?? [];
    const pairedHostIds = new Set(
      (pairedHostsQuery.data ?? []).map((host) => host.host_id),
    );

    return relayHosts.map((host) => ({
      id: host.id,
      name: host.name,
      status: mapRelayHostStatus(host, pairedHostIds),
    }));
  }, [enabled, hostsQuery.data, pairedHostsQuery.data]);

  return {
    hosts,
    isLoading: enabled && (hostsQuery.isLoading || pairedHostsQuery.isLoading),
  };
}
