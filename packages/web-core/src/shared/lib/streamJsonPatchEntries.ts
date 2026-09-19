// streamJsonPatchEntries.ts - WebSocket JSON patch streaming utility
import { produce } from 'immer';
import type { Operation } from 'rfc6902';
import { applyUpsertPatch } from '@/shared/lib/jsonPatch';
import { openLocalApiStream } from '@/shared/lib/localApiTransport';

type PatchContainer<E = unknown> = { entries: E[] };

export interface StreamOptions<E = unknown> {
  initial?: PatchContainer<E>;
  /** called after each successful patch application */
  onEntries?: (entries: E[]) => void;
  onConnect?: () => void;
  onError?: (err: unknown) => void;
  /** called once when a "finished" event is received */
  onFinished?: (entries: E[]) => void;
  /**
   * Abandon a socket that hasn't fired `open` within this many ms and retry.
   *
   * Standalone (WebKit) PWAs that get suspended/resumed can leave a WebSocket
   * stuck in CONNECTING with no `open`/`error`/`close` event ever firing. The
   * browser's own connect timeout is ~60s+, which surfaces to the user as an
   * indefinite loading spinner — so we time it out ourselves.
   */
  connectTimeoutMs?: number;
  /**
   * Abandon an OPEN socket that has delivered nothing for this many ms and
   * retry; the server replays the full history on the new connection.
   *
   * Only armed on a connection that has delivered a heartbeat. The SSE
   * transport surfaces the server's keep-alive comments (every 15s) as
   * heartbeats, so a gap this long means the receive path is dead: a socket
   * left half-open by a suspended PWA or a dropped TCP session never fires
   * `close`, and without this the conversation stays frozen on the last entry
   * it received until the user refreshes. The WebSocket variant of the log
   * streams sends no heartbeat, so it never arms there and a quiet stream is
   * left alone.
   */
  silenceTimeoutMs?: number;
  /**
   * Maximum (re)connection attempts before giving up and calling `onError`.
   * Covers both stalled connects and drops that happen before `finished`.
   */
  maxRetries?: number;
  /**
   * Route the stream to this host explicitly (null = the local backend).
   * Without it the transport falls back to the document's host scope, which is
   * the wrong host for a split pane showing another host's workspace.
   */
  hostId?: string | null;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
// Three missed 15s keep-alives.
const DEFAULT_SILENCE_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_RETRIES = 5;
// rAF does not run while the document is hidden (a queued frame included), so
// a timer keeps the snapshot current regardless of visibility.
const PATCH_FLUSH_TIMEOUT_MS = 100;

interface StreamController<E = unknown> {
  /** Current entries array (immutable snapshot) */
  getEntries(): E[];
  /** Full { entries } snapshot */
  getSnapshot(): PatchContainer<E>;
  /** Best-effort connection state */
  isConnected(): boolean;
  /** Subscribe to updates; returns an unsubscribe function */
  onChange(cb: (entries: E[]) => void): () => void;
  /** Close the stream */
  close(): void;
}

/**
 * Connect to a WebSocket endpoint that emits JSON messages containing:
 *   {"JsonPatch": [{"op": "add", "path": "/entries/0", "value": {...}}, ...]}
 *   {"Finished": ""}
 *
 * Maintains an in-memory { entries: [] } snapshot and returns a controller.
 *
 * Messages are batched per animation frame and applied using immer for
 * structural sharing, avoiding a full deep clone on every message.
 */
export function streamJsonPatchEntries<E = unknown>(
  url: string,
  opts: StreamOptions<E> = {}
): StreamController<E> {
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const silenceTimeoutMs = opts.silenceTimeoutMs ?? DEFAULT_SILENCE_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;

  let connected = false;
  let closed = false;
  let finished = false;
  let attempt = 0;
  // Bumps on every (re)connect and whenever a socket is abandoned. Listeners
  // capture the generation they were created under and ignore events from a
  // stale/zombie socket, so a connection we gave up on can never resurface.
  let generation = 0;
  let ws: WebSocket | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  // Set once the current connection has delivered a heartbeat; gates the
  // silence watchdog (see `silenceTimeoutMs`).
  let heartbeatSeen = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  // Fresh copy of the baseline the stream starts from. The server replays the
  // full history on every (re)connection, so each reconnect must rebuild from
  // this baseline rather than appending onto entries from the prior connection.
  const initialSnapshot = (): PatchContainer<E> =>
    structuredClone(opts.initial ?? ({ entries: [] } as PatchContainer<E>));
  let snapshot: PatchContainer<E> = initialSnapshot();

  const subscribers = new Set<(entries: E[]) => void>();
  if (opts.onEntries) subscribers.add(opts.onEntries);

  // --- batching state (animation frame, with a timer fallback) ---
  let pendingOps: Operation[] = [];
  let rafId: number | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const notify = () => {
    for (const cb of subscribers) {
      try {
        cb(snapshot.entries);
      } catch {
        /* swallow subscriber errors */
      }
    }
  };

  const cancelFlush = () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  };

  const flush = () => {
    cancelFlush();
    if (pendingOps.length === 0) return;

    const ops = squashReplaces(pendingOps);
    pendingOps = [];

    snapshot = produce(snapshot, (draft) => {
      applyUpsertPatch(draft, ops);
    });
    notify();
  };

  const scheduleFlush = () => {
    if (rafId !== null || flushTimer !== null) return;
    if (
      typeof document === 'undefined' ||
      document.visibilityState !== 'hidden'
    ) {
      rafId = requestAnimationFrame(flush);
    }
    flushTimer = setTimeout(flush, PATCH_FLUSH_TIMEOUT_MS);
  };

  const clearConnectTimer = () => {
    if (connectTimer !== null) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
  };

  const clearSilenceTimer = () => {
    if (silenceTimer !== null) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  };

  const clearRetryTimer = () => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  // Abandon the current socket: bumping the generation makes its in-flight
  // open()/listeners no-op even if the zombie later fires events.
  const abandonSocket = () => {
    generation += 1;
    clearConnectTimer();
    clearSilenceTimer();
    const stalled = ws;
    ws = null;
    if (stalled) {
      try {
        stalled.close();
      } catch {
        /* ignore */
      }
    }
  };

  // Terminal failure: stop everything and surface the error once.
  const fail = (err: unknown) => {
    if (closed || finished) return;
    closed = true;
    clearConnectTimer();
    clearSilenceTimer();
    clearRetryTimer();
    cancelFlush();
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      ws = null;
    }
    opts.onError?.(err);
  };

  const scheduleRetry = (reason: unknown) => {
    if (closed || finished) return;
    if (attempt >= maxRetries) {
      fail(reason);
      return;
    }
    attempt += 1;
    const delay = Math.min(8000, 500 * 2 ** (attempt - 1));
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  };

  // Silence watchdog: every delivery (patch or heartbeat) proves the receive
  // path is alive and pushes the deadline out; reaching it means the socket is
  // dead even though it never fired `close`.
  const resetSilenceTimer = (myGen: number) => {
    if (!heartbeatSeen || silenceTimeoutMs <= 0 || closed || finished) return;
    clearSilenceTimer();
    silenceTimer = setTimeout(() => {
      silenceTimer = null;
      if (closed || finished || myGen !== generation) return;
      abandonSocket();
      scheduleRetry(new Error('WebSocket silence timeout'));
    }, silenceTimeoutMs);
  };

  const handleMessage = (event: MessageEvent, myGen: number) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.heartbeat !== undefined) heartbeatSeen = true;

      // Handle JsonPatch messages — accumulate ops for the next flush
      if (msg.JsonPatch) {
        pendingOps.push(...(msg.JsonPatch as Operation[]));
        scheduleFlush();
      }

      // Handle Finished messages — flush synchronously before closing
      if (msg.finished !== undefined) {
        finished = true;
        clearConnectTimer();
        clearSilenceTimer();
        clearRetryTimer();
        flush();
        opts.onFinished?.(snapshot.entries);
        if (ws) {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          ws = null;
        }
        return;
      }

      resetSilenceTimer(myGen);
    } catch (err) {
      fail(err);
    }
  };

  function connect() {
    if (closed || finished) return;
    // Reconnect (attempt > 0): the server restarts the stream by replaying the
    // entire history as `add /entries/N` patches. Reset the snapshot to the
    // baseline and drop any ops buffered from the dead socket so the replay
    // rebuilds the list cleanly instead of duplicating every entry once per
    // reconnect. No notify() here — the in-flight entries stay visible until the
    // first flush swaps in the rebuilt (identical) list, avoiding a blank flash.
    if (attempt > 0) {
      snapshot = initialSnapshot();
      pendingOps = [];
    }
    const myGen = ++generation;
    connected = false;
    heartbeatSeen = false;
    clearSilenceTimer();

    // Connect watchdog: if the socket never opens, abandon it and retry rather
    // than letting the caller wait on the browser's multi-minute timeout.
    connectTimer = setTimeout(() => {
      connectTimer = null;
      if (closed || finished || myGen !== generation) return;
      abandonSocket();
      scheduleRetry(new Error('WebSocket connect timeout'));
    }, connectTimeoutMs);

    void (async () => {
      try {
        const opened = await openLocalApiStream(
          url,
          opts.hostId !== undefined
            ? {
                hostScope: 'explicit',
                hostId: opts.hostId,
                relayHostId: opts.hostId,
              }
            : undefined
        );

        if (closed || finished || myGen !== generation) {
          opened.close();
          return;
        }

        ws = opened;

        opened.addEventListener('open', () => {
          if (myGen !== generation) return;
          connected = true;
          clearConnectTimer();
          // A successful open resets the retry budget so a later drop still
          // gets its full set of reconnection attempts.
          attempt = 0;
          opts.onConnect?.();
        });

        opened.addEventListener('message', (event) => {
          if (myGen !== generation) return;
          handleMessage(event as MessageEvent, myGen);
        });

        opened.addEventListener('error', () => {
          if (myGen !== generation) return;
          // Let 'close' (which always follows) drive the retry logic.
          connected = false;
        });

        opened.addEventListener('close', () => {
          if (myGen !== generation) return;
          connected = false;
          cancelFlush();
          if (closed || finished) return;
          // Closed before we saw "finished" — treat as a drop and reconnect.
          clearConnectTimer();
          clearSilenceTimer();
          ws = null;
          scheduleRetry(new Error('WebSocket closed before finish'));
        });
      } catch (error) {
        if (closed || finished || myGen !== generation) return;
        clearConnectTimer();
        scheduleRetry(error);
      }
    })();
  }

  connect();

  return {
    getEntries(): E[] {
      return snapshot.entries;
    },
    getSnapshot(): PatchContainer<E> {
      return snapshot;
    },
    isConnected(): boolean {
      return connected;
    },
    onChange(cb: (entries: E[]) => void): () => void {
      subscribers.add(cb);
      // push current state immediately
      cb(snapshot.entries);
      return () => subscribers.delete(cb);
    },
    close(): void {
      closed = true;
      // Abandon any in-flight connection attempt.
      generation += 1;
      clearConnectTimer();
      clearSilenceTimer();
      clearRetryTimer();
      cancelFlush();
      if (ws) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        ws = null;
      }
      subscribers.clear();
      connected = false;
    },
  };
}

/**
 * Drop a `replace` that a later `replace` on the same path supersedes, when
 * only replaces on unrelated paths sit in between — the streaming-delta case
 * where one entry is re-sent per token. Order is preserved and nothing else is
 * ever dropped: `add`/`remove` shift the array index of everything after them,
 * so an `add` superseded by a later `replace` of the same index cannot be
 * skipped (the adds between them would land one slot early and the replace
 * would then overwrite one of them). Mirrors `squash_replaces` in
 * crates/utils/src/ws_batch.rs.
 */
export function squashReplaces(ops: Operation[]): Operation[] {
  const dropped = new Set<number>();
  const pending = new Map<string, number>();
  ops.forEach((op, index) => {
    if (op.op !== 'replace') {
      pending.clear();
      return;
    }
    for (const other of pending.keys()) {
      if (other !== op.path && related(other, op.path)) pending.delete(other);
    }
    const previous = pending.get(op.path);
    if (previous !== undefined) dropped.add(previous);
    pending.set(op.path, index);
  });
  return dropped.size === 0 ? ops : ops.filter((_, i) => !dropped.has(i));
}

/** Whether one JSON pointer is a strict ancestor of the other. */
function related(a: string, b: string): boolean {
  const isPrefix = (outer: string, inner: string) =>
    inner.startsWith(outer) && inner.charAt(outer.length) === '/';
  return isPrefix(a, b) || isPrefix(b, a);
}
