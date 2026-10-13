import { useQuery } from '@tanstack/react-query';
import { relayApi } from '@/shared/lib/api';
import { useAppRuntime } from '@/shared/hooks/useAppRuntime';
import { useWorkspacePanesStore } from '@/shared/stores/useWorkspacePanesStore';

const SELF_CLOUD_HOST_ID_QUERY_KEY = ['relay', 'self-host-id'] as const;

let selfCloudHostId: string | null = null;

/** Non-React read for the route parser; `null` until the query has resolved. */
export function getSelfCloudHostId(): string | null {
  return selfCloudHostId;
}

async function fetchSelfCloudHostId(): Promise<string | null> {
  selfCloudHostId = await relayApi.getSelfRelayHostId();
  if (selfCloudHostId) {
    // Persisted panes written before the id was known may still carry it.
    useWorkspacePanesStore.getState().collapseHostId(selfCloudHostId);
  }
  return selfCloudHostId;
}

/**
 * The cloud relay host id assigned to THIS machine, or `null` when unknown or
 * not applicable (remote runtime, relay disabled, not yet registered).
 *
 * The route parser folds `/hosts/{selfHostId}/...` back to the local host
 * (`null`): a machine is never paired with itself, so self must be addressed
 * directly rather than relay-proxied. This is only meaningful in the local
 * runtime — the remote (cloud) app reaches every host, including this one,
 * exclusively through the relay.
 */
export function useSelfCloudHostId(): {
  hostId: string | null;
  isPending: boolean;
} {
  const runtime = useAppRuntime();
  const { data, isPending } = useQuery({
    queryKey: SELF_CLOUD_HOST_ID_QUERY_KEY,
    queryFn: fetchSelfCloudHostId,
    enabled: runtime === 'local',
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  return {
    hostId: data ?? null,
    isPending: runtime === 'local' && isPending,
  };
}
