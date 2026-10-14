import { describe, expect, it } from 'vitest';
import type { ExecutorConfig } from 'shared/types';
import {
  createPendingProcess,
  isPendingProcessId,
  keepOptimisticAdds,
  matchArrivedProcess,
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

describe('mergeOptimisticProcesses with a stop folded into an add', () => {
  it('shows the stop on the streamed row until the server reports it', () => {
    const row = { ...createPendingProcess('s', 'hi', config), id: 'real-1' };
    const ops: Record<string, OptimisticOp> = {
      'real-1': { kind: 'add', process: { ...row, status: 'killed' } },
    };
    expect(mergeOptimisticProcesses([row], ops, 's')[0].status).toBe('killed');
    const done = { ...row, status: 'completed' as const };
    expect(mergeOptimisticProcesses([done], ops, 's')[0].status).toBe(
      'completed'
    );
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

describe('matchArrivedProcess', () => {
  const sent = createPendingProcess('s', 'do the thing', config);
  const real = { ...sent, id: 'real-1' };
  const pending = {
    sessionId: 's',
    knownIds: new Set(['old-1']),
    prompt: 'do the thing',
  };

  it('finds the new coding-agent row carrying the sent prompt', () => {
    const old = { ...real, id: 'old-1' };
    expect(matchArrivedProcess([old, sent, real], pending)).toBe(real);
  });

  it('matches a handoff by the user text, not its bootstrap prompt', () => {
    const handoff = createPendingProcess('s', 'do the thing', config, 0, {
      handoffFrom: 'CLAUDE_CODE' as never,
    });
    expect(handoff.executor_action.typ).toMatchObject({
      type: 'CodingAgentInitialRequest',
      handoff_user_prompt: 'do the thing',
    });
    const arrived = {
      ...handoff,
      id: 'real-h',
      executor_action: {
        typ: { ...handoff.executor_action.typ, prompt: 'bootstrap text' },
        next_action: null,
      },
    };
    expect(matchArrivedProcess([arrived], pending)).toBe(arrived);
  });

  it('ignores rows known at send time, placeholders, other sessions, other prompts', () => {
    const other = {
      ...real,
      id: 'real-2',
      executor_action: {
        typ: { ...real.executor_action.typ, prompt: 'something else' },
        next_action: null,
      },
    };
    const foreign = { ...real, id: 'real-3', session_id: 'other' };
    expect(
      matchArrivedProcess(
        [{ ...real, id: 'old-1' }, sent, other, foreign],
        pending
      )
    ).toBeUndefined();
  });
});
