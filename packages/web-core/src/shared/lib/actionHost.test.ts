import { describe, expect, it } from 'vitest';
import type { ActionExecutorContext } from '@/shared/types/actions';
import { resolveActionHost } from './actionHost';

const scope = (currentHostId: string | null) =>
  ({ currentHostId, userId: 'synthetic' }) as unknown as ActionExecutorContext;

describe('action host', () => {
  it('fixes an unnamed target to the dispatching scope’s host', () => {
    const onB = scope('host-b');
    expect(resolveActionHost(undefined, onB)).toEqual({
      hostId: 'host-b',
      context: onB,
    });
    const onThisMachine = scope(null);
    expect(resolveActionHost(undefined, onThisMachine)).toEqual({
      hostId: null,
      context: onThisMachine,
    });
  });

  it('keeps an explicit target, this machine included', () => {
    const onB = scope('host-b');
    expect(resolveActionHost(null, onB).hostId).toBeNull();
    expect(resolveActionHost('host-c', onB).hostId).toBe('host-c');
  });

  it('hands context-reading actions the target instead of the scope host', () => {
    const onB = scope('host-b');
    const { context } = resolveActionHost(null, onB);
    expect(context.currentHostId).toBeNull();
    expect(context.userId).toBe('synthetic');
    // The scope's own context is left untouched for the next action.
    expect(onB.currentHostId).toBe('host-b');
  });

  it('reuses the context when the target is the scope host', () => {
    const onB = scope('host-b');
    expect(resolveActionHost('host-b', onB).context).toBe(onB);
  });
});
