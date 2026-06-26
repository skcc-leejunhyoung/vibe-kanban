import { useMutation, useQueryClient } from '@tanstack/react-query';
import { workspacesApi, Result } from '@/shared/lib/api';
import type { GitOperationError, UpdateFromBaseStrategy } from 'shared/types';
import { repoBranchKeys } from '@/shared/hooks/useRepoBranches';
import { workspaceRepoKeys } from '@/shared/hooks/useWorkspaceRepo';

/**
 * Bring the target (base) branch into the work branch. `merge` preserves
 * history (safe on shared PR branches); `rebase` rewrites it. Conflicts are
 * surfaced as a typed failure `Result` so the existing conflict-resolution UI
 * (rebase/merge in progress) can take over, identical to {@link useRebase}.
 */
export function useUpdateFromBase(
  workspaceId: string | undefined,
  repoId: string | undefined,
  onSuccess?: () => void,
  onError?: (err: Result<void, GitOperationError>) => void
) {
  const queryClient = useQueryClient();

  type UpdateFromBaseArgs = {
    repoId: string;
    strategy: UpdateFromBaseStrategy;
  };

  return useMutation<void, Result<void, GitOperationError>, UpdateFromBaseArgs>(
    {
      mutationFn: (args) => {
        if (!workspaceId) return Promise.resolve();
        const { repoId, strategy } = args;

        return workspacesApi
          .updateFromBase(workspaceId, {
            repo_id: repoId,
            strategy,
          })
          .then((res) => {
            if (!res.success) {
              // Propagate typed failure Result for caller to handle conflicts.
              return Promise.reject(res);
            }
          });
      },
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: ['branchStatus', workspaceId],
        });
        queryClient.invalidateQueries({
          queryKey: ['workspaceWithSession', workspaceId],
        });
        queryClient.invalidateQueries({
          queryKey: workspaceRepoKeys.byWorkspace(workspaceId),
        });
        if (repoId) {
          queryClient.invalidateQueries({
            queryKey: repoBranchKeys.byRepo(repoId),
          });
        }
        onSuccess?.();
      },
      onError: (err: Result<void, GitOperationError>) => {
        console.error('Failed to update from base:', err);
        // On failure (likely conflicts) re-fetch status so the conflict banner shows.
        queryClient.invalidateQueries({
          queryKey: ['branchStatus', workspaceId],
        });
        onError?.(err);
      },
    }
  );
}
