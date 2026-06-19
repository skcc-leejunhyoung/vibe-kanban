import { useEffect, useState, useRef } from 'react';
import { produce } from 'immer';
import type { Operation } from 'rfc6902';
import { applyUpsertPatch } from '@/shared/lib/jsonPatch';
import { openLocalApiWebSocket } from '@/shared/lib/localApiTransport';

type WsJsonPatchMsg = { JsonPatch: Operation[] };
type WsReadyMsg = { Ready: true };
type WsFinishedMsg = { finished: boolean };
type WsMsg = WsJsonPatchMsg | WsReadyMsg | WsFinishedMsg;

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
  const retryTimerRef = useRef<number | null>(null);
  const retryAttemptsRef = useRef<number>(0);
  const [retryNonce, setRetryNonce] = useState(0);
  const finishedRef = useRef<boolean>(false);
  const connectWatchdogRef = useRef<number | null>(null);
  // Mirrors of the connection state, read by the resume handler without making
  // it a dependency (which would re-bind listeners on every status change).
  const isConnectedRef = useRef<boolean>(false);
  const isInitializedRef = useRef<boolean>(false);

  const injectInitialEntry = options?.injectInitialEntry;
  const deduplicatePatches = options?.deduplicatePatches;

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

  function scheduleReconnect() {
    if (retryTimerRef.current) return; // already scheduled
    // Exponential backoff with cap: 1s, 2s, 4s, 8s (max), then stay at 8s
    const attempt = retryAttemptsRef.current;
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
      if (retryTimerRef.current) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      retryAttemptsRef.current = 0;
      finishedRef.current = false;
      setData(undefined);
      setIsConnected(false);
      setIsInitialized(false);
      setError(null);
      dataRef.current = undefined;
      return;
    }

    // Initialize data
    if (!dataRef.current) {
      dataRef.current = initialData();

      // Inject initial entry if provided
      if (injectInitialEntry) {
        injectInitialEntry(dataRef.current);
      }
    }

    let cancelled = false;

    // Create WebSocket if it doesn't exist
    if (!wsRef.current) {
      // Reset finished flag for new connection
      finishedRef.current = false;

      void (async () => {
        try {
          const ws = await openLocalApiWebSocket(endpoint);

          if (cancelled) {
            ws.close();
            return;
          }

          ws.onopen = () => {
            clearConnectWatchdog();
            setError(null);
            setIsConnected(true);
            // Reset backoff on successful connection
            retryAttemptsRef.current = 0;
            if (retryTimerRef.current) {
              window.clearTimeout(retryTimerRef.current);
              retryTimerRef.current = null;
            }
          };

          ws.onmessage = (event) => {
            try {
              const msg: WsMsg = JSON.parse(event.data);

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
            retryAttemptsRef.current += 1;
            // Only show error if we haven't received any data yet
            if (!dataRef.current && retryAttemptsRef.current > 6) {
              setError('Connection failed');
            }
            scheduleReconnect();
          };

          wsRef.current = ws;

          // Connect watchdog: if the socket never reaches OPEN, abandon it and
          // reconnect instead of waiting on the browser's multi-minute timeout.
          clearConnectWatchdog();
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
            retryAttemptsRef.current += 1;
            scheduleReconnect();
          }, CONNECT_TIMEOUT_MS);
        } catch (error) {
          if (cancelled) {
            return;
          }

          console.error('Failed to open WebSocket stream:', error);
          retryAttemptsRef.current += 1;
          scheduleReconnect();
        }
      })();
    }

    return () => {
      cancelled = true;
      clearConnectWatchdog();
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
      // `pageshow` also fires on the initial load; only treat bfcache restores
      // as a resume so we don't churn the first connection.
      if (evt?.type === 'pageshow' && !(evt as PageTransitionEvent).persisted) {
        return;
      }
      if (finishedRef.current) return;
      if (document.visibilityState !== 'visible') return;
      // Already healthy → nothing to do.
      if (isConnectedRef.current && isInitializedRef.current) return;

      retryAttemptsRef.current = 0;
      if (retryTimerRef.current) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      // Drop any stalled socket so the main effect opens a fresh one.
      clearConnectWatchdog();
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

  return {
    data,
    isConnected,
    isInitialized: isInitializedForCurrentEndpoint,
    error,
  };
};
