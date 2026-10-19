import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ExecutionProcess, ExecutorConfig } from 'shared/types';
import { ApiError, queueApi, sessionsApi } from '@/shared/lib/api';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { workspaceSessionKeys } from '@/shared/hooks/workspaceSessionKeys';
import { queueStatusQueryKey } from './useSessionQueueInteraction';

interface UseSessionSendOptions {
  /** Session the composer is showing; follow-ups go here unless overridden. */
  sessionId: string | undefined;
  /** Workspace ID (its sessions list is refreshed after a send) */
  workspaceId: string | undefined;
  /** Unified executor config (executor + variant + overrides) */
  executorConfig?: ExecutorConfig | null;
}

export interface SendOptions {
  /** Send into this session instead of the composer's (a just-created one). */
  sessionId?: string;
}

interface UseSessionSendResult {
  /**
   * Send a follow-up; resolves with the created process, or null when the
   * previous turn was still finishing and the message was queued to run next.
   * Rejects on failure (the message is also kept in `error` for the target
   * session's composer).
   */
  send: (
    message: string,
    options?: SendOptions
  ) => Promise<ExecutionProcess | null>;
  /** Error message if the send for the *current* session failed */
  error: string | null;
  /** Clear the error */
  clearError: () => void;
}

/**
 * Follow-up transport for SessionChatBoxContainer. Showing the turn, stop
 * handling and session creation live in the container; this only validates,
 * posts, refreshes the sessions list and remembers the failure.
 */
export function useSessionSend({
  sessionId,
  workspaceId,
  executorConfig,
}: UseSessionSendOptions): UseSessionSendResult {
  const queryClient = useQueryClient();
  const hostId = useHostId();
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
    async (
      message: string,
      options?: SendOptions
    ): Promise<ExecutionProcess | null> => {
      const target = options?.sessionId ?? sessionId;
      const failure = (text: string): Error => {
        setErrorState({ sessionId: target, message: text });
        return new Error(text);
      };
      const trimmed = message.trim();
      if (!trimmed) throw failure('Nothing to send');
      if (!executorConfig) throw failure('No executor selected');
      if (!target) throw failure('No session selected');

      setErrorState(null);
      try {
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
        void queryClient.invalidateQueries({
          queryKey: workspaceSessionKeys.byWorkspace(workspaceId, hostId),
        });
        return process;
      } catch (e: unknown) {
        let error = e;
        // 423: the previous turn is still finishing (no turn is running).
        // Its finish starts the queue, so the message waits there.
        if (e instanceof ApiError && e.status === 423) {
          try {
            const status = await queueApi.queue(
              target,
              { message: trimmed, executor_config: executorConfig },
              hostId
            );
            queryClient.setQueryData(
              queueStatusQueryKey(target, hostId),
              status
            );
            return null;
          } catch (queueError: unknown) {
            error = queueError;
          }
        }
        const err = error as { message?: string };
        throw failure(`Failed to send: ${err.message ?? 'Unknown error'}`);
      }
    },
    [sessionId, workspaceId, executorConfig, queryClient, hostId]
  );

  const clearError = useCallback(() => setErrorState(null), []);

  return { send, error, clearError };
}
