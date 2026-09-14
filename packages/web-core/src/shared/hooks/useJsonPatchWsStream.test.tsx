import { act, memo, Profiler, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyPatch, type Operation } from 'rfc6902';
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
