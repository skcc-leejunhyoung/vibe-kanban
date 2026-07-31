import { useCallback, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { queueApi } from '@/shared/lib/api';
import type { ExecutorConfig, QueuedMessage, QueueStatus } from 'shared/types';
import {
  advanceQueueTracking,
  queueStatusRefetchInterval,
} from '../queueReconciliation';

interface UseSessionQueueInteractionOptions {
  /** Session ID for queue operations */
  sessionId: string | undefined;
  /** Reconcile execution state after the server consumes the queue. */
  onQueueConsumed?: () => void;
}

interface UseSessionQueueInteractionResult {
  /** All queued messages, oldest first */
  queuedMessages: QueuedMessage[];
  /** Whether at least one message is currently queued */
  isQueued: boolean;
  /** Whether a queue operation is in progress */
  isQueueLoading: boolean;
  /** Append a message to the back of the queue */
  queueMessage: (
    message: string,
    executorConfig: ExecutorConfig
  ) => Promise<void>;
  /** Interrupt the running turn and run this message immediately */
  steer: (message: string, executorConfig: ExecutorConfig) => Promise<void>;
  /** Interrupt the running turn and run an already-queued message immediately */
  steerQueued: (messageId: string) => Promise<void>;
  /** Reorder the queue to the given message id order (front first) */
  reorderQueue: (messageIds: string[]) => Promise<void>;
  /** Cancel all queued messages */
  cancelQueue: () => Promise<void>;
  /** Cancel a single queued message by id */
  cancelOne: (messageId: string) => Promise<void>;
  /** Refresh queue status from server */
  refreshQueueStatus: () => Promise<void>;
}

const QUEUE_STATUS_KEY = 'queue-status';

/**
 * Hook to manage queue interaction for session messages.
 * Uses TanStack Query for caching and mutation handling.
 */
export function useSessionQueueInteraction({
  sessionId,
  onQueueConsumed,
}: UseSessionQueueInteractionOptions): UseSessionQueueInteractionResult {
  const queryClient = useQueryClient();

  // Query for queue status
  const { data: queueStatus = { status: 'empty' as const }, refetch } =
    useQuery<QueueStatus>({
      queryKey: [QUEUE_STATUS_KEY, sessionId],
      queryFn: () => queueApi.getStatus(sessionId!),
      enabled: !!sessionId,
      // Queue state is in-memory and has no push stream of its own. Poll only
      // while work is waiting, including in non-focused split-screen panes.
      refetchInterval: (query) => queueStatusRefetchInterval(query.state.data),
      refetchIntervalInBackground: true,
    });

  const queuedMessages =
    queueStatus.status === 'queued' ? queueStatus.messages : [];
  const isQueued = queuedMessages.length > 0;
  const queueTrackingRef = useRef({ sessionId, wasQueued: false });

  useEffect(() => {
    const next = advanceQueueTracking(
      queueTrackingRef.current,
      sessionId,
      isQueued
    );
    queueTrackingRef.current = next.state;
    if (next.shouldReconcile) {
      // The queue can be consumed between execution-process stream patches.
      // Replay the authoritative process snapshot so a panel that missed the
      // new-process add immediately shows the running follow-up.
      onQueueConsumed?.();
    }
  }, [isQueued, onQueueConsumed]);

  const applyStatus = useCallback(
    (status: QueueStatus) => {
      queryClient.setQueryData([QUEUE_STATUS_KEY, sessionId], status);
    },
    [queryClient, sessionId]
  );

  // Mutation for appending a message to the queue
  const queueMutation = useMutation({
    mutationFn: ({
      message,
      executorConfig,
    }: {
      message: string;
      executorConfig: ExecutorConfig;
    }) =>
      queueApi.queue(sessionId!, {
        message,
        executor_config: executorConfig,
      }),
    onSuccess: applyStatus,
  });

  // Mutation for steering ("send now")
  const steerMutation = useMutation({
    mutationFn: ({
      message,
      executorConfig,
    }: {
      message: string;
      executorConfig: ExecutorConfig;
    }) =>
      queueApi.steer(sessionId!, {
        message,
        executor_config: executorConfig,
      }),
    onSuccess: applyStatus,
  });

  // Mutation for steering an already-queued message ("send now" on a queued row)
  const steerQueuedMutation = useMutation({
    mutationFn: (messageId: string) =>
      queueApi.steerQueued(sessionId!, messageId),
    onSuccess: applyStatus,
  });

  // Mutation for reordering the queue. Optimistic so the up/down arrows feel
  // instant; the server response replaces the optimistic order on success.
  const reorderMutation = useMutation({
    mutationFn: (messageIds: string[]) =>
      queueApi.reorder(sessionId!, messageIds),
    onMutate: async (messageIds: string[]) => {
      await queryClient.cancelQueries({
        queryKey: [QUEUE_STATUS_KEY, sessionId],
      });
      const previous = queryClient.getQueryData<QueueStatus>([
        QUEUE_STATUS_KEY,
        sessionId,
      ]);
      if (previous && previous.status === 'queued') {
        const byId = new Map(previous.messages.map((m) => [m.id, m]));
        const ordered = messageIds
          .map((id) => byId.get(id))
          .filter((m): m is QueuedMessage => m !== undefined);
        // Keep any messages not named in the new order (guards against a stale
        // client list silently dropping a message).
        for (const m of previous.messages) {
          if (!messageIds.includes(m.id)) ordered.push(m);
        }
        applyStatus({ status: 'queued', messages: ordered });
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) applyStatus(context.previous);
    },
    onSuccess: applyStatus,
  });

  // Mutation for cancelling the whole queue
  const cancelMutation = useMutation({
    mutationFn: () => queueApi.cancel(sessionId!),
    onSuccess: applyStatus,
  });

  // Mutation for cancelling a single message
  const cancelOneMutation = useMutation({
    mutationFn: (messageId: string) =>
      queueApi.cancelOne(sessionId!, messageId),
    onSuccess: applyStatus,
  });

  const queueMessage = useCallback(
    async (message: string, executorConfig: ExecutorConfig) => {
      if (!sessionId) return;
      await queueMutation.mutateAsync({ message, executorConfig });
    },
    [sessionId, queueMutation]
  );

  const steer = useCallback(
    async (message: string, executorConfig: ExecutorConfig) => {
      if (!sessionId) return;
      await steerMutation.mutateAsync({ message, executorConfig });
    },
    [sessionId, steerMutation]
  );

  const steerQueued = useCallback(
    async (messageId: string) => {
      if (!sessionId) return;
      await steerQueuedMutation.mutateAsync(messageId);
    },
    [sessionId, steerQueuedMutation]
  );

  const reorderQueue = useCallback(
    async (messageIds: string[]) => {
      if (!sessionId) return;
      await reorderMutation.mutateAsync(messageIds);
    },
    [sessionId, reorderMutation]
  );

  const cancelQueue = useCallback(async () => {
    if (!sessionId) return;
    await cancelMutation.mutateAsync();
  }, [sessionId, cancelMutation]);

  const cancelOne = useCallback(
    async (messageId: string) => {
      if (!sessionId) return;
      await cancelOneMutation.mutateAsync(messageId);
    },
    [sessionId, cancelOneMutation]
  );

  const refreshQueueStatus = useCallback(async () => {
    if (!sessionId) return;
    await refetch();
  }, [sessionId, refetch]);

  return {
    queuedMessages,
    isQueued,
    isQueueLoading:
      queueMutation.isPending ||
      steerMutation.isPending ||
      cancelMutation.isPending ||
      cancelOneMutation.isPending,
    queueMessage,
    steer,
    steerQueued,
    reorderQueue,
    cancelQueue,
    cancelOne,
    refreshQueueStatus,
  };
}
