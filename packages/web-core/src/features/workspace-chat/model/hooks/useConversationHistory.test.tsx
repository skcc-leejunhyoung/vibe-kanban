import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionProcess, PatchType } from 'shared/types';
import { installDomlessReact } from '@/shared/lib/electric/electricTestKit';
import { setLocalApiTransport } from '@/shared/lib/localApiTransport';
import type { AddEntryType } from '@/shared/hooks/useConversationHistory/types';
import {
  clearProcessEntriesCache,
  setCachedProcessEntries,
} from '@/features/workspace-chat/model/processEntriesCache';

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
type HistoryResult = ReturnType<typeof useConversationHistory>;

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
  clearProcessEntriesCache();
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

// Finished turns whose logs are already cached load without a socket, so the
// paging path can be driven end to end with plain awaits.
const completedProcess = (id: string, second: number): ExecutionProcess =>
  ({
    ...runningProcess(id),
    status: 'completed',
    exit_code: 0n,
    created_at: `2026-09-19T00:00:${String(second).padStart(2, '0')}Z`,
    completed_at: '2026-09-19T00:01:00Z',
  }) as unknown as ExecutionProcess;

const message = (text: string): PatchType => ({
  type: 'NORMALIZED_ENTRY',
  content: {
    entry_type: { type: 'assistant_message' },
    content: text,
    timestamp: null,
  },
});

function seedCompletedTurns(count: number, entriesPerTurn: number) {
  const processes: ExecutionProcess[] = [];
  for (let i = 1; i <= count; i += 1) {
    const id = `p${i}`;
    processes.push(completedProcess(id, i));
    setCachedProcessEntries(
      null,
      id,
      Array.from({ length: entriesPerTurn }, (_, j) => message(`${id}:${j}`))
    );
  }
  return processes;
}

type Emit = { addType: AddEntryType; loaded: string[] };

function PagingHarness({
  resultRef,
  emits,
}: {
  resultRef: { current: HistoryResult | null };
  emits: Emit[];
}) {
  resultRef.current = useConversationHistory({
    scopeKey: 'attempt:session-a',
    onTimelineUpdated: (source, addType) => {
      emits.push({
        addType,
        loaded: Object.keys(source.executionProcessState).sort(),
      });
    },
  });
  return null;
}

describe('useConversationHistory — awaited history paging', () => {
  it('loadOlderBatch resolves after the batch is emitted and false once nothing older remains', async () => {
    // 6 entries per turn: the initial window stops after the newest three
    // turns (18 > MIN_INITIAL_ENTRIES) and leaves p1 behind pagination.
    context.processes = seedCompletedTurns(4, 6);
    const resultRef = { current: null as HistoryResult | null };
    const emits: Emit[] = [];
    await dom.render(<PagingHarness resultRef={resultRef} emits={emits} />);
    await settle();

    expect(emits.at(-1)).toEqual({
      addType: 'initial',
      loaded: ['p2', 'p3', 'p4'],
    });
    expect(resultRef.current?.hasMoreHistory).toBe(true);

    let loaded: boolean | undefined;
    await act(async () => {
      loaded = await resultRef.current!.loadOlderBatch();
    });
    expect(loaded).toBe(true);
    expect(emits.at(-1)).toEqual({
      addType: 'historic',
      loaded: ['p1', 'p2', 'p3', 'p4'],
    });
    expect(resultRef.current?.hasMoreHistory).toBe(false);

    const emitCount = emits.length;
    await act(async () => {
      loaded = await resultRef.current!.loadOlderBatch();
    });
    expect(loaded).toBe(false);
    expect(emits).toHaveLength(emitCount);
  });

  it('loadUntilProcess pages in older turns until the requested one is present', async () => {
    context.processes = seedCompletedTurns(5, 6);
    const resultRef = { current: null as HistoryResult | null };
    const emits: Emit[] = [];
    await dom.render(<PagingHarness resultRef={resultRef} emits={emits} />);
    await settle();
    expect(emits.at(-1)?.loaded).toEqual(['p3', 'p4', 'p5']);

    await act(async () => {
      await resultRef.current!.loadUntilProcess('p1');
    });
    expect(emits.at(-1)?.addType).toBe('historic');
    expect(emits.at(-1)?.loaded).toContain('p1');

    // Already loaded: resolves without another fetch or emit.
    const emitCount = emits.length;
    await act(async () => {
      await resultRef.current!.loadUntilProcess('p1');
    });
    expect(emits).toHaveLength(emitCount);
  });
});
