import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataChannelMessage, WsFrame } from "shared/types";
import { setLocalApiTransport } from "@/shared/lib/localApiTransport";
import { clearWsSnapshots } from "@/shared/lib/wsSnapshotCache";
import { useJsonPatchWsStream } from "@/shared/hooks/useJsonPatchWsStream";
import { bytesToBase64 } from "@remote/shared/lib/relay/bytes";
import { WebRtcConnection } from "./connection";
import { Defragmenter, fragment } from "./chunking";
import { createDataChannelWebSocket } from "./dataChannelWebSocket";
import { requestLocalApiViaWebRtc } from "./transport";

const runtime = vi.hoisted(() => ({
  connection: null as WebRtcConnection | null,
}));
const relayRequest = vi.hoisted(() =>
  vi.fn(async () => new Response("fallback")),
);
vi.mock("./connectionManager", () => ({
  WEBRTC_ENABLED: true,
  getWebRtcConnection: () => runtime.connection,
}));
vi.mock("@remote/shared/lib/relayHostApi", () => ({
  requestRelayHostApi: async () =>
    new Response(JSON.stringify({ success: true, data: { sdp: "answer" } })),
  requestLocalApiViaRelay: relayRequest,
}));
vi.mock("@remote/shared/lib/relay/routing", () => ({
  shouldRelayApiPath: () => true,
  toPathAndQuery: (path: string) => path,
  resolveRelayHostIdForCurrentPage: () => "host-1",
}));
vi.mock("@/shared/providers/HostIdProvider", () => ({
  useHostId: () => null,
  getCurrentHostId: () => null,
}));

class FakeDataChannel extends EventTarget {
  readyState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType = "arraybuffer";
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly chunks: Uint8Array[] = [];
  readonly outgoing: DataChannelMessage[] = [];
  readonly listeners = new Map<
    string,
    Set<EventListenerOrEventListenerObject>
  >();
  private defrag = new Defragmenter();

  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    super.addEventListener(type, listener, options);
    if (listener) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }
  }

  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ) {
    super.removeEventListener(type, listener, options);
    if (listener) this.listeners.get(type)?.delete(listener);
  }

  get listenerCount() {
    return [...this.listeners.values()].reduce(
      (sum, listeners) => sum + listeners.size,
      0,
    );
  }

  send(chunk: Uint8Array) {
    expect(this.readyState).toBe("open");
    this.bufferedAmount += chunk.byteLength;
    expect(this.bufferedAmount).toBeLessThanOrEqual(1024 * 1024);
    this.chunks.push(chunk.slice());
    const complete = this.defrag.process(new Uint8Array(chunk).buffer);
    if (complete)
      this.outgoing.push(JSON.parse(new TextDecoder().decode(complete)));
  }

  receive(message: DataChannelMessage) {
    for (const chunk of fragment(
      new TextEncoder().encode(JSON.stringify(message)),
    )) {
      this.onmessage?.(
        new MessageEvent("message", { data: new Uint8Array(chunk).buffer }),
      );
    }
  }

  drain() {
    this.bufferedAmount = 0;
    this.dispatchEvent(new Event("bufferedamountlow"));
  }

  close() {
    this.readyState = "closed";
    this.onclose?.();
    this.dispatchEvent(new Event("close"));
  }
}

class FakePeerConnection {
  static latest: FakePeerConnection;
  readonly channel = new FakeDataChannel();
  localDescription = { sdp: "offer" };
  iceConnectionState = "connected";
  onicecandidate: ((event: { candidate: null }) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  close = vi.fn();
  constructor() {
    FakePeerConnection.latest = this;
  }
  createDataChannel() {
    return this.channel;
  }
  async createOffer() {
    return this.localDescription;
  }
  async setLocalDescription() {
    this.onicecandidate?.({ candidate: null });
  }
  async setRemoteDescription() {}
}

let conn: WebRtcConnection;
let dc: FakeDataChannel;
let disconnected: ReturnType<typeof vi.fn>;
const flush = () => vi.advanceTimersByTimeAsync(0);
const frame = (connId: string, text: string): WsFrame => ({
  conn_id: connId,
  msg_type: "text",
  payload_b64: bytesToBase64(new TextEncoder().encode(text)),
});

async function openWs() {
  const handlers = { onFrame: vi.fn(), onClose: vi.fn(), onError: vi.fn() };
  const opening = conn.openWs("/stream", undefined, handlers);
  await flush();
  const request = dc.outgoing.at(-1)!;
  expect(request.type).toBe("ws_open");
  if (request.type !== "ws_open") throw new Error("missing WS open");
  dc.receive({ type: "ws_opened", conn_id: request.conn_id });
  return { ...(await opening), handlers };
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  vi.stubGlobal("WebSocket", { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  vi.stubGlobal(
    "CloseEvent",
    class extends Event {
      code: number;
      reason: string;
      wasClean: boolean;
      constructor(type: string, init: CloseEventInit = {}) {
        super(type);
        this.code = init.code ?? 0;
        this.reason = init.reason ?? "";
        this.wasClean = init.wasClean ?? false;
      }
    },
  );
  disconnected = vi.fn();
  conn = await WebRtcConnection.connect("host-1", {
    onDisconnect: disconnected,
  });
  dc = FakePeerConnection.latest.channel;
  runtime.connection = conn;
  relayRequest.mockClear();
});

afterEach(async () => {
  conn.close();
  await flush();
  runtime.connection = null;
  setLocalApiTransport(null);
  clearWsSnapshots();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WebRTC backpressure", () => {
  it("expires a sent GET without resending a POST routed through the relay", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const slow = requestLocalApiViaWebRtc("/api/slow");
    await vi.advanceTimersByTimeAsync(1000);
    relayRequest.mockResolvedValueOnce(new Response(null, { status: 201 }));
    const post = requestLocalApiViaWebRtc("/api/create", {
      method: "POST",
      body: "{}",
    });
    await flush();
    expect((await post).status).toBe(201);
    expect(dc.outgoing).toEqual([
      expect.objectContaining({ type: "http_request", method: "GET" }),
    ]);
    await vi.advanceTimersByTimeAsync(29000);
    expect(conn.isConnected).toBe(true);
    await slow;
    expect(relayRequest.mock.calls).toEqual([
      ["/api/create", { method: "POST", body: "{}" }],
      ["/api/slow", {}],
    ]);
    expect(disconnected).not.toHaveBeenCalled();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "keeps a pending %s on the relay when the WebRTC backlog overflows",
    async (method) => {
      const ws = await openWs();
      let complete!: (response: Response) => void;
      relayRequest.mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
      );
      const init = { method, body: "{}" };
      const request = requestLocalApiViaWebRtc("/api/change", init);
      await flush();
      expect(dc.outgoing).toEqual([
        expect.objectContaining({ type: "ws_open" }),
      ]);
      Reflect.set(conn, "queuedBytes", 128 * 1024 * 1024);
      ws.send(frame(ws.connId, "over capacity"));
      await flush();
      expect(disconnected).toHaveBeenCalledOnce();
      expect(relayRequest.mock.calls).toEqual([["/api/change", init]]);
      complete(new Response(null, { status: 201 }));
      expect((await request).status).toBe(201);
      expect(relayRequest).toHaveBeenCalledOnce();
    },
  );

  it("cancels an unsent request and releases its buffer wait without closing the channel", async () => {
    dc.bufferedAmount = 1024 * 1024;
    const expired = conn
      .sendHttpRequest("POST", "/expired", {})
      .catch((error) => error);
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    const healthy = conn.sendHttpRequest("GET", "/healthy", {}).then(
      (response) => response.status,
      (error) => error,
    );
    await vi.advanceTimersByTimeAsync(29000);
    expect(await expired).toBeInstanceOf(Error);
    expect(conn.isConnected).toBe(true);
    dc.drain();
    await flush();
    expect(dc.outgoing).toHaveLength(1);
    const sent = dc.outgoing[0];
    if (sent.type !== "http_request") throw new Error("missing request");
    expect(sent.path).toBe("/healthy");
    dc.receive({
      type: "http_response",
      id: sent.id,
      status: 200,
      headers: {},
    });
    expect(await healthy).toBe(200);
    expect(dc.listenerCount).toBe(0);
    expect(disconnected).not.toHaveBeenCalled();
  });

  it("closes a partial HTTP message before a retry can leave trailing fragments", async () => {
    const expired = conn
      .sendHttpRequest("POST", "/partial", {}, new Uint8Array(2 * 1024 * 1024))
      .catch((error) => error);
    await flush();
    expect(dc.chunks.length).toBeGreaterThan(0);
    expect(dc.outgoing).toHaveLength(0);
    const sentChunks = dc.chunks.length;
    await vi.advanceTimersByTimeAsync(30000);
    expect(await expired).toBeInstanceOf(Error);
    expect(disconnected).toHaveBeenCalledOnce();
    dc.drain();
    await flush();
    expect(dc.chunks).toHaveLength(sentChunks);
    expect(dc.listenerCount).toBe(0);
  });

  it("bounds the channel buffer and keeps concurrent WS messages intact across drains", async () => {
    const first = await openWs();
    const second = await openWs();
    const a = frame(first.connId, "a".repeat(1500000));
    const b = frame(second.connId, "b");
    first.send(a);
    second.send(b);
    await flush();
    expect(dc.listenerCount).toBeGreaterThan(0);
    for (let i = 0; i < 4; i++) {
      dc.drain();
      await flush();
    }
    expect(
      dc.outgoing.filter((message) => message.type === "ws_frame"),
    ).toEqual([
      { type: "ws_frame", ...a },
      { type: "ws_frame", ...b },
    ]);
    expect(dc.bufferedAmountLowThreshold).toBe(256 * 1024);
    expect(dc.listenerCount).toBe(0);
  });

  it.each(["explicit", "channel", "error", "ice", "timeout"])(
    "settles buffer waits and removes listeners on %s",
    async (cause) => {
      const ws = await openWs();
      dc.bufferedAmount = 1024 * 1024;
      ws.send(frame(ws.connId, "blocked"));
      await flush();
      if (cause === "explicit") conn.close();
      if (cause === "channel") dc.close();
      if (cause === "error") dc.onerror?.();
      if (cause === "ice") {
        FakePeerConnection.latest.iceConnectionState = "disconnected";
        FakePeerConnection.latest.oniceconnectionstatechange?.();
      }
      if (cause === "timeout") await vi.advanceTimersByTimeAsync(30000);
      await flush();
      expect(dc.listenerCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(ws.handlers.onClose).toHaveBeenCalledOnce();
      expect(disconnected).toHaveBeenCalledTimes(cause === "explicit" ? 0 : 1);
    },
  );

  it.each(["GET", "HEAD"])(
    "falls back for a sent %s when the JS backlog cap closes the channel",
    async (method) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const ws = await openWs();
      const request = requestLocalApiViaWebRtc("/api/read", { method });
      await flush();
      expect(dc.outgoing.at(-1)).toEqual(
        expect.objectContaining({ type: "http_request", method }),
      );
      Reflect.set(conn, "queuedBytes", 128 * 1024 * 1024);
      ws.send(frame(ws.connId, "over capacity"));
      expect((await request).status).toBe(200);
      expect(relayRequest.mock.calls).toEqual([["/api/read", { method }]]);
      expect(disconnected).toHaveBeenCalledOnce();
      expect(ws.handlers.onClose).toHaveBeenCalledOnce();
    },
  );

  it("reconnects the real stream hook after 1013 and replaces stale state with a replayed snapshot", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "document",
      Object.assign(new EventTarget(), {
        nodeType: 9,
        visibilityState: "visible",
        activeElement: null,
      }),
    );
    vi.stubGlobal(
      "window",
      Object.assign(new EventTarget(), {
        document,
        setTimeout,
        clearTimeout,
        HTMLIFrameElement: class {},
      }),
    );
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 16),
    );
    vi.stubGlobal("cancelAnimationFrame", clearTimeout);
    const container = Object.assign(new EventTarget(), {
      nodeType: 1,
      tagName: "DIV",
      ownerDocument: document,
    });
    const root = createRoot(container as unknown as HTMLElement);
    setLocalApiTransport({
      request: vi.fn(),
      openWebSocket: (path) => createDataChannelWebSocket(conn, path),
    });
    let result: ReturnType<typeof useJsonPatchWsStream<{ count: number }>>;
    function Probe() {
      result = useJsonPatchWsStream("/stream", true, () => ({ count: 0 }), {
        keepSnapshotForEndpoint: true,
      });
      return null;
    }
    const snapshot = (connId: string, count: number) =>
      dc.receive({
        type: "ws_frame",
        ...frame(
          connId,
          JSON.stringify({
            JsonPatch: [{ op: "replace", path: "/count", value: count }],
          }),
        ),
      });
    try {
      await act(async () => {
        root.render(createElement(Probe));
      });
      await act(flush);
      const first = dc.outgoing.at(-1)!;
      if (first.type !== "ws_open")
        throw new Error("missing initial subscription");
      await act(async () => {
        dc.receive({ type: "ws_opened", conn_id: first.conn_id });
        await flush();
        snapshot(first.conn_id, 1);
        await vi.advanceTimersByTimeAsync(16);
      });
      expect(result!.data).toEqual({ count: 1 });
      await act(async () => {
        dc.receive({
          type: "ws_close",
          conn_id: first.conn_id,
          code: 1013,
          reason: "receive queue full",
        });
        await vi.advanceTimersByTimeAsync(2000);
      });
      await act(flush);
      const reopened = dc.outgoing.at(-1)!;
      if (reopened.type !== "ws_open")
        throw new Error("subscription did not reconnect");
      expect(reopened.conn_id).not.toBe(first.conn_id);
      await act(async () => {
        dc.receive({ type: "ws_opened", conn_id: reopened.conn_id });
        await flush();
        snapshot(reopened.conn_id, 65);
        dc.receive({
          type: "ws_frame",
          ...frame(reopened.conn_id, JSON.stringify({ Ready: true })),
        });
        await vi.advanceTimersByTimeAsync(16);
      });
      expect(result!.data).toEqual({ count: 65 });
      expect(result!.isConnected).toBe(true);
      expect(result!.isInitialized).toBe(true);
      expect(disconnected).not.toHaveBeenCalled();
    } finally {
      await act(() => root.unmount());
    }
  });
});
