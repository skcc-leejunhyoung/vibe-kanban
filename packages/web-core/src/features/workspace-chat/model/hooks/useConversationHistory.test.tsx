import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionProcess } from 'shared/types';
import { installDomlessReact } from '@/shared/lib/electric/electricTestKit';
import { setLocalApiTransport } from '@/shared/lib/localApiTransport';

const context = vi.hoisted(() => ({
  processes: [] as unknown[],
}));

vi.mock('@/shared/hooks/useExecutionProcessesContext', () => ({
  useExecutionProcessesContext: () => ({
    executionProcessesVisible: context.processes,
    isLoading: false,
    isConnected: true,
  }),
}));
vi.mock('@/shared/providers/HostIdProvider', () => ({
  useHostId: () => null,
  getCurrentHostId: () => null,
}));

const { useConversationHistory } = await import('./useConversationHistory');

// Minimal socket double: records close() calls and never emits on its own.
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  closeCalls = 0;
  url: string;
  private listeners: Record<string, Set<(ev: unknown) => void>> = {};

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: unknown) => void) {
    (this.listeners[type] ??= new Set()).add(cb);
  }

  removeEventListener(type: string, cb: (ev: unknown) => void) {
    this.listeners[type]?.delete(cb);
  }

  close() {
    this.closeCalls += 1;
    this.readyState = 3;
  }

  emitOpen() {
    this.readyState = 1;
    this.listeners.open?.forEach((cb) => cb({}));
  }
}

const runningProcess = (id: string): ExecutionProcess =>
  ({
    id,
    session_id: 'session-1',
    run_reason: 'codingagent',
    status: 'running',
    exit_code: null,
    executor_action: { typ: { type: 'CodingAgentInitialRequest' } },
    created_at: '2026-09-19T00:00:00Z',
    updated_at: '2026-09-19T00:00:00Z',
    completed_at: null,
  }) as unknown as ExecutionProcess;

function Harness({ scopeKey }: { scopeKey: string }) {
  useConversationHistory({ onTimelineUpdated: () => {}, scopeKey });
  return null;
}

let dom: ReturnType<typeof installDomlessReact>;

beforeEach(() => {
  FakeWebSocket.instances = [];
  context.processes = [runningProcess('proc-1')];
  setLocalApiTransport({
    request: (async () => ({}) as unknown as Response) as never,
    openWebSocket: (path: string) =>
      new FakeWebSocket(path) as unknown as WebSocket,
  });
  globalThis.requestAnimationFrame ??= ((cb: FrameRequestCallback) =>
    setTimeout(
      () => cb(0),
      0
    ) as unknown as number) as typeof requestAnimationFrame;
  dom = installDomlessReact();
});

afterEach(async () => {
  await dom.unmount();
  setLocalApiTransport(null);
});

/** Let the load effects and the async stream open settle. */
async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('useConversationHistory — live stream ownership', () => {
  it('closes the running stream when the scope changes and reopens it for the new scope', async () => {
    await dom.render(<Harness scopeKey="attempt:session-a" />);
    await settle();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const first = FakeWebSocket.instances[0];
    first.emitOpen();

    await dom.render(<Harness scopeKey="attempt:session-b" />);
    await settle();

    // The old scope's stream must not outlive it (socket leak + patches
    // applied into the new scope's state); the new scope gets its own.
    expect(first.closeCalls).toBe(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1].closeCalls).toBe(0);
  });

  it('closes the running stream on unmount', async () => {
    await dom.render(<Harness scopeKey="attempt:session-a" />);
    await settle();
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();

    await dom.unmount();

    expect(socket.closeCalls).toBe(1);
  });
});
