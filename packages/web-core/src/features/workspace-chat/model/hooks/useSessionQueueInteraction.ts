import { useCallback, useEffect, useRef } from 'react';
import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { queueApi } from '@/shared/lib/api';
import type { ExecutorConfig, QueuedMessage, QueueStatus } from 'shared/types';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { getHostRequestScopeQueryKey } from '@/shared/lib/hostRequestScope';
import {
  advanceQueueTracking,
  queueStatusRefetchInterval,
} from '../queueReconciliation';

interface UseSessionQueueInteractionOptions {
  /** Session ID for queue operations */
  sessionId: string | undefined;
  /**
   * A turn is running or an auto-resume is scheduled: the queue waits behind
   * it, so another tab, device or the API can add messages meanwhile.
   */
  hasTurnAhead?: boolean;
  /** Reconcile execution state after the server consumes the queue. */
  onQueueConsumed?: () => void;
}

interface UseSessionQueueInteractionResult {
  /** All queued messages, oldest first */
  queuedMessages: QueuedMessage[];
  /** Whether at least one message is currently queued */
  isQueued: boolean;
  /**
   * Append a message to the back of the queue. `after`: a send still on its
   * way — the row shows at once, the request waits for it (so the message
   * queues behind that turn) and is dropped if it failed.
   */
  queueMessage: (
    message: string,
    executorConfig: ExecutorConfig,
    after?: Promise<boolean>
  ) => Promise<void>;
  /**
   * Interrupt the running turn and run this message immediately. Resolves
   * with the queue as the server left it (the message pinned at the front).
   */
  steer: (
    message: string,
    executorConfig: ExecutorConfig
  ) => Promise<QueueStatus>;
  /** Interrupt the running turn and run an already-queued message immediately */
  steerQueued: (messageId: string) => Promise<void>;
  /** Edit an already-queued message in place, preserving its position */
  updateQueued: (
    messageId: string,
    message: string,
    executorConfig: ExecutorConfig
  ) => Promise<void>;
  /** Reorder the queue to the given message id order (front first) */
  reorderQueue: (messageIds: string[]) => Promise<void>;
  /** Cancel all queued messages */
  cancelQueue: () => Promise<void>;
  /** Cancel a single queued message by id */
  cancelOne: (messageId: string) => Promise<void>;
  /** Drop a row from the local list only (e.g. once its turn is on screen). */
  dropQueuedLocally: (messageId: string) => void;
  /** Refresh queue status from server */
  refreshQueueStatus: () => Promise<void>;
}

const QUEUE_STATUS_KEY = 'queue-status';
const OPTIMISTIC_QUEUED_PREFIX = 'pending-queue-';

/** The send a queued message was waiting on failed, so it wasn't queued. */
export class QueuedAfterFailedSendError extends Error {}

/** A row the server hasn't acknowledged yet: there is no id to act on. */
export const isOptimisticQueuedId = (id: string): boolean =>
  id.startsWith(OPTIMISTIC_QUEUED_PREFIX);

const messagesOf = (status: QueueStatus | undefined): QueuedMessage[] =>
  status?.status === 'queued' ? status.messages : [];

const statusOf = (messages: QueuedMessage[]): QueueStatus =>
  messages.length > 0 ? { status: 'queued', messages } : { status: 'empty' };

/**
 * Hook to manage queue interaction for session messages.
 * Uses TanStack Query for caching and mutation handling. Every edit is applied
 * to the list first and corrected from the server's answer (or rolled back),
 * so the queue never shows a spinner for a round trip.
 */
export function useSessionQueueInteraction({
  sessionId,
  hasTurnAhead = false,
  onQueueConsumed,
}: UseSessionQueueInteractionOptions): UseSessionQueueInteractionResult {
  const queryClient = useQueryClient();
  const hostId = useHostId();
  const queueKey = [
    QUEUE_STATUS_KEY,
    sessionId,
    getHostRequestScopeQueryKey(hostId),
  ];
  const mutationKey = [QUEUE_STATUS_KEY, 'mutate', sessionId];
  // A poll landing mid-mutation would overwrite the optimistic list with the
  // pre-mutation server state, so polling pauses while one is in flight.
  const isMutating = useIsMutating({ mutationKey }) > 0;

  // Query for queue status
  const { data: queueStatus = { status: 'empty' as const }, refetch } =
    useQuery<QueueStatus>({
      queryKey: queueKey,
      queryFn: () => queueApi.getStatus(sessionId!, hostId),
      enabled: !!sessionId,
      // Queue state is in-memory and has no push stream of its own. Poll while
      // work is waiting, and slower while a turn is ahead so messages queued
      // from another tab, device or the API show up; in-document split panes
      // share this tab's visibility, so the default (pause while hidden) is
      // enough.
      refetchInterval: (query) =>
        isMutating
          ? false
          : queueStatusRefetchInterval(query.state.data, hasTurnAhead),
    });

  const queuedMessages = messagesOf(queueStatus);
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
      queryClient.setQueryData(queueKey, status);
    },
    [queryClient, queueKey]
  );

  // Snapshot the list and apply an edit to it; the mutation's error handler
  // restores the snapshot, its success handler installs the server's answer.
  const editLocally = useCallback(
    async (edit: (messages: QueuedMessage[]) => QueuedMessage[]) => {
      await queryClient.cancelQueries({ queryKey: queueKey });
      const previous = queryClient.getQueryData<QueueStatus>(queueKey);
      applyStatus(statusOf(edit(messagesOf(previous))));
      return { previous };
    },
    [queryClient, queueKey, applyStatus]
  );
  const rollback = useCallback(
    (_error: unknown, _vars: unknown, context?: { previous?: QueueStatus }) => {
      applyStatus(context?.previous ?? { status: 'empty' });
    },
    [applyStatus]
  );

  // Mutation for appending a message to the queue
  const queueMutation = useMutation({
    mutationKey,
    mutationFn: async ({
      message,
      executorConfig,
      after,
    }: {
      message: string;
      executorConfig: ExecutorConfig;
      after?: Promise<boolean>;
    }) => {
      // Queued while a send was on its way: post only once that turn exists,
      // so the queue drain can't start this message next to it.
      if (after && !(await after)) {
        throw new QueuedAfterFailedSendError(
          'The message before this one was not sent, so it was not queued.'
        );
      }
      return queueApi.queue(
        sessionId!,
        { message, executor_config: executorConfig },
        hostId
      );
    },
    onMutate: ({ message, executorConfig }) =>
      editLocally((messages) => [
        ...messages,
        {
          id: `${OPTIMISTIC_QUEUED_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
          session_id: sessionId ?? '',
          data: { message, executor_config: executorConfig },
          queued_at: new Date().toISOString(),
          start_error: null,
        },
      ]),
    onError: rollback,
    onSuccess: applyStatus,
  });

  // Mutation for steering ("send now"): the composer shows the message as the
  // next turn itself, so the list is left to the server's answer.
  const steerMutation = useMutation({
    mutationKey,
    mutationFn: ({
      message,
      executorConfig,
    }: {
      message: string;
      executorConfig: ExecutorConfig;
    }) =>
      queueApi.steer(
        sessionId!,
        { message, executor_config: executorConfig },
        hostId
      ),
    onSuccess: applyStatus,
  });

  // Mutation for steering an already-queued message ("send now" on a queued row)
  const steerQueuedMutation = useMutation({
    mutationKey,
    mutationFn: (messageId: string) =>
      queueApi.steerQueued(sessionId!, messageId, hostId),
    onMutate: (messageId) =>
      editLocally((messages) => {
        const target = messages.find((m) => m.id === messageId);
        return target
          ? [target, ...messages.filter((m) => m.id !== messageId)]
          : messages;
      }),
    onError: rollback,
    onSuccess: applyStatus,
  });

  // Mutation for editing a queued message in place
  const updateQueuedMutation = useMutation({
    mutationKey,
    mutationFn: ({
      messageId,
      message,
      executorConfig,
    }: {
      messageId: string;
      message: string;
      executorConfig: ExecutorConfig;
    }) =>
      queueApi.updateQueued(
        sessionId!,
        messageId,
        { message, executor_config: executorConfig },
        hostId
      ),
    onMutate: ({ messageId, message, executorConfig }) =>
      editLocally((messages) =>
        messages.map((m) =>
          m.id === messageId
            ? { ...m, data: { message, executor_config: executorConfig } }
            : m
        )
      ),
    onError: rollback,
    onSuccess: applyStatus,
  });

  // Mutation for reordering the queue
  const reorderMutation = useMutation({
    mutationKey,
    mutationFn: (messageIds: string[]) =>
      queueApi.reorder(sessionId!, messageIds, hostId),
    onMutate: (messageIds) =>
      editLocally((messages) => {
        const byId = new Map(messages.map((m) => [m.id, m]));
        const ordered = messageIds
          .map((id) => byId.get(id))
          .filter((m): m is QueuedMessage => m !== undefined);
        // Keep any messages not named in the new order (guards against a stale
        // client list silently dropping a message).
        for (const m of messages) {
          if (!messageIds.includes(m.id)) ordered.push(m);
        }
        return ordered;
      }),
    onError: rollback,
    onSuccess: applyStatus,
  });

  // Mutation for cancelling the whole queue
  const cancelMutation = useMutation({
    mutationKey,
    mutationFn: () => queueApi.cancel(sessionId!, hostId),
    onMutate: () => editLocally(() => []),
    onError: rollback,
    onSuccess: applyStatus,
  });

  // Mutation for cancelling a single message
  const cancelOneMutation = useMutation({
    mutationKey,
    mutationFn: (messageId: string) =>
      queueApi.cancelOne(sessionId!, messageId, hostId),
    onMutate: (messageId) =>
      editLocally((messages) => messages.filter((m) => m.id !== messageId)),
    onError: rollback,
    onSuccess: applyStatus,
  });

  const queueMessage = useCallback(
    async (
      message: string,
      executorConfig: ExecutorConfig,
      after?: Promise<boolean>
    ) => {
      if (!sessionId) return;
      await queueMutation.mutateAsync({ message, executorConfig, after });
    },
    [sessionId, queueMutation]
  );

  const steer = useCallback(
    async (message: string, executorConfig: ExecutorConfig) => {
      if (!sessionId) return { status: 'empty' as const };
      return steerMutation.mutateAsync({ message, executorConfig });
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

  const updateQueued = useCallback(
    async (
      messageId: string,
      message: string,
      executorConfig: ExecutorConfig
    ) => {
      if (!sessionId) return;
      await updateQueuedMutation.mutateAsync({
        messageId,
        message,
        executorConfig,
      });
    },
    [sessionId, updateQueuedMutation]
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
    await cancelMutation.mutateAsync(undefined);
  }, [sessionId, cancelMutation]);

  const cancelOne = useCallback(
    async (messageId: string) => {
      if (!sessionId) return;
      await cancelOneMutation.mutateAsync(messageId);
    },
    [sessionId, cancelOneMutation]
  );

  const dropQueuedLocally = useCallback(
    (messageId: string) => {
      queryClient.setQueryData<QueueStatus>(queueKey, (current) =>
        statusOf(messagesOf(current).filter((m) => m.id !== messageId))
      );
    },
    [queryClient, queueKey]
  );

  const refreshQueueStatus = useCallback(async () => {
    if (!sessionId) return;
    await refetch();
  }, [sessionId, refetch]);

  return {
    queuedMessages,
    isQueued,
    queueMessage,
    steer,
    steerQueued,
    updateQueued,
    reorderQueue,
    cancelQueue,
    cancelOne,
    dropQueuedLocally,
    refreshQueueStatus,
  };
}
