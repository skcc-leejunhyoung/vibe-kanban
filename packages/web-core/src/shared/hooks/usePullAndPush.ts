import { useMutation, useQueryClient } from '@tanstack/react-query';
import { workspacesApi } from '@/shared/lib/api';
import type { GitOperationError, PushWorkspaceRequest } from 'shared/types';

class PullAndPushErrorWithData extends Error {
  constructor(
    message: string,
    public errorData?: GitOperationError
  ) {
    super(message);
    this.name = 'PullAndPushErrorWithData';
  }
}

/**
 * Resolve a diverged push the safe way: fetch + merge the branch's own remote
 * into the local branch, then push. The non-destructive alternative to a force
 * push. A merge conflict comes back as a typed `GitOperationError` (via
 * `errorData`); the worktree is left mid-merge and `branchStatus` is invalidated
 * so the existing conflict-resolution UI takes over.
 */
export function usePullAndPush(
  workspaceId?: string,
  onSuccess?: () => void,
  onError?: (err: unknown, errorData?: GitOperationError) => void
) {
  const queryClient = useQueryClient();

  return useMutation<void, unknown, PushWorkspaceRequest>({
    mutationFn: async (params: PushWorkspaceRequest) => {
      if (!workspaceId) return;
      const result = await workspacesApi.pullAndPush(workspaceId, params);
      if (!result.success) {
        throw new PullAndPushErrorWithData(
          result.message || 'Pull and push failed',
          result.error
        );
      }
    },
    onSuccess: () => {
      onSuccess?.();
    },
    onError: (err) => {
      console.error('Failed to pull and push:', err);
      const errorData =
        err instanceof PullAndPushErrorWithData ? err.errorData : undefined;
      onError?.(err, errorData);
    },
    onSettled: () => {
      // A pull-and-push changes both the local branch tip and remote status; on
      // conflict it also leaves the worktree mid-merge, which the conflict UI
      // reads from branchStatus. Refresh it either way.
      queryClient.invalidateQueries({
        queryKey: ['branchStatus', workspaceId],
      });
    },
  });
}
