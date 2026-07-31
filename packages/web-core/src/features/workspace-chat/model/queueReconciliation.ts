import type { QueueStatus } from 'shared/types';

export const QUEUE_STATUS_REFETCH_INTERVAL_MS = 1000;

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
