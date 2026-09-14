import { act, memo, Profiler, Suspense, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyPatch, type Operation } from 'rfc6902';
import { apply as applyOperation } from 'rfc6902/patch';
import { produce } from 'immer';
import type { ExecutionProcess } from 'shared/types';
import { setLocalApiTransport } from '@/shared/lib/localApiTransport';
import {
  clearWsSnapshots,
  getWsSnapshot,
  wsSnapshotKey,
} from '@/shared/lib/wsSnapshotCache';
import { ExecutionProcessesProvider } from '@/shared/providers/ExecutionProcessesProvider';
import { useExecutionProcessesContext } from './useExecutionProcessesContext';
import { useApprovals } from './useApprovals';
import { useExecutionProcesses } from './useExecutionProcesses';
import { useJsonPatchWsStream } from './useJsonPatchWsStream';

const host = vi.hoisted(() => ({ id: null as string | null }));
vi.mock('rfc6902', async (importOriginal) => {
  const actual = await importOriginal<typeof import('rfc6902')>();
  return { ...actual, applyPatch: vi.fn(actual.applyPatch) };
});
vi.mock('rfc6902/patch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('rfc6902/patch')>();
  return { ...actual, apply: vi.fn(actual.apply) };
});
vi.mock('immer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('immer')>();
  return { ...actual, produce: vi.fn(actual.produce) };
});
vi.mock('@/shared/providers/HostIdProvider', () => ({
  useHostId: () => host.id,
  getCurrentHostId: () => host.id,
}));

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; wasClean: boolean }) => void) | null = null;
  onerror = null;
  close = vi.fn(() => {
    this.readyState = 3;
  });

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  message(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  disconnect(code = 1006, wasClean = false) {
    this.readyState = 3;
    this.onclose?.({ code, wasClean });
  }
}

let root: Root;
let frames: Map<number, FrameRequestCallback>;

beforeEach(() => {
  vi.useFakeTimers();
  clearWsSnapshots();
  host.id = null;
  FakeWebSocket.instances = [];
  vi.mocked(applyPatch).mockClear();
  vi.mocked(applyOperation).mockClear();
  vi.mocked(produce).mockClear();
  frames = new Map();
  let frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.set(++frameId, cb);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

  // The probes render no DOM nodes. Only the root/event surface is needed;
  // React's actual effects, memoization, context and Profiler still run.
  vi.stubGlobal(
    'document',
    Object.assign(new EventTarget(), {
      nodeType: 9,
      visibilityState: 'visible',
      activeElement: null,
    })
  );
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      document,
      setTimeout,
      clearTimeout,
      HTMLIFrameElement: class {},
    })
  );
  const container = Object.assign(new EventTarget(), {
    nodeType: 1,
    tagName: 'DIV',
    ownerDocument: document,
  });
  root = createRoot(container as unknown as HTMLElement);
  setLocalApiTransport({
    request: vi.fn(),
    openWebSocket: (url) => new FakeWebSocket(url) as unknown as WebSocket,
  });
});

afterEach(async () => {
  await act(() => root.unmount());
  setLocalApiTransport(null);
  clearWsSnapshots();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function render(node: ReactNode) {
  await act(() => root.render(node));
}

async function renderHook<T>(useHook: () => T) {
  let result: T;
  const onRender = vi.fn();
  function Probe() {
    result = useHook();
    return (
      <Profiler id="hook" onRender={onRender}>
        {null}
      </Profiler>
    );
  }
  const rerender = () => render(<Probe />);
  await rerender();
  return {
    get result() {
      return result!;
    },
    rerender,
    onRender,
  };
}

async function flushFrame() {
  await act(() => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((cb) => cb(performance.now()));
  });
}

const initialData = () => ({ entries: [] as string[] });
const process = (id: string, sessionId = 'session-a') =>
  ({
    id,
    session_id: sessionId,
    created_at: '2026-09-03T00:00:00Z',
    status: 'completed',
    run_reason: 'codingagent',
  }) as ExecutionProcess;

describe('stream subscription identity', () => {
  it('keeps a socket for the same initializer reference', async () => {
    const hook = await renderHook(() =>
      useJsonPatchWsStream('/stream', true, initialData)
    );
    await hook.rerender();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].close).not.toHaveBeenCalled();
  });

  it('does not resubscribe when a render recreates the initializer', async () => {
    const hook = await renderHook(() =>
      useJsonPatchWsStream('/stream', true, () => ({ entries: [] }))
    );
    await hook.rerender();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('keeps one approvals connection through 60 seconds of parent renders', async () => {
    const hook = await renderHook(useApprovals);
    for (let frame = 0; frame < 3600; frame++) {
      const ws = FakeWebSocket.instances.at(-1)!;
      if (ws.readyState === 0) await act(() => ws.open());
      await hook.rerender();
      await act(() => vi.advanceTimersByTime(1000 / 60));
    }
    console.info(
      'approvals sockets / 3600 parent renders:',
      FakeWebSocket.instances.length
    );
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].close).not.toHaveBeenCalled();
  });

  it('uses the latest initializer on endpoint, host and enabled changes', async () => {
    let endpoint = '/a';
    let enabled = true;
    let seed = 'a';
    const hook = await renderHook(() =>
      useJsonPatchWsStream(endpoint, enabled, () => ({ entries: [seed] }), {
        keepSnapshotForEndpoint: true,
      })
    );
    const first = FakeWebSocket.instances[0];
    await act(() =>
      first.message({
        JsonPatch: [{ op: 'add', path: '/entries/-', value: 'old' }],
      })
    );
    seed = 'b';
    endpoint = '/b';
    await hook.rerender();
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(getWsSnapshot(wsSnapshotKey('/a', null))).toEqual({
      entries: ['a', 'old'],
    });
    expect(hook.result.data).toBeUndefined();
    expect(frames.size).toBe(0);
    await act(() =>
      FakeWebSocket.instances[1].message({
        JsonPatch: [{ op: 'add', path: '/entries/-', value: 'new' }],
      })
    );
    await flushFrame();
    expect(hook.result.data).toEqual({ entries: ['b', 'new'] });

    host.id = 'other-host';
    await hook.rerender();
    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(hook.result.data).toBeUndefined();
    enabled = false;
    await hook.rerender();
    expect(FakeWebSocket.instances[2].close).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTime(60_000));
    expect(FakeWebSocket.instances).toHaveLength(3);
    enabled = true;
    await hook.rerender();
    expect(FakeWebSocket.instances).toHaveLength(4);
  });
});

describe('execution process memoization', () => {
  it('keeps derived references until data or session changes', async () => {
    let sessionId = 'session-a';
    const hook = await renderHook(() => useExecutionProcesses(sessionId));
    const ws = FakeWebSocket.instances[0];
    await act(() => {
      ws.open();
      ws.message({
        JsonPatch: [
          {
            op: 'replace',
            path: '/execution_processes',
            value: {
              a: process('a'),
              b: process('b', 'session-b'),
            },
          },
        ],
      });
      ws.message({ Ready: true });
    });
    await flushFrame();
    const first = hook.result;
    await hook.rerender();
    expect(hook.result.executionProcesses).toBe(first.executionProcesses);
    expect(hook.result.executionProcessesById).toBe(
      first.executionProcessesById
    );
    expect(first.executionProcesses.map(({ id }) => id)).toEqual(['a']);

    await act(() =>
      ws.message({
        JsonPatch: [
          { op: 'add', path: '/execution_processes/c', value: process('c') },
        ],
      })
    );
    await flushFrame();
    expect(hook.result.executionProcesses).not.toBe(first.executionProcesses);
    expect(hook.result.executionProcesses.map(({ id }) => id)).toEqual([
      'a',
      'c',
    ]);
    sessionId = 'session-b';
    await hook.rerender();
    expect(hook.result.executionProcesses).toEqual([]);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('only commits context consumers when their data changes', async () => {
    const onRender = vi.fn();
    const Consumer = memo(function Consumer() {
      useExecutionProcessesContext();
      return (
        <Profiler id="consumer" onRender={onRender}>
          {null}
        </Profiler>
      );
    });
    const consumer = <Consumer />;
    const rerender = () =>
      render(
        <ExecutionProcessesProvider sessionId="session-a">
          {consumer}
        </ExecutionProcessesProvider>
      );
    await rerender();
    const ws = FakeWebSocket.instances[0];
    await act(() => {
      ws.open();
      ws.message({
        JsonPatch: [
          {
            op: 'replace',
            path: '/execution_processes',
            value: { a: process('a') },
          },
        ],
      });
      ws.message({ Ready: true });
    });
    await flushFrame();
    onRender.mockClear();
    for (let i = 0; i < 60; i++) await rerender();
    console.info(
      'context consumer commits / 60 unchanged renders:',
      onRender.mock.calls.length
    );
    expect(onRender.mock.calls.length).toBe(0);
    await act(() =>
      ws.message({
        JsonPatch: [
          { op: 'add', path: '/execution_processes/b', value: process('b') },
        ],
      })
    );
    await flushFrame();
    expect(onRender).toHaveBeenCalledTimes(1);
  });
});

describe('frame batching', () => {
  it('applies 60 multi-op messages once with the same sequential result', async () => {
    const hook = await renderHook(() =>
      useJsonPatchWsStream('/stream', true, initialData)
    );
    const ws = FakeWebSocket.instances[0];
    await act(() => ws.open());
    const messages: Operation[][] = Array.from({ length: 60 }, (_, i) => [
      { op: 'add', path: '/entries/-', value: String(i) },
      { op: 'replace', path: '/entries/0', value: 'first' },
    ]);
    const expected = initialData();
    for (const ops of messages) applyPatch(expected, ops);
    vi.mocked(applyPatch).mockClear();
    hook.onRender.mockClear();
    // Separate acts simulate separate WebSocket message tasks: React's own
    // synchronous-event batching must not hide the per-message updates.
    for (const JsonPatch of messages)
      await act(() => ws.message({ JsonPatch }));
    await flushFrame();
    console.info(
      '60 messages: consumer commits / applyPatch calls:',
      hook.onRender.mock.calls.length,
      vi.mocked(applyPatch).mock.calls.length
    );
    expect(hook.result.data).toEqual(expected);
    expect(hook.onRender.mock.calls.length).toBe(1);
    expect(vi.mocked(applyPatch).mock.calls.length).toBe(1);
  });

  it.each(['before', 'after'])(
    'flushes with a timer when hidden %s queuing rAF',
    async (when) => {
      const hook = await renderHook(() =>
        useJsonPatchWsStream('/stream', true, initialData)
      );
      if (when === 'before')
        Object.assign(document, { visibilityState: 'hidden' });
      await act(() =>
        FakeWebSocket.instances[0].message({
          JsonPatch: [{ op: 'add', path: '/entries/-', value: 'hidden' }],
        })
      );
      Object.assign(document, { visibilityState: 'hidden' });
      expect(hook.result.data).toBeUndefined();
      await act(() => vi.advanceTimersByTime(100));
      expect(hook.result.data).toEqual({ entries: ['hidden'] });
      expect(frames.size).toBe(0);
    }
  );

  it.each(['Ready', 'finished', 'clean close'])(
    'flushes before %s without reconnecting',
    async (boundary) => {
      const hook = await renderHook(() =>
        useJsonPatchWsStream('/stream', true, initialData)
      );
      const ws = FakeWebSocket.instances[0];
      await act(() => {
        ws.open();
        ws.message({
          JsonPatch: [{ op: 'add', path: '/entries/-', value: 'last' }],
        });
        if (boundary === 'clean close') ws.disconnect(1000, true);
        else ws.message({ [boundary]: true });
      });
      expect(hook.result.data).toEqual({ entries: ['last'] });
      expect(hook.result.isInitialized).toBe(boundary === 'Ready');
      expect(frames.size).toBe(0);
      await act(() => vi.advanceTimersByTime(60_000));
      expect(FakeWebSocket.instances).toHaveLength(1);
    }
  );

  it('flushes an unexpected close and recovers through the existing backoff and replay', async () => {
    const hook = await renderHook(() =>
      useJsonPatchWsStream('/stream', true, initialData, {
        keepSnapshotForEndpoint: true,
      })
    );
    const ws = FakeWebSocket.instances[0];
    await act(() => {
      ws.open();
      ws.message({
        JsonPatch: [{ op: 'add', path: '/entries/-', value: 'old' }],
      });
      ws.disconnect();
    });
    expect(hook.result.data).toEqual({ entries: ['old'] });
    await act(() => vi.advanceTimersByTime(1999));
    expect(FakeWebSocket.instances).toHaveLength(1);
    await act(() => vi.advanceTimersByTime(1));
    expect(FakeWebSocket.instances).toHaveLength(2);
    const next = FakeWebSocket.instances[1];
    await act(() => {
      next.open();
      next.message({
        JsonPatch: [{ op: 'replace', path: '/entries', value: ['replayed'] }],
      });
      next.message({ Ready: true });
    });
    expect(hook.result.data).toEqual({ entries: ['replayed'] });
    expect(hook.result.isConnected).toBe(true);
    expect(hook.result.isInitialized).toBe(true);
    expect(hook.result.error).toBeNull();
  });

  it('saves the pending snapshot on unmount and cancels scheduled publishes', async () => {
    const hook = await renderHook(() =>
      useJsonPatchWsStream('/stream', true, initialData, {
        keepSnapshotForEndpoint: true,
      })
    );
    await act(() =>
      FakeWebSocket.instances[0].message({
        JsonPatch: [{ op: 'add', path: '/entries/-', value: 'cached' }],
      })
    );
    await render(null);
    expect(getWsSnapshot(wsSnapshotKey('/stream', null))).toEqual({
      entries: ['cached'],
    });
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await hook.rerender();
    expect(hook.result.data).toEqual({ entries: ['cached'] });
  });

  it('rolls back only the malformed message and retains its valid neighbors', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hook = await renderHook(() =>
      useJsonPatchWsStream('/stream', true, initialData)
    );
    const ws = FakeWebSocket.instances[0];
    for (const JsonPatch of [
      [{ op: 'add', path: '/entries/-', value: 'before' }],
      [
        { op: 'add', path: '/entries/-', value: 'rolled back' },
        { op: 'add', path: 'invalid-pointer', value: 0 },
      ],
      [{ op: 'add', path: '/entries/-', value: 'after' }],
    ])
      await act(() => ws.message({ JsonPatch }));
    await flushFrame();
    expect(hook.result.data).toEqual({ entries: ['before', 'after'] });
    expect(hook.result.error).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    await act(() =>
      ws.message({
        JsonPatch: [{ op: 'add', path: 'invalid-pointer', value: 0 }],
      })
    );
    await flushFrame();
    expect(hook.result.error).toBe('Failed to process stream update');
    expect(hook.result.data).toEqual({ entries: ['before', 'after'] });
  });

  it('keeps the running-process silence deadline despite heartbeats', async () => {
    const hook = await renderHook(() => useExecutionProcesses('session-a'));
    const ws = FakeWebSocket.instances[0];
    await act(() => {
      ws.open();
      ws.message({
        JsonPatch: [
          {
            op: 'add',
            path: '/execution_processes/a',
            value: { ...process('a'), status: 'running' },
          },
        ],
      });
      ws.message({ Ready: true });
    });
    expect(hook.result.isAttemptRunning).toBe(true);
    await act(() => vi.advanceTimersByTime(74_999));
    await act(() => ws.message({ heartbeat: true }));
    expect(ws.close).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTime(1));
    expect(ws.close).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTime(2000));
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it.each([false, true])(
    'honors a queued running=%s update at the silence deadline',
    async (running) => {
      const shouldReconcileAfterSilence = (state: { running: boolean }) =>
        state.running;
      const hook = await renderHook(() =>
        useJsonPatchWsStream('/running', true, () => ({ running: true }), {
          silenceTimeoutMs: 1000,
          shouldReconcileAfterSilence,
        })
      );
      const ws = FakeWebSocket.instances[0];
      await act(() => ws.open());
      await act(() => vi.advanceTimersByTime(999));
      await act(() =>
        ws.message({
          JsonPatch: [{ op: 'replace', path: '/running', value: running }],
        })
      );
      await act(() => vi.advanceTimersByTime(1));
      expect(ws.close).not.toHaveBeenCalled();
      expect(hook.result.data).toEqual({ running });
      await act(() => vi.advanceTimersByTime(1000));
      expect(ws.close.mock.calls.length).toBe(running ? 1 : 0);
    }
  );
});

describe('batched stream lifecycle', () => {
  it.each(['visible', 'hidden'])(
    'preserves short execution completion reconciliation while %s',
    async (visibilityState) => {
      const hook = await renderHook(() => useExecutionProcesses('session-a'));
      const ws = FakeWebSocket.instances[0];
      await act(() => {
        ws.open();
        ws.message({
          JsonPatch: [
            { op: 'replace', path: '/execution_processes', value: {} },
          ],
        });
        ws.message({ Ready: true });
      });
      Object.assign(document, { visibilityState });
      await act(() =>
        ws.message({
          JsonPatch: [
            {
              op: 'add',
              path: '/execution_processes/short',
              value: {
                ...process('short'),
                run_reason: 'setupscript',
                status: 'running',
              },
            },
          ],
        })
      );
      await act(() => vi.advanceTimersByTime(1));
      await act(() =>
        ws.message({
          JsonPatch: [
            {
              op: 'replace',
              path: '/execution_processes/short/status',
              value: 'completed',
            },
          ],
        })
      );
      if (visibilityState === 'visible') await flushFrame();
      else await act(() => vi.advanceTimersByTime(99));
      expect(hook.result.executionProcesses[0].status).toBe('completed');
      expect(hook.result.isAttemptRunning).toBe(false);
      // Unrelated metadata updates must not cancel or postpone the handoff.
      await act(() => vi.advanceTimersByTime(500));
      await act(() =>
        ws.message({
          JsonPatch: [
            {
              op: 'add',
              path: '/execution_processes/short/dropped',
              value: true,
            },
          ],
        })
      );
      if (visibilityState === 'visible') await flushFrame();
      else await act(() => vi.advanceTimersByTime(100));
      await act(() =>
        vi.advanceTimersByTime(visibilityState === 'visible' ? 499 : 399)
      );
      expect(FakeWebSocket.instances).toHaveLength(1);
      await act(() => vi.advanceTimersByTime(1));
      expect(FakeWebSocket.instances.length).toBe(2);
      const fresh = FakeWebSocket.instances[1];
      await act(() => {
        fresh.open();
        fresh.message({
          JsonPatch: [
            {
              op: 'replace',
              path: '/execution_processes',
              value: {
                short: { ...process('short'), run_reason: 'setupscript' },
              },
            },
          ],
        });
        fresh.message({ Ready: true });
      });
      await act(() => vi.advanceTimersByTime(2000));
      expect(FakeWebSocket.instances).toHaveLength(2);
    }
  );

  it.each(['heartbeat', 'empty patch', 'Ready', 'finished', 'unknown'])(
    'preserves error clearing when a %s follows a bad operation before flush',
    async (kind) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const hook = await renderHook(() =>
        useJsonPatchWsStream('/stream', true, initialData)
      );
      const ws = FakeWebSocket.instances[0];
      await act(() => ws.open());
      await act(() =>
        ws.message({
          JsonPatch: [{ op: 'add', path: 'invalid-pointer', value: 'bad' }],
        })
      );
      const next =
        kind === 'empty patch' ? { JsonPatch: [] } : { [kind]: true };
      await act(() => ws.message(next));
      await flushFrame();
      expect(hook.result.error).toBeNull();
    }
  );

  it('retains the latest failure after an empty or deduplicated patch clears an older error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const deduplicatePatches = (ops: Operation[]) =>
      ops.filter((op) => op.path !== '/duplicate');
    const hook = await renderHook(() =>
      useJsonPatchWsStream('/stream', true, initialData, {
        deduplicatePatches,
      })
    );
    const ws = FakeWebSocket.instances[0];
    await act(() => ws.open());
    const malformed = {
      JsonPatch: [{ op: 'add', path: 'invalid-pointer', value: 'bad' }],
    };
    await act(() => ws.message(malformed));
    await act(() =>
      ws.message({ JsonPatch: [{ op: 'add', path: '/duplicate', value: 0 }] })
    );
    await flushFrame();
    expect(hook.result.error).toBeNull();
    await act(() => ws.message({ JsonPatch: [] }));
    await act(() => ws.message(malformed));
    await flushFrame();
    expect(hook.result.error).toBe('Failed to process stream update');
    await act(() => {
      ws.message({
        JsonPatch: [{ op: 'add', path: '/entries/-', value: 'valid' }],
      });
      ws.onmessage?.({ data: '{invalid json' });
    });
    expect(hook.result.data).toEqual({ entries: ['valid'] });
    expect(hook.result.error).toBe('Failed to process stream update');
  });

  it('does not reconcile terminal history, scope switches, or live devserver completion', async () => {
    let sessionId = 'session-a';
    const hook = await renderHook(() => useExecutionProcesses(sessionId));
    for (const scope of ['initial', 'session', 'host', 'replay']) {
      if (scope === 'session') sessionId = 'session-b';
      if (scope === 'host') host.id = 'other-host';
      if (scope === 'replay') await act(() => hook.result.reconcile());
      else await hook.rerender();
      const ws = FakeWebSocket.instances.at(-1)!;
      await act(() => ws.open());
      // Initial history may itself span more than one frame before Ready.
      for (const id of ['first', 'second']) {
        await act(() =>
          ws.message({
            JsonPatch: [
              {
                op: 'add',
                path: `/execution_processes/${scope}-${id}`,
                value: process(`${scope}-${id}`, sessionId),
              },
            ],
          })
        );
        await flushFrame();
      }
      await act(() => ws.message({ Ready: true }));
      await act(() =>
        ws.message({
          JsonPatch: [
            {
              op: 'add',
              path: '/execution_processes/dev',
              value: {
                ...process('dev', sessionId),
                run_reason: 'devserver',
                status: 'running',
              },
            },
          ],
        })
      );
      await act(() =>
        ws.message({
          JsonPatch: [
            {
              op: 'replace',
              path: '/execution_processes/dev/status',
              value: 'completed',
            },
          ],
        })
      );
      await flushFrame();
      const sockets = FakeWebSocket.instances.length;
      await act(() => vi.advanceTimersByTime(2000));
      expect(FakeWebSocket.instances).toHaveLength(sockets);
      expect(ws.close).not.toHaveBeenCalled();
    }
  });

  it.each(['new execution', 'session', 'host', 'unmount'])(
    'cancels terminal reconciliation after %s',
    async (action) => {
      let sessionId = 'session-a';
      const hook = await renderHook(() => useExecutionProcesses(sessionId));
      const ws = FakeWebSocket.instances[0];
      await act(() => {
        ws.open();
        ws.message({
          JsonPatch: [
            {
              op: 'add',
              path: '/execution_processes/a',
              value: { ...process('a'), status: 'running' },
            },
          ],
        });
        ws.message({ Ready: true });
      });
      expect(hook.result.isAttemptRunning).toBe(true);
      await act(() =>
        ws.message({
          JsonPatch: [
            {
              op: 'replace',
              path: '/execution_processes/a/status',
              value: 'failed',
            },
          ],
        })
      );
      await flushFrame();
      await act(() => vi.advanceTimersByTime(500));
      if (action === 'new execution') {
        await act(() =>
          ws.message({
            JsonPatch: [
              {
                op: 'add',
                path: '/execution_processes/b',
                value: { ...process('b'), status: 'running' },
              },
            ],
          })
        );
        await flushFrame();
      } else if (action === 'unmount') {
        await render(null);
      } else {
        if (action === 'session') sessionId = 'session-b';
        else host.id = 'other-host';
        await hook.rerender();
      }
      const sockets = FakeWebSocket.instances.length;
      await act(() => vi.advanceTimersByTime(1500));
      expect(FakeWebSocket.instances).toHaveLength(sockets);
      if (action === 'new execution') expect(ws.close).not.toHaveBeenCalled();
      if (action === 'unmount') expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('closes a socket whose asynchronous open resolves after unmount', async () => {
    let resolveOpen!: (ws: WebSocket) => void;
    setLocalApiTransport({
      request: vi.fn(),
      openWebSocket: () =>
        new Promise<WebSocket>((resolve) => {
          resolveOpen = resolve;
        }),
    });
    await renderHook(() => useJsonPatchWsStream('/stream', true, initialData));
    await render(null);
    const ws = new FakeWebSocket('/stream');
    await act(async () => resolveOpen(ws as unknown as WebSocket));
    expect(ws.close.mock.calls.length).toBe(1);
    expect(ws.onmessage).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not publish old pending operations after an explicit reconcile', async () => {
    const hook = await renderHook(() =>
      useJsonPatchWsStream('/stream', true, initialData, {
        keepSnapshotForEndpoint: true,
      })
    );
    const ws = FakeWebSocket.instances[0];
    await act(() => {
      ws.open();
      ws.message({
        JsonPatch: [{ op: 'replace', path: '/entries', value: [] }],
      });
      ws.message({ Ready: true });
    });
    await act(() =>
      ws.message({
        JsonPatch: [{ op: 'add', path: '/entries/-', value: 'old' }],
      })
    );
    await act(() => hook.result.reconcile());
    const fresh = FakeWebSocket.instances[1];
    await act(() => {
      fresh.open();
      fresh.message({
        JsonPatch: [{ op: 'replace', path: '/entries', value: ['fresh'] }],
      });
      fresh.message({ Ready: true });
    });
    await flushFrame();
    await act(() => vi.advanceTimersByTime(100));
    expect(hook.result.data).toEqual({ entries: ['fresh'] });
    expect(ws.close.mock.calls.length).toBe(1);
    expect(FakeWebSocket.instances.length).toBe(2);
  });

  it.each([1000, 9000])(
    'preserves visibility resume policy after %i ms',
    async (duration) => {
      const hook = await renderHook(() =>
        useJsonPatchWsStream('/stream', true, initialData, {
          keepSnapshotForEndpoint: true,
        })
      );
      const ws = FakeWebSocket.instances[0];
      await act(() => {
        ws.open();
        ws.message({
          JsonPatch: [{ op: 'replace', path: '/entries', value: ['initial'] }],
        });
        ws.message({ Ready: true });
      });
      await act(() => {
        Object.assign(document, { visibilityState: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await act(() =>
        ws.message({
          JsonPatch: [{ op: 'add', path: '/entries/-', value: 'hidden' }],
        })
      );
      await act(() => vi.advanceTimersByTime(duration));
      await act(() => {
        Object.assign(document, { visibilityState: 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(FakeWebSocket.instances.length).toBe(duration >= 8000 ? 2 : 1);
      expect(hook.result.data).toEqual({ entries: ['initial', 'hidden'] });
    }
  );
});

describe('execution control across batch boundaries', () => {
  it.each([
    ['reconcile', 'running'],
    ['resume', 'running'],
    ['reconcile', 'removed'],
    ['resume', 'removed'],
  ])(
    'preserves the queued child state across %s when the child is %s',
    async (kind, childState) => {
      const hook = await renderHook(() => useExecutionProcesses('session-a'));
      const first = FakeWebSocket.instances[0];
      await act(() => {
        first.open();
        first.message({
          JsonPatch: [
            {
              op: 'add',
              path: '/execution_processes/a',
              value: { ...process('a'), status: 'running' },
            },
          ],
        });
        first.message({ Ready: true });
      });
      await act(() =>
        first.message({
          JsonPatch: [
            {
              op: 'replace',
              path: '/execution_processes/a/status',
              value: 'completed',
            },
          ],
        })
      );
      await flushFrame();
      await act(() => vi.advanceTimersByTime(999));
      await act(() =>
        first.message({
          JsonPatch: [
            {
              op: 'add',
              path: '/execution_processes/child',
              value: { ...process('child'), status: 'running' },
            },
          ],
        })
      );
      if (childState === 'removed') {
        await act(() =>
          first.message({
            JsonPatch: [{ op: 'remove', path: '/execution_processes/child' }],
          })
        );
      }
      await act(() => {
        if (kind === 'reconcile') hook.result.reconcile();
        else
          window.dispatchEvent(
            Object.assign(new Event('pageshow'), { persisted: true })
          );
      });
      expect(FakeWebSocket.instances).toHaveLength(2);
      const second = FakeWebSocket.instances[1];
      await act(() => second.open());
      expect(hook.result.isAttemptRunning).toBe(childState === 'running');
      await act(() => vi.advanceTimersByTime(1));
      expect(FakeWebSocket.instances).toHaveLength(2);
      expect(second.close).not.toHaveBeenCalled();
      if (childState === 'removed') {
        // A completed child gets its own full handoff window, even if its
        // running and removed messages only materialized during cleanup.
        await act(() => vi.advanceTimersByTime(998));
        expect(FakeWebSocket.instances).toHaveLength(2);
        await act(() => vi.advanceTimersByTime(1));
        expect(FakeWebSocket.instances).toHaveLength(3);
      }
    }
  );

  it.each(['session', 'host', 'unmount'])(
    'disposes control timers created by a cleanup batch on %s exit',
    async (kind) => {
      let sessionId = 'session-a';
      const hook = await renderHook(() => useExecutionProcesses(sessionId));
      const ws = FakeWebSocket.instances[0];
      await act(() => {
        ws.open();
        ws.message({ Ready: true });
        ws.message({
          JsonPatch: [
            {
              op: 'add',
              path: '/execution_processes/short',
              value: { ...process('short'), status: 'running' },
            },
          ],
        });
        ws.message({
          JsonPatch: [{ op: 'remove', path: '/execution_processes/short' }],
        });
      });
      if (kind === 'unmount') await render(null);
      else {
        if (kind === 'session') sessionId = 'session-b';
        else host.id = 'other-host';
        await hook.rerender();
      }
      const sockets = FakeWebSocket.instances.length;
      await act(() => vi.advanceTimersByTime(2000));
      expect(FakeWebSocket.instances).toHaveLength(sockets);
      expect(frames.size).toBe(0);
      if (kind === 'unmount') expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('keeps the committed observer while a later render is suspended', async () => {
    const onApplied = vi.fn();
    const uncommitted = vi.fn();
    const pending = new Promise<never>(() => {});
    function Probe({ suspend }: { suspend: boolean }) {
      useJsonPatchWsStream('/stream', true, initialData, {
        patchObserver: {
          selectState: () => false,
          onApplied: suspend ? uncommitted : onApplied,
        },
      });
      if (suspend) throw pending;
      return null;
    }
    await render(
      <Suspense fallback={null}>
        <Probe suspend={false} />
      </Suspense>
    );
    const ws = FakeWebSocket.instances[0];
    await act(() => ws.open());
    await render(
      <Suspense fallback={null}>
        <Probe suspend />
      </Suspense>
    );
    await act(() =>
      ws.message({
        JsonPatch: [{ op: 'add', path: '/entries/-', value: 'live' }],
      })
    );
    await flushFrame();
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(uncommitted).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it.each(['visible', 'hidden'])(
    'does not reconnect if a child start is already queued at the handoff deadline (%s)',
    async (visibilityState) => {
      const hook = await renderHook(() => useExecutionProcesses('session-a'));
      const ws = FakeWebSocket.instances[0];
      await act(() => {
        ws.open();
        ws.message({
          JsonPatch: [
            {
              op: 'add',
              path: '/execution_processes/a',
              value: { ...process('a'), status: 'running' },
            },
          ],
        });
        ws.message({ Ready: true });
      });
      await act(() =>
        ws.message({
          JsonPatch: [
            {
              op: 'replace',
              path: '/execution_processes/a/status',
              value: 'completed',
            },
          ],
        })
      );
      await flushFrame();
      await act(() => vi.advanceTimersByTime(999));
      Object.assign(document, { visibilityState });
      await act(() =>
        ws.message({
          JsonPatch: [
            {
              op: 'add',
              path: '/execution_processes/child',
              value: { ...process('child'), status: 'running' },
            },
          ],
        })
      );
      await act(() => vi.advanceTimersByTime(1));
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(ws.close).not.toHaveBeenCalled();
      await flushFrame();
      expect(hook.result.isAttemptRunning).toBe(true);
    }
  );

  it('preserves completion reconciliation when a short process is removed in the same frame', async () => {
    const hook = await renderHook(() => useExecutionProcesses('session-a'));
    const ws = FakeWebSocket.instances[0];
    await act(() => {
      ws.open();
      ws.message({
        JsonPatch: [{ op: 'replace', path: '/execution_processes', value: {} }],
      });
      ws.message({ Ready: true });
    });
    await act(() =>
      ws.message({
        JsonPatch: [
          {
            op: 'add',
            path: '/execution_processes/short',
            value: {
              ...process('short'),
              run_reason: 'setupscript',
              status: 'running',
            },
          },
        ],
      })
    );
    await act(() =>
      ws.message({
        JsonPatch: [{ op: 'remove', path: '/execution_processes/short' }],
      })
    );
    await flushFrame();
    await act(() => vi.advanceTimersByTime(1000));
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('reconciles a coalesced terminal row once without requiring a running render', async () => {
    const hook = await renderHook(() => useExecutionProcesses('session-a'));
    const ws = FakeWebSocket.instances[0];
    await act(() => {
      ws.open();
      ws.message({
        JsonPatch: [{ op: 'replace', path: '/execution_processes', value: {} }],
      });
      ws.message({ Ready: true });
    });
    await act(() =>
      ws.message({
        JsonPatch: [
          {
            op: 'replace',
            path: '/execution_processes/a',
            value: process('a'),
          },
          {
            op: 'replace',
            path: '/execution_processes/b',
            value: { ...process('b'), status: 'failed' },
          },
        ],
      })
    );
    await flushFrame();
    expect(hook.result.executionProcesses).toHaveLength(2);
    await act(() => vi.advanceTimersByTime(1000));
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('observes 60 execution transitions in one document update and one render', async () => {
    const hook = await renderHook(() => useExecutionProcesses('session-a'));
    const ws = FakeWebSocket.instances[0];
    await act(() => {
      ws.open();
      ws.message({
        JsonPatch: [
          {
            op: 'add',
            path: '/execution_processes/a',
            value: { ...process('a'), status: 'running' },
          },
        ],
      });
      ws.message({ Ready: true });
    });
    vi.mocked(produce).mockClear();
    vi.mocked(applyOperation).mockClear();
    hook.onRender.mockClear();
    for (let i = 0; i < 60; i++) {
      await act(() =>
        ws.message({
          JsonPatch: [
            {
              op: 'replace',
              path: '/execution_processes/a/status',
              value: i % 2 ? 'completed' : 'running',
            },
          ],
        })
      );
    }
    expect(produce).not.toHaveBeenCalled();
    await flushFrame();
    expect(hook.result.isAttemptRunning).toBe(false);
    expect(produce).toHaveBeenCalledTimes(1);
    expect(applyOperation).toHaveBeenCalledTimes(60);
    expect(hook.onRender).toHaveBeenCalledTimes(1);
    console.info(
      '60 execution messages: immutable docs / operation applications / commits:',
      vi.mocked(produce).mock.calls.length,
      vi.mocked(applyOperation).mock.calls.length,
      hook.onRender.mock.calls.length
    );
    await act(() => vi.advanceTimersByTime(1000));
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it.each(['short child', 'metadata', 'invalid child', 'invalid completion'])(
    'handles a queued %s at the handoff deadline without losing the timer',
    async (kind) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const hook = await renderHook(() => useExecutionProcesses('session-a'));
      const ws = FakeWebSocket.instances[0];
      await act(() => {
        ws.open();
        ws.message({
          JsonPatch: [
            {
              op: 'add',
              path: '/execution_processes/a',
              value: { ...process('a'), status: 'running' },
            },
          ],
        });
        ws.message({ Ready: true });
      });
      await act(() =>
        ws.message({
          JsonPatch: [
            {
              op: 'replace',
              path: '/execution_processes/a/status',
              value: 'completed',
            },
          ],
        })
      );
      await flushFrame();
      await act(() => vi.advanceTimersByTime(999));
      if (kind === 'metadata') {
        await act(() =>
          ws.message({
            JsonPatch: [
              {
                op: 'add',
                path: '/execution_processes/a/dropped',
                value: true,
              },
            ],
          })
        );
      } else {
        const JsonPatch: Operation[] = [
          {
            op: 'add',
            path: '/execution_processes/child',
            value: { ...process('child'), status: 'running' },
          },
        ];
        if (kind === 'invalid child')
          JsonPatch.push({ op: 'add', path: 'invalid-pointer', value: 0 });
        await act(() => ws.message({ JsonPatch }));
        if (kind === 'short child' || kind === 'invalid completion') {
          const removal: Operation[] = [
            { op: 'remove', path: '/execution_processes/child' },
          ];
          if (kind === 'invalid completion')
            removal.push({ op: 'add', path: 'invalid-pointer', value: 0 });
          await act(() => ws.message({ JsonPatch: removal }));
        }
      }
      await act(() => vi.advanceTimersByTime(1));
      if (kind === 'invalid completion') {
        expect(hook.result.isAttemptRunning).toBe(true);
        await act(() => vi.advanceTimersByTime(1000));
        expect(FakeWebSocket.instances).toHaveLength(1);
        return;
      }
      if (kind === 'short child') {
        expect(FakeWebSocket.instances).toHaveLength(1);
        await act(() => vi.advanceTimersByTime(999));
        expect(FakeWebSocket.instances).toHaveLength(1);
        await act(() => vi.advanceTimersByTime(1));
      }
      expect(FakeWebSocket.instances).toHaveLength(2);
    }
  );
});
