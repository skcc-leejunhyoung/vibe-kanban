import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { useExecutionProcesses } from '@/shared/hooks/useExecutionProcesses';
import { type ExecutionProcess, ExecutionProcessStatus } from 'shared/types';
import {
  ExecutionProcessesContext,
  type ExecutionProcessesContextType,
} from '@/shared/hooks/useExecutionProcessesContext';
import {
  belongsToSession,
  getSeededProcessesVersion,
  keepOptimisticAdds,
  mergeOptimisticProcesses,
  reconcileOptimisticOps,
  subscribeSeededProcesses,
  takeSeededProcesses,
  type OptimisticOp,
} from './executionProcessScope';

// Optimistic overlay on the streamed process list, so chat interactions
// (send / stop / reset) reflect immediately instead of waiting for the WS
// stream round-trip. Each op is keyed by process id and superseded once the
// stream confirms it. `OptimisticOp` + the merge are in executionProcessScope.

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
    reconcile,
  } = useExecutionProcesses(sessionId, { showSoftDeleted: true });

  const [optimistic, setOptimistic] = useState<Record<string, OptimisticOp>>(
    {}
  );

  const addOptimisticProcess = useCallback(
    (process: ExecutionProcess) => {
      // A follow-up request may resolve after the user has navigated away.
      // Its callback still targets this long-lived provider, so never attach
      // the old session's process to the newly selected conversation.
      if (!belongsToSession(process, sessionId)) return;

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
    },
    [sessionId]
  );

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

  // On a session change (the provider isn't remounted per session — only its
  // sessionId prop changes) drop patches/removes; adds are session-guarded in
  // the merge and survive, so a send still pending for the previous session
  // shows its turn again when the user returns.
  useEffect(() => {
    setOptimistic(keepOptimisticAdds);
  }, [sessionId]);

  // Pick up a process handed over for this session (a just-created workspace
  // or session, or a review started into the one on screen), so its turn is
  // there before the stream's replay.
  const seedVersion = useSyncExternalStore(
    subscribeSeededProcesses,
    getSeededProcessesVersion
  );
  useEffect(() => {
    takeSeededProcesses(sessionId).forEach(addOptimisticProcess);
  }, [sessionId, seedVersion, addOptimisticProcess]);

  // Drop each op once the stream confirms it (see reconcileOptimisticOps).
  useEffect(() => {
    setOptimistic((current) =>
      reconcileOptimisticOps(current, executionProcessesById)
    );
  }, [executionProcessesById]);

  // Apply removes/patches to streamed rows, then append adds not yet streamed
  // (session-scoped so a stale follow-up can't leak across a conversation
  // switch). See mergeOptimisticProcesses for the guard and its tests.
  const mergedAll = useMemo(
    () => mergeOptimisticProcesses(executionProcesses, optimistic, sessionId),
    [executionProcesses, optimistic, sessionId]
  );

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
      reconcile,
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
      reconcile,
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
