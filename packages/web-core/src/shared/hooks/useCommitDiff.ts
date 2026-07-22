import { useQuery } from '@tanstack/react-query';
import type { Diff } from 'shared/types';
import { workspacesApi } from '@/shared/lib/api';
import { getHostRequestScopeQueryKey } from '@/shared/lib/hostRequestScope';
import { useHostId } from '@/shared/providers/HostIdProvider';

/**
 * Fetches the diff introduced by a single commit. Commit diffs are immutable,
 * so the result never goes stale.
 */
export function useCommitDiff(
  workspaceId: string | null | undefined,
  repoId: string | null | undefined,
  sha: string | null | undefined,
  enabled = true
) {
  const hostId = useHostId();

  return useQuery<Diff[]>({
    queryKey: [
      'commit-diff',
      getHostRequestScopeQueryKey(hostId),
      workspaceId,
      repoId,
      sha,
    ],
    queryFn: () =>
      workspacesApi.getCommitDiff(workspaceId!, repoId!, sha!, hostId),
    enabled: enabled && !!workspaceId && !!repoId && !!sha,
    staleTime: Infinity,
  });
}
