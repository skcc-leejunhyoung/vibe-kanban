// Decide whether a JSON-patch WebSocket stream should be force-reconnected when
// the app is resumed (tab visible again / back online / bfcache restore).
//
// WebKit standalone PWAs (macOS "Add to Dock", iOS home screen) get frozen in
// the background and, on resume, can be left holding a socket that is reported
// as OPEN but is actually dead — a "half-open zombie" that never fires
// open/error/close and never delivers another message. A plain Safari tab does
// not freeze while it is the visible tab, which is why the slowness only shows
// up in the installed PWA.
//
// The tricky part is telling a real zombie apart from a perfectly healthy idle
// socket: a workspace-list stream legitimately sends nothing while nothing
// changes. We cannot probe an idle socket without an app-level ping, so instead
// we use *freeze suspicion*: if the document was hidden long enough that the OS
// could have frozen us (or we were restored from bfcache), we discard the
// seemingly-healthy socket and reconnect. Brief tab switches stay untouched to
// avoid needless reconnect churn.

export interface ResumeDecisionInput {
  /** Whether the stream is currently enabled. */
  enabled: boolean;
  /** Whether the stream has an endpoint to connect to. */
  hasEndpoint: boolean;
  /** Whether the stream already reached its terminal `finished` state. */
  finished: boolean;
  /** The resume event type: 'visibilitychange' | 'online' | 'pageshow'. */
  eventType: string;
  /** For 'pageshow' only: whether this is a bfcache restore. */
  persisted: boolean;
  /** Current document visibility. */
  visibilityState: DocumentVisibilityState;
  /** Whether the socket currently reports as connected (OPEN). */
  isConnected: boolean;
  /** Whether the stream received its initial `Ready` for the current endpoint. */
  isInitialized: boolean;
  /** How long the document was hidden before this resume (ms); 0 if unknown. */
  hiddenDurationMs: number;
  /** Hidden duration past which a freeze is suspected. */
  freezeSuspectMs: number;
}

// A hide longer than this is treated as a possible OS freeze. Short tab switches
// stay below it so a healthy socket is not churned on every focus change.
export const FREEZE_SUSPECT_MS = 8_000;

// Watchdog for a socket opened by a resume reconnect. Freeze-recovery sockets
// tend to zombie again, so we abandon them far sooner than a cold connect's
// timeout instead of leaving the user on a multi-second spinner.
export const RESUME_CONNECT_TIMEOUT_MS = 3_000;

export function shouldReconnectOnResume(input: ResumeDecisionInput): boolean {
  const {
    enabled,
    hasEndpoint,
    finished,
    eventType,
    persisted,
    visibilityState,
    isConnected,
    isInitialized,
    hiddenDurationMs,
    freezeSuspectMs,
  } = input;

  if (!enabled || !hasEndpoint) return false;
  // `pageshow` also fires on the initial load; only a bfcache restore counts as
  // a resume so we don't churn the first connection.
  if (eventType === 'pageshow' && !persisted) return false;
  if (finished) return false;
  if (visibilityState !== 'visible') return false;

  // A dead or not-yet-initialized socket always needs a (re)connect.
  if (!isConnected || !isInitialized) return true;

  // Otherwise the socket looks healthy. Only discard it when a freeze is
  // suspected (hidden long enough to be frozen, or restored from bfcache),
  // because it may be a half-open zombie that will never recover on its own.
  return (
    hiddenDurationMs >= freezeSuspectMs ||
    (eventType === 'pageshow' && persisted)
  );
}
