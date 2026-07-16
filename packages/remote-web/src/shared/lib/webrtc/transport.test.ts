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
