import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { streamJsonPatchEntries } from './streamJsonPatchEntries';
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
