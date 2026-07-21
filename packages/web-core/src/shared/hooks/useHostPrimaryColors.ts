import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { configApi } from '@/shared/lib/api';
import { getHostRequestScopeQueryKey } from '@/shared/lib/hostRequestScope';

export function useHostPrimaryColors(hostIds: Array<string | null>) {
  const uniqueHostIds = useMemo(() => [...new Set(hostIds)], [hostIds]);
  const queries = useQueries({
    queries: uniqueHostIds.map((hostId) => ({
      queryKey: [
        'user-system',
        'workspace-host-primary-color',
        getHostRequestScopeQueryKey(hostId),
      ],
      queryFn: () => configApi.getConfig(hostId),
      staleTime: 30_000,
    })),
  });

  return useMemo(() => {
    const colors = new Map<string | null, string>();
    uniqueHostIds.forEach((hostId, index) => {
      const color = queries[index]?.data?.config.primary_color;
      if (color) colors.set(hostId, color);
    });
    return colors;
  }, [queries, uniqueHostIds]);
}
