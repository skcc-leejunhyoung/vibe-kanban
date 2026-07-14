import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useExecutionProcesses } from '@/shared/hooks/useExecutionProcesses';
import { type ExecutionProcess, ExecutionProcessStatus } from 'shared/types';
import {
  ExecutionProcessesContext,
  type ExecutionProcessesContextType,
} from '@/shared/hooks/useExecutionProcessesContext';

export const ExecutionProcessesProvider: React.FC<{
  sessionId?: string | undefined;
  children: React.ReactNode;
}> = ({ sessionId, children }) => {
  const {
    executionProcesses,
    executionProcessesById,
    isAttemptRunning,
    isLoading,
    isConnected,
    error,
  } = useExecutionProcesses(sessionId, { showSoftDeleted: true });

  // Optimistic processes: rows injected by the sender (from the follow-up POST
  // response) so the just-sent turn renders immediately, before the WS stream
  // delivers the same process. Superseded by the streamed row (same id).
  const [optimisticProcesses, setOptimisticProcesses] = useState<
    ExecutionProcess[]
  >([]);

  const addOptimisticProcess = useCallback((process: ExecutionProcess) => {
    setOptimisticProcesses((current) => {
      if (current.some((p) => p.id === process.id)) return current;
      // Force `running` so the new turn (and the running indicator) show right
      // away; the authoritative status arrives on the stream moments later.
      return [
        ...current,
        { ...process, status: ExecutionProcessStatus.running },
      ];
    });
  }, []);

  const streamedIds = useMemo(
    () => new Set(executionProcesses.map((p) => p.id)),
    [executionProcesses]
  );

  // Clear optimistic rows when the session changes (the provider isn't
  // remounted per session — only its sessionId prop changes).
  useEffect(() => {
    setOptimisticProcesses([]);
  }, [sessionId]);

  // Drop an optimistic row once the real one arrives on the stream.
  useEffect(() => {
    setOptimisticProcesses((current) => {
      const next = current.filter((p) => !streamedIds.has(p.id));
      return next.length === current.length ? current : next;
    });
  }, [streamedIds]);

  // Streamed rows win; optimistic rows only fill in ids not yet streamed.
  const mergedAll = useMemo(() => {
    const extras = optimisticProcesses.filter((p) => !streamedIds.has(p.id));
    if (extras.length === 0) return executionProcesses;
    return [...executionProcesses, ...extras].sort(
      (a, b) =>
        new Date(a.created_at as unknown as string).getTime() -
        new Date(b.created_at as unknown as string).getTime()
    );
  }, [executionProcesses, optimisticProcesses, streamedIds]);

  const mergedById = useMemo(() => {
    if (mergedAll === executionProcesses) return executionProcessesById;
    const m: Record<string, ExecutionProcess> = {};
    for (const p of mergedAll) m[p.id] = p;
    return m;
  }, [mergedAll, executionProcesses, executionProcessesById]);

  const mergedIsAttemptRunning = useMemo(
    () =>
      mergedAll === executionProcesses
        ? isAttemptRunning
        : mergedAll.some(
            (process) =>
              (process.run_reason === 'codingagent' ||
                process.run_reason === 'setupscript' ||
                process.run_reason === 'cleanupscript' ||
                process.run_reason === 'archivescript') &&
              process.status === 'running'
          ),
    [mergedAll, executionProcesses, isAttemptRunning]
  );

  const visible = useMemo(() => {
    return mergedAll.filter((p) => !p.dropped);
  }, [mergedAll]);

  const executionProcessesByIdVisible = useMemo(() => {
    const m: Record<string, ExecutionProcess> = {};
    for (const p of visible) m[p.id] = p;
    return m;
  }, [visible]);

  const isAttemptRunningVisible = useMemo(
    () =>
      visible.some(
        (process) =>
          (process.run_reason === 'codingagent' ||
            process.run_reason === 'cleanupscript' ||
            process.run_reason === 'archivescript') &&
          process.status === 'running'
      ),
    [visible]
  );

  const value = useMemo<ExecutionProcessesContextType>(
    () => ({
      executionProcessesAll: mergedAll,
      executionProcessesByIdAll: mergedById,
      isAttemptRunningAll: mergedIsAttemptRunning,
      executionProcessesVisible: visible,
      executionProcessesByIdVisible,
      isAttemptRunningVisible,
      isLoading,
      isConnected,
      error,
      addOptimisticProcess,
    }),
    [
      mergedAll,
      mergedById,
      mergedIsAttemptRunning,
      visible,
      executionProcessesByIdVisible,
      isAttemptRunningVisible,
      isLoading,
      isConnected,
      error,
      addOptimisticProcess,
    ]
  );

  return (
    <ExecutionProcessesContext.Provider value={value}>
      {children}
    </ExecutionProcessesContext.Provider>
  );
};
