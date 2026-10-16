import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { organizationsApi } from '@/shared/lib/api';
import type { OrganizationMemberWithProfile } from 'shared/types';
import { organizationKeys } from '@/shared/hooks/organizationKeys';

export function useOrganizationMembers(organizationId?: string) {
  const queryClient = useQueryClient();
  const query = useQuery<OrganizationMemberWithProfile[]>({
    queryKey: organizationKeys.members(organizationId ?? ''),
    queryFn: ({ signal }) => {
      if (!organizationId) {
        throw new Error('No organization ID available');
      }
      return organizationsApi.getMembers(organizationId, signal);
    },
    enabled: Boolean(organizationId),
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: false,
    refetchInterval: (query) =>
      query.state.status === 'error' ? 30_000 : false,
  });
  const { refetch } = query;
  const retry = useCallback(async () => {
    if (!organizationId) return;
    await queryClient.cancelQueries({
      queryKey: organizationKeys.members(organizationId),
      exact: true,
    });
    await refetch();
  }, [organizationId, queryClient, refetch]);
  return { ...query, retry };
}
