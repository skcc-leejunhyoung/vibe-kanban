import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useExecutionProcesses } from '@/shared/hooks/useExecutionProcesses';
import { type ExecutionProcess, ExecutionProcessStatus } from 'shared/types';
import {
  ExecutionProcessesContext,
  type ExecutionProcessesContextType,
} from '@/shared/hooks/useExecutionProcessesContext';

// Optimistic overlay on the streamed process list, so chat interactions
// (send / stop / reset) reflect immediately instead of waiting for the WS
// stream round-trip. Each op is keyed by process id and superseded once the
// stream confirms it.
type OptimisticOp =
  | { kind: 'add'; process: ExecutionProcess }
  | { kind: 'patch'; changes: Partial<ExecutionProcess> }
  | { kind: 'remove' };

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

  const [optimistic, setOptimistic] = useState<Record<string, OptimisticOp>>(
    {}
  );

  const addOptimisticProcess = useCallback((process: ExecutionProcess) => {
    setOptimistic((current) => {
      if (current[process.id]?.kind === 'add') return current;
      // Force `running` so the new turn (and the running indicator) show right
      // away; the authoritative status arrives on the stream moments later.
      return {
        ...current,
        [process.id]: {
          kind: 'add',
          process: { ...process, status: ExecutionProcessStatus.running },
        },
      };
    });
  }, []);

  const patchOptimisticProcess = useCallback(
    (id: string, changes: Partial<ExecutionProcess>) => {
      setOptimistic((current) => {
        // A process still only in an optimistic `add` (its streamed row hasn't
        // arrived yet) has no streamed row for a bare `patch` to apply to, so
        // replacing the `add` would make the just-added turn vanish until the
        // stream catches up. Fold the change into the add instead.
        const existing = current[id];
        if (existing?.kind === 'add') {
          return {
            ...current,
            [id]: {
              kind: 'add',
              process: { ...existing.process, ...changes },
            },
          };
        }
        return { ...current, [id]: { kind: 'patch', changes } };
      });
    },
    []
  );

  const removeOptimisticProcess = useCallback((id: string) => {
    setOptimistic((current) => ({ ...current, [id]: { kind: 'remove' } }));
  }, []);

  const clearOptimisticProcess = useCallback((id: string) => {
    setOptimistic((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);

  // Clear the overlay when the session changes (the provider isn't remounted
  // per session — only its sessionId prop changes).
  useEffect(() => {
    setOptimistic({});
  }, [sessionId]);

  // Drop each op once the stream confirms it.
  useEffect(() => {
    setOptimistic((current) => {
      const ids = Object.keys(current);
      if (ids.length === 0) return current;
      let changed = false;
      const next = { ...current };
      for (const id of ids) {
        const op = current[id];
        const streamed = executionProcessesById[id];
        let drop = false;
        if (op.kind === 'add') drop = !!streamed;
        else if (op.kind === 'remove') drop = !streamed || !!streamed.dropped;
        else if (op.kind === 'patch')
          drop =
            !!streamed && streamed.status !== ExecutionProcessStatus.running;
        if (drop) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [executionProcessesById]);

  const hasOptimistic = Object.keys(optimistic).length > 0;

  // Apply removes/patches to streamed rows, then append adds not yet streamed.
  const mergedAll = useMemo(() => {
    if (!hasOptimistic) return executionProcesses;
    const streamedIds = new Set(executionProcesses.map((p) => p.id));
    const result: ExecutionProcess[] = [];
    for (const p of executionProcesses) {
      const op = optimistic[p.id];
      if (op?.kind === 'remove') continue;
      result.push(op?.kind === 'patch' ? { ...p, ...op.changes } : p);
    }
    for (const [id, op] of Object.entries(optimistic)) {
      if (op.kind === 'add' && !streamedIds.has(id)) result.push(op.process);
    }
    return result.sort(
      (a, b) =>
        new Date(a.created_at as unknown as string).getTime() -
        new Date(b.created_at as unknown as string).getTime()
    );
  }, [executionProcesses, optimistic, hasOptimistic]);

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
      patchOptimisticProcess,
      removeOptimisticProcess,
      clearOptimisticProcess,
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
      patchOptimisticProcess,
      removeOptimisticProcess,
      clearOptimisticProcess,
    ]
  );

  return (
    <ExecutionProcessesContext.Provider value={value}>
      {children}
    </ExecutionProcessesContext.Provider>
  );
};
