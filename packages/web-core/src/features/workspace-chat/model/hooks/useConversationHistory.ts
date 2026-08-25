import {
  ExecutionProcess,
  ExecutionProcessStatus,
  PatchType,
} from 'shared/types';
import { useExecutionProcessesContext } from '@/shared/hooks/useExecutionProcessesContext';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { streamJsonPatchEntries } from '@/shared/lib/streamJsonPatchEntries';
import { useHostId } from '@/shared/providers/HostIdProvider';
import {
  getCachedProcessEntries,
  hasStableCompletedLog,
  setCachedProcessEntries,
} from '@/features/workspace-chat/model/processEntriesCache';
import type {
  AddEntryType,
  ConversationTimelineSource,
  ExecutionProcessStateStore,
  PatchTypeWithKey,
  UseConversationHistoryParams,
} from '@/shared/hooks/useConversationHistory/types';

// Result type for the new UI's conversation history hook
export interface UseConversationHistoryResult {
  /** Whether the conversation only has a single coding agent turn (no follow-ups) */
  isFirstTurn: boolean;
  /** Whether an older-history batch is currently being fetched */
  isLoadingHistory: boolean;
  /** Whether there are older turns not yet loaded (drives scroll-up paging). */
  hasMoreHistory: boolean;
  /**
   * Fetch the next older batch of history. Call when the reader scrolls near
   * the top. No-ops while a fetch is in flight or when nothing remains.
   */
  loadOlderHistory: () => void;
  /**
   * Fetch older batches until the given execution process is loaded. Used by
   * turn navigation to jump to an old turn that hasn't been paged in yet.
   */
  loadUntilProcess: (processId: string) => Promise<void>;
}
import {
  HISTORIC_LOAD_CONCURRENCY,
  MIN_INITIAL_ENTRIES,
  REMAINING_BATCH_SIZE,
} from '@/shared/hooks/useConversationHistory/constants';

export const useConversationHistory = ({
  onTimelineUpdated,
  scopeKey,
}: UseConversationHistoryParams): UseConversationHistoryResult => {
  const {
    executionProcessesVisible: executionProcessesRaw,
    isLoading,
    isConnected,
  } = useExecutionProcessesContext();
  // Read through a ref at stream-open time: the loaders below are memoized
  // once per mount, so a render-captured host would go stale. Each open takes
  // its own snapshot, scoping the stream AND its cache entry to the host the
  // data is actually fetched from — never the focused route's host, which
  // differs in a split pane showing another host's workspace.
  const hostId = useHostId();
  const hostIdRef = useRef(hostId);
  hostIdRef.current = hostId;
  const executionProcesses = useRef<ExecutionProcess[]>(executionProcessesRaw);
  const displayedExecutionProcesses = useRef<ExecutionProcessStateStore>({});
  const loadedInitialEntries = useRef(false);
  const emittedEmptyInitialRef = useRef(false);
  const streamingProcessIdsRef = useRef<Set<string>>(new Set());
  const onTimelineUpdatedRef = useRef<
    UseConversationHistoryParams['onTimelineUpdated'] | null
  >(null);
  const previousStatusMapRef = useRef<Map<string, ExecutionProcessStatus>>(
    new Map()
  );
  const [isLoadingHistoryState, setIsLoadingHistory] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const loadingOlderRef = useRef(false);

  // Derive whether this is the first turn (no follow-up processes exist)
  const isFirstTurn = useMemo(() => {
    const codingAgentProcessCount = executionProcessesRaw.filter(
      (ep) =>
        ep.executor_action.typ.type === 'CodingAgentInitialRequest' ||
        ep.executor_action.typ.type === 'CodingAgentFollowUpRequest'
    ).length;
    return codingAgentProcessCount <= 1;
  }, [executionProcessesRaw]);

  const mergeIntoDisplayed = (
    mutator: (state: ExecutionProcessStateStore) => void
  ) => {
    const state = displayedExecutionProcesses.current;
    mutator(state);
  };

  // The hook owns transport, loading, and reconciliation.
  // It emits a source model that later derivation layers can transform further.

  const buildTimelineSource = useCallback(
    (
      executionProcessState: ExecutionProcessStateStore
    ): ConversationTimelineSource => ({
      executionProcessState,
      liveExecutionProcesses: executionProcesses.current,
    }),
    []
  );

  useEffect(() => {
    onTimelineUpdatedRef.current = onTimelineUpdated;
  }, [onTimelineUpdated]);

  // Keep executionProcesses up to date
  useEffect(() => {
    executionProcesses.current = executionProcessesRaw.filter(
      (ep) =>
        ep.run_reason === 'setupscript' ||
        ep.run_reason === 'cleanupscript' ||
        ep.run_reason === 'archivescript' ||
        ep.run_reason === 'codingagent'
    );
  }, [executionProcessesRaw]);

  const loadEntriesForHistoricExecutionProcess = (
    executionProcess: ExecutionProcess
  ) => {
    const streamHostId = hostIdRef.current;
    // Finished-process logs are immutable: entries resolved once are reused
    // across navigations instead of re-streaming the whole history.
    const cached = getCachedProcessEntries(streamHostId, executionProcess.id);
    if (cached) return Promise.resolve(cached);

    let url = '';
    if (executionProcess.executor_action.typ.type === 'ScriptRequest') {
      url = `/api/execution-processes/${executionProcess.id}/raw-logs/ws`;
    } else {
      url = `/api/execution-processes/${executionProcess.id}/normalized-logs/ws`;
    }

    return new Promise<PatchType[]>((resolve) => {
      const controller = streamJsonPatchEntries<PatchType>(url, {
        hostId: streamHostId,
        onFinished: (allEntries) => {
          controller.close();
          if (
            executionProcess.status !== ExecutionProcessStatus.running &&
            hasStableCompletedLog(executionProcess.completed_at)
          ) {
            setCachedProcessEntries(
              streamHostId,
              executionProcess.id,
              allEntries
            );
          }
          resolve(allEntries);
        },
        onError: (err) => {
          console.warn(
            `Error loading entries for historic execution process ${executionProcess.id}`,
            err
          );
          controller.close();
          resolve([]);
        },
      });
    });
  };

  const patchWithKey = (
    patch: PatchType,
    executionProcessId: string,
    index: number
  ) => {
    return {
      ...patch,
      patchKey: `${executionProcessId}:${index}`,
      executionProcessId,
    };
  };

  const flattenEntries = (
    executionProcessState: ExecutionProcessStateStore
  ): PatchTypeWithKey[] => {
    return Object.values(executionProcessState)
      .filter(
        (p) =>
          p.executionProcess.executor_action.typ.type ===
            'CodingAgentFollowUpRequest' ||
          p.executionProcess.executor_action.typ.type ===
            'CodingAgentInitialRequest' ||
          p.executionProcess.executor_action.typ.type === 'ReviewRequest'
      )
      .sort(
        (a, b) =>
          new Date(
            a.executionProcess.created_at as unknown as string
          ).getTime() -
          new Date(b.executionProcess.created_at as unknown as string).getTime()
      )
      .flatMap((p) => p.entries);
  };

  const getActiveAgentProcesses = (): ExecutionProcess[] => {
    return (
      executionProcesses?.current.filter(
        (p) =>
          p.status === ExecutionProcessStatus.running &&
          p.run_reason !== 'devserver'
      ) ?? []
    );
  };

  const emitEntries = useCallback(
    (
      executionProcessState: ExecutionProcessStateStore,
      addEntryType: AddEntryType,
      loading: boolean
    ) => {
      const timelineSource = buildTimelineSource(executionProcessState);
      let modifiedAddEntryType = addEntryType;

      const latestEntry = Object.values(executionProcessState)
        .sort(
          (a, b) =>
            new Date(
              a.executionProcess.created_at as unknown as string
            ).getTime() -
            new Date(
              b.executionProcess.created_at as unknown as string
            ).getTime()
        )
        .flatMap((processState) => processState.entries)
        .at(-1);

      if (
        latestEntry?.type === 'NORMALIZED_ENTRY' &&
        latestEntry.content.entry_type.type === 'tool_use' &&
        latestEntry.content.entry_type.tool_name === 'ExitPlanMode'
      ) {
        modifiedAddEntryType = 'plan';
      }

      onTimelineUpdatedRef.current?.(
        timelineSource,
        modifiedAddEntryType,
        loading
      );
    },
    [buildTimelineSource]
  );

  // This emits its own events as they are streamed
  const loadRunningAndEmit = useCallback(
    (executionProcess: ExecutionProcess): Promise<void> => {
      return new Promise((resolve, reject) => {
        let url = '';
        if (executionProcess.executor_action.typ.type === 'ScriptRequest') {
          url = `/api/execution-processes/${executionProcess.id}/raw-logs/ws`;
        } else {
          url = `/api/execution-processes/${executionProcess.id}/normalized-logs/ws`;
        }
        const controller = streamJsonPatchEntries<PatchType>(url, {
          hostId: hostIdRef.current,
          onEntries(entries) {
            const patchesWithKey = entries.map((entry, index) =>
              patchWithKey(entry, executionProcess.id, index)
            );
            const latestExecutionProcess =
              executionProcesses.current.find(
                (process) => process.id === executionProcess.id
              ) ?? executionProcess;
            mergeIntoDisplayed((state) => {
              state[executionProcess.id] = {
                executionProcess: latestExecutionProcess,
                entries: patchesWithKey,
              };
            });
            emitEntries(displayedExecutionProcesses.current, 'running', false);
          },
          onFinished: () => {
            emitEntries(displayedExecutionProcesses.current, 'running', false);
            controller.close();
            resolve();
          },
          onError: () => {
            controller.close();
            reject();
          },
        });
      });
    },
    [emitEntries]
  );

  // Sometimes it can take a few seconds for the stream to start, wrap the loadRunningAndEmit method
  const loadRunningAndEmitWithBackoff = useCallback(
    async (executionProcess: ExecutionProcess) => {
      for (let i = 0; i < 20; i++) {
        try {
          await loadRunningAndEmit(executionProcess);
          break;
        } catch (_) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    },
    [loadRunningAndEmit]
  );

  const loadHistoricEntries = useCallback(
    async (maxEntries?: number): Promise<ExecutionProcessStateStore> => {
      const localDisplayedExecutionProcesses: ExecutionProcessStateStore = {};

      if (!executionProcesses?.current) return localDisplayedExecutionProcesses;

      const historicProcesses = [...executionProcesses.current]
        .reverse()
        .filter(
          (executionProcess) =>
            executionProcess.status !== ExecutionProcessStatus.running
        );

      // Load a few processes concurrently: display order is decided by
      // created_at during flatten (not resolution order), and overlapping the
      // per-process round trips matters on high-latency transports (remote
      // web relays every stream). The early-stop check per batch means we
      // over-fetch at most a batch beyond maxEntries, which just becomes
      // already-loaded history.
      for (
        let i = 0;
        i < historicProcesses.length;
        i += HISTORIC_LOAD_CONCURRENCY
      ) {
        const batch = historicProcesses.slice(i, i + HISTORIC_LOAD_CONCURRENCY);
        await Promise.all(
          batch.map(async (executionProcess) => {
            const entries =
              await loadEntriesForHistoricExecutionProcess(executionProcess);
            localDisplayedExecutionProcesses[executionProcess.id] = {
              executionProcess,
              entries: entries.map((e, idx) =>
                patchWithKey(e, executionProcess.id, idx)
              ),
            };
          })
        );

        if (
          maxEntries != null &&
          flattenEntries(localDisplayedExecutionProcesses).length > maxEntries
        ) {
          break;
        }
      }

      return localDisplayedExecutionProcesses;
    },
    [executionProcesses]
  );

  const loadRemainingEntriesInBatches = useCallback(
    async (batchSize: number): Promise<boolean> => {
      if (!executionProcesses?.current) return false;

      let anyUpdated = false;
      for (const executionProcess of [
        ...executionProcesses.current,
      ].reverse()) {
        const current = displayedExecutionProcesses.current;
        if (
          current[executionProcess.id] ||
          executionProcess.status === ExecutionProcessStatus.running
        )
          continue;

        const entries =
          await loadEntriesForHistoricExecutionProcess(executionProcess);
        const entriesWithKey = entries.map((e, idx) =>
          patchWithKey(e, executionProcess.id, idx)
        );

        mergeIntoDisplayed((state) => {
          state[executionProcess.id] = {
            executionProcess,
            entries: entriesWithKey,
          };
        });

        if (
          flattenEntries(displayedExecutionProcesses.current).length > batchSize
        ) {
          anyUpdated = true;
          break;
        }
        anyUpdated = true;
      }
      return anyUpdated;
    },
    [executionProcesses]
  );

  // Whether any non-running process still has unloaded (older) entries.
  const computeHasMoreHistory = useCallback((): boolean => {
    const displayed = displayedExecutionProcesses.current;
    return (executionProcesses.current ?? []).some(
      (p) => !displayed[p.id] && p.status !== ExecutionProcessStatus.running
    );
  }, []);

  // Scroll-up pagination: fetch the next older batch on demand instead of
  // eagerly streaming all history in the background (which prepended above the
  // reader and made the content shift while they were scrolled up reading).
  const loadOlderHistory = useCallback(() => {
    if (loadingOlderRef.current) return;
    if (!loadedInitialEntries.current) return;
    if (!computeHasMoreHistory()) return;

    loadingOlderRef.current = true;
    setIsLoadingHistory(true);
    (async () => {
      try {
        const updated =
          await loadRemainingEntriesInBatches(REMAINING_BATCH_SIZE);
        if (updated) {
          emitEntries(displayedExecutionProcesses.current, 'historic', false);
        }
        setHasMoreHistory(computeHasMoreHistory());
      } finally {
        loadingOlderRef.current = false;
        setIsLoadingHistory(false);
      }
    })();
  }, [computeHasMoreHistory, loadRemainingEntriesInBatches, emitEntries]);

  // Turn navigation: keep fetching older batches until `processId` is loaded,
  // so a click on an old turn in the navigator lands on real content. Resolves
  // once the process is present (or nothing older remains). Serializes with the
  // scroll-up loader via loadingOlderRef so they don't double-fetch.
  const loadUntilProcess = useCallback(
    async (processId: string): Promise<void> => {
      if (!loadedInitialEntries.current) return;
      if (displayedExecutionProcesses.current[processId]) return;

      while (loadingOlderRef.current) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (displayedExecutionProcesses.current[processId]) return;
      }

      loadingOlderRef.current = true;
      setIsLoadingHistory(true);
      try {
        let guard = 0;
        while (
          !displayedExecutionProcesses.current[processId] &&
          computeHasMoreHistory() &&
          guard < 200
        ) {
          guard += 1;
          const updated =
            await loadRemainingEntriesInBatches(REMAINING_BATCH_SIZE);
          if (updated) {
            emitEntries(displayedExecutionProcesses.current, 'historic', false);
          }
          if (!updated) break;
        }
        setHasMoreHistory(computeHasMoreHistory());
      } finally {
        loadingOlderRef.current = false;
        setIsLoadingHistory(false);
      }
    },
    [computeHasMoreHistory, loadRemainingEntriesInBatches, emitEntries]
  );

  const ensureProcessVisible = useCallback((p: ExecutionProcess) => {
    mergeIntoDisplayed((state) => {
      if (!state[p.id]) {
        state[p.id] = {
          executionProcess: {
            id: p.id,
            created_at: p.created_at,
            updated_at: p.updated_at,
            executor_action: p.executor_action,
          },
          entries: [],
        };
      }
    });
  }, []);

  const idListKey = useMemo(
    () => executionProcessesRaw?.map((p) => p.id).join(','),
    [executionProcessesRaw]
  );

  const idStatusKey = useMemo(
    () => executionProcessesRaw?.map((p) => `${p.id}:${p.status}`).join(','),
    [executionProcessesRaw]
  );

  // Clean up entries for processes that have been removed (e.g., after reset)
  useEffect(() => {
    if (isLoading || !isConnected) return;
    const visibleProcessIds = new Set(executionProcessesRaw.map((p) => p.id));
    const displayedIds = Object.keys(displayedExecutionProcesses.current);
    let changed = false;

    for (const id of displayedIds) {
      if (!visibleProcessIds.has(id)) {
        delete displayedExecutionProcesses.current[id];
        changed = true;
      }
    }

    if (changed) {
      emitEntries(displayedExecutionProcesses.current, 'historic', false);
    }
  }, [idListKey, executionProcessesRaw, emitEntries, isLoading, isConnected]);

  useEffect(() => {
    displayedExecutionProcesses.current = {};
    loadedInitialEntries.current = false;
    emittedEmptyInitialRef.current = false;
    streamingProcessIdsRef.current.clear();
    previousStatusMapRef.current.clear();
    loadingOlderRef.current = false;
    setHasMoreHistory(false);
    emitEntries(displayedExecutionProcesses.current, 'initial', true);
  }, [scopeKey, emitEntries]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (loadedInitialEntries.current) return;

      if (isLoading) return;

      if (executionProcesses.current.length === 0) {
        if (emittedEmptyInitialRef.current) return;
        emittedEmptyInitialRef.current = true;
        emitEntries(displayedExecutionProcesses.current, 'initial', false);
        return;
      }

      emittedEmptyInitialRef.current = false;

      const allInitialEntries = await loadHistoricEntries(MIN_INITIAL_ENTRIES);
      if (cancelled) return;
      loadedInitialEntries.current = true;
      mergeIntoDisplayed((state) => {
        Object.assign(state, allInitialEntries);
      });
      emitEntries(displayedExecutionProcesses.current, 'initial', false);

      // Older turns are now loaded on demand (scroll-up pagination) rather than
      // eagerly in the background, so the reader's view never shifts unless
      // they scroll toward the top to ask for more.
      if (!cancelled) setHasMoreHistory(computeHasMoreHistory());
    })();
    return () => {
      cancelled = true;
    };
  }, [
    scopeKey,
    idListKey,
    isLoading,
    loadHistoricEntries,
    computeHasMoreHistory,
    emitEntries,
  ]); // include idListKey so new processes trigger reload

  // Late-arriving finished processes. The initial load above may have run
  // against a CACHED (stale) process snapshot; when the fresh server replay
  // reveals finished processes the timeline has never seen — e.g. a turn that
  // started AND completed while the user was away — no other effect covers
  // them: the active-process effect only handles running ones, and the
  // status-transition effect needs a previously observed `running` status.
  // Load anything finished, undisplayed, and within/after the loaded window
  // (older ones stay behind scroll-up pagination).
  const reconcileInFlightRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (isLoading || !loadedInitialEntries.current) return;

    const displayed = displayedExecutionProcesses.current;
    const displayedTimes = Object.values(displayed).map((p) =>
      new Date(p.executionProcess.created_at as unknown as string).getTime()
    );
    if (displayedTimes.length === 0) return;
    const oldestDisplayedAt = Math.min(...displayedTimes);

    const missing = executionProcesses.current.filter(
      (p) =>
        p.status !== ExecutionProcessStatus.running &&
        !displayed[p.id] &&
        !reconcileInFlightRef.current.has(p.id) &&
        new Date(p.created_at as unknown as string).getTime() >=
          oldestDisplayedAt
    );
    if (missing.length === 0) {
      setHasMoreHistory(computeHasMoreHistory());
      return;
    }

    missing.forEach((p) => reconcileInFlightRef.current.add(p.id));
    (async () => {
      try {
        await Promise.all(
          missing.map(async (executionProcess) => {
            const entries =
              await loadEntriesForHistoricExecutionProcess(executionProcess);
            // The scope may have changed while the stream resolved; the
            // current process list is scope-authoritative, so a process no
            // longer in it must not be merged into the new conversation.
            if (
              !executionProcesses.current.some(
                (current) => current.id === executionProcess.id
              )
            ) {
              return;
            }
            mergeIntoDisplayed((state) => {
              state[executionProcess.id] = {
                executionProcess,
                entries: entries.map((e, idx) =>
                  patchWithKey(e, executionProcess.id, idx)
                ),
              };
            });
          })
        );
        emitEntries(displayedExecutionProcesses.current, 'running', false);
        setHasMoreHistory(computeHasMoreHistory());
      } finally {
        missing.forEach((p) => reconcileInFlightRef.current.delete(p.id));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idListKey, isLoading, computeHasMoreHistory, emitEntries]);

  useEffect(() => {
    const activeProcesses = getActiveAgentProcesses();
    if (activeProcesses.length === 0) return;

    for (const activeProcess of activeProcesses) {
      if (!displayedExecutionProcesses.current[activeProcess.id]) {
        const runningOrInitial =
          Object.keys(displayedExecutionProcesses.current).length > 1
            ? 'running'
            : 'initial';
        ensureProcessVisible(activeProcess);
        emitEntries(
          displayedExecutionProcesses.current,
          runningOrInitial,
          false
        );
      }

      if (
        activeProcess.status === ExecutionProcessStatus.running &&
        !streamingProcessIdsRef.current.has(activeProcess.id)
      ) {
        streamingProcessIdsRef.current.add(activeProcess.id);
        loadRunningAndEmitWithBackoff(activeProcess).finally(() => {
          streamingProcessIdsRef.current.delete(activeProcess.id);
        });
      }
    }
  }, [
    scopeKey,
    idStatusKey,
    emitEntries,
    ensureProcessVisible,
    loadRunningAndEmitWithBackoff,
  ]);

  useEffect(() => {
    if (!executionProcessesRaw) return;

    let statusChanged = false;

    for (const process of executionProcessesRaw) {
      const previousStatus = previousStatusMapRef.current.get(process.id);
      const currentStatus = process.status;

      if (
        previousStatus === ExecutionProcessStatus.running &&
        currentStatus !== ExecutionProcessStatus.running &&
        displayedExecutionProcesses.current[process.id]
      ) {
        // The live log stream already owns the authoritative entry list. Keep
        // those entries mounted and only replace the process metadata so the
        // loading row disappears without replaying/replacing every action in
        // the completed turn. The stream may still deliver its final buffered
        // chunk; loadRunningAndEmit reads the latest metadata on every update.
        displayedExecutionProcesses.current[process.id].executionProcess =
          process;
        statusChanged = true;
      }

      previousStatusMapRef.current.set(process.id, currentStatus);
    }

    if (statusChanged) {
      emitEntries(displayedExecutionProcesses.current, 'running', false);
    }
  }, [idStatusKey, executionProcessesRaw, emitEntries]);

  // If an execution process is removed, remove it from the state
  useEffect(() => {
    if (!executionProcessesRaw) return;

    const removedProcessIds = Object.keys(
      displayedExecutionProcesses.current
    ).filter((id) => !executionProcessesRaw.some((p) => p.id === id));

    if (removedProcessIds.length > 0) {
      mergeIntoDisplayed((state) => {
        removedProcessIds.forEach((id) => {
          delete state[id];
        });
      });
    }
  }, [scopeKey, idListKey, executionProcessesRaw]);

  return {
    isFirstTurn,
    isLoadingHistory: isLoadingHistoryState,
    hasMoreHistory,
    loadOlderHistory,
    loadUntilProcess,
  };
};
