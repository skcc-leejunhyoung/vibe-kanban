import { useQuery } from '@tanstack/react-query';
import type { Diff } from 'shared/types';
import { workspacesApi } from '@/shared/lib/api';

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
  return useQuery<Diff[]>({
    queryKey: ['commit-diff', workspaceId, repoId, sha],
    queryFn: () => workspacesApi.getCommitDiff(workspaceId!, repoId!, sha!),
    enabled: enabled && !!workspaceId && !!repoId && !!sha,
    staleTime: Infinity,
  });
}
