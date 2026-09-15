import { electricCollectionOptions } from '@tanstack/electric-db-collection';
import { createCollection } from '@tanstack/react-db';

import { getAuthRuntime } from '@/shared/lib/auth/runtime';
import { getRemoteApiUrl, makeRequest } from '@/shared/lib/remoteApi';
import {
  PROJECT_GITHUB_ISSUE_LINKS_SHAPE,
  type GithubIssueLink,
  type MutationDefinition,
  type ShapeDefinition,
} from 'shared/remote-types';
import type { CollectionConfig, SyncError } from '@/shared/lib/electric/types';

type ElectricRow = Record<string, unknown> & { [key: string]: unknown };

type SourceMode = 'electric' | 'fallback';

type SourceRuntime = {
  mode: SourceMode;
  fallbackLocked: boolean;
  fallbackLockedAt: number | null;
  refreshers: Set<() => Promise<void>>;
  fallbackSwitchers: Set<() => void>;
  /** Sessions currently on the fallback that can probe Electric on demand. */
  probeTriggers: Set<() => void>;
};

type MutationFnParams = {
  transaction: {
    mutations: Array<{
      modified?: unknown;
      original?: unknown;
      key?: string;
      changes?: unknown;
    }>;
  };
};

type SyncMessage = {
  type: 'insert' | 'update' | 'delete';
  value: ElectricRow;
  metadata?: Record<string, unknown>;
};

type SyncParams = {
  collection: {
    isReady: () => boolean;
    onFirstReady: (callback: () => void) => void;
  };
  begin: () => void;
  write: (message: SyncMessage) => void;
  commit: () => void;
  markReady: () => void;
  truncate: () => void;
};

type LoadSubsetFn = (options: unknown) => true | Promise<void>;
type UnloadSubsetFn = (options: unknown) => void;

type SyncResult =
  | void
  | (() => void)
  | {
      cleanup?: () => void;
      loadSubset?: LoadSubsetFn;
      unloadSubset?: UnloadSubsetFn;
    };

type NormalizedSyncResult = {
  cleanup?: () => void;
  loadSubset?: LoadSubsetFn;
  unloadSubset?: UnloadSubsetFn;
};

type SyncConfigLike = {
  sync: (syncParams: SyncParams) => SyncResult;
  getSyncMetadata?: () => Record<string, unknown>;
  rowUpdateMode?: 'partial' | 'full';
};

type TimeoutId = ReturnType<typeof globalThis.setTimeout>;

type ProbeState = {
  sync: NormalizedSyncResult;
  timeoutId: TimeoutId | null;
  adopted: boolean;
};

type MutationSlot = {
  current: MutationDefinition<unknown, unknown, unknown> | null;
};

export type ShapeErrorListener = {
  onError: (error: SyncError) => void;
  /** Electric is streaming again after a fallback period. */
  onRecover?: () => void;
};

type ErrorChannel = {
  report: (error: SyncError) => void;
  recovered: () => void;
  /** Bumped on every stream error, even ones that are not reported. */
  noteStreamError: () => void;
  streamErrorCount: number;
  /** Background probes fail quietly: the source is already known-degraded. */
  silent: boolean;
};

type ShapeCollection = ReturnType<typeof createCollection>;

// Streams nobody reads any more stop after this grace period. Long enough to
// survive route transitions and dialog remounts, short enough that leaving a
// project actually ends its shape streams instead of keeping them for minutes.
export const SHAPE_GC_TIME_MS = 30 * 1000;
// Wall-clock timer: heavy renders (e.g. several panes remounting) can delay
// ready-processing of a healthy stream, so keep this generous.
export const ELECTRIC_READY_TIMEOUT_MS = 10_000;
export const FALLBACK_REFRESH_INTERVAL_MS = 30 * 1000;
// A fallback-locked source retries Electric on the next sync session once
// this cooldown has passed, instead of staying degraded for the whole tab.
const FALLBACK_RETRY_COOLDOWN_MS = 60 * 1000;
// While a session polls the fallback it also probes Electric in the
// background with exponential backoff; a probe that reaches up-to-date swaps
// the session back to Electric at once.
export const ELECTRIC_PROBE_BASE_DELAY_MS = 30 * 1000;
export const ELECTRIC_PROBE_MAX_DELAY_MS = 5 * 60 * 1000;

/**
 * Client-side column projection (`columns=` is forwarded by the shape proxy).
 * `github_issue_links` carries the automation worker's `synced_*` mirror of
 * each issue; the UI never reads it, so dropping it keeps worker writes to
 * those columns from streaming to every open board. Rows from the REST
 * fallback keep every column, which is a harmless superset.
 */
export const GITHUB_ISSUE_LINK_COLUMNS = [
  'id',
  'project_id',
  'issue_id',
  'repository',
  'number',
  'url',
  'github_node_id',
  'github_state',
] as const satisfies readonly (keyof GithubIssueLink)[];

export type ProjectGithubIssueLink = Pick<
  GithubIssueLink,
  (typeof GITHUB_ISSUE_LINK_COLUMNS)[number]
>;

const SHAPE_COLUMNS = new Map<ShapeDefinition<unknown>, readonly string[]>([
  [PROJECT_GITHUB_ISSUE_LINKS_SHAPE, GITHUB_ISSUE_LINK_COLUMNS],
]);

const collectionCache = new Map<string, ShapeCollection>();
const mutationSlots = new Map<string, MutationSlot>();
const sourceRuntimes = new Map<string, SourceRuntime>();
const fallbackSnapshotCache = new Map<string, ElectricRow[]>();
const errorListeners = new WeakMap<object, Set<ShapeErrorListener>>();
const collectionSourceKeys = new WeakMap<object, string>();

class ErrorHandler {
  private lastErrorTime = 0;
  private lastErrorMessage = '';
  private consecutiveErrors = 0;
  private readonly baseDebounceMs = 1000;
  private readonly maxDebounceMs = 30000;

  shouldReport(message: string): boolean {
    const now = Date.now();
    const debounceMs = Math.min(
      this.baseDebounceMs * Math.pow(2, this.consecutiveErrors),
      this.maxDebounceMs
    );

    if (
      message === this.lastErrorMessage &&
      now - this.lastErrorTime < debounceMs
    ) {
      return false;
    }

    this.lastErrorTime = now;
    if (message === this.lastErrorMessage) {
      this.consecutiveErrors += 1;
    } else {
      this.consecutiveErrors = 0;
      this.lastErrorMessage = message;
    }

    return true;
  }
}

function buildUrl(baseUrl: string, params: Record<string, string>): string {
  let url = baseUrl;
  for (const [key, value] of Object.entries(params)) {
    url = url.replace(`{${key}}`, encodeURIComponent(value));
  }
  return url;
}

function buildFallbackRequestPath(
  fallbackUrl: string,
  params: Record<string, string>
): string {
  const path = buildUrl(fallbackUrl, params);
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (!value) continue;
    query.set(key, value);
  }

  const queryString = query.toString();
  return queryString ? `${path}?${queryString}` : path;
}

// One collection (and one Electric stream) per shape + params. Mutation
// handlers are always attached and resolve their definition lazily, so
// read-only and mutating readers share the same stream.
function buildCollectionId(
  table: string,
  params: Record<string, string>
): string {
  const sortedParams = Object.keys(params)
    .sort()
    .map((key) => params[key])
    .join('-');

  return sortedParams ? `${table}-${sortedParams}` : table;
}

function getRowKey(item: Record<string, unknown>): string {
  if ('id' in item && item.id) {
    return String(item.id);
  }

  return Object.entries(item)
    .filter(([key]) => key.endsWith('_id'))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => String(value))
    .join('-');
}

function normalizeSyncResult(result: SyncResult): NormalizedSyncResult {
  if (!result) return {};
  if (typeof result === 'function') {
    return { cleanup: result };
  }
  return result;
}

function getOrCreateSourceRuntime(sourceKey: string): SourceRuntime {
  const existing = sourceRuntimes.get(sourceKey);
  if (existing) {
    return existing;
  }

  const created: SourceRuntime = {
    mode: 'electric',
    fallbackLocked: false,
    fallbackLockedAt: null,
    refreshers: new Set(),
    fallbackSwitchers: new Set(),
    probeTriggers: new Set(),
  };
  sourceRuntimes.set(sourceKey, created);
  return created;
}

function lockSourceToFallback(sourceKey: string): void {
  const runtime = getOrCreateSourceRuntime(sourceKey);
  if (runtime.fallbackLocked) return;

  runtime.fallbackLocked = true;
  runtime.fallbackLockedAt = Date.now();
  runtime.mode = 'fallback';

  const switchers = Array.from(runtime.fallbackSwitchers);
  for (const switcher of switchers) {
    switcher();
  }
}

function unlockSource(sourceKey: string): void {
  const runtime = getOrCreateSourceRuntime(sourceKey);
  runtime.fallbackLocked = false;
  runtime.fallbackLockedAt = null;
  runtime.mode = 'electric';
}

function registerFallbackSwitcher(
  sourceKey: string,
  switcher: () => void
): () => void {
  const runtime = getOrCreateSourceRuntime(sourceKey);
  runtime.fallbackSwitchers.add(switcher);

  if (runtime.fallbackLocked) {
    switcher();
  }

  return () => {
    runtime.fallbackSwitchers.delete(switcher);
  };
}

function registerFallbackRefresher(
  sourceKey: string,
  refresher: () => Promise<void>
): () => void {
  const runtime = getOrCreateSourceRuntime(sourceKey);
  runtime.refreshers.add(refresher);
  return () => {
    runtime.refreshers.delete(refresher);
  };
}

function registerProbeTrigger(
  sourceKey: string,
  trigger: () => void
): () => void {
  const runtime = getOrCreateSourceRuntime(sourceKey);
  runtime.probeTriggers.add(trigger);
  return () => {
    runtime.probeTriggers.delete(trigger);
  };
}

function invalidateFallbackCache(sourceKey: string): void {
  fallbackSnapshotCache.delete(sourceKey);
}

function refreshFallbackSource(sourceKey: string): void {
  const runtime = getOrCreateSourceRuntime(sourceKey);
  for (const refresher of runtime.refreshers) {
    void refresher();
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function isPageVisible(): boolean {
  return document.visibilityState === 'visible';
}

function isCancelledErrorMessage(message?: string): boolean {
  if (!message) return false;
  return /\bcancell?ed\b/i.test(message);
}

function isTransientElectricFailure(error: unknown): boolean {
  if (isAbortError(error)) return true;
  if (!isPageVisible()) return true;

  const message = error instanceof Error ? error.message : String(error);
  return isCancelledErrorMessage(message);
}

function isTransientElectricShapeError(error: {
  name?: string;
  message?: string;
}): boolean {
  if (error.name === 'AbortError') return true;
  if (!isPageVisible()) return true;
  return isCancelledErrorMessage(error.message);
}

function createErrorChannel(
  listeners: Set<ShapeErrorListener>,
  config?: CollectionConfig
): ErrorChannel {
  const handler = new ErrorHandler();
  if (config?.onError) {
    listeners.add({ onError: config.onError });
  }

  const channel: ErrorChannel = {
    silent: false,
    streamErrorCount: 0,
    noteStreamError: () => {
      channel.streamErrorCount += 1;
    },
    report: (error: SyncError) => {
      if (channel.silent) return;
      if (!handler.shouldReport(error.message)) return;

      if (isPageVisible()) {
        console.error('Shape sync error:', error);
      }
      for (const listener of listeners) {
        listener.onError(error);
      }
    },
    recovered: () => {
      for (const listener of listeners) {
        listener.onRecover?.();
      }
    },
  };
  return channel;
}

function createErrorHandlingFetch(args: {
  onError: (error: SyncError) => void;
  onStreamError: () => void;
  onElectricUnavailable: () => void;
  isPaused: () => boolean;
}) {
  return async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    if (args.isPaused()) {
      throw new DOMException(
        'Shape request aborted: not authenticated',
        'AbortError'
      );
    }

    try {
      return await fetch(input, init);
    } catch (error) {
      args.onStreamError();
      if (isTransientElectricFailure(error)) {
        throw error;
      }

      const message = error instanceof Error ? error.message : 'Network error';
      args.onError({ message });
      args.onElectricUnavailable();
      throw error;
    }
  };
}

function createElectricShapeOptions(args: {
  shape: ShapeDefinition<unknown>;
  params: Record<string, string>;
  errors: ErrorChannel;
  onElectricUnavailable: () => void;
}) {
  const authRuntime = getAuthRuntime();
  let isPaused = false;
  const pauseable = {
    pause: () => {
      isPaused = true;
    },
    resume: () => {
      isPaused = false;
    },
  };

  const url = buildUrl(args.shape.url, args.params);
  const columns = SHAPE_COLUMNS.get(args.shape);

  const shapeOptions = {
    url: `${getRemoteApiUrl()}${url}`,
    params: columns
      ? { ...args.params, columns: columns.join(',') }
      : args.params,
    headers: {
      Authorization: async () => {
        const token = await authRuntime.getToken();
        if (!token) {
          isPaused = true;
          return '';
        }
        return `Bearer ${token}`;
      },
    },
    parser: {
      timestamptz: (value: string) => value,
    },
    fetchClient: createErrorHandlingFetch({
      onError: args.errors.report,
      onStreamError: args.errors.noteStreamError,
      onElectricUnavailable: args.onElectricUnavailable,
      isPaused: () => isPaused,
    }),
    onError: (error: { status?: number; message?: string; name?: string }) => {
      args.errors.noteStreamError();
      if (isPaused) return;
      if (isTransientElectricShapeError(error)) return;

      const status = error.status;
      const message = error.message || String(error);

      if (status === 401) {
        authRuntime.triggerRefresh().catch(() => {
          args.errors.report({ status, message });
        });
        return;
      }

      args.errors.report({ status, message });

      if (status === undefined || status >= 500) {
        args.onElectricUnavailable();
      }
    },
  };

  return {
    shapeOptions,
    // Registered per sync session so a garbage-collected collection stops
    // holding a pause/resume hook in the token manager.
    attachAuthPause: () => authRuntime.registerShape(pauseable),
  };
}

function applySnapshot(syncParams: SyncParams, rows: ElectricRow[]): void {
  syncParams.begin();
  syncParams.truncate();

  for (const row of rows) {
    syncParams.write({
      type: 'insert',
      value: row,
      metadata: {},
    });
  }

  syncParams.commit();
  syncParams.markReady();
}

function extractFallbackRows(
  payload: unknown,
  table: string
): Array<ElectricRow> {
  if (!payload || typeof payload !== 'object') {
    throw new Error(`Fallback response for "${table}" is not an object`);
  }

  const rows = (payload as Record<string, unknown>)[table];
  if (!Array.isArray(rows)) {
    throw new Error(`Fallback response missing "${table}" array`);
  }

  return rows as Array<ElectricRow>;
}

async function parseResponseError(
  response: Response,
  fallbackMessage: string
): Promise<string> {
  try {
    const body = (await response.json()) as {
      message?: string;
      error?: string;
    };
    return body.message || body.error || fallbackMessage;
  } catch {
    return fallbackMessage;
  }
}

function createFallbackSync(args: {
  sourceKey: string;
  shape: ShapeDefinition<unknown>;
  params: Record<string, string>;
  reportError: (error: SyncError) => void;
}) {
  return (syncParams: SyncParams): SyncResult => {
    const runtime = getOrCreateSourceRuntime(args.sourceKey);
    runtime.mode = 'fallback';
    runtime.fallbackLocked = true;

    let isCleanedUp = false;
    let refreshPromise: Promise<void> | null = null;

    const refreshNow = async () => {
      if (refreshPromise) {
        return refreshPromise;
      }

      refreshPromise = (async () => {
        try {
          const response = await makeRequest(
            buildFallbackRequestPath(args.shape.fallbackUrl, args.params),
            { method: 'GET', cache: 'no-store' }
          );

          if (!response.ok) {
            const message = await parseResponseError(
              response,
              `Failed to fetch fallback ${args.shape.table}`
            );
            throw new Error(message);
          }

          const payload = (await response.json()) as unknown;
          const rows = extractFallbackRows(payload, args.shape.table);
          fallbackSnapshotCache.set(args.sourceKey, rows);

          if (!isCleanedUp) {
            applySnapshot(syncParams, rows);
          }
        } catch (error) {
          if (isAbortError(error)) return;

          const message =
            error instanceof Error ? error.message : 'Fallback fetch failed';
          args.reportError({ message });

          if (!isCleanedUp && !syncParams.collection.isReady()) {
            syncParams.markReady();
          }
        } finally {
          refreshPromise = null;
        }
      })();

      return refreshPromise;
    };

    const unregisterRefresher = registerFallbackRefresher(
      args.sourceKey,
      refreshNow
    );

    const cachedRows = fallbackSnapshotCache.get(args.sourceKey);
    if (cachedRows) {
      applySnapshot(syncParams, cachedRows);
    }

    void refreshNow();

    const intervalId = globalThis.setInterval(() => {
      void refreshNow();
    }, FALLBACK_REFRESH_INTERVAL_MS);

    return {
      cleanup: () => {
        isCleanedUp = true;
        globalThis.clearInterval(intervalId);
        unregisterRefresher();
      },
      loadSubset: () => true,
    };
  };
}

/**
 * Sync params for an Electric probe running beside the fallback. Everything
 * Electric writes is held back until its first up-to-date; `onReady` then
 * gets a `replay` that swaps the fallback rows for the Electric snapshot in
 * one truncating transaction, after which writes pass straight through.
 */
function createBufferedSyncParams(
  real: SyncParams,
  onReady: (replay: () => void) => void
): SyncParams {
  let pending: SyncMessage[] = [];
  let live = false;

  return {
    collection: real.collection,
    begin: () => {
      if (live) real.begin();
    },
    write: (message) => {
      if (live) real.write(message);
      else pending.push(message);
    },
    commit: () => {
      if (live) real.commit();
    },
    truncate: () => {
      if (live) real.truncate();
      else pending = [];
    },
    markReady: () => {
      if (live) {
        real.markReady();
        return;
      }
      // The Electric stream also marks ready on errors (synchronously before
      // its onError callback); deferring lets the probe owner see that error
      // first and refuse the swap.
      queueMicrotask(() => {
        if (live) return;
        onReady(() => {
          live = true;
          real.begin();
          real.truncate();
          for (const message of pending) real.write(message);
          pending = [];
          real.commit();
          real.markReady();
        });
      });
    },
  };
}

function createHybridSync(args: {
  sourceKey: string;
  shape: ShapeDefinition<unknown>;
  params: Record<string, string>;
  errors: ErrorChannel;
  electricSync: SyncConfigLike['sync'];
  attachAuthPause: () => () => void;
}) {
  const fallbackSync = createFallbackSync({
    sourceKey: args.sourceKey,
    shape: args.shape,
    params: args.params,
    reportError: args.errors.report,
  });

  return (syncParams: SyncParams): SyncResult => {
    const runtime = getOrCreateSourceRuntime(args.sourceKey);

    let isCleanedUp = false;
    let usingFallback = false;
    let activeSync: NormalizedSyncResult = {};
    let readyTimeoutId: TimeoutId | null = null;
    let probeTimeoutId: TimeoutId | null = null;
    let probe: ProbeState | null = null;
    let failedProbes = 0;
    const detachAuthPause = args.attachAuthPause();

    const discardProbe = () => {
      if (!probe) return;
      if (probe.timeoutId) globalThis.clearTimeout(probe.timeoutId);
      probe.sync.cleanup?.();
      probe = null;
      args.errors.silent = false;
    };

    const scheduleProbe = () => {
      if (isCleanedUp || !usingFallback) return;
      if (probeTimeoutId) globalThis.clearTimeout(probeTimeoutId);
      const delay = Math.min(
        ELECTRIC_PROBE_BASE_DELAY_MS * 2 ** failedProbes,
        ELECTRIC_PROBE_MAX_DELAY_MS
      );
      probeTimeoutId = globalThis.setTimeout(() => {
        probeTimeoutId = null;
        startProbe();
      }, delay);
    };

    const startProbe = () => {
      if (isCleanedUp || !usingFallback || probe) return;
      if (!isPageVisible()) {
        scheduleProbe();
        return;
      }

      args.errors.silent = true;
      const errorsAtStart = args.errors.streamErrorCount;
      const state: ProbeState = { sync: {}, timeoutId: null, adopted: false };
      probe = state;

      const buffered = createBufferedSyncParams(syncParams, (replay) => {
        // Only a probe that reached up-to-date without a single stream error
        // is trusted to take over from the fallback.
        if (isCleanedUp || probe !== state) return;
        if (args.errors.streamErrorCount !== errorsAtStart) return;

        state.adopted = true;
        probe = null;
        if (state.timeoutId) globalThis.clearTimeout(state.timeoutId);
        args.errors.silent = false;

        activeSync.cleanup?.();
        activeSync = state.sync;
        usingFallback = false;
        failedProbes = 0;
        unlockSource(args.sourceKey);
        replay();
        args.errors.recovered();
      });

      state.sync = normalizeSyncResult(args.electricSync(buffered));
      if (state.adopted) {
        activeSync = state.sync;
        return;
      }

      state.timeoutId = globalThis.setTimeout(() => {
        failedProbes += 1;
        discardProbe();
        scheduleProbe();
      }, ELECTRIC_READY_TIMEOUT_MS);
    };

    const switchToFallback = () => {
      if (isCleanedUp || usingFallback) return;
      usingFallback = true;

      discardProbe();
      activeSync.cleanup?.();
      activeSync = normalizeSyncResult(fallbackSync(syncParams));
      scheduleProbe();
    };

    const scheduleReadyTimeout = () => {
      readyTimeoutId = globalThis.setTimeout(() => {
        if (isCleanedUp || usingFallback || syncParams.collection.isReady()) {
          return;
        }

        if (!isPageVisible()) {
          scheduleReadyTimeout();
          return;
        }

        args.errors.report({
          message: `Electric sync timed out after ${ELECTRIC_READY_TIMEOUT_MS}ms, switching to fallback`,
        });
        lockSourceToFallback(args.sourceKey);
      }, ELECTRIC_READY_TIMEOUT_MS);
    };

    if (
      runtime.fallbackLocked &&
      Date.now() - (runtime.fallbackLockedAt ?? 0) >= FALLBACK_RETRY_COOLDOWN_MS
    ) {
      // Cooldown over: give Electric another chance on this fresh session.
      unlockSource(args.sourceKey);
    }

    if (!runtime.fallbackLocked) {
      runtime.mode = 'electric';
      activeSync = normalizeSyncResult(args.electricSync(syncParams));
      scheduleReadyTimeout();
      syncParams.collection.onFirstReady(() => {
        if (!usingFallback && readyTimeoutId) {
          globalThis.clearTimeout(readyTimeoutId);
        }
      });
    }

    // A source that is still locked switches this session to the fallback
    // right away (and starts probing).
    const unregisterSwitcher = registerFallbackSwitcher(
      args.sourceKey,
      switchToFallback
    );
    const unregisterProbeTrigger = registerProbeTrigger(args.sourceKey, () => {
      if (isCleanedUp || !usingFallback || probe) return;
      if (probeTimeoutId) {
        globalThis.clearTimeout(probeTimeoutId);
        probeTimeoutId = null;
      }
      failedProbes = 0;
      startProbe();
    });

    return {
      cleanup: () => {
        isCleanedUp = true;
        if (readyTimeoutId) globalThis.clearTimeout(readyTimeoutId);
        if (probeTimeoutId) globalThis.clearTimeout(probeTimeoutId);
        discardProbe();
        unregisterSwitcher();
        unregisterProbeTrigger();
        detachAuthPause();
        activeSync.cleanup?.();
      },
      loadSubset: (options: unknown) =>
        activeSync.loadSubset ? activeSync.loadSubset(options) : true,
      unloadSubset: (options: unknown) => {
        activeSync.unloadSubset?.(options);
      },
    };
  };
}

function isSourceFallbackLocked(sourceKey: string): boolean {
  const runtime = getOrCreateSourceRuntime(sourceKey);
  return runtime.fallbackLocked;
}

function maybeRefreshFallbackAfterMutation(sourceKey: string): void {
  if (!isSourceFallbackLocked(sourceKey)) return;
  invalidateFallbackCache(sourceKey);
  refreshFallbackSource(sourceKey);
}

function buildMutationHandlers(
  slot: MutationSlot,
  table: string,
  sourceKey: string
) {
  const requireMutation = () => {
    if (!slot.current) {
      throw new Error(
        `No mutation definition registered for the "${table}" shape; pass one to useShape`
      );
    }
    return slot.current;
  };

  return {
    onInsert: async ({
      transaction,
    }: MutationFnParams): Promise<{ txid: number[] } | void> => {
      const mutation = requireMutation();
      const txids = await Promise.all(
        transaction.mutations.map(async (mutationItem) => {
          const data = mutationItem.modified as Record<string, unknown>;
          const response = await makeRequest(mutation.url, {
            method: 'POST',
            body: JSON.stringify(data),
          });

          if (!response.ok) {
            const message = await parseResponseError(
              response,
              `Failed to create ${mutation.name}`
            );
            throw new Error(message);
          }

          const result = (await response.json()) as { txid: number };
          return result.txid;
        })
      );

      maybeRefreshFallbackAfterMutation(sourceKey);

      if (isSourceFallbackLocked(sourceKey)) {
        return;
      }

      return { txid: txids };
    },

    onUpdate: async ({
      transaction,
    }: MutationFnParams): Promise<{ txid: number[] } | void> => {
      const mutation = requireMutation();
      let txids: number[] = [];

      if (transaction.mutations.length > 1) {
        const updates = transaction.mutations.map((mutationItem) => {
          if (!mutationItem.key) {
            throw new Error(`Failed to update ${mutation.name}: missing key`);
          }

          return {
            id: String(mutationItem.key),
            ...(mutationItem.changes as Record<string, unknown>),
          };
        });

        const response = await makeRequest(`${mutation.url}/bulk`, {
          method: 'POST',
          body: JSON.stringify({ updates }),
        });

        if (!response.ok) {
          const message = await parseResponseError(
            response,
            `Failed to bulk update ${mutation.name}`
          );
          throw new Error(message);
        }

        const result = (await response.json()) as { txid: number };
        txids = [result.txid];
      } else {
        const mutationItem = transaction.mutations[0];
        if (!mutationItem?.key) {
          throw new Error(`Failed to update ${mutation.name}: missing key`);
        }

        const response = await makeRequest(
          `${mutation.url}/${mutationItem.key}`,
          {
            method: 'PATCH',
            body: JSON.stringify(mutationItem.changes),
          }
        );

        if (!response.ok) {
          const message = await parseResponseError(
            response,
            `Failed to update ${mutation.name}`
          );
          throw new Error(message);
        }

        const result = (await response.json()) as { txid: number };
        txids = [result.txid];
      }

      maybeRefreshFallbackAfterMutation(sourceKey);

      if (isSourceFallbackLocked(sourceKey)) {
        return;
      }

      return { txid: txids };
    },

    onDelete: async ({
      transaction,
    }: MutationFnParams): Promise<{ txid: number[] } | void> => {
      const mutation = requireMutation();
      const txids = await Promise.all(
        transaction.mutations.map(async (mutationItem) => {
          const response = await makeRequest(
            `${mutation.url}/${mutationItem.key}`,
            {
              method: 'DELETE',
            }
          );

          if (!response.ok) {
            const message = await parseResponseError(
              response,
              `Failed to delete ${mutation.name}`
            );
            throw new Error(message);
          }

          const result = (await response.json()) as { txid: number };
          return result.txid;
        })
      );

      maybeRefreshFallbackAfterMutation(sourceKey);

      if (isSourceFallbackLocked(sourceKey)) {
        return;
      }

      return { txid: txids };
    },
  };
}

/**
 * Receive sync errors (and recovery) for a collection returned by
 * `createShapeCollection`. Returns an unsubscribe function.
 */
export function subscribeShapeErrors(
  collection: object,
  listener: ShapeErrorListener
): () => void {
  const listeners = errorListeners.get(collection);
  if (!listeners) return () => {};
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Manual retry: a source polling the fallback probes Electric right away. */
export function retryShapeSource(collection: object): void {
  const sourceKey = collectionSourceKeys.get(collection);
  if (!sourceKey) return;
  for (const trigger of getOrCreateSourceRuntime(sourceKey).probeTriggers) {
    trigger();
  }
}

export function createShapeCollection<TRow extends ElectricRow>(
  shape: ShapeDefinition<TRow>,
  params: Record<string, string>,
  config?: CollectionConfig,
  mutation?: MutationDefinition<unknown, unknown, unknown>
) {
  const collectionId = buildCollectionId(shape.table, params);

  const slot = mutationSlots.get(collectionId) ?? { current: null };
  mutationSlots.set(collectionId, slot);
  if (mutation) {
    slot.current = mutation;
  }

  const cached = collectionCache.get(collectionId);
  if (cached) {
    if (config?.onError) {
      subscribeShapeErrors(cached, { onError: config.onError });
    }
    return cached as typeof cached & { __rowType?: TRow };
  }

  const listeners = new Set<ShapeErrorListener>();
  const errors = createErrorChannel(listeners, config);
  const onElectricUnavailable = () => lockSourceToFallback(collectionId);

  const { shapeOptions, attachAuthPause } = createElectricShapeOptions({
    shape,
    params,
    errors,
    onElectricUnavailable,
  });

  const electricOptions = electricCollectionOptions({
    id: collectionId,
    shapeOptions: shapeOptions as never,
    getKey: (item: ElectricRow) => getRowKey(item),
    gcTime: SHAPE_GC_TIME_MS,
    ...buildMutationHandlers(slot, shape.table, collectionId),
  } as never);

  const electricSyncConfig = electricOptions.sync as unknown as SyncConfigLike;

  const collectionOptions = {
    ...electricOptions,
    sync: {
      ...electricSyncConfig,
      sync: createHybridSync({
        sourceKey: collectionId,
        shape,
        params,
        errors,
        electricSync: electricSyncConfig.sync,
        attachAuthPause,
      }),
    },
  };

  const collection = createCollection(
    collectionOptions as never
  ) as unknown as ShapeCollection & { __rowType?: TRow };

  errorListeners.set(collection, listeners);
  collectionSourceKeys.set(collection, collectionId);
  collectionCache.set(collectionId, collection);

  // TanStack cleans a collection up once it has had no subscribers for
  // gcTime. Drop it from the cache then, so the next reader gets a fresh
  // collection instead of restarting a cleaned-up one.
  collection.on('status:change', (event) => {
    if (event.status !== 'cleaned-up') return;
    if (collectionCache.get(collectionId) === collection) {
      collectionCache.delete(collectionId);
      mutationSlots.delete(collectionId);
    }
  });

  return collection;
}
