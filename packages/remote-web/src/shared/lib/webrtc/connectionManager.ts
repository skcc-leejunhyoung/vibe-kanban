import { WebRtcConnection } from "./connection";

const FAILED_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

type HostEntry =
  | { state: "connecting" }
  | { state: "connected"; connection: WebRtcConnection }
  | { state: "failed"; failedAt: number };

const hosts = new Map<string, HostEntry>();

export function getWebRtcConnection(hostId: string): WebRtcConnection | null {
  const entry = hosts.get(hostId);

  if (entry?.state === "connected") {
    if (entry.connection.isConnected) {
      return entry.connection;
    }
    hosts.delete(hostId);
  }

  if (entry?.state === "connecting") {
    return null;
  }

  if (
    entry?.state === "failed" &&
    Date.now() - entry.failedAt < FAILED_RETRY_COOLDOWN_MS
  ) {
    return null;
  }

  startConnect(hostId);
  return null;
}

export function closeWebRtcConnection(hostId: string): void {
  const entry = hosts.get(hostId);
  if (entry?.state === "connected") {
    entry.connection.close();
  }
  hosts.delete(hostId);
}

/**
 * Drop any WebRTC state that a suspended PWA may have left stale on resume.
 *
 * A standalone (WebKit) PWA that was backgrounded can come back with a dead
 * peer connection whose close event never fired, and the host may have evicted
 * its (in-memory, 15-min idle TTL) relay signing session. Without this:
 *   - dead "connected" entries leak until the next request happens to probe
 *     `isConnected`, and
 *   - a host stuck in the 5-minute `failed` cooldown cannot reconnect at all,
 *     so the app spins until a full reload.
 *
 * Clearing `failed`/dead entries lets the next `getWebRtcConnection` rebuild a
 * fresh connection (and, via the relay HTTP path, a fresh signing session).
 * Healthy and in-flight (`connecting`) entries are left untouched.
 */
export function resetWebRtcConnectionsForResume(): void {
  for (const [hostId, entry] of hosts) {
    if (entry.state === "failed") {
      hosts.delete(hostId);
    } else if (entry.state === "connected" && !entry.connection.isConnected) {
      entry.connection.close();
      hosts.delete(hostId);
    }
  }
}

function startConnect(hostId: string): void {
  hosts.set(hostId, { state: "connecting" });

  WebRtcConnection.connect(hostId, {
    onDisconnect: () => {
      hosts.delete(hostId);
    },
  })
    .then((connection) => {
      hosts.set(hostId, { state: "connected", connection });
    })
    .catch((err) => {
      console.warn("[webrtc] connection failed for host", hostId, err);
      hosts.set(hostId, { state: "failed", failedAt: Date.now() });
    });
}
