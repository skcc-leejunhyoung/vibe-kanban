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
  cm.closeWebRtcConnection("host-stuck");
  cm.closeWebRtcConnection("host-stale");
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

  it("drops a stuck connecting entry on resume so the host can reconnect", async () => {
    const host = "host-stuck";
    // A connect that was in flight when the PWA suspended never settles.
    connectMock.mockReturnValueOnce(new Promise(() => {}));

    expect(cm.getWebRtcConnection(host)).toBeNull(); // connecting (stuck)
    await flush();
    // Still stuck: getWebRtcConnection refuses to start a new connect while
    // `connecting`, so without the reset this host would spin forever.
    expect(cm.getWebRtcConnection(host)).toBeNull();
    expect(connectMock).toHaveBeenCalledTimes(1);

    // Resume must clear the stuck connecting entry...
    cm.resetWebRtcConnectionsForResume();
    // ...so the next request starts a fresh connect.
    connectMock.mockResolvedValueOnce(makeConn(true));
    expect(cm.getWebRtcConnection(host)).toBeNull();
    await flush();
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(cm.getWebRtcConnection(host)).not.toBeNull();
  });

  it("ignores a stale connect that settles after a resume reset", async () => {
    const host = "host-stale";
    let resolveStale!: (c: unknown) => void;
    const staleConn = makeConn(true);
    connectMock.mockReturnValueOnce(
      new Promise((r) => {
        resolveStale = r;
      }),
    );

    expect(cm.getWebRtcConnection(host)).toBeNull(); // connecting (gen 1)

    // Resume drops the in-flight connect; a fresh request starts a new one.
    cm.resetWebRtcConnectionsForResume();
    const freshConn = makeConn(true);
    connectMock.mockResolvedValueOnce(freshConn);
    expect(cm.getWebRtcConnection(host)).toBeNull(); // connecting (gen 2)
    await flush();
    expect(cm.getWebRtcConnection(host)).toBe(freshConn); // gen 2 connected

    // The original (gen 1) connect finally resolves — it must NOT clobber the
    // fresh connection, and must close its now-orphaned connection.
    resolveStale(staleConn);
    await flush();
    expect(cm.getWebRtcConnection(host)).toBe(freshConn);
    expect(staleConn.close).toHaveBeenCalledTimes(1);
  });
});
