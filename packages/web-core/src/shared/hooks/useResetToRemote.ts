import { useMutation, useQueryClient } from '@tanstack/react-query';
import { workspacesApi } from '@/shared/lib/api';
import type { ResetWorkspaceToRemoteRequest } from 'shared/types';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { workspaceCommitsKey } from './useWorkspaceCommits';

export function useResetToRemote(
  workspaceId?: string,
  onSuccess?: () => void,
  onError?: (err: unknown) => void,
  isTarget = false
) {
  const queryClient = useQueryClient();
  const hostId = useHostId();

  return useMutation<void, unknown, ResetWorkspaceToRemoteRequest>({
    mutationFn: async (params) => {
      if (!workspaceId) return;
      if (isTarget) {
        await workspacesApi.resetTargetBranchToRemote(workspaceId, params);
      } else {
        await workspacesApi.resetToRemote(workspaceId, params);
      }
    },
    onSuccess: () => {
      onSuccess?.();
    },
    onError: (err) => {
      console.error('Failed to reset local branch to remote:', err);
      onError?.(err);
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
