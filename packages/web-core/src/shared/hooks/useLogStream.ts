import { useEffect, useState, useRef } from 'react';
import type { PatchType } from 'shared/types';
import { openLocalApiStream } from '@/shared/lib/localApiTransport';
import { useHostId } from '@/shared/providers/HostIdProvider';
import {
  appendLogBatch,
  EMPTY_LOG_BUFFER,
  MAX_LOG_LINES,
  type LogBufferState,
  type LogStreamEntry as LogEntry,
} from '@/shared/lib/logBuffer';

interface UseLogStreamResult {
  logs: LogEntry[];
  /** Lines trimmed off the front by the ring buffer since the stream started. */
  dropped: number;
  error: string | null;
}

export const useLogStream = (processId: string): UseLogStreamResult => {
  // Context host, not the document fallback: in a split pane this process
  // lives on the pane's host, which may differ from the focused route's.
  const hostId = useHostId();
  const [buffer, setBuffer] = useState<LogBufferState>(EMPTY_LOG_BUFFER);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const retryCountRef = useRef<number>(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isIntentionallyClosed = useRef<boolean>(false);
  // Prevent reconnection after the server signals the stream is done
  const finishedRef = useRef<boolean>(false);
  // Track current processId to prevent stale WebSocket messages from contaminating logs
  const currentProcessIdRef = useRef<string>(processId);

  useEffect(() => {
    if (!processId) {
      return;
    }

    let cancelled = false;

    // Update the ref to track the current processId
    currentProcessIdRef.current = processId;

    // Clear logs when process changes
    setBuffer(EMPTY_LOG_BUFFER);
    setError(null);
    finishedRef.current = false;

    // One state write per frame instead of per line: a chatty dev server
    // otherwise re-renders (and re-copies the whole log array) thousands of
    // times a second.
    let pending: LogEntry[] = [];
    let pendingDropped = 0;
    let pendingReplace = false;
    let rafHandle: number | null = null;

    const flush = () => {
      rafHandle = null;
      if (pending.length === 0 && pendingDropped === 0) return;
      const batch = pending;
      const alreadyDropped = pendingDropped;
      const replace = pendingReplace;
      pending = [];
      pendingDropped = 0;
      pendingReplace = false;
      setBuffer((prev) =>
        appendLogBatch(prev, batch, { replace, alreadyDropped })
      );
    };

    const open = () => {
      // Don't reconnect if the stream already signalled finished
      if (finishedRef.current) {
        return;
      }

      // Capture processId at the time of opening the WebSocket
      const capturedProcessId = processId;
      void (async () => {
        try {
          const ws = await openLocalApiStream(
            `/api/execution-processes/${processId}/raw-logs/ws`,
            { hostScope: 'explicit', hostId, relayHostId: hostId }
          );

          if (cancelled || currentProcessIdRef.current !== capturedProcessId) {
            ws.close();
            return;
          }

          wsRef.current = ws;
          isIntentionallyClosed.current = false;

          // Track whether this is a reconnect so the first flushed batch
          // replaces (not appends to) the logs, avoiding duplicates from the
          // server replaying history.
          pendingReplace = retryCountRef.current > 0;

          ws.onopen = () => {
            // Ignore if processId has changed since WebSocket was opened
            if (
              cancelled ||
              currentProcessIdRef.current !== capturedProcessId
            ) {
              ws.close();
              return;
            }
            setError(null);
            retryCountRef.current = 0;
            // Don't clear logs here — on reconnect the server replays
            // history, and clearing eagerly causes a flash if the
            // connection drops again before data arrives.
          };

          const addLogEntry = (entry: LogEntry) => {
            // Only add log entry if this WebSocket is still for the current process
            if (
              cancelled ||
              currentProcessIdRef.current !== capturedProcessId
            ) {
              return;
            }
            pending.push(entry);
            // A hidden tab gets no animation frames, so bound the queue too.
            if (pending.length > MAX_LOG_LINES) {
              pendingDropped += pending.length - MAX_LOG_LINES;
              pending = pending.slice(-MAX_LOG_LINES);
            }
            if (rafHandle === null) {
              rafHandle = requestAnimationFrame(flush);
            }
          };

          // Handle WebSocket messages
          ws.onmessage = (event) => {
            try {
              const data = JSON.parse(event.data);

              // Handle different message types based on LogMsg enum
              if ('JsonPatch' in data) {
                const patches = data.JsonPatch as Array<{ value?: PatchType }>;
                patches.forEach((patch) => {
                  const value = patch?.value;
                  if (!value || !value.type) return;

                  switch (value.type) {
                    case 'STDOUT':
                    case 'STDERR':
                      addLogEntry({ type: value.type, content: value.content });
                      break;
                    // Ignore other patch types (NORMALIZED_ENTRY, DIFF, etc.)
                    default:
                      break;
                  }
                });
              } else if (data.finished === true) {
                finishedRef.current = true;
                isIntentionallyClosed.current = true;
                // Don't strand the tail of the log in the pending batch.
                flush();
                ws.close();
              }
            } catch (e) {
              console.error('Failed to parse message:', e);
            }
          };

          ws.onerror = () => {
            // Don't set error here — onclose always fires after onerror
            // and handles retry logic. Setting error eagerly hides logs
            // that were already received.
          };

          ws.onclose = (event) => {
            // Don't retry for stale WebSocket connections
            if (
              cancelled ||
              currentProcessIdRef.current !== capturedProcessId
            ) {
              return;
            }
            flush();
            // Only retry if the close was not intentional and not a normal closure
            if (!isIntentionallyClosed.current && event.code !== 1000) {
              const next = retryCountRef.current + 1;
              retryCountRef.current = next;
              if (next <= 6) {
                const delay = Math.min(1500, 250 * 2 ** (next - 1));
                retryTimerRef.current = setTimeout(() => open(), delay);
              } else {
                setError('Connection failed');
              }
            }
          };
        } catch (error) {
          if (cancelled || currentProcessIdRef.current !== capturedProcessId) {
            return;
          }
          const next = retryCountRef.current + 1;
          retryCountRef.current = next;
          if (next <= 6) {
            const delay = Math.min(1500, 250 * 2 ** (next - 1));
            retryTimerRef.current = setTimeout(() => open(), delay);
          } else {
            setError('Connection failed');
          }
        }
      })();
    };

    open();

    return () => {
      cancelled = true;
      if (rafHandle !== null) {
        cancelAnimationFrame(rafHandle);
        rafHandle = null;
      }
      if (wsRef.current) {
        isIntentionallyClosed.current = true;
        wsRef.current.close();
        wsRef.current = null;
      }
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [processId, hostId]);

  return { logs: buffer.logs, dropped: buffer.dropped, error };
};
