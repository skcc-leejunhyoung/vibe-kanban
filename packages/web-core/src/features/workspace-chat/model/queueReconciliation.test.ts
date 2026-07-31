import { describe, expect, it } from 'vitest';
import {
  QUEUE_STATUS_REFETCH_INTERVAL_MS,
  didQueueDrain,
  queueStatusRefetchInterval,
} from './queueReconciliation';

describe('queue reconciliation', () => {
  it('polls only while a session has queued work', () => {
    expect(queueStatusRefetchInterval({ status: 'queued', messages: [] })).toBe(
      QUEUE_STATUS_REFETCH_INTERVAL_MS
    );
    expect(queueStatusRefetchInterval({ status: 'empty' })).toBe(false);
    expect(queueStatusRefetchInterval(undefined)).toBe(false);
  });

  it('reconciles execution state when queued work leaves the queue', () => {
    expect(didQueueDrain(true, false)).toBe(true);
    expect(didQueueDrain(true, true)).toBe(false);
    expect(didQueueDrain(false, false)).toBe(false);
    expect(didQueueDrain(false, true)).toBe(false);
  });
});
