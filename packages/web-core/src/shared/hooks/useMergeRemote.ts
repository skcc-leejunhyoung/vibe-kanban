import { useMutation, useQueryClient } from '@tanstack/react-query';
import { workspacesApi } from '@/shared/lib/api';
import type { GitOperationError, PushWorkspaceRequest } from 'shared/types';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { workspaceCommitsKey } from './useWorkspaceCommits';

class MergeRemoteErrorWithData extends Error {
  constructor(
    message: string,
    public errorData?: GitOperationError
  ) {
    super(message);
    this.name = 'MergeRemoteErrorWithData';
  }
}

export function useMergeRemote(
  workspaceId?: string,
  onSuccess?: () => void,
  onError?: (err: unknown, errorData?: GitOperationError) => void
) {
  const queryClient = useQueryClient();
  const hostId = useHostId();

  return useMutation<void, unknown, PushWorkspaceRequest>({
    mutationFn: async (params) => {
      if (!workspaceId) return;
      const result = await workspacesApi.mergeRemote(workspaceId, params);
      if (!result.success) {
        throw new MergeRemoteErrorWithData(
          result.message || 'Failed to merge remote branch',
          result.error
        );
      }
    },
    onSuccess,
    onError: (err) => {
      const errorData =
        err instanceof MergeRemoteErrorWithData ? err.errorData : undefined;
      onError?.(err, errorData);
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: ['branchStatus', workspaceId],
      });
      queryClient.invalidateQueries({
        queryKey: workspaceCommitsKey(workspaceId, hostId),
      });
    },
  });
}
