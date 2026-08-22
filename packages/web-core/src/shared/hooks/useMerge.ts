import { useMutation, useQueryClient } from '@tanstack/react-query';
import { workspacesApi } from '@/shared/lib/api';
import { repoBranchKeys } from '@/shared/hooks/useRepoBranches';
import { workspaceRepoKeys } from '@/shared/hooks/useWorkspaceRepo';
import { useHostId } from '@/shared/providers/HostIdProvider';

type MergeParams = {
  repoId: string;
};

export function useMerge(
  workspaceId?: string,
  onSuccess?: () => void,
  onError?: (err: unknown) => void
) {
  const queryClient = useQueryClient();
  const hostId = useHostId();

  return useMutation<void, unknown, MergeParams>({
    mutationFn: (params: MergeParams) => {
      if (!workspaceId) return Promise.resolve();
      return workspacesApi.merge(
        workspaceId,
        { repo_id: params.repoId },
        hostId
      );
    },
    onSuccess: () => {
      // Refresh attempt-specific branch information
      queryClient.invalidateQueries({
        queryKey: ['branchStatus', workspaceId],
      });

      // Merging into a remote-only target materializes it as a local branch and
      // persists the new target branch on the workspace repo.
      queryClient.invalidateQueries({
        queryKey: ['workspaceWithSession', workspaceId],
      });
      queryClient.invalidateQueries({
        queryKey: workspaceRepoKeys.byWorkspace(workspaceId, hostId),
      });

      // Invalidate all repo branches queries
      queryClient.invalidateQueries({ queryKey: repoBranchKeys.all });

      onSuccess?.();
    },
    onError: (err) => {
      console.error('Failed to merge:', err);
      onError?.(err);
    },
  });
}
