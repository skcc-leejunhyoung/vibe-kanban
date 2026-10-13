import { describe, expect, it } from 'vitest';
import type { ExecutorConfig } from 'shared/types';
import {
  createPendingProcess,
  isPendingProcessId,
  mergeOptimisticProcesses,
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

  it('is excluded once the real process is streamed and the add is cleared', () => {
    const pending = createPendingProcess('session-a', 'hello', config);
    const streamed = [{ ...pending, id: 'real-1' }];
    expect(
      mergeOptimisticProcesses(streamed, {}, 'session-a').map((p) => p.id)
    ).toEqual(['real-1']);
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
