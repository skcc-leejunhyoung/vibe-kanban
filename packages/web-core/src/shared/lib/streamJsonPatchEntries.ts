// streamJsonPatchEntries.ts - WebSocket JSON patch streaming utility
import { produce } from 'immer';
import type { Operation } from 'rfc6902';
import { applyUpsertPatch } from '@/shared/lib/jsonPatch';
import { openLocalApiWebSocket } from '@/shared/lib/localApiTransport';

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
   * Maximum (re)connection attempts before giving up and calling `onError`.
   * Covers both stalled connects and drops that happen before `finished`.
   */
  maxRetries?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 5;

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
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  // Fresh copy of the baseline the stream starts from. The server replays the
  // full history on every (re)connection, so each reconnect must rebuild from
  // this baseline rather than appending onto entries from the prior connection.
  const initialSnapshot = (): PatchContainer<E> =>
    structuredClone(opts.initial ?? ({ entries: [] } as PatchContainer<E>));
  let snapshot: PatchContainer<E> = initialSnapshot();

  const subscribers = new Set<(entries: E[]) => void>();
  if (opts.onEntries) subscribers.add(opts.onEntries);

  // --- rAF batching state ---
  let pendingOps: Operation[] = [];
  let rafId: number | null = null;

  const notify = () => {
    for (const cb of subscribers) {
      try {
        cb(snapshot.entries);
      } catch {
        /* swallow subscriber errors */
      }
    }
  };

  const flush = () => {
    rafId = null;
    if (pendingOps.length === 0) return;

    const ops = dedupeOps(pendingOps);
    pendingOps = [];

    snapshot = produce(snapshot, (draft) => {
      applyUpsertPatch(draft, ops);
    });
    notify();
  };

  const clearConnectTimer = () => {
    if (connectTimer !== null) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
  };

  const clearRetryTimer = () => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const cancelRaf = () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  };

  // Terminal failure: stop everything and surface the error once.
  const fail = (err: unknown) => {
    if (closed || finished) return;
    closed = true;
    clearConnectTimer();
    clearRetryTimer();
    cancelRaf();
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

  const handleMessage = (event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data);

      // Handle JsonPatch messages — accumulate ops for next rAF flush
      if (msg.JsonPatch) {
        const raw = msg.JsonPatch as Operation[];
        pendingOps.push(...raw);
        if (rafId === null) {
          rafId = requestAnimationFrame(flush);
        }
      }

      // Handle Finished messages — flush synchronously before closing
      if (msg.finished !== undefined) {
        finished = true;
        clearConnectTimer();
        clearRetryTimer();
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
        }
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
      }
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

    // Connect watchdog: if the socket never opens, abandon it and retry rather
    // than letting the caller wait on the browser's multi-minute timeout.
    connectTimer = setTimeout(() => {
      connectTimer = null;
      if (closed || finished || myGen !== generation) return;
      // Abandon this attempt: bumping the generation makes the in-flight
      // open()/listeners no-op even if the zombie later fires events.
      generation += 1;
      const stalled = ws;
      ws = null;
      if (stalled) {
        try {
          stalled.close();
        } catch {
          /* ignore */
        }
      }
      scheduleRetry(new Error('WebSocket connect timeout'));
    }, connectTimeoutMs);

    void (async () => {
      try {
        const opened = await openLocalApiWebSocket(url);

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
          handleMessage(event as MessageEvent);
        });

        opened.addEventListener('error', () => {
          if (myGen !== generation) return;
          // Let 'close' (which always follows) drive the retry logic.
          connected = false;
        });

        opened.addEventListener('close', () => {
          if (myGen !== generation) return;
          connected = false;
          cancelRaf();
          if (closed || finished) return;
          // Closed before we saw "finished" — treat as a drop and reconnect.
          clearConnectTimer();
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
      clearRetryTimer();
      cancelRaf();
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
 * Dedupe multiple ops that touch the same path within a batch.
 * Last write for a path wins, while preserving the overall left-to-right
 * order of the *kept* final operations.
 *
 * Example:
 *   add /entries/4, replace /entries/4  -> keep only the final replace
 */
function dedupeOps(ops: Operation[]): Operation[] {
  const lastIndexByPath = new Map<string, number>();
  ops.forEach((op, i) => lastIndexByPath.set(op.path, i));

  // Keep only the last op for each path, in ascending order of their final index
  const keptIndices = [...lastIndexByPath.values()].sort((a, b) => a - b);
  return keptIndices.map((i) => ops[i]!);
}
