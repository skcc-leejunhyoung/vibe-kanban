import { describe, expect, it } from 'vitest';
import type { ExecutionProcess } from 'shared/types';
import { devServerStreamSignature } from './devServerUtils';

const process = (
  id: string,
  run_reason: string,
  status: string
): ExecutionProcess =>
  ({ id, run_reason, status }) as unknown as ExecutionProcess;

describe('devServerStreamSignature', () => {
  it('ignores non dev-server processes', () => {
    const before = [
      process('a', 'devserver', 'running'),
      process('b', 'codingagent', 'running'),
    ];
    const after = [
      process('a', 'devserver', 'running'),
      process('b', 'codingagent', 'completed'),
    ];
    expect(devServerStreamSignature(after)).toBe(
      devServerStreamSignature(before)
    );
  });

  it('changes when a dev server starts, stops, or dies', () => {
    const none = devServerStreamSignature([]);
    const running = devServerStreamSignature([
      process('a', 'devserver', 'running'),
    ]);
    const killed = devServerStreamSignature([
      process('a', 'devserver', 'killed'),
    ]);
    expect(new Set([none, running, killed]).size).toBe(3);
  });

  it('treats a missing stream as no dev servers', () => {
    expect(devServerStreamSignature(undefined)).toBe('');
  });
});
