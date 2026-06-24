import { useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { queueApi } from '@/shared/lib/api';
import type { ExecutorConfig, QueuedMessage, QueueStatus } from 'shared/types';

interface UseSessionQueueInteractionOptions {
  /** Session ID for queue operations */
  sessionId: string | undefined;
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
}: UseSessionQueueInteractionOptions): UseSessionQueueInteractionResult {
  const queryClient = useQueryClient();

  // Query for queue status
  const { data: queueStatus = { status: 'empty' as const }, refetch } =
    useQuery<QueueStatus>({
      queryKey: [QUEUE_STATUS_KEY, sessionId],
      queryFn: () => queueApi.getStatus(sessionId!),
      enabled: !!sessionId,
    });

  const queuedMessages =
    queueStatus.status === 'queued' ? queueStatus.messages : [];
  const isQueued = queuedMessages.length > 0;

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
    cancelQueue,
    cancelOne,
    refreshQueueStatus,
  };
}
