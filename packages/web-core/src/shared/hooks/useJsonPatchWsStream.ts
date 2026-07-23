import { useEffect, useState, useRef } from 'react';
import { produce } from 'immer';
import type { Operation } from 'rfc6902';
import { applyUpsertPatch } from '@/shared/lib/jsonPatch';
import { openLocalApiStream } from '@/shared/lib/localApiTransport';
import { getWsSnapshot, saveWsSnapshot } from '@/shared/lib/wsSnapshotCache';
import { WsConnectionHealth } from '@/shared/lib/wsConnectionHealth';
import { shouldReconnectForStreamSilence } from '@/shared/lib/wsStreamHeartbeat';
import {
  shouldReconnectOnResume,
  FREEZE_SUSPECT_MS,
  RESUME_CONNECT_TIMEOUT_MS,
} from '@/shared/lib/wsStreamResume';

type WsJsonPatchMsg = { JsonPatch: Operation[] };
type WsReadyMsg = { Ready: true };
type WsFinishedMsg = { finished: boolean };
type WsHeartbeatMsg = { heartbeat: boolean };
type WsMsg = WsJsonPatchMsg | WsReadyMsg | WsFinishedMsg | WsHeartbeatMsg;

// Abandon a socket stuck in CONNECTING after this long and reconnect. WebKit
// standalone PWAs that are suspended/resumed can leave a WebSocket that never
// fires open/error/close; without this the loading spinner is indefinite.
const CONNECT_TIMEOUT_MS = 10_000;

interface UseJsonPatchStreamOptions<T> {
  /**
   * Called once when the stream starts to inject initial data
   */
  injectInitialEntry?: (data: T) => void;
  /**
   * Filter/deduplicate patches before applying them
   */
  deduplicatePatches?: (patches: Operation[]) => Operation[];
  /**
   * Keep the last materialized state per endpoint in a module-level cache and
   * serve it immediately when the same endpoint is consumed again (endpoint
   * switch back, reconnect). The server's snapshot replay then refreshes it —
   * stale-while-revalidate instead of blanking to `undefined`.
   */
  keepSnapshotForEndpoint?: boolean;
  /** Route the stream to this host explicitly instead of inheriting page context. */
  targetHostId?: string | null;
  /** Reconnect when this stream receives no data or heartbeat for this long. */
  silenceTimeoutMs?: number;
}

interface UseJsonPatchStreamResult<T> {
  data: T | undefined;
  isConnected: boolean;
  isInitialized: boolean;
  error: string | null;
}

/**
 * Generic hook for consuming WebSocket streams that send JSON messages with patches
 */
export const useJsonPatchWsStream = <T extends object>(
  endpoint: string | undefined,
  enabled: boolean,
  initialData: () => T,
  options?: UseJsonPatchStreamOptions<T>
): UseJsonPatchStreamResult<T> => {
  const [data, setData] = useState<T | undefined>(undefined);
  const [isConnected, setIsConnected] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const initializedForEndpointRef = useRef<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const dataRef = useRef<T | undefined>(undefined);
  // Which endpoint the current `data` state belongs to. On an endpoint switch
  // there is one paint before the effect resets state; this lets the render
  // below serve the new endpoint's cached snapshot instead of the stale data.
  const dataEndpointRef = useRef<string | undefined>(undefined);
  // Whether `dataRef` holds real streamed/cached content (vs the empty
  // `initialData()` shell). Only real content is worth snapshotting.
  const dataPatchedRef = useRef<boolean>(false);
  // A cached snapshot (or an older successful connection to this endpoint)
  // must not count as proof that the current connection generation is live.
  const connectionHealthRef = useRef(new WsConnectionHealth());
  const healthEndpointRef = useRef<string | undefined>(undefined);
  const retryTimerRef = useRef<number | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const finishedRef = useRef<boolean>(false);
  const connectWatchdogRef = useRef<number | null>(null);
  const silenceWatchdogRef = useRef<number | null>(null);
  // Timestamp (ms) the document last became hidden, used by the resume handler
  // to tell a brief tab switch apart from a (possibly freezing) long background.
  const hiddenSinceRef = useRef<number | null>(null);
  // Set when the next connection is a resume reconnect, so the connect watchdog
  // uses the shorter resume timeout instead of the cold-connect timeout.
  const resumeReconnectRef = useRef<boolean>(false);
  // Mirrors of the connection state, read by the resume handler without making
  // it a dependency (which would re-bind listeners on every status change).
  const isConnectedRef = useRef<boolean>(false);
  const isInitializedRef = useRef<boolean>(false);

  const injectInitialEntry = options?.injectInitialEntry;
  const deduplicatePatches = options?.deduplicatePatches;
  const keepSnapshotForEndpoint = options?.keepSnapshotForEndpoint ?? false;
  const targetHostId = options?.targetHostId;
  const silenceTimeoutMs = options?.silenceTimeoutMs;

  useEffect(() => {
    isConnectedRef.current = isConnected;
  }, [isConnected]);
  useEffect(() => {
    isInitializedRef.current = isInitialized;
  }, [isInitialized]);

  function clearConnectWatchdog() {
    if (connectWatchdogRef.current) {
      window.clearTimeout(connectWatchdogRef.current);
      connectWatchdogRef.current = null;
    }
  }

  function clearSilenceWatchdog() {
    if (silenceWatchdogRef.current) {
      window.clearTimeout(silenceWatchdogRef.current);
      silenceWatchdogRef.current = null;
    }
  }

  function scheduleReconnect() {
    if (retryTimerRef.current) return; // already scheduled
    // Exponential backoff with cap: 1s, 2s, 4s, 8s (max), then stay at 8s
    const attempt = connectionHealthRef.current.failureCount();
    const delay = Math.min(8000, 1000 * Math.pow(2, attempt));
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      setRetryNonce((n) => n + 1);
    }, delay);
  }

  useEffect(() => {
    if (!enabled || !endpoint) {
      // Close connection and reset state
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      clearConnectWatchdog();
      clearSilenceWatchdog();
      if (retryTimerRef.current) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      connectionHealthRef.current.reset();
      healthEndpointRef.current = undefined;
      finishedRef.current = false;
      setData(undefined);
      setIsConnected(false);
      setIsInitialized(false);
      setError(null);
      dataRef.current = undefined;
      return;
    }

    // Initialize data, preferring the endpoint's cached snapshot so returning
    // consumers paint immediately while the server replay refreshes it.
    if (!dataRef.current) {
      const cached = keepSnapshotForEndpoint
        ? getWsSnapshot<T>(endpoint)
        : undefined;
      if (cached) {
        dataRef.current = cached;
        dataPatchedRef.current = true;
        setData(cached);
      } else {
        dataRef.current = initialData();
        dataPatchedRef.current = false;

        // Inject initial entry if provided
        if (injectInitialEntry) {
          injectInitialEntry(dataRef.current);
        }
      }
      dataEndpointRef.current = endpoint;
    }

    let cancelled = false;
    if (healthEndpointRef.current !== endpoint) {
      healthEndpointRef.current = endpoint;
      setError(null);
    }
    const connectionGeneration =
      connectionHealthRef.current.startConnection(endpoint);

    const recordConnectionFailure = () => {
      if (connectionHealthRef.current.recordFailure(connectionGeneration)) {
        setError('Connection failed');
      }
      scheduleReconnect();
    };

    // Create WebSocket if it doesn't exist
    if (!wsRef.current) {
      // Reset finished flag for new connection
      finishedRef.current = false;

      void (async () => {
        try {
          const ws = await openLocalApiStream(
            endpoint,
            targetHostId !== undefined
              ? {
                  hostScope: 'explicit',
                  hostId: targetHostId,
                  relayHostId: targetHostId,
                }
              : undefined
          );

          if (cancelled) {
            ws.close();
            return;
          }

          const resetSilenceWatchdog = () => {
            if (!silenceTimeoutMs) return;
            clearSilenceWatchdog();
            silenceWatchdogRef.current = window.setTimeout(() => {
              silenceWatchdogRef.current = null;
              if (
                !shouldReconnectForStreamSilence({
                  enabled,
                  hasEndpoint: !!endpoint,
                  finished: finishedRef.current,
                  isCurrentSocket: wsRef.current === ws,
                  readyState: ws.readyState,
                })
              ) {
                return;
              }

              // A WebSocket can remain OPEN after its receive path wedges.
              // Detach handlers before closing so its late close event cannot
              // race the reconnect scheduled below.
              ws.onopen = null;
              ws.onmessage = null;
              ws.onerror = null;
              ws.onclose = null;
              try {
                ws.close();
              } catch {
                /* ignore */
              }
              wsRef.current = null;
              setIsConnected(false);
              recordConnectionFailure();
            }, silenceTimeoutMs);
          };

          ws.onopen = () => {
            clearConnectWatchdog();
            // Back to a normal connection: subsequent reconnects (if any) use
            // the cold-connect watchdog again until the next resume.
            resumeReconnectRef.current = false;
            setIsConnected(true);
            resetSilenceWatchdog();
            if (retryTimerRef.current) {
              window.clearTimeout(retryTimerRef.current);
              retryTimerRef.current = null;
            }
          };

          ws.onmessage = (event) => {
            try {
              const msg: WsMsg = JSON.parse(event.data);
              resetSilenceWatchdog();
              connectionHealthRef.current.markLive(connectionGeneration);
              setError(null);

              // Handle JsonPatch messages (same as SSE json_patch event)
              if ('JsonPatch' in msg) {
                const patches: Operation[] = msg.JsonPatch;
                const filtered = deduplicatePatches
                  ? deduplicatePatches(patches)
                  : patches;

                const current = dataRef.current;
                if (!filtered.length || !current) return;

                // Use Immer for structural sharing - only modified parts get new references
                const next = produce(current, (draft) => {
                  applyUpsertPatch(draft, filtered);
                });

                dataRef.current = next;
                dataPatchedRef.current = true;
                setData(next);
              }

              // Handle Ready messages (initial data has been sent)
              if ('Ready' in msg) {
                initializedForEndpointRef.current = endpoint;
                setIsInitialized(true);
                setError(null);
              }

              // Handle finished messages ({finished: true})
              // Treat finished as terminal - do NOT reconnect
              if ('finished' in msg) {
                finishedRef.current = true;
                clearConnectWatchdog();
                clearSilenceWatchdog();
                ws.close(1000, 'finished');
                wsRef.current = null;
                setIsConnected(false);
              }
            } catch (err) {
              console.error('Failed to process WebSocket message:', err);
              setError('Failed to process stream update');
            }
          };

          ws.onerror = () => {
            // Don't set error here — onclose always fires after onerror
            // and handles retry logic. Setting error eagerly hides data
            // that was already received.
          };

          ws.onclose = (evt) => {
            clearConnectWatchdog();
            clearSilenceWatchdog();
            setIsConnected(false);
            wsRef.current = null;

            // Do not reconnect if we received a finished message or clean close
            if (
              cancelled ||
              finishedRef.current ||
              (evt?.code === 1000 && evt?.wasClean)
            ) {
              return;
            }

            // Otherwise, reconnect on unexpected/error closures
            recordConnectionFailure();
          };

          wsRef.current = ws;

          // Connect watchdog: if the socket never reaches OPEN, abandon it and
          // reconnect instead of waiting on the browser's multi-minute timeout.
          // A resume reconnect (freeze recovery) uses a shorter timeout since
          // its socket tends to zombie again and the user is already waiting.
          clearConnectWatchdog();
          const connectTimeoutMs = resumeReconnectRef.current
            ? RESUME_CONNECT_TIMEOUT_MS
            : CONNECT_TIMEOUT_MS;
          connectWatchdogRef.current = window.setTimeout(() => {
            connectWatchdogRef.current = null;
            if (cancelled || finishedRef.current) return;
            if (ws.readyState === WebSocket.OPEN) return;

            // Detach handlers so the zombie socket can't fire later, then drop
            // and reconnect through the normal backoff path.
            ws.onopen = null;
            ws.onmessage = null;
            ws.onerror = null;
            ws.onclose = null;
            try {
              ws.close();
            } catch {
              /* ignore */
            }
            if (wsRef.current === ws) {
              wsRef.current = null;
            }
            setIsConnected(false);
            recordConnectionFailure();
          }, connectTimeoutMs);
        } catch (error) {
          if (cancelled) {
            return;
          }

          console.error('Failed to open WebSocket stream:', error);
          recordConnectionFailure();
        }
      })();
    }

    return () => {
      cancelled = true;
      clearConnectWatchdog();
      clearSilenceWatchdog();
      // Preserve the materialized state for this endpoint (closure-captured,
      // so an endpoint switch stores it under the OLD endpoint) before the
      // reset below discards it.
      if (
        keepSnapshotForEndpoint &&
        dataRef.current &&
        dataPatchedRef.current
      ) {
        saveWsSnapshot(endpoint, dataRef.current);
      }
      if (wsRef.current) {
        const ws = wsRef.current;

        // Clear all event handlers first to prevent callbacks after cleanup
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;

        // Close regardless of state
        ws.close();
        wsRef.current = null;
      }
      if (retryTimerRef.current) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      finishedRef.current = false;
      dataRef.current = undefined;
      setData(undefined);
      setIsInitialized(false);
    };
  }, [
    endpoint,
    enabled,
    initialData,
    injectInitialEntry,
    deduplicatePatches,
    keepSnapshotForEndpoint,
    targetHostId,
    retryNonce,
  ]);

  // When a suspended PWA is resumed (tab visible again / back online), a
  // not-yet-connected stream may be sitting on a dead socket whose close event
  // never fired. Force an immediate reconnect so the conversation loads without
  // the user having to switch workspaces or refresh.
  useEffect(() => {
    if (!enabled || !endpoint) return;
    if (typeof document === 'undefined') return;

    const onResume = (evt?: Event) => {
      // Record when we go hidden so the resume decision can measure how long we
      // were backgrounded (a long hide may mean the OS froze us).
      if (evt?.type === 'visibilitychange') {
        if (document.visibilityState === 'hidden') {
          hiddenSinceRef.current = Date.now();
          return;
        }
      }

      const hiddenSince = hiddenSinceRef.current;
      const hiddenDurationMs =
        hiddenSince != null ? Date.now() - hiddenSince : 0;

      const reconnect = shouldReconnectOnResume({
        enabled,
        hasEndpoint: !!endpoint,
        finished: finishedRef.current,
        eventType: evt?.type ?? 'visibilitychange',
        persisted: (evt as PageTransitionEvent | undefined)?.persisted ?? false,
        visibilityState: document.visibilityState,
        isConnected: isConnectedRef.current,
        isInitialized: isInitializedRef.current,
        hiddenDurationMs,
        freezeSuspectMs: FREEZE_SUSPECT_MS,
      });

      // Clear the hidden marker once visible so a later online/pageshow on the
      // same foreground session doesn't re-use a stale duration.
      if (document.visibilityState === 'visible') {
        hiddenSinceRef.current = null;
      }

      if (!reconnect) return;

      // The socket we're about to open is a freeze-recovery reconnect → use the
      // shorter resume watchdog.
      resumeReconnectRef.current = true;
      if (retryTimerRef.current) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      // Drop any stalled socket so the main effect opens a fresh one.
      clearConnectWatchdog();
      clearSilenceWatchdog();
      if (wsRef.current) {
        const ws = wsRef.current;
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        wsRef.current = null;
      }
      setIsConnected(false);
      setRetryNonce((n) => n + 1);
    };

    document.addEventListener('visibilitychange', onResume);
    window.addEventListener('online', onResume);
    window.addEventListener('pageshow', onResume);
    return () => {
      document.removeEventListener('visibilitychange', onResume);
      window.removeEventListener('online', onResume);
      window.removeEventListener('pageshow', onResume);
    };
  }, [enabled, endpoint]);

  const isInitializedForCurrentEndpoint =
    isInitialized && initializedForEndpointRef.current === endpoint;

  // Serve `data` only when it belongs to the current endpoint. During the
  // paint between an endpoint switch and the effect reset, fall back to the
  // new endpoint's cached snapshot (if any) instead of leaking stale data.
  const dataForEndpoint =
    dataEndpointRef.current === endpoint
      ? data
      : keepSnapshotForEndpoint
        ? getWsSnapshot<T>(endpoint)
        : undefined;

  return {
    data: dataForEndpoint,
    isConnected,
    isInitialized: isInitializedForCurrentEndpoint,
    error,
  };
};
