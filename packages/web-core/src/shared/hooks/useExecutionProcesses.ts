import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useJsonPatchWsStream } from '@/shared/hooks/useJsonPatchWsStream';
import {
  advanceExecutionActivity,
  TERMINAL_EXECUTION_RECONCILE_DELAY_MS,
} from '@/shared/lib/executionProcessReconciliation';
import { EXECUTION_PROCESS_STREAM_SILENCE_TIMEOUT_MS } from '@/shared/lib/wsStreamHeartbeat';
import { useHostId } from '@/shared/providers/HostIdProvider';
import type { ExecutionProcess } from 'shared/types';

type ExecutionProcessState = {
  execution_processes: Record<string, ExecutionProcess>;
};

const isAttemptProcess = (process: ExecutionProcess) =>
  process.run_reason === 'codingagent' ||
  process.run_reason === 'setupscript' ||
  process.run_reason === 'cleanupscript' ||
  process.run_reason === 'archivescript';

interface UseExecutionProcessesResult {
  executionProcesses: ExecutionProcess[];
  executionProcessesById: Record<string, ExecutionProcess>;
  isAttemptRunning: boolean;
  isLoading: boolean;
  isConnected: boolean;
  error: string | null;
  reconcile: () => void;
}

/**
 * Stream execution processes for a session via WebSocket (JSON Patch) and expose as array + map.
 * Server sends initial snapshot: replace /execution_processes with an object keyed by id.
 * Live updates arrive at /execution_processes/<id> via add/replace/remove operations.
 */
export const useExecutionProcesses = (
  sessionId: string | undefined,
  opts?: { showSoftDeleted?: boolean }
): UseExecutionProcessesResult => {
  const hostId = useHostId();
  const showSoftDeleted = opts?.showSoftDeleted;
  let endpoint: string | undefined;

  if (sessionId) {
    const apiBasePath = hostId ? `/api/host/${hostId}` : '/api';
    const params = new URLSearchParams({ session_id: sessionId });
    if (typeof showSoftDeleted === 'boolean') {
      params.set('show_soft_deleted', String(showSoftDeleted));
    }
    endpoint = `${apiBasePath}/execution-processes/stream/session/ws?${params.toString()}`;
  }

  const initialData = useCallback(
    (): ExecutionProcessState => ({ execution_processes: {} }),
    []
  );
  const shouldReconcileAfterSilence = useCallback(
    (state: ExecutionProcessState) =>
      Object.values(state.execution_processes).some(
        (process) => process.status === 'running'
      ),
    []
  );
  const selectRunningState = useCallback(
    (state: ExecutionProcessState) =>
      Object.values(state.execution_processes).some(
        (process) =>
          process.session_id === sessionId &&
          isAttemptProcess(process) &&
          process.status === 'running'
      ),
    [sessionId]
  );
  const terminalReconcileTimerRef = useRef<number | null>(null);
  const clearTerminalReconcile = useCallback(() => {
    if (terminalReconcileTimerRef.current !== null) {
      window.clearTimeout(terminalReconcileTimerRef.current);
      terminalReconcileTimerRef.current = null;
    }
  }, []);

  const { data, isConnected, isInitialized, error, reconcile, flush } =
    useJsonPatchWsStream<ExecutionProcessState>(
      endpoint,
      !!sessionId,
      initialData,
      // Re-serve the last snapshot instantly when returning to a session, so
      // the conversation can render from cache while the stream re-syncs.
      {
        keepSnapshotForEndpoint: true,
        silenceTimeoutMs: EXECUTION_PROCESS_STREAM_SILENCE_TIMEOUT_MS,
        shouldReconcileAfterSilence,
        patchObserver: {
          selectState: selectRunningState,
          onApplied(states, previous, current, isReady) {
            let activity = {
              sessionId,
              wasRunning: selectRunningState(previous),
            };
            let shouldReconcile = false;
            for (const running of states) {
              const transition = advanceExecutionActivity(
                activity,
                sessionId,
                running
              );
              activity = transition.state;
              shouldReconcile = running
                ? false
                : shouldReconcile || transition.shouldReconcile;
            }

            // The server can coalesce a short execution into a terminal row.
            // Initial history is a baseline, not a live completion event.
            shouldReconcile ||=
              isReady &&
              Object.values(current.execution_processes).some(
                (process) =>
                  process.session_id === sessionId &&
                  isAttemptProcess(process) &&
                  process.status !== 'running' &&
                  !previous.execution_processes[process.id]
              );

            if (activity.wasRunning || shouldReconcile)
              clearTerminalReconcile();
            if (activity.wasRunning || !shouldReconcile) return;

            // A continuation may start just before this handoff deadline.
            // Flush first: its observed state can cancel/replace this timer
            // synchronously, without waiting for React to render the batch.
            const timerId = window.setTimeout(() => {
              flush();
              if (terminalReconcileTimerRef.current !== timerId) return;
              terminalReconcileTimerRef.current = null;
              reconcile();
            }, TERMINAL_EXECUTION_RECONCILE_DELAY_MS);
            terminalReconcileTimerRef.current = timerId;
          },
        },
      }
    );

  useEffect(() => clearTerminalReconcile, [clearTerminalReconcile, reconcile]);

  const { executionProcesses, executionProcessesById, isAttemptRunning } =
    useMemo(() => {
      const streamedExecutionProcesses = Object.values(
        data?.execution_processes ?? {}
      ).sort(
        (a, b) =>
          new Date(a.created_at as unknown as string).getTime() -
          new Date(b.created_at as unknown as string).getTime()
      );

      // Guard against stale buffered stream data when switching sessions quickly.
      const executionProcesses = sessionId
        ? streamedExecutionProcesses.filter(
            (executionProcess) => executionProcess.session_id === sessionId
          )
        : streamedExecutionProcesses;

      const executionProcessesById = executionProcesses.reduce<
        Record<string, ExecutionProcess>
      >((processesById, executionProcess) => {
        processesById[executionProcess.id] = executionProcess;
        return processesById;
      }, {});

      const isAttemptRunning = executionProcesses.some(
        (process) => isAttemptProcess(process) && process.status === 'running'
      );
      return { executionProcesses, executionProcessesById, isAttemptRunning };
    }, [data, sessionId]);
  // Loading until the first snapshot — unless a cached snapshot is already
  // being served (data defined pre-Ready), which renders immediately.
  const isLoading = !!sessionId && !isInitialized && !error && !data;

  return {
    executionProcesses,
    executionProcessesById,
    isAttemptRunning,
    isLoading,
    isConnected,
    error,
    reconcile,
  };
};
