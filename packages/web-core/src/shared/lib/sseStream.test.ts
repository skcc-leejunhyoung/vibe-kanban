import { describe, it, expect, vi } from 'vitest';
import {
  SseParser,
  sseEventToWsPayload,
  openSseAsWebSocket,
} from './sseStream';

// A ReadableStream that emits the given text chunks then closes — stands in for
// fetch().body so the adapter can be exercised without a real network.
function bodyOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
}

// ---------------------------------------------------------------------------
// sseEventToWsPayload: maps a server SSE event (LogMsg::to_sse_event encoding)
// back to the exact JSON envelope the WS path produced (to_ws_message_unchecked),
// so the existing useJsonPatchWsStream / streamJsonPatchEntries message handlers
// stay byte-for-byte unchanged.
// ---------------------------------------------------------------------------
describe('sseEventToWsPayload', () => {
  it('wraps a bare json_patch array into {JsonPatch}', () => {
    expect(
      sseEventToWsPayload('json_patch', '[{"op":"add","path":"/a","value":1}]')
    ).toBe('{"JsonPatch":[{"op":"add","path":"/a","value":1}]}');
  });

  it('maps ready to the WS Ready envelope', () => {
    expect(sseEventToWsPayload('ready', '')).toBe('{"Ready":true}');
  });

  it('maps finished to the WS finished envelope', () => {
    expect(sseEventToWsPayload('finished', '')).toBe('{"finished":true}');
  });

  it('maps stdout/stderr to externally-tagged enum envelopes', () => {
    expect(sseEventToWsPayload('stdout', 'hello')).toBe('{"Stdout":"hello"}');
    expect(sseEventToWsPayload('stderr', 'oops')).toBe('{"Stderr":"oops"}');
  });

  it('maps session_id / message_id / scheduled_resume', () => {
    expect(sseEventToWsPayload('session_id', 's1')).toBe('{"SessionId":"s1"}');
    expect(sseEventToWsPayload('message_id', 'm1')).toBe('{"MessageId":"m1"}');
    expect(sseEventToWsPayload('scheduled_resume', '[]')).toBe(
      '{"ScheduledResume":"[]"}'
    );
  });

  it('returns null for unknown events (keep-alive comments, etc.)', () => {
    expect(sseEventToWsPayload('bogus', 'x')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SseParser: incremental SSE wire parser over ReadableStream text chunks.
// Implements the parts of the SSE spec we need: event/data fields, multi-line
// data, comment (keep-alive) lines, and events split across chunk boundaries.
// ---------------------------------------------------------------------------
describe('SseParser', () => {
  it('parses a single event terminated by a blank line', () => {
    const p = new SseParser();
    expect(p.feed('event: json_patch\ndata: [1,2]\n\n')).toEqual([
      { event: 'json_patch', data: '[1,2]' },
    ]);
  });

  it('defaults the event name to "message" when only data is present', () => {
    const p = new SseParser();
    expect(p.feed('data: hello\n\n')).toEqual([
      { event: 'message', data: 'hello' },
    ]);
  });

  it('joins multi-line data with newlines', () => {
    const p = new SseParser();
    expect(p.feed('data: a\ndata: b\n\n')).toEqual([
      { event: 'message', data: 'a\nb' },
    ]);
  });

  it('emits nothing until the terminating blank line arrives', () => {
    const p = new SseParser();
    expect(p.feed('event: ready\nda')).toEqual([]);
    expect(p.feed('ta: x\n\n')).toEqual([{ event: 'ready', data: 'x' }]);
  });

  it('ignores comment (keep-alive) lines', () => {
    const p = new SseParser();
    expect(p.feed(': keep-alive\n\nevent: ready\ndata: \n\n')).toEqual([
      { event: 'ready', data: '' },
    ]);
  });

  it('strips only one optional leading space after the colon', () => {
    const p = new SseParser();
    expect(p.feed('data:  two\n\n')).toEqual([
      { event: 'message', data: ' two' },
    ]);
  });

  it('tolerates CRLF line endings', () => {
    const p = new SseParser();
    expect(p.feed('event: ready\r\ndata: \r\n\r\n')).toEqual([
      { event: 'ready', data: '' },
    ]);
  });

  it('parses two events delivered in one chunk', () => {
    const p = new SseParser();
    expect(
      p.feed('event: ready\ndata: \n\nevent: finished\ndata: \n\n')
    ).toEqual([
      { event: 'ready', data: '' },
      { event: 'finished', data: '' },
    ]);
  });
});

describe('openSseAsWebSocket', () => {
  it('opens, maps events to WS payloads, then closes cleanly', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: bodyOf([
        'event: ready\ndata: \n\n',
        'event: json_patch\ndata: [{"op":"add","path":"/x","value":1}]\n\n',
      ]),
    } as Response);

    const socket = openSseAsWebSocket(
      '/api/x',
      fetchMock as unknown as typeof fetch
    );
    const messages: string[] = [];
    let opened = false;
    let closeEvt: { code?: number; wasClean?: boolean } | null = null;
    socket.onopen = () => {
      opened = true;
    };
    socket.onmessage = (e) => messages.push(e.data);
    socket.onclose = (e) => {
      closeEvt = e;
    };

    await vi.waitFor(() => expect(closeEvt).not.toBeNull());

    expect(opened).toBe(true);
    expect(messages).toEqual([
      '{"Ready":true}',
      '{"JsonPatch":[{"op":"add","path":"/x","value":1}]}',
    ]);
    expect(closeEvt).toEqual({ code: 1000, wasClean: true });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/x',
      expect.objectContaining({ cache: 'no-store' })
    );
  });

  it('reports an error close when the response is not ok', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500, body: null } as Response);
    const socket = openSseAsWebSocket(
      '/api/x',
      fetchMock as unknown as typeof fetch
    );
    let errored = false;
    let closeEvt: { code?: number; wasClean?: boolean } | null = null;
    socket.onerror = () => {
      errored = true;
    };
    socket.onclose = (e) => {
      closeEvt = e;
    };

    await vi.waitFor(() => expect(closeEvt).not.toBeNull());

    expect(errored).toBe(true);
    expect(closeEvt).toEqual({ code: 500, wasClean: false });
  });

  it('reports an error close when fetch rejects', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network'));
    const socket = openSseAsWebSocket(
      '/api/x',
      fetchMock as unknown as typeof fetch
    );
    let closeEvt: { code?: number; wasClean?: boolean } | null = null;
    socket.onclose = (e) => {
      closeEvt = e;
    };

    await vi.waitFor(() => expect(closeEvt).not.toBeNull());

    expect(closeEvt).toEqual({ wasClean: false });
  });
});
