import { useQuery } from '@tanstack/react-query';
import { relayApi } from '@/shared/lib/api';
import { useAppRuntime } from '@/shared/hooks/useAppRuntime';

const SELF_CLOUD_HOST_ID_QUERY_KEY = ['relay', 'self-host-id'] as const;

/**
 * The cloud relay host id assigned to THIS machine, or `null` when unknown or
 * not applicable (remote runtime, relay disabled, not yet registered).
 *
 * Used to collapse `/hosts/{selfHostId}/...` routes back to the direct local
 * path: a machine is never paired with itself, so relay-proxying to our own
 * host id always 400s with "No paired relay credentials for this host". This is
 * only meaningful in the local runtime — the remote (cloud) app reaches every
 * host, including this one, exclusively through the relay.
 */
export function useSelfCloudHostId(): string | null {
  const runtime = useAppRuntime();
  const { data } = useQuery({
    queryKey: SELF_CLOUD_HOST_ID_QUERY_KEY,
    queryFn: () => relayApi.getSelfRelayHostId(),
    enabled: runtime === 'local',
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  return data ?? null;
}
