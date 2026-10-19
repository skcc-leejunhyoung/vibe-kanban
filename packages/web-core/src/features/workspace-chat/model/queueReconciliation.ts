import type { QueueStatus } from 'shared/types';

export const QUEUE_STATUS_REFETCH_INTERVAL_MS = 1000;
// Slower check while a turn is ahead (running, or an auto-resume scheduled)
// with nothing queued here: another tab, device or the API can queue behind
// it, and there is no push stream.
export const QUEUE_STATUS_RUNNING_REFETCH_INTERVAL_MS = 5000;

export interface QueueTrackingState {
  sessionId: string | undefined;
  wasQueued: boolean;
}

export function queueStatusRefetchInterval(
  status: QueueStatus | undefined,
  hasTurnAhead = false
): number | false {
  if (status?.status === 'queued') return QUEUE_STATUS_REFETCH_INTERVAL_MS;
  return hasTurnAhead ? QUEUE_STATUS_RUNNING_REFETCH_INTERVAL_MS : false;
}

export function didQueueDrain(
  previouslyQueued: boolean,
  isQueued: boolean
): boolean {
  return previouslyQueued && !isQueued;
}

export function advanceQueueTracking(
  previous: QueueTrackingState,
  sessionId: string | undefined,
  isQueued: boolean
): { state: QueueTrackingState; shouldReconcile: boolean } {
  if (previous.sessionId !== sessionId) {
    return {
      state: { sessionId, wasQueued: isQueued },
      shouldReconcile: false,
    };
  }

  return {
    state: { sessionId, wasQueued: isQueued },
    shouldReconcile: didQueueDrain(previous.wasQueued, isQueued),
  };
}
