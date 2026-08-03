export const TERMINAL_EXECUTION_RECONCILE_DELAY_MS = 1_000;

export interface ExecutionActivityState {
  sessionId: string | undefined;
  wasRunning: boolean;
}

export const advanceExecutionActivity = (
  previous: ExecutionActivityState,
  sessionId: string | undefined,
  isRunning: boolean
): {
  state: ExecutionActivityState;
  shouldReconcile: boolean;
} => {
  const isSameSession = previous.sessionId === sessionId;

  return {
    state: { sessionId, wasRunning: isRunning },
    shouldReconcile: isSameSession && previous.wasRunning && !isRunning,
  };
};
