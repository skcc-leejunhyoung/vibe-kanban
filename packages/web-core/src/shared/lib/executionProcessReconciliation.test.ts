import { describe, expect, it } from 'vitest';
import { advanceExecutionActivity } from './executionProcessReconciliation';

describe('advanceExecutionActivity', () => {
  it('reconciles when an execution becomes idle in the same session', () => {
    const result = advanceExecutionActivity(
      { sessionId: 'session-a', wasRunning: true },
      'session-a',
      false
    );

    expect(result.shouldReconcile).toBe(true);
    expect(result.state).toEqual({ sessionId: 'session-a', wasRunning: false });
  });

  it('does not reconcile an initially idle session', () => {
    const result = advanceExecutionActivity(
      { sessionId: 'session-a', wasRunning: false },
      'session-a',
      false
    );

    expect(result.shouldReconcile).toBe(false);
  });

  it('does not treat a session switch as a completed execution', () => {
    const result = advanceExecutionActivity(
      { sessionId: 'session-a', wasRunning: true },
      'session-b',
      false
    );

    expect(result.shouldReconcile).toBe(false);
    expect(result.state).toEqual({ sessionId: 'session-b', wasRunning: false });
  });
});
