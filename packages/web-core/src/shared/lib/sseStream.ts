// Client-side Server-Sent Events plumbing for the WS→SSE migration.
//
// WebKit standalone PWAs cannot reliably open the ~7-9 concurrent WebSockets a
// workspace needs (the handshakes hang for the full connect-watchdog timeout),
// so the JSON-patch streams move to HTTP/SSE. The server already serializes
// every stream message via `LogMsg::to_sse_event()` (crates/utils/src/log_msg.rs).
//
// This module holds the two pure pieces the SSE transport adapter is built from,
// kept separate so they unit-test without a DOM:
//   - SseParser:           incremental wire parser over text chunks
//   - sseEventToWsPayload:  SSE event → the exact JSON envelope the WS path used
//
// Mapping SSE events back to the WS envelope means the existing message handlers
// in useJsonPatchWsStream / streamJsonPatchEntries stay byte-for-byte unchanged.

export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Incremental SSE parser. Feed it text chunks as they arrive from a
 * ReadableStream reader; it returns whichever complete events the chunk
 * completed (events are dispatched on a blank line, per the SSE spec).
 */
export class SseParser {
  private buf = '';
  private eventName = '';
  private dataLines: string[] = [];
  private hasFields = false;

  feed(chunk: string): SseEvent[] {
    this.buf += chunk;
    const out: SseEvent[] = [];

    let newlineIdx: number;
    while ((newlineIdx = this.buf.indexOf('\n')) >= 0) {
      let line = this.buf.slice(0, newlineIdx);
      this.buf = this.buf.slice(newlineIdx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);

      if (line === '') {
        // Blank line → dispatch the accumulated event (if any fields were set).
        if (this.hasFields) {
          out.push({
            event: this.eventName || 'message',
            data: this.dataLines.join('\n'),
          });
        }
        this.eventName = '';
        this.dataLines = [];
        this.hasFields = false;
        continue;
      }

      // Comment / keep-alive line.
      if (line.startsWith(':')) continue;

      const colonIdx = line.indexOf(':');
      let field: string;
      let value: string;
      if (colonIdx === -1) {
        field = line;
        value = '';
      } else {
        field = line.slice(0, colonIdx);
        value = line.slice(colonIdx + 1);
        // Spec: a single optional leading space after the colon is stripped.
        if (value.startsWith(' ')) value = value.slice(1);
      }

      if (field === 'event') {
        this.eventName = value;
        this.hasFields = true;
      } else if (field === 'data') {
        this.dataLines.push(value);
        this.hasFields = true;
      }
      // `id`/`retry` are ignored: the hook owns reconnect, not EventSource.
    }

    return out;
  }
}

/**
 * Map a server SSE event (LogMsg::to_sse_event encoding) back to the exact JSON
 * string the WS path produced via LogMsg::to_ws_message_unchecked, so the
 * downstream message handlers need no changes.
 *
 * Returns null for events with no WS equivalent (e.g. stray keep-alive names),
 * which the adapter then drops.
 */
export function sseEventToWsPayload(
  event: string,
  data: string
): string | null {
  switch (event) {
    case 'json_patch':
      // SSE sends the bare patch array; the WS path wrapped it in {JsonPatch}.
      return JSON.stringify({ JsonPatch: JSON.parse(data) });
    case 'ready':
      return '{"Ready":true}';
    case 'finished':
      return '{"finished":true}';
    case 'stdout':
      return JSON.stringify({ Stdout: data });
    case 'stderr':
      return JSON.stringify({ Stderr: data });
    case 'session_id':
      return JSON.stringify({ SessionId: data });
    case 'message_id':
      return JSON.stringify({ MessageId: data });
    case 'scheduled_resume':
      return JSON.stringify({ ScheduledResume: data });
    default:
      return null;
  }
}

// The minimal WebSocket surface that useJsonPatchWsStream / streamJsonPatchEntries
// actually drive. The SSE adapter implements exactly this so the consumers can
// treat it like a socket and keep their watchdog/backoff/resume logic unchanged.
//
// Two consumers, two subscription styles: useJsonPatchWsStream / useLogStream
// assign the `onX` setters, while streamJsonPatchEntries subscribes via
// `addEventListener`. The adapter has to honour both to stand in for a WebSocket.
export interface SseSocketLike {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((ev: { code?: number; wasClean?: boolean }) => void) | null;
  readyState: number;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (ev?: unknown) => void): void;
  removeEventListener(type: string, listener: (ev?: unknown) => void): void;
}

// WebSocket.readyState values, replicated so this module needs no DOM constant.
const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

/**
 * Open an SSE stream and expose it through the WebSocket-shaped `SseSocketLike`
 * surface. Backed by fetch + ReadableStream (not EventSource) so the consumer
 * hook keeps owning reconnect/backoff instead of EventSource's built-in retry,
 * and so we can read a clean end-of-stream as a 1000/wasClean close.
 *
 * `fetchImpl` is injectable for tests.
 */
export function openSseAsWebSocket(
  url: string,
  fetchImpl: typeof fetch = fetch
): SseSocketLike {
  const controller = new AbortController();
  let closed = false;

  const listeners: Record<string, Set<(ev?: unknown) => void>> = {
    open: new Set(),
    message: new Set(),
    error: new Set(),
    close: new Set(),
  };

  const socket: SseSocketLike = {
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    readyState: CONNECTING,
    close(_code?: number, _reason?: string) {
      if (closed) return;
      closed = true;
      socket.readyState = CLOSED;
      controller.abort();
    },
    addEventListener(type, listener) {
      listeners[type]?.add(listener);
    },
    removeEventListener(type, listener) {
      listeners[type]?.delete(listener);
    },
  };

  // Dispatch to both the onX setter and any addEventListener subscribers so
  // consumers using either WebSocket API style receive every event.
  const fireOpen = () => {
    socket.onopen?.();
    for (const l of listeners.open) l();
  };
  const fireMessage = (data: string) => {
    socket.onmessage?.({ data });
    for (const l of listeners.message) l({ data });
  };
  const fireError = () => {
    socket.onerror?.();
    for (const l of listeners.error) l();
  };
  const fireClose = (ev: { code?: number; wasClean?: boolean }) => {
    socket.onclose?.(ev);
    for (const l of listeners.close) l(ev);
  };

  void (async () => {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { Accept: 'text/event-stream' },
        cache: 'no-store',
      });
    } catch {
      if (closed) return;
      socket.readyState = CLOSED;
      fireError();
      fireClose({ wasClean: false });
      return;
    }

    if (closed) return;

    if (!response.ok || !response.body) {
      socket.readyState = CLOSED;
      fireError();
      fireClose({ code: response.status, wasClean: false });
      return;
    }

    socket.readyState = OPEN;
    fireOpen();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (closed) return;
        if (done) break;
        for (const ev of parser.feed(decoder.decode(value, { stream: true }))) {
          const payload = sseEventToWsPayload(ev.event, ev.data);
          if (payload !== null) fireMessage(payload);
        }
      }
    } catch {
      if (closed) return;
      socket.readyState = CLOSED;
      fireError();
      fireClose({ wasClean: false });
      return;
    }

    if (closed) return;
    // Server ended the stream → mirror a clean WebSocket close so the consumer
    // does not treat it as an error and reconnect.
    socket.readyState = CLOSED;
    fireClose({ code: 1000, wasClean: true });
  })();

  return socket;
}

/**
 * Map a WebSocket stream endpoint to its SSE sibling. The server exposes each
 * JSON-patch stream at both `/.../ws` and `/.../sse`, so only the final path
 * segment changes; query strings are preserved.
 */
export function toSseUrl(wsPathOrUrl: string): string {
  return wsPathOrUrl.replace(/\/ws(\?|$)/, '/sse$1');
}

/**
 * Decide the stream transport from the page protocol and an opt-in flag.
 *
 * Over HTTP/2 (https) SSE multiplexes across a single connection, so the
 * browser's HTTP/1.1 6-connection-per-host limit doesn't apply and SSE both
 * fixes the WebKit-standalone WebSocket hang and scales past 6 streams. Over
 * plain HTTP/1.1 SSE would instead starve on that 6-connection limit, so we
 * stay on WebSocket there unless a client explicitly opts in for testing.
 */
export function resolveStreamTransport(input: {
  protocol: string;
  flag: string | null;
}): 'sse' | 'ws' {
  if (input.protocol === 'https:') return 'sse';
  if (input.flag === 'sse') return 'sse';
  return 'ws';
}

/** Whether the local stream transport should use SSE instead of WebSocket. */
export function shouldUseSseStream(): boolean {
  try {
    const protocol = typeof location !== 'undefined' ? location.protocol : '';
    const flag =
      typeof localStorage !== 'undefined'
        ? localStorage.getItem('vk-stream-transport')
        : null;
    return resolveStreamTransport({ protocol, flag }) === 'sse';
  } catch {
    return false;
  }
}
