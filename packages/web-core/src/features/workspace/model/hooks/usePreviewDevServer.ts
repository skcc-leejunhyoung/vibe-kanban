import { useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { workspacesApi, executionProcessesApi } from '@/shared/lib/api';
import { useWorkspaceDevServers } from '@/shared/hooks/useWorkspaceDevServers';
import {
  filterRunningDevServers,
  filterDevServerProcesses,
  deduplicateDevServersByWorkingDir,
} from '@/shared/lib/devServerUtils';
import { workspaceSummaryKeys } from '@/shared/hooks/workspaceSummaryKeys';
import { useHostId } from '@/shared/providers/HostIdProvider';

interface UsePreviewDevServerOptions {
  onStartSuccess?: () => void;
  onStartError?: (err: unknown) => void;
  onStopSuccess?: () => void;
  onStopError?: (err: unknown) => void;
}

export function usePreviewDevServer(
  workspaceId: string | undefined,
  options?: UsePreviewDevServerOptions
) {
  const queryClient = useQueryClient();
  const hostId = useHostId();
  const processes = useWorkspaceDevServers(workspaceId);

  const runningDevServers = useMemo(
    () => filterRunningDevServers(processes),
    [processes]
  );

  const devServerProcesses = useMemo(
    () =>
      deduplicateDevServersByWorkingDir(filterDevServerProcesses(processes)),
    [processes]
  );

  const startMutation = useMutation({
    mutationKey: ['startDevServer', workspaceId],
    mutationFn: async () => {
      if (!workspaceId) return;
      await workspacesApi.startDevServer(workspaceId, hostId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['workspaceDevServers', workspaceId],
      });
      queryClient.invalidateQueries({ queryKey: workspaceSummaryKeys.all });
      options?.onStartSuccess?.();
    },
    onError: (err) => {
      console.error('Failed to start dev server:', err);
      options?.onStartError?.(err);
    },
  });

  const stopMutation = useMutation({
    mutationKey: ['stopDevServer', workspaceId],
    mutationFn: async () => {
      if (runningDevServers.length === 0) return;
      await Promise.all(
        runningDevServers.map((ds) =>
          executionProcessesApi.stopExecutionProcess(ds.id, hostId)
        )
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['workspaceDevServers', workspaceId],
      });
      for (const ds of runningDevServers) {
        queryClient.invalidateQueries({
          queryKey: ['processDetails', ds.id],
        });
      }
      queryClient.invalidateQueries({ queryKey: workspaceSummaryKeys.all });
      options?.onStopSuccess?.();
    },
    onError: (err) => {
      console.error('Failed to stop dev server:', err);
      options?.onStopError?.(err);
    },
  });

  return {
    start: startMutation.mutate,
    stop: stopMutation.mutate,
    isStarting: startMutation.isPending,
    isStopping: stopMutation.isPending,
    runningDevServers,
    devServerProcesses,
  };
}
