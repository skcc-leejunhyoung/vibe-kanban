import { useContext } from 'react';
import { createHmrContext } from '@/shared/lib/hmrContext';
import type { ExecutionProcess } from 'shared/types';

export type ExecutionProcessesContextType = {
  executionProcessesAll: ExecutionProcess[];
  executionProcessesByIdAll: Record<string, ExecutionProcess>;
  isAttemptRunningAll: boolean;

  executionProcessesVisible: ExecutionProcess[];
  executionProcessesByIdVisible: Record<string, ExecutionProcess>;
  isAttemptRunningVisible: boolean;

  isLoading: boolean;
  isConnected: boolean;
  error: string | null;

  /**
   * Optimistically add a just-created process (e.g. the one returned by a
   * follow-up POST) so the conversation renders its turn immediately instead of
   * waiting for the same process to arrive over the WS stream. The streamed row
   * supersedes it by id as soon as it arrives.
   */
  addOptimisticProcess: (process: ExecutionProcess) => void;
  /**
   * Optimistically patch a process (e.g. mark a running turn killed on stop) so
   * the change shows immediately. Dropped once the stream reflects it.
   */
  patchOptimisticProcess: (
    id: string,
    changes: Partial<ExecutionProcess>
  ) => void;
  /**
   * Optimistically hide a process (e.g. on reset) so it disappears immediately.
   * Dropped once the stream drops/removes it.
   */
  removeOptimisticProcess: (id: string) => void;
  /** Drop any optimistic op for a process (e.g. to revert a failed action). */
  clearOptimisticProcess: (id: string) => void;
};

export const ExecutionProcessesContext =
  createHmrContext<ExecutionProcessesContextType | null>(
    'ExecutionProcessesContext',
    null
  );

export const useExecutionProcessesContext = () => {
  const ctx = useContext(ExecutionProcessesContext);
  if (!ctx) {
    throw new Error(
      'useExecutionProcessesContext must be used within ExecutionProcessesProvider'
    );
  }
  return ctx;
};
