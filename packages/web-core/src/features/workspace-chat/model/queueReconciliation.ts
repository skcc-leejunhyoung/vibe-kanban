import type { QueueStatus } from 'shared/types';

export const QUEUE_STATUS_REFETCH_INTERVAL_MS = 1000;

export interface QueueTrackingState {
  sessionId: string | undefined;
  wasQueued: boolean;
}

export function queueStatusRefetchInterval(
  status: QueueStatus | undefined
): number | false {
  return status?.status === 'queued' ? QUEUE_STATUS_REFETCH_INTERVAL_MS : false;
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
