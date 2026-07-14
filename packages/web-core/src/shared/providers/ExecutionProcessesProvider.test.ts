import { describe, expect, it } from 'vitest';
import type { ExecutionProcess } from 'shared/types';
import { belongsToSession } from './executionProcessScope';

const process = (sessionId: string) =>
  ({ session_id: sessionId }) as ExecutionProcess;

describe('belongsToSession', () => {
  it('accepts an optimistic process for the selected session', () => {
    expect(belongsToSession(process('session-a'), 'session-a')).toBe(true);
  });

  it('rejects a follow-up that resolves after switching sessions', () => {
    expect(belongsToSession(process('session-a'), 'session-b')).toBe(false);
  });

  it('rejects optimistic processes when no session is selected', () => {
    expect(belongsToSession(process('session-a'), undefined)).toBe(false);
  });
});
