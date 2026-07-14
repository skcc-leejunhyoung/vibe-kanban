import { describe, expect, it } from 'vitest';
import type { ExecutionProcess } from 'shared/types';
import {
  belongsToSession,
  mergeOptimisticProcesses,
  type OptimisticOp,
} from './executionProcessScope';

const process = (sessionId: string) =>
  ({ session_id: sessionId }) as ExecutionProcess;

const proc = (
  id: string,
  sessionId: string,
  overrides: Partial<ExecutionProcess> = {}
) =>
  ({
    id,
    session_id: sessionId,
    created_at: '2026-07-15T00:00:00Z',
    status: 'running',
    ...overrides,
  }) as ExecutionProcess;

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

describe('mergeOptimisticProcesses', () => {
  it('returns the streamed list by reference when there is no overlay', () => {
    const streamed = [proc('p1', 'session-a')];
    expect(mergeOptimisticProcesses(streamed, {}, 'session-a')).toBe(streamed);
  });

  it('appends an optimistic add for the selected session', () => {
    const added = proc('p2', 'session-a');
    const optimistic: Record<string, OptimisticOp> = {
      p2: { kind: 'add', process: added },
    };
    const merged = mergeOptimisticProcesses([], optimistic, 'session-a');
    expect(merged.map((p) => p.id)).toEqual(['p2']);
  });

  it('excludes an optimistic add after switching to another session (A → B)', () => {
    // The pending send for session A resolves while session B is selected; its
    // process must not surface under B.
    const added = proc('p2', 'session-a');
    const optimistic: Record<string, OptimisticOp> = {
      p2: { kind: 'add', process: added },
    };
    const merged = mergeOptimisticProcesses([], optimistic, 'session-b');
    expect(merged).toEqual([]);
  });

  it('excludes an optimistic add when no session is selected', () => {
    const optimistic: Record<string, OptimisticOp> = {
      p2: { kind: 'add', process: proc('p2', 'session-a') },
    };
    expect(mergeOptimisticProcesses([], optimistic, undefined)).toEqual([]);
  });

  it('drops a streamed row marked for optimistic removal', () => {
    const streamed = [proc('p1', 'session-a'), proc('p2', 'session-a')];
    const optimistic: Record<string, OptimisticOp> = {
      p1: { kind: 'remove' },
    };
    const merged = mergeOptimisticProcesses(streamed, optimistic, 'session-a');
    expect(merged.map((p) => p.id)).toEqual(['p2']);
  });

  it('applies an optimistic patch to a streamed row', () => {
    const streamed = [proc('p1', 'session-a', { status: 'running' })];
    const optimistic: Record<string, OptimisticOp> = {
      p1: { kind: 'patch', changes: { status: 'killed' } as never },
    };
    const merged = mergeOptimisticProcesses(streamed, optimistic, 'session-a');
    expect(merged[0].status).toBe('killed');
  });

  it('does not duplicate an add whose row has already streamed', () => {
    const streamed = [proc('p2', 'session-a')];
    const optimistic: Record<string, OptimisticOp> = {
      p2: { kind: 'add', process: proc('p2', 'session-a') },
    };
    const merged = mergeOptimisticProcesses(streamed, optimistic, 'session-a');
    expect(merged.map((p) => p.id)).toEqual(['p2']);
  });
});
