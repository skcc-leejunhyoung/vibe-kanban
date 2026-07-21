import { useCallback, useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { HostAppearance } from 'shared/types';
import { configApi } from '@/shared/lib/api';
import { getHostRequestScopeQueryKey } from '@/shared/lib/hostRequestScope';

const LOCAL_HOST_COLOR_KEY = 'local';

export function getHostPrimaryColorKey(hostId: string | null): string {
  return hostId ?? LOCAL_HOST_COLOR_KEY;
}

export function useHostPrimaryColors(hostIds: Array<string | null>) {
  const hostIdSignature = [...new Set(hostIds)]
    .map(getHostPrimaryColorKey)
    .sort()
    .join('\n');
  const uniqueHostIds = useMemo(
    () =>
      hostIdSignature
        ? hostIdSignature
            .split('\n')
            .map((hostId) => (hostId === LOCAL_HOST_COLOR_KEY ? null : hostId))
        : [],
    [hostIdSignature]
  );
  const combine = useCallback(
    (results: Array<{ data?: HostAppearance }>) =>
      Object.fromEntries(
        uniqueHostIds.flatMap((hostId, index) => {
          const color = results[index]?.data?.primary_color;
          return color ? [[getHostPrimaryColorKey(hostId), color]] : [];
        })
      ),
    [uniqueHostIds]
  );

  return useQueries({
    queries: uniqueHostIds.map((hostId) => ({
      queryKey: [
        'user-system',
        'workspace-host-primary-color',
        getHostRequestScopeQueryKey(hostId),
      ],
      queryFn: () => configApi.getHostAppearance(hostId),
      staleTime: 5 * 60_000,
    })),
    combine,
  });
}
