import { useCallback, useMemo } from 'react';
import { useExecutionProcessesContext } from '@/shared/hooks/useExecutionProcessesContext';
import { useBranchStatus } from '@/shared/hooks/useBranchStatus';
import { isCodingAgent } from '@/shared/constants/processes';
import { useResetProcessMutation } from './useResetProcessMutation';

export interface UseResetProcessResult {
  resetProcess: (executionProcessId: string) => void;
  canResetProcess: (executionProcessId: string) => boolean;
  isResetPending: boolean;
}

/**
 * @param workspaceId - passed explicitly to avoid subscribing to WorkspaceContext
 * @param selectedSessionId - passed explicitly to avoid subscribing to WorkspaceContext
 */
export function useResetProcess(
  workspaceId: string | undefined,
  selectedSessionId: string | undefined
): UseResetProcessResult {
  const { data: branchStatus } = useBranchStatus(workspaceId);
  const { executionProcessesAll: processes, removeOptimisticProcess } =
    useExecutionProcessesContext();

  const resetMutation = useResetProcessMutation(selectedSessionId ?? '');
  const isResetPending = resetMutation.isPending;

  const hasCodingProcess = useMemo(
    () =>
      processes.some(
        (process) => !process.dropped && isCodingAgent(process.run_reason)
      ),
    [processes]
  );

  const canResetProcess = useCallback(
    (executionProcessId: string) => hasCodingProcess && !!executionProcessId,
    [hasCodingProcess]
  );

  const resetProcess = useCallback(
    (executionProcessId: string) => {
      if (!selectedSessionId) return;
      // Reset drops the target process and everything created at/after it
      // (backend: `created_at >= target`). Hide that exact set optimistically so
      // the turns disappear immediately; the stream confirms the drop and clears
      // the overlay.
      const target = processes.find((p) => p.id === executionProcessId);
      const idsToRemove =
        target != null
          ? processes
              .filter(
                (p) =>
                  !p.dropped &&
                  new Date(p.created_at as unknown as string).getTime() >=
                    new Date(target.created_at as unknown as string).getTime()
              )
              .map((p) => p.id)
          : [executionProcessId];
      resetMutation.mutate(
        {
          executionProcessId,
          branchStatus,
          processes,
        },
        {
          onSuccess: () =>
            idsToRemove.forEach((id) => removeOptimisticProcess(id)),
        }
      );
    },
    [
      branchStatus,
      processes,
      resetMutation,
      selectedSessionId,
      removeOptimisticProcess,
    ]
  );

  return useMemo(
    () => ({
      resetProcess,
      canResetProcess,
      isResetPending,
    }),
    [resetProcess, canResetProcess, isResetPending]
  );
}
