import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// connectionManager only ever calls `WebRtcConnection.connect`; mock it so the
// real WebRTC/RTCPeerConnection code never loads in the node test environment.
const connectMock = vi.fn();
vi.mock("./connection", () => ({
  WebRtcConnection: {
    connect: (...args: unknown[]) => connectMock(...args),
  },
}));

import * as cm from "./connectionManager";

function makeConn(isConnected: boolean) {
  return { isConnected, close: vi.fn() };
}

// Flush startConnect's .then/.catch microtasks.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  connectMock.mockReset();
});

afterEach(() => {
  cm.closeWebRtcConnection("host-healthy");
  cm.closeWebRtcConnection("host-failed");
  cm.closeWebRtcConnection("host-dead");
  vi.restoreAllMocks();
});

describe("connectionManager — resume recovery", () => {
  it("returns a healthy connection and leaves it untouched on resume reset", async () => {
    const conn = makeConn(true);
    connectMock.mockResolvedValueOnce(conn);
    const host = "host-healthy";

    expect(cm.getWebRtcConnection(host)).toBeNull(); // connecting
    await flush();
    expect(cm.getWebRtcConnection(host)).toBe(conn); // connected
    expect(connectMock).toHaveBeenCalledTimes(1);

    cm.resetWebRtcConnectionsForResume();
    expect(cm.getWebRtcConnection(host)).toBe(conn); // still the same, healthy
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(conn.close).not.toHaveBeenCalled();
  });

  it("clears the failed cooldown on resume so the next request reconnects", async () => {
    // startConnect logs the (expected) failure via console.warn — silence it.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    connectMock.mockRejectedValueOnce(
      new Error("offer rejected: signing session expired"),
    );
    const host = "host-failed";

    expect(cm.getWebRtcConnection(host)).toBeNull(); // connecting → will fail
    await flush();
    expect(connectMock).toHaveBeenCalledTimes(1); // now in failed cooldown

    // During the 5-minute cooldown, further requests do NOT retry — this is the
    // lockout that strands a resumed PWA until a full page reload.
    expect(cm.getWebRtcConnection(host)).toBeNull();
    expect(cm.getWebRtcConnection(host)).toBeNull();
    expect(connectMock).toHaveBeenCalledTimes(1);

    // Resume (PWA woke up): the cooldown must be cleared so we reconnect with a
    // fresh signing session instead of waiting out the 5 minutes.
    cm.resetWebRtcConnectionsForResume();
    connectMock.mockResolvedValueOnce(makeConn(true));
    expect(cm.getWebRtcConnection(host)).toBeNull(); // triggers a fresh connect
    await flush();
    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it("closes and drops a dead connection on resume reset", async () => {
    const dead = makeConn(false);
    connectMock.mockResolvedValueOnce(dead);
    const host = "host-dead";

    expect(cm.getWebRtcConnection(host)).toBeNull();
    await flush();

    // The entry is "connected" but the data channel is dead (zombie peer from a
    // suspended PWA). Resume reset must close it so it is not leaked.
    cm.resetWebRtcConnectionsForResume();
    expect(dead.close).toHaveBeenCalledTimes(1);

    connectMock.mockResolvedValueOnce(makeConn(true));
    expect(cm.getWebRtcConnection(host)).toBeNull(); // brand-new connect
    await flush();
    expect(connectMock).toHaveBeenCalledTimes(2);
  });
});
