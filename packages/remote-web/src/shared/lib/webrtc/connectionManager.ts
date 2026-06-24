import { WebRtcConnection } from "./connection";

// Some browsers hide host ICE candidates behind mDNS (`.local`), and overlay /
// L3 networks don't carry mDNS multicast, so the host (webrtc-rs, which does
// not resolve mDNS) never learns the peer's address. With no TURN configured,
// WebRTC P2P cannot establish in such setups, leaving the data channel unopened
// and workspace entry stuck. We route all local API traffic over the relay
// HTTP/WS path instead — a first-class path, not a degraded fallback. Flip to
// `true` to re-enable WebRTC where direct P2P actually works (e.g. same LAN).
export const WEBRTC_ENABLED = false;

const FAILED_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

type HostEntry =
  | { state: "connecting"; token: object }
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
 * Clearing `failed`/dead/in-flight entries lets the next `getWebRtcConnection`
 * rebuild a fresh connection (and, via the relay HTTP path, a fresh signing
 * session). Only healthy `connected` entries are left untouched.
 */
export function resetWebRtcConnectionsForResume(): void {
  for (const [hostId, entry] of hosts) {
    if (entry.state === "failed") {
      hosts.delete(hostId);
    } else if (entry.state === "connected" && !entry.connection.isConnected) {
      entry.connection.close();
      hosts.delete(hostId);
    } else if (entry.state === "connecting") {
      // A connect in flight when the PWA suspended will likely never settle
      // (dead signaling, and connect() has no timeout); meanwhile
      // getWebRtcConnection refuses to start a new one while an entry is
      // `connecting`, so the host would spin forever. Drop it so the next
      // getWebRtcConnection starts fresh — the stale promise is neutralized by
      // the per-connect token guard in startConnect.
      hosts.delete(hostId);
    }
  }
}

function startConnect(hostId: string): void {
  // Unique identity for this connect. If the `connecting` entry is replaced or
  // dropped before the promise settles (e.g. resume cleanup starts a fresh
  // connect), the settle handlers below detect the stale token and bail instead
  // of clobbering the newer entry.
  const token = {};
  hosts.set(hostId, { state: "connecting", token });

  const isStale = (): boolean => {
    const current = hosts.get(hostId);
    return current?.state !== "connecting" || current.token !== token;
  };

  WebRtcConnection.connect(hostId, {
    onDisconnect: () => {
      hosts.delete(hostId);
    },
  })
    .then((connection) => {
      if (isStale()) {
        connection.close();
        return;
      }
      hosts.set(hostId, { state: "connected", connection });
    })
    .catch((err) => {
      if (isStale()) return;
      console.warn("[webrtc] connection failed for host", hostId, err);
      hosts.set(hostId, { state: "failed", failedAt: Date.now() });
    });
}
