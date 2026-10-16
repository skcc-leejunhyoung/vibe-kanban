import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { organizationsApi } from '@/shared/lib/api';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import type { ListOrganizationsResponse } from 'shared/types';
import { organizationKeys } from '@/shared/hooks/organizationKeys';

/**
 * Hook to fetch all organizations that the current user is a member of
 */
export function useUserOrganizations() {
  const { isSignedIn } = useAuth();
  const queryClient = useQueryClient();

  const query = useQuery<ListOrganizationsResponse>({
    queryKey: organizationKeys.userList(),
    queryFn: ({ signal }) => organizationsApi.getUserOrganizations(signal),
    enabled: isSignedIn,
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: false,
    refetchInterval: (query) =>
      query.state.status === 'error' ? 30_000 : false,
  });
  const { refetch } = query;
  const retry = useCallback(async () => {
    if (!isSignedIn) return;
    await queryClient.cancelQueries({
      queryKey: organizationKeys.userList(),
      exact: true,
    });
    await refetch();
  }, [isSignedIn, queryClient, refetch]);
  return { ...query, retry };
}
