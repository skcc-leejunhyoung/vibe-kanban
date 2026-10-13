import { describe, expect, it } from 'vitest';
import type { ExecutorConfig } from 'shared/types';
import {
  createPendingProcess,
  isPendingProcessId,
  keepOptimisticAdds,
  mergeOptimisticProcesses,
  reconcileOptimisticOps,
  type OptimisticOp,
} from './executionProcessScope';

const config = { executor: 'CLAUDE_CODE' } as ExecutorConfig;

describe('createPendingProcess', () => {
  it('renders as a running follow-up turn for the session', () => {
    const pending = createPendingProcess('session-a', 'hello', config);
    expect(isPendingProcessId(pending.id)).toBe(true);
    expect(pending.session_id).toBe('session-a');
    expect(pending.status).toBe('running');
    expect(pending.run_reason).toBe('codingagent');
    expect(pending.executor_action.typ).toMatchObject({
      type: 'CodingAgentFollowUpRequest',
      prompt: 'hello',
      executor_config: config,
    });
  });

  it('gets a fresh id per send so two pending turns never collide', () => {
    const a = createPendingProcess('s', 'one', config);
    const b = createPendingProcess('s', 'two', config);
    expect(a.id).not.toBe(b.id);
  });

  it('is kept across a session switch but hidden from the other session', () => {
    const pending = createPendingProcess('session-a', 'hello', config);
    const ops: Record<string, OptimisticOp> = {
      [pending.id]: { kind: 'add', process: pending },
      other: { kind: 'patch', changes: { status: 'killed' as const } },
      gone: { kind: 'remove' },
    };
    const kept = keepOptimisticAdds(ops);
    expect(Object.keys(kept)).toEqual([pending.id]);
    expect(mergeOptimisticProcesses([], kept, 'session-b')).toEqual([]);
    expect(
      mergeOptimisticProcesses([], kept, 'session-a').map((p) => p.id)
    ).toEqual([pending.id]);
    // Nothing to drop → same object (keeps memoization downstream intact).
    expect(keepOptimisticAdds(kept)).toBe(kept);
  });
});

describe('reconcileOptimisticOps', () => {
  const real = createPendingProcess('s', 'hi', config);
  const streamedRunning = { ...real, id: 'real-1' };
  const streamedKilled = { ...streamedRunning, status: 'killed' as const };

  it('drops a confirmed add and leaves an unconfirmed one', () => {
    const ops: Record<string, OptimisticOp> = {
      'real-1': { kind: 'add', process: streamedRunning },
      [real.id]: { kind: 'add', process: real },
    };
    const next = reconcileOptimisticOps(ops, { 'real-1': streamedRunning });
    expect(Object.keys(next)).toEqual([real.id]);
  });

  it('keeps an optimistic kill folded into an add until the stream agrees', () => {
    const ops: Record<string, OptimisticOp> = {
      'real-1': { kind: 'add', process: streamedKilled },
    };
    const next = reconcileOptimisticOps(ops, { 'real-1': streamedRunning });
    expect(next['real-1']).toEqual({
      kind: 'patch',
      changes: { status: 'killed' },
    });
    // Stream reports the terminal status → nothing left to overlay.
    expect(reconcileOptimisticOps(next, { 'real-1': streamedKilled })).toEqual(
      {}
    );
  });

  it('returns the same object when nothing changed', () => {
    const ops: Record<string, OptimisticOp> = {
      'real-1': { kind: 'patch', changes: { status: 'killed' as const } },
    };
    expect(reconcileOptimisticOps(ops, { 'real-1': streamedRunning })).toBe(
      ops
    );
    expect(reconcileOptimisticOps({}, {})).toEqual({});
  });

  it('never sorts before an existing process when the client clock lags', () => {
    const serverAhead = Date.now() + 60_000;
    const pending = createPendingProcess('s', 'hi', config, serverAhead);
    expect(Date.parse(pending.created_at)).toBeGreaterThan(serverAhead);
    // Without a floor it is simply "now".
    const plain = createPendingProcess('s', 'hi', config);
    expect(Date.parse(plain.created_at)).toBeLessThanOrEqual(Date.now());
  });

  it('does not flag server ids as pending', () => {
    expect(isPendingProcessId('4b1d1f5e-0000-4000-8000-000000000000')).toBe(
      false
    );
  });
});
