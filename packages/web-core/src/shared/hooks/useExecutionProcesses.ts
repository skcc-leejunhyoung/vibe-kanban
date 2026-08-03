import { useCallback, useEffect, useRef } from 'react';
import { useJsonPatchWsStream } from '@/shared/hooks/useJsonPatchWsStream';
import {
  advanceExecutionActivity,
  TERMINAL_EXECUTION_RECONCILE_DELAY_MS,
  type ExecutionActivityState,
} from '@/shared/lib/executionProcessReconciliation';
import { EXECUTION_PROCESS_STREAM_SILENCE_TIMEOUT_MS } from '@/shared/lib/wsStreamHeartbeat';
import { useHostId } from '@/shared/providers/HostIdProvider';
import type { ExecutionProcess } from 'shared/types';

type ExecutionProcessState = {
  execution_processes: Record<string, ExecutionProcess>;
};

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

  const { data, isConnected, isInitialized, error, reconcile } =
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
      }
    );

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
    (process) =>
      (process.run_reason === 'codingagent' ||
        process.run_reason === 'setupscript' ||
        process.run_reason === 'cleanupscript' ||
        process.run_reason === 'archivescript') &&
      process.status === 'running'
  );
  const executionActivityRef = useRef<ExecutionActivityState>({
    sessionId,
    wasRunning: false,
  });

  useEffect(() => {
    const transition = advanceExecutionActivity(
      executionActivityRef.current,
      sessionId,
      isAttemptRunning
    );
    executionActivityRef.current = transition.state;

    if (!transition.shouldReconcile) return;

    // Vibe and other server-driven continuations are created after the
    // completed-process patch. Reconnect once after that handoff window so a
    // missed child-process add cannot leave the conversation stale forever.
    const timeoutId = window.setTimeout(
      reconcile,
      TERMINAL_EXECUTION_RECONCILE_DELAY_MS
    );
    return () => window.clearTimeout(timeoutId);
  }, [isAttemptRunning, reconcile, sessionId]);

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
