import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ExecutionProcess, ExecutorConfig } from 'shared/types';
import { sessionsApi } from '@/shared/lib/api';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { workspaceSessionKeys } from '@/shared/hooks/workspaceSessionKeys';

interface UseSessionSendOptions {
  /** Session the composer is showing; follow-ups go here unless overridden. */
  sessionId: string | undefined;
  /** Workspace ID (its sessions list is refreshed after a send) */
  workspaceId: string | undefined;
  /** Unified executor config (executor + variant + overrides) */
  executorConfig?: ExecutorConfig | null;
  /**
   * Called with the process the follow-up POST created, so the caller can
   * render its turn optimistically instead of waiting for the WS stream.
   */
  onOptimisticProcess?: (process: ExecutionProcess) => void;
}

export interface SendOptions {
  /** Replaces `onOptimisticProcess` for this call (correlate with a placeholder). */
  onProcess?: (process: ExecutionProcess) => void;
  /** Send into this session instead of the composer's (a just-created one). */
  sessionId?: string;
  /** Also told about a failure (the composer that sent may be gone by then). */
  onError?: (message: string) => void;
}

interface UseSessionSendResult {
  /** Send a follow-up. Returns true on success, false on failure. */
  send: (message: string, options?: SendOptions) => Promise<boolean>;
  /** Whether a send operation is in progress */
  isSending: boolean;
  /** Error message if the send for the *current* session failed */
  error: string | null;
  /** Clear the error */
  clearError: () => void;
}

/**
 * Hook for sending follow-up messages from SessionChatBoxContainer. Session
 * creation is the container's job (it creates the row, switches to it, then
 * sends the first message through here as a pending follow-up).
 */
export function useSessionSend({
  sessionId,
  workspaceId,
  executorConfig,
  onOptimisticProcess,
}: UseSessionSendOptions): UseSessionSendResult {
  const queryClient = useQueryClient();
  const hostId = useHostId();
  const [isSending, setIsSending] = useState(false);
  // Keyed by the session the send targeted: a failure that lands after the
  // user switched conversations must not show up under the other session.
  const [errorState, setErrorState] = useState<{
    sessionId: string | undefined;
    message: string;
  } | null>(null);
  const error =
    errorState && errorState.sessionId === sessionId
      ? errorState.message
      : null;

  const send = useCallback(
    async (message: string, options?: SendOptions): Promise<boolean> => {
      const target = options?.sessionId ?? sessionId;
      const setError = (text: string | null) =>
        setErrorState(
          text === null ? null : { sessionId: target, message: text }
        );
      const trimmed = message.trim();
      if (!trimmed) return false;
      if (!executorConfig) {
        setError('No executor selected');
        return false;
      }
      if (!target) {
        setError('No session selected');
        return false;
      }

      setError(null);
      setIsSending(true);
      try {
        // The POST returns the created process; hand it to the caller so the
        // turn renders immediately instead of waiting for the WS stream.
        const process = await sessionsApi.followUp(
          target,
          {
            prompt: trimmed,
            executor_config: executorConfig,
            retry_process_id: null,
            force_when_dirty: null,
            perform_git_reset: null,
          },
          hostId
        );
        (options?.onProcess ?? onOptimisticProcess)?.(process);
        await queryClient.invalidateQueries({
          queryKey: workspaceSessionKeys.byWorkspace(workspaceId, hostId),
        });
        return true;
      } catch (e: unknown) {
        const err = e as { message?: string };
        const message = `Failed to send: ${err.message ?? 'Unknown error'}`;
        setError(message);
        options?.onError?.(message);
        return false;
      } finally {
        setIsSending(false);
      }
    },
    [
      sessionId,
      workspaceId,
      executorConfig,
      onOptimisticProcess,
      queryClient,
      hostId,
    ]
  );

  const clearError = useCallback(() => setErrorState(null), []);

  return { send, isSending, error, clearError };
}
