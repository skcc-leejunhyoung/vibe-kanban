import { useMutation, useQueryClient } from '@tanstack/react-query';
import { workspacesApi } from '@/shared/lib/api';
import type { PullWorkspaceResponse } from 'shared/types';
import { repoBranchKeys } from '@/shared/hooks/useRepoBranches';

type PullParams = {
  repoId: string;
};

/**
 * Fast-forward the work branch to its own remote (`git pull --ff-only`). The
 * mutation resolves with the outcome (up to date / fast-forwarded / diverged)
 * so the caller can message the user; `diverged` is not an error.
 */
export function usePull(
  workspaceId?: string,
  onSuccess?: (result: PullWorkspaceResponse) => void,
  onError?: (err: unknown) => void
) {
  const queryClient = useQueryClient();

  return useMutation<PullWorkspaceResponse | undefined, unknown, PullParams>({
    mutationFn: (params: PullParams) => {
      if (!workspaceId) return Promise.resolve(undefined);
      return workspacesApi.pull(workspaceId, {
        repo_id: params.repoId,
      });
    },
    onSuccess: (result) => {
      // Refresh attempt-specific branch information
      queryClient.invalidateQueries({
        queryKey: ['branchStatus', workspaceId],
      });

      // Invalidate all repo branches queries
      queryClient.invalidateQueries({ queryKey: repoBranchKeys.all });

      if (result) onSuccess?.(result);
    },
    onError: (err) => {
      console.error('Failed to pull:', err);
      onError?.(err);
    },
  });
}
