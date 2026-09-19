import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Operation } from 'rfc6902';
import {
  squashReplaces,
  streamJsonPatchEntries,
} from './streamJsonPatchEntries';
import { setLocalApiTransport } from './localApiTransport';

// ---------------------------------------------------------------------------
// Controllable fake WebSocket.
//
// The PWA infinite-loading bug is caused by sockets that get stuck in the
// CONNECTING state after the standalone (WebKit) app is suspended/resumed:
// the OS tears the connection down but `open`/`error`/`close` never fire in
// the JS event loop. This fake reproduces exactly that "zombie" by simply
// never emitting any event unless the test asks it to.
// ---------------------------------------------------------------------------
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
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
    this.readyState = FakeWebSocket.CLOSED;
    // A real zombie socket does NOT emit 'close' here — tests emit explicitly.
  }

  private emit(type: string, ev: unknown) {
    this.listeners[type]?.forEach((cb) => cb(ev));
  }

  // --- test helpers ---
  emitOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open', {});
  }

  emitMessage(obj: unknown) {
    this.emit('message', { data: JSON.stringify(obj) });
  }

  emitClose(code = 1006) {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', { code, wasClean: code === 1000 });
  }
}

const URL = '/api/execution-processes/abc/normalized-logs/ws';

beforeEach(() => {
  FakeWebSocket.instances = [];

  setLocalApiTransport({
    request: (async () => ({}) as unknown as Response) as never,
    openWebSocket: (path: string) =>
      new FakeWebSocket(path) as unknown as WebSocket,
  });

  vi.useFakeTimers();

  // streamJsonPatchEntries batches patches via requestAnimationFrame; the node
  // test environment has no rAF, so shim it onto the (fake) timer queue.
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(
      () => cb(0),
      0
    ) as unknown as number) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) =>
    clearTimeout(
      id as unknown as ReturnType<typeof setTimeout>
    )) as typeof cancelAnimationFrame;
});

afterEach(() => {
  vi.useRealTimers();
  setLocalApiTransport(null);
});

describe('streamJsonPatchEntries — explicit host scoping (split panes)', () => {
  it('prefixes the stream path with the given host', async () => {
    streamJsonPatchEntries(URL, { hostId: 'host-1' });
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances[0].url).toBe(
      `/api/host/host-1${URL.slice('/api'.length)}`
    );
  });

  it('leaves the path unscoped for the local host (null)', async () => {
    streamJsonPatchEntries(URL, { hostId: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances[0].url).toBe(URL);
  });
});

describe('streamJsonPatchEntries — connection watchdog (PWA resume)', () => {
  it('surfaces an error instead of hanging forever when the socket never connects', async () => {
    const onFinished = vi.fn();
    const onError = vi.fn();

    streamJsonPatchEntries(URL, {
      onFinished,
      onError,
      connectTimeoutMs: 1000,
      maxRetries: 2,
    });

    // Let the async open() attach listeners + arm the connect watchdog.
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].readyState).toBe(
      FakeWebSocket.CONNECTING
    );

    // Sockets stay CONNECTING forever (the "zombie" from a suspended PWA).
    // Advance well past every watchdog + backoff window.
    await vi.advanceTimersByTimeAsync(60_000);

    // Without a watchdog this hangs forever (bug). With it, the stream must
    // give up after exhausting retries so callers stop showing a spinner.
    expect(onFinished).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('retries a stalled connection and recovers when a later socket connects', async () => {
    const onFinished = vi.fn();
    const onError = vi.fn();

    streamJsonPatchEntries(URL, {
      onFinished,
      onError,
      connectTimeoutMs: 1000,
      maxRetries: 3,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(1);

    // Trip the watchdog on the first (stalled) socket; a retry must open a new
    // socket — the automatic equivalent of the user switching workspaces /
    // refreshing the page to force a fresh connection.
    await vi.advanceTimersByTimeAsync(1000 + 500 + 1);
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);

    // The fresh socket connects and finishes normally.
    const latest = FakeWebSocket.instances.at(-1)!;
    latest.emitOpen();
    latest.emitMessage({ finished: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(onError).not.toHaveBeenCalled();
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it('retries when a socket closes before the stream finishes', async () => {
    const onFinished = vi.fn();
    const onError = vi.fn();

    streamJsonPatchEntries(URL, {
      onFinished,
      onError,
      connectTimeoutMs: 5000,
      maxRetries: 3,
    });

    await vi.advanceTimersByTimeAsync(0);
    const first = FakeWebSocket.instances[0];
    first.emitOpen();
    // Connection drops before any "finished" message.
    first.emitClose(1006);

    // Backoff, then a new socket should be opened.
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);

    const second = FakeWebSocket.instances.at(-1)!;
    second.emitOpen();
    second.emitMessage({ finished: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(onError).not.toHaveBeenCalled();
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it('does not fire the watchdog on a healthy connection', async () => {
    const onFinished = vi.fn();
    const onError = vi.fn();

    streamJsonPatchEntries(URL, {
      onFinished,
      onError,
      connectTimeoutMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.emitOpen();
    ws.emitMessage({
      JsonPatch: [{ op: 'add', path: '/entries/0', value: { id: 'x' } }],
    });
    ws.emitMessage({ finished: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(onError).not.toHaveBeenCalled();
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(onFinished.mock.calls[0][0]).toEqual([{ id: 'x' }]);

    // No spurious retry/error long after a successful finish.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('does not duplicate entries when a reconnect replays the full history', async () => {
    const onFinished = vi.fn();
    const onError = vi.fn();

    streamJsonPatchEntries(URL, {
      onFinished,
      onError,
      connectTimeoutMs: 5000,
      maxRetries: 3,
    });

    const history = [
      { op: 'add', path: '/entries/0', value: { id: 'a' } },
      { op: 'add', path: '/entries/1', value: { id: 'b' } },
      { op: 'add', path: '/entries/2', value: { id: 'c' } },
    ];

    await vi.advanceTimersByTimeAsync(0);
    const first = FakeWebSocket.instances[0];
    first.emitOpen();
    // Server streams the full history, then the socket drops before "finished"
    // (the suspended-PWA reconnect case this guards).
    first.emitMessage({ JsonPatch: history });
    await vi.advanceTimersByTimeAsync(0); // flush the rAF batch
    first.emitClose(1006);

    // Reconnect: the server restarts the stream by replaying the SAME full
    // history from scratch (history_plus_stream), then finishes.
    await vi.advanceTimersByTimeAsync(1000);
    const second = FakeWebSocket.instances.at(-1)!;
    expect(second).not.toBe(first);
    second.emitOpen();
    second.emitMessage({ JsonPatch: history });
    second.emitMessage({ finished: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(onError).not.toHaveBeenCalled();
    expect(onFinished).toHaveBeenCalledTimes(1);
    // The replay must rebuild the list, not append onto the pre-drop entries
    // (without the snapshot reset this would be [a,b,c,a,b,c]).
    expect(onFinished.mock.calls[0][0]).toEqual([
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ]);
  });
});

describe('squashReplaces — batch coalescing keeps op order', () => {
  it('never drops an add that a later replace on the same index supersedes', () => {
    // A running-process replay: the wait notice at 2 is settled after the
    // agent has already appended 3. Dropping the add would make `add /3`
    // land in slot 2 and the replace overwrite it.
    const ops: Operation[] = [
      { op: 'add', path: '/entries/2', value: 'waiting' },
      { op: 'add', path: '/entries/3', value: 'x' },
      { op: 'replace', path: '/entries/2', value: 'finished' },
    ];
    expect(squashReplaces(ops)).toEqual(ops);
  });

  it('keeps only the last of replaces on one path separated by unrelated replaces', () => {
    const ops: Operation[] = [
      { op: 'replace', path: '/entries/2', value: 'a' },
      { op: 'replace', path: '/entries/3', value: 'b' },
      { op: 'replace', path: '/entries/2', value: 'c' },
    ];
    expect(squashReplaces(ops)).toEqual([ops[1], ops[2]]);
  });

  it('treats index-shifting ops and related paths as barriers', () => {
    const shifting: Operation[] = [
      { op: 'replace', path: '/entries/2', value: 'a' },
      { op: 'add', path: '/entries/3', value: 'x' },
      { op: 'replace', path: '/entries/2', value: 'c' },
    ];
    expect(squashReplaces(shifting)).toEqual(shifting);

    const nested: Operation[] = [
      { op: 'replace', path: '/entries/2/content', value: 'a' },
      { op: 'replace', path: '/entries/2', value: { content: 'b' } },
      { op: 'replace', path: '/entries/2/content', value: 'c' },
    ];
    expect(squashReplaces(nested)).toEqual(nested);
  });
});

describe('streamJsonPatchEntries — batch application', () => {
  it('applies a burst that settles an earlier index after later adds without losing entries', async () => {
    const onFinished = vi.fn();
    streamJsonPatchEntries(URL, { onFinished });

    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.emitOpen();
    ws.emitMessage({
      JsonPatch: [
        { op: 'add', path: '/entries/0', value: { id: 'a' } },
        { op: 'add', path: '/entries/1', value: { id: 'waiting' } },
        { op: 'add', path: '/entries/2', value: { id: 'x' } },
        { op: 'add', path: '/entries/3', value: { id: 'y' } },
        { op: 'replace', path: '/entries/1', value: { id: 'finished' } },
        { op: 'add', path: '/entries/4', value: { id: 'z' } },
      ],
    });
    ws.emitMessage({ finished: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(onFinished.mock.calls[0][0]).toEqual([
      { id: 'a' },
      { id: 'finished' },
      { id: 'x' },
      { id: 'y' },
      { id: 'z' },
    ]);
  });

  it('applies patches through the timer fallback when no animation frame runs', async () => {
    // A hidden document never runs rAF callbacks, a queued one included.
    globalThis.requestAnimationFrame = (() =>
      1) as unknown as typeof requestAnimationFrame;
    const onEntries = vi.fn();
    streamJsonPatchEntries(URL, { onEntries });

    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.emitOpen();
    ws.emitMessage({
      JsonPatch: [{ op: 'add', path: '/entries/0', value: { id: 'a' } }],
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(onEntries).toHaveBeenLastCalledWith([{ id: 'a' }]);
  });
});

describe('streamJsonPatchEntries — silence watchdog (dead open socket)', () => {
  it('reconnects when a heartbeat-bearing connection goes silent and rebuilds from the replay', async () => {
    const onEntries = vi.fn();
    const onFinished = vi.fn();
    const onError = vi.fn();

    streamJsonPatchEntries(URL, {
      onEntries,
      onFinished,
      onError,
      silenceTimeoutMs: 45_000,
    });

    await vi.advanceTimersByTimeAsync(0);
    const first = FakeWebSocket.instances[0];
    first.emitOpen();
    first.emitMessage({
      JsonPatch: [{ op: 'add', path: '/entries/0', value: { id: 'a' } }],
    });
    first.emitMessage({ heartbeat: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(onEntries).toHaveBeenLastCalledWith([{ id: 'a' }]);

    // Healthy but quiet: keep-alives keep arriving, so no reconnect.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
      first.emitMessage({ heartbeat: true });
    }
    expect(FakeWebSocket.instances).toHaveLength(1);

    // The socket dies silently (suspended PWA): no data, no close event. The
    // patch the server pushed meanwhile never arrives on it.
    await vi.advanceTimersByTimeAsync(45_000 + 500 + 1);
    expect(first.closeCalls).toBe(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // The replay on the fresh socket rebuilds the list, including the patch
    // the dead socket swallowed.
    const second = FakeWebSocket.instances[1];
    second.emitOpen();
    second.emitMessage({
      JsonPatch: [
        { op: 'add', path: '/entries/0', value: { id: 'a' } },
        { op: 'add', path: '/entries/1', value: { id: 'b' } },
      ],
    });
    second.emitMessage({ finished: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(onError).not.toHaveBeenCalled();
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(onFinished.mock.calls[0][0]).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('leaves a quiet connection alone when it never delivered a heartbeat (WebSocket)', async () => {
    streamJsonPatchEntries(URL, { silenceTimeoutMs: 45_000 });

    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.emitOpen();
    ws.emitMessage({
      JsonPatch: [{ op: 'add', path: '/entries/0', value: { id: 'a' } }],
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(ws.closeCalls).toBe(0);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('stops watching once the stream finished', async () => {
    const onFinished = vi.fn();
    const onError = vi.fn();
    streamJsonPatchEntries(URL, {
      onFinished,
      onError,
      silenceTimeoutMs: 45_000,
    });

    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.emitOpen();
    ws.emitMessage({ heartbeat: true });
    ws.emitMessage({ finished: true });
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
