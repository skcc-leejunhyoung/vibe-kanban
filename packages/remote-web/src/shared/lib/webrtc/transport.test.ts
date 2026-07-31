import { beforeEach, describe, expect, it, vi } from "vitest";

// With WEBRTC_ENABLED=false the transport must route every relayable local API
// call straight to the relay HTTP/WS path and never touch the WebRTC data
// channel (mDNS-hidden candidates + no TURN make P2P impossible in some
// networks). These mocks let us assert exactly that: relay delegate is called,
// WebRTC is not. If someone removes the guard, getWebRtcConnection starts
// getting called and these tests fail.
const requestLocalApiViaRelayMock = vi.fn(
  async (..._args: unknown[]) => ({}) as Response,
);
const openLocalApiWebSocketViaRelayMock = vi.fn(
  async (..._args: unknown[]) => ({}) as WebSocket,
);
const openSseAsWebSocketMock = vi.fn(
  (_url: string, _fetchImpl: typeof fetch) => ({}) as WebSocket,
);
const getWebRtcConnectionMock = vi.fn();
const createDataChannelWebSocketMock = vi.fn();

vi.mock("./connectionManager", () => ({
  getWebRtcConnection: (...args: unknown[]) => getWebRtcConnectionMock(...args),
  WEBRTC_ENABLED: false,
}));
vi.mock("@remote/shared/lib/relayHostApi", () => ({
  requestLocalApiViaRelay: (...args: unknown[]) =>
    requestLocalApiViaRelayMock(...args),
  openLocalApiWebSocketViaRelay: (...args: unknown[]) =>
    openLocalApiWebSocketViaRelayMock(...args),
}));
vi.mock("@/shared/lib/sseStream", () => ({
  openSseAsWebSocket: (url: string, fetchImpl: typeof fetch) =>
    openSseAsWebSocketMock(url, fetchImpl),
  toSseUrl: (path: string) => path.replace(/\/ws(\?|$)/, "/sse$1"),
}));
vi.mock("./dataChannelWebSocket", () => ({
  createDataChannelWebSocket: (...args: unknown[]) =>
    createDataChannelWebSocketMock(...args),
}));
vi.mock("@remote/shared/lib/relay/routing", () => ({
  shouldRelayApiPath: () => true,
  toPathAndQuery: (x: string) => x,
  resolveRelayHostIdForCurrentPage: () => "host-1",
}));
vi.mock("@remote/shared/lib/relay/bytes", () => ({
  base64ToBytes: vi.fn(),
}));

import {
  requestLocalApiViaWebRtc,
  openLocalApiStreamViaWebRtc,
  openLocalApiWebSocketViaWebRtc,
} from "./transport";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("transport — WebRTC disabled (relay-only)", () => {
  it("HTTP request bypasses WebRTC and delegates to the relay path", async () => {
    await requestLocalApiViaWebRtc("/api/info");

    expect(requestLocalApiViaRelayMock).toHaveBeenCalledOnce();
    expect(getWebRtcConnectionMock).not.toHaveBeenCalled();
  });

  it("WebSocket bypasses the data channel and delegates to the relay WS path", async () => {
    await openLocalApiWebSocketViaWebRtc("/api/workspaces/streams/ws");

    expect(openLocalApiWebSocketViaRelayMock).toHaveBeenCalledOnce();
    expect(getWebRtcConnectionMock).not.toHaveBeenCalled();
    expect(createDataChannelWebSocketMock).not.toHaveBeenCalled();
  });

  it("opens one-way streams through relay SSE instead of relay WebSocket", async () => {
    openLocalApiStreamViaWebRtc("/api/workspaces/streams/ws", {
      relayHostId: "host-1",
    });

    expect(openSseAsWebSocketMock).toHaveBeenCalledOnce();
    const [url, fetchViaRelay] = openSseAsWebSocketMock.mock
      .calls[0] as unknown as [string, typeof fetch];
    expect(url).toBe("/api/workspaces/streams/sse");

    await fetchViaRelay(url, { headers: { Accept: "text/event-stream" } });
    expect(requestLocalApiViaRelayMock).toHaveBeenCalledWith(url, {
      headers: { Accept: "text/event-stream" },
      hostScope: undefined,
      hostId: undefined,
      relayHostId: "host-1",
    });
    expect(openLocalApiWebSocketViaRelayMock).not.toHaveBeenCalled();
    expect(getWebRtcConnectionMock).not.toHaveBeenCalled();
  });

  it("never opens a WebRTC data channel for any relayable request", async () => {
    await requestLocalApiViaWebRtc("/api/workspaces/0b11a24b/git/status");
    await openLocalApiWebSocketViaWebRtc("/api/sessions/streams/ws");

    // The whole point of the switch: zero WebRTC/ICE activity.
    expect(getWebRtcConnectionMock).not.toHaveBeenCalled();
    expect(createDataChannelWebSocketMock).not.toHaveBeenCalled();
    expect(requestLocalApiViaRelayMock).toHaveBeenCalledTimes(1);
    expect(openLocalApiWebSocketViaRelayMock).toHaveBeenCalledTimes(1);
  });
});
