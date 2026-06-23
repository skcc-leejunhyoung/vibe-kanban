import { getActiveRelayHostId } from "@remote/shared/lib/relay/activeHostContext";
import {
  invalidateAllRemoteSessionIds,
  refreshActiveHostSigningSessionForResume,
} from "@remote/shared/lib/relay/context";
import {
  getWebRtcConnection,
  resetWebRtcConnectionsForResume,
} from "@remote/shared/lib/webrtc/connectionManager";

// Only treat a visibility change as a "resume" if the app was hidden at least
// this long. The host's relay signing session has a 15-min idle TTL, so a short
// app switch never expires it — gating avoids churning the relay/WebRTC state
// (and re-creating relay sessions) on every quick foreground/background flip.
const RESUME_HIDDEN_THRESHOLD_MS = 10_000;

let installed = false;

/**
 * Recover the relay transport after a standalone PWA is resumed.
 *
 * A suspended WebKit PWA comes back with a dead WebRTC peer connection and,
 * after >15 min, an expired host-side signing session — so every relayed
 * request (including `/api/webrtc/offer` and `/api/workspaces/summaries`) is
 * rejected and the app spins forever until a manual reload. On resume we drop
 * the cached relay sessions and the WebRTC failed-cooldown so the next request
 * re-establishes a fresh session + data channel automatically.
 */
export function installRelayResumeReconnect(): void {
  if (installed) return;
  if (typeof document === "undefined" || typeof window === "undefined") return;
  installed = true;

  let hiddenAt: number | null = null;

  const recover = () => {
    invalidateAllRemoteSessionIds();
    resetWebRtcConnectionsForResume();
    // Proactively rebuild the data channel for the host the user is viewing.
    // `refetchOnWindowFocus` is off, so without this nudge a focus-only resume
    // (network never dropped, just the idle signing session expired) would have
    // nothing to re-trigger the connection until the user interacts.
    const activeHostId = getActiveRelayHostId();
    if (!activeHostId) return;
    // Refresh the (likely expired) signing session first so the WebRTC offer
    // lands on a valid session on the first try, then rebuild the data channel.
    // Best-effort: rebuild regardless of whether the refresh succeeds.
    void refreshActiveHostSigningSessionForResume(activeHostId).finally(() => {
      getWebRtcConnection(activeHostId);
    });
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      return;
    }
    const hiddenFor = hiddenAt == null ? 0 : Date.now() - hiddenAt;
    hiddenAt = null;
    if (hiddenFor >= RESUME_HIDDEN_THRESHOLD_MS) {
      recover();
    }
  });

  // Network came back (e.g. cellular ⇄ wifi on wake): always re-establish.
  window.addEventListener("online", recover);

  // bfcache restore (Safari back/forward, some PWA wakes) replays the page
  // without re-running module init, so treat a persisted pageshow as a resume.
  window.addEventListener("pageshow", (event) => {
    if ((event as PageTransitionEvent).persisted) {
      recover();
    }
  });
}
