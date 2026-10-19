import { describe, expect, it } from 'vitest';
import {
  QUEUE_STATUS_REFETCH_INTERVAL_MS,
  QUEUE_STATUS_RUNNING_REFETCH_INTERVAL_MS,
  advanceQueueTracking,
  didQueueDrain,
  queueStatusRefetchInterval,
} from './queueReconciliation';

describe('queue reconciliation', () => {
  it('polls while work is queued or a turn is running', () => {
    expect(queueStatusRefetchInterval({ status: 'queued', messages: [] })).toBe(
      QUEUE_STATUS_REFETCH_INTERVAL_MS
    );
    expect(
      queueStatusRefetchInterval({ status: 'queued', messages: [] }, true)
    ).toBe(QUEUE_STATUS_REFETCH_INTERVAL_MS);
    expect(queueStatusRefetchInterval({ status: 'empty' })).toBe(false);
    expect(queueStatusRefetchInterval(undefined)).toBe(false);
  });

  it('keeps checking an empty queue while a turn runs, for messages queued elsewhere', () => {
    expect(queueStatusRefetchInterval({ status: 'empty' }, true)).toBe(
      QUEUE_STATUS_RUNNING_REFETCH_INTERVAL_MS
    );
    expect(queueStatusRefetchInterval(undefined, true)).toBe(
      QUEUE_STATUS_RUNNING_REFETCH_INTERVAL_MS
    );
  });

  it('reconciles execution state when queued work leaves the queue', () => {
    expect(didQueueDrain(true, false)).toBe(true);
    expect(didQueueDrain(true, true)).toBe(false);
    expect(didQueueDrain(false, false)).toBe(false);
    expect(didQueueDrain(false, true)).toBe(false);
  });

  it('reconciles each split panel independently after it observes the drain', () => {
    const initial = { sessionId: 'session-a', wasQueued: false };
    const panelAQueued = advanceQueueTracking(initial, 'session-a', true);
    const panelBQueued = advanceQueueTracking(initial, 'session-a', true);

    const panelAStillWaiting = advanceQueueTracking(
      panelAQueued.state,
      'session-a',
      true
    );
    const panelBObservedDrain = advanceQueueTracking(
      panelBQueued.state,
      'session-a',
      false
    );

    expect(panelAStillWaiting.shouldReconcile).toBe(false);
    expect(panelBObservedDrain.shouldReconcile).toBe(true);
  });

  it('does not reconcile stale queue state after switching sessions', () => {
    const result = advanceQueueTracking(
      { sessionId: 'session-a', wasQueued: true },
      'session-b',
      false
    );

    expect(result).toEqual({
      state: { sessionId: 'session-b', wasQueued: false },
      shouldReconcile: false,
    });
  });
});
