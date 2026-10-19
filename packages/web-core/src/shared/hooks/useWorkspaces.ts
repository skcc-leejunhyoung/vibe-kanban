import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  keepPreviousData,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { statusFirstSentence } from '@/shared/lib/statusNote';
import { useJsonPatchWsStream } from '@/shared/hooks/useJsonPatchWsStream';
import { workspaceSummaryKeys } from '@/shared/hooks/workspaceSummaryKeys';
import { makeLocalApiRequest } from '@/shared/lib/localApiTransport';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { useWorkspaceHostOptions } from '@/shared/hooks/useWorkspaceHostOptions';
import { useAppRuntime } from '@/shared/hooks/useAppRuntime';
import { workspacesApi } from '@/shared/lib/api';
import type {
  Workspace as WorkspaceRecord,
  WorkspaceWithStatus,
  WorkspaceSummary,
  WorkspaceSummaryResponse,
  ApiResponse,
} from 'shared/types';

// UI-specific workspace type for sidebar display
export interface SidebarWorkspace {
  id: string;
  name: string;
  branch: string;
  /**
   * Checkout path. Carried on the list entry so actions fired from document
   * chrome can read the *targeted* pane's path without refetching it.
   */
  containerRef?: string | null;
  createdAt: string;
  updatedAt: string;
  description: string;
  filesChanged?: number;
  linesAdded?: number;
  linesRemoved?: number;
  isRunning?: boolean;
  /**
   * Blocker-gated deferred start: the latest execution hasn't spawned because
   * the linked issue has unresolved blockers. Rendered as a "waiting" state.
   */
  isWaiting?: boolean;
  isPinned?: boolean;
  isArchived?: boolean;
  /** Quick-chat ("in-place") workspace: runs in an existing checkout, no worktree. */
  isInPlace?: boolean;
  /**
   * Set when automatic expiry cleanup could not verify this workspace's
   * uncommitted changes and quarantined it. Only an explicit delete reclaims
   * the directory.
   */
  cleanupBlockedReason?: string | null;
  hasPendingApproval?: boolean;
  hasRunningDevServer?: boolean;
  hasUnseenActivity?: boolean;
  /** Total items in the agent's latest TODO list (running workspaces only). */
  todoTotal?: number;
  /** Completed items in the agent's latest TODO list (running only). */
  todoCompleted?: number;
  /** When the latest agent turn was sent (its process started). */
  latestProcessStartedAt?: string;
  latestProcessCompletedAt?: string;
  latestProcessStatus?: 'running' | 'completed' | 'failed' | 'killed';
  prStatus?: 'open' | 'merged' | 'closed' | 'unknown';
  prNumber?: number;
  prUrl?: string;
  pullRequests?: Array<{
    status: 'open' | 'merged' | 'closed' | 'unknown';
    number: number;
    url: string;
  }>;
  /** Most recent prompt sent in this workspace (what it's working on) */
  latestPrompt?: string;
  /** The agent's live summary, stored on the workspace row. */
  statusNote?: string;
  statusUpdatedAt?: string;
  /** First sentence of `statusNote`, for rows and cards. */
  statusHeadline?: string;
  /** Host that owns the workspace. `null` is this machine. */
  hostId: string | null;
}

// Keep the old export name for backwards compatibility
export type Workspace = SidebarWorkspace;

export interface UseWorkspacesResult {
  workspaces: SidebarWorkspace[];
  archivedWorkspaces: SidebarWorkspace[];
  /**
   * Raw stream rows by id (active + archived). `WorkspaceWithStatus` is a
   * superset of the `Workspace` record, so these can seed the per-workspace
   * record query while its fetch is in flight.
   */
  workspaceRecordsById: Record<string, WorkspaceWithStatus>;
  /** The active list has nothing to show yet. */
  isLoading: boolean;
  /**
   * The archive loads after the active list, so `archivedWorkspaces` can be
   * empty while `isLoading` is already false. Wait on this before treating
   * the lists as the complete set of this host's workspaces.
   */
  isArchivedLoading: boolean;
  isConnected: boolean;
  error: string | null;
}

export function getHostWorkspaceKey(
  workspaceId: string,
  hostId: string | null
): string {
  return `${hostId ?? 'local'}:${workspaceId}`;
}

// Stable empty map for React Query's `data = <default>` fallback. Without a
// shared reference, every render allocates a fresh Map while the summary query
// is disabled/pending, which destabilizes the downstream useMemo and — for the
// remote host streams — drives an onUpdate -> setStreams -> re-render loop
// (Maximum update depth exceeded) on the unified multi-host list. Never mutate.
const EMPTY_WORKSPACE_SUMMARIES = new Map<string, WorkspaceSummary>();
const EMPTY_UNIFIED_WORKSPACES: UseWorkspacesResult = {
  workspaces: [],
  archivedWorkspaces: [],
  workspaceRecordsById: {},
  isLoading: false,
  isArchivedLoading: false,
  isConnected: false,
  error: null,
};

// State shape from the WebSocket stream
type WorkspacesState = {
  workspaces: Record<string, WorkspaceWithStatus>;
};

// Transform WorkspaceWithStatus to SidebarWorkspace, optionally merging summary data
const sidebarWorkspaceCache = new WeakMap<
  WorkspaceWithStatus,
  {
    summary: WorkspaceSummary | undefined;
    workspace: SidebarWorkspace;
  }
>();
const createdAtTimestamps = new WeakMap<SidebarWorkspace, number>();

export function toSidebarWorkspace(
  ws: WorkspaceWithStatus,
  summary?: WorkspaceSummary,
  hostId: string | null = null
): SidebarWorkspace {
  const cached = sidebarWorkspaceCache.get(ws);
  if (cached?.summary === summary && cached?.workspace.hostId === hostId) {
    return cached.workspace;
  }
  const workspace: SidebarWorkspace = {
    id: ws.id,
    name: ws.name ?? ws.branch, // Use name if available, fallback to branch
    branch: ws.branch,
    containerRef: ws.container_ref,
    createdAt: ws.created_at,
    updatedAt: ws.updated_at,
    description: '',
    // Use real stats from summary if available
    filesChanged: summary?.files_changed ?? undefined,
    linesAdded: summary?.lines_added ?? undefined,
    linesRemoved: summary?.lines_removed ?? undefined,
    // Real data from stream
    isRunning: ws.is_running,
    isPinned: ws.pinned,
    isArchived: ws.archived,
    isInPlace: ws.in_place,
    cleanupBlockedReason: ws.cleanup_blocked_reason,
    // Additional data from summary
    isWaiting: summary?.is_waiting_on_blockers ?? undefined,
    hasPendingApproval: summary?.has_pending_approval,
    hasRunningDevServer: summary?.has_running_dev_server,
    hasUnseenActivity: summary?.has_unseen_turns,
    todoTotal: summary?.todo_total ?? undefined,
    todoCompleted: summary?.todo_completed ?? undefined,
    latestProcessStartedAt: summary?.latest_process_started_at ?? undefined,
    latestProcessCompletedAt: summary?.latest_process_completed_at ?? undefined,
    latestProcessStatus: summary?.latest_process_status ?? undefined,
    prStatus: summary?.pr_status ?? undefined,
    prNumber:
      summary?.pr_number != null ? Number(summary.pr_number) : undefined,
    prUrl: summary?.pr_url ?? undefined,
    pullRequests: summary?.pull_requests?.map((pr) => ({
      ...pr,
      number: Number(pr.number),
    })),
    latestPrompt: summary?.latest_prompt ?? undefined,
    statusNote: ws.status_note ?? undefined,
    statusUpdatedAt: ws.status_updated_at ?? undefined,
    statusHeadline: ws.status_note
      ? statusFirstSentence(ws.status_note)
      : undefined,
    hostId,
  };
  createdAtTimestamps.set(workspace, Date.parse(ws.created_at));
  sidebarWorkspaceCache.set(ws, { summary, workspace });
  return workspace;
}

// Reuse the ordering when a patch changes only status/summary fields. The
// input's insertion order is part of the key to preserve stable timestamp ties.
export function createSidebarWorkspaceList() {
  let previous: SidebarWorkspace[] = [];
  let order: number[] = [];
  return (
    records: Record<string, WorkspaceWithStatus>,
    summaries: ReadonlyMap<string, WorkspaceSummary>,
    hostId: string | null
  ) => {
    const next = Object.values(records).map((ws) =>
      toSidebarWorkspace(ws, summaries.get(ws.id), hostId)
    );
    if (
      next.length !== previous.length ||
      next.some(
        (ws, i) =>
          ws.id !== previous[i].id ||
          ws.isPinned !== previous[i].isPinned ||
          ws.createdAt !== previous[i].createdAt
      )
    ) {
      order = next
        .map((_, i) => i)
        .sort(
          (a, b) =>
            Number(next[b].isPinned) - Number(next[a].isPinned) ||
            createdAtTimestamps.get(next[b])! -
              createdAtTimestamps.get(next[a])!
        );
    }
    previous = next;
    return order.map((i) => next[i]);
  };
}

function toSnapshotSidebarWorkspace(
  ws: WorkspaceRecord,
  summary: WorkspaceSummary | undefined,
  hostId: string | null
): SidebarWorkspace {
  const latestStatus = summary?.latest_process_status?.toLowerCase();
  return toSidebarWorkspace(
    {
      ...ws,
      is_running:
        latestStatus === 'running' && !summary?.is_waiting_on_blockers,
      is_errored: latestStatus === 'failed',
    },
    summary,
    hostId
  );
}

export const workspaceKeys = {
  all: ['workspaces'] as const,
};

// workspaceSummaryKeys is imported from @/shared/hooks/workspaceSummaryKeys

// One list per request: the archive is fetched separately and far less often.
export async function fetchWorkspaceSummaries(
  hostId: string | null,
  {
    archived,
    includeLatestPrompt = true,
  }: { archived: boolean; includeLatestPrompt?: boolean }
): Promise<Map<string, WorkspaceSummary>> {
  try {
    const response = await makeLocalApiRequest('/api/workspaces/summaries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        archived,
        include_latest_prompt: includeLatestPrompt,
      }),
      hostScope: 'explicit',
      hostId,
      relayHostId: hostId,
    });
    if (!response.ok) {
      console.warn('Failed to fetch workspace summaries:', response.status);
      return new Map();
    }

    const data: ApiResponse<WorkspaceSummaryResponse> = await response.json();
    if (!data.success || !data.data?.summaries) {
      return new Map();
    }
    const map = new Map<string, WorkspaceSummary>();
    for (const summary of data.data.summaries) {
      map.set(summary.workspace_id, summary);
    }
    return map;
  } catch (err) {
    console.warn('Error fetching workspace summaries:', err);
    return new Map();
  }
}

export function useWorkspaces(enabled = true): UseWorkspacesResult {
  return useHostWorkspaces(useHostId(), enabled);
}

const ARCHIVED_SUMMARIES_REFRESH_MS = 5 * 60_000;

/**
 * One host's active and archived lists. They are separate streams so the list
 * can render from the small active snapshot; the archive (100x larger on a
 * long-lived host) only opens once the active list has data. No limit param:
 * we fetch all and slice on the frontend so backfill works when archiving.
 */
function useHostWorkspaces(
  hostId: string | null,
  enabled: boolean,
  archiveEnabled = true
): UseWorkspacesResult {
  const apiBasePath = hostId ? `/api/host/${hostId}` : '/api';
  const initialData = useCallback(
    (): WorkspacesState => ({ workspaces: {} }),
    []
  );
  const streamOptions = { keepSnapshotForEndpoint: true, targetHostId: hostId };

  const {
    data: activeData,
    isConnected: activeIsConnected,
    isInitialized: activeIsInitialized,
    error: activeError,
  } = useJsonPatchWsStream<WorkspacesState>(
    `${apiBasePath}/workspaces/streams/ws?archived=false`,
    enabled,
    initialData,
    streamOptions
  );

  const {
    data: archivedData,
    isConnected: archivedIsConnected,
    isInitialized: archivedIsInitialized,
    error: archivedError,
  } = useJsonPatchWsStream<WorkspacesState>(
    `${apiBasePath}/workspaces/streams/ws?archived=true`,
    // `activeData` survives reconnects (cached snapshot), so the archive
    // doesn't drop and re-download when the active stream blips.
    enabled && archiveEnabled && (activeIsInitialized || !!activeData),
    initialData,
    streamOptions
  );

  const { data: activeSummaries = EMPTY_WORKSPACE_SUMMARIES } = useQuery({
    queryKey: workspaceSummaryKeys.byHost(hostId),
    queryFn: () => fetchWorkspaceSummaries(hostId, { archived: false }),
    enabled: enabled && activeIsInitialized,
    staleTime: 1000,
    refetchInterval: 15_000,
    refetchOnWindowFocus: false,
    refetchOnMount: 'always',
    placeholderData: keepPreviousData,
  });

  // Archived rows rarely change: fetch when the archive attaches, when a row is
  // archived into it or its process state changes, and on a slow interval. No
  // archived row shows its latest prompt, which is most of this response's
  // weight.
  const {
    data: archivedSummaries = EMPTY_WORKSPACE_SUMMARIES,
    refetch: refetchArchivedSummaries,
  } = useQuery({
    queryKey: workspaceSummaryKeys.archivedByHost(hostId),
    queryFn: () =>
      fetchWorkspaceSummaries(hostId, {
        archived: true,
        includeLatestPrompt: false,
      }),
    enabled: enabled && archivedIsInitialized,
    staleTime: ARCHIVED_SUMMARIES_REFRESH_MS,
    refetchInterval: ARCHIVED_SUMMARIES_REFRESH_MS,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  });

  // Compared by value, so a reconnect replaying the same rows refetches nothing.
  const seenArchivedRows = useRef<{
    hostId: string | null;
    rows: ReadonlyMap<string, string>;
  } | null>(null);
  useEffect(() => {
    if (!archivedIsInitialized) return;
    const rows = new Map(
      Object.values(archivedData?.workspaces ?? {}).map((ws) => [
        ws.id,
        `${ws.is_running}:${ws.is_errored}`,
      ])
    );
    const seen = seenArchivedRows.current;
    seenArchivedRows.current = { hostId, rows };
    if (
      seen?.hostId === hostId &&
      [...rows].some(([id, state]) => seen.rows.get(id) !== state)
    ) {
      void refetchArchivedSummaries();
    }
  }, [archivedData, archivedIsInitialized, hostId, refetchArchivedSummaries]);

  const [selectActive] = useState(createSidebarWorkspaceList);
  const [selectArchived] = useState(createSidebarWorkspaceList);
  const workspaces = useMemo(
    () => selectActive(activeData?.workspaces ?? {}, activeSummaries, hostId),
    [activeData, activeSummaries, hostId, selectActive]
  );

  const archivedWorkspaces = useMemo(
    () =>
      selectArchived(archivedData?.workspaces ?? {}, archivedSummaries, hostId),
    [archivedData, archivedSummaries, hostId, selectArchived]
  );

  const workspaceRecordsById = useMemo(() => {
    const byId: Record<string, WorkspaceWithStatus> = {};
    for (const ws of Object.values(archivedData?.workspaces ?? {})) {
      byId[getHostWorkspaceKey(ws.id, hostId)] = ws;
    }
    for (const ws of Object.values(activeData?.workspaces ?? {})) {
      byId[getHostWorkspaceKey(ws.id, hostId)] = ws;
    }
    return byId;
  }, [activeData, archivedData, hostId]);

  // Loading means nothing to show for a stream yet — neither its initial
  // replay nor a cached snapshot from a previous connection.
  const isLoading = enabled && !activeIsInitialized && !activeData;
  const isArchivedLoading = enabled && !archivedIsInitialized && !archivedData;
  const isConnected = activeIsConnected && archivedIsConnected;
  const error = activeError || archivedError;

  // Stable identity: the remote provider publishes this object to state.
  return useMemo(
    () => ({
      workspaces,
      archivedWorkspaces,
      workspaceRecordsById,
      isLoading,
      isArchivedLoading,
      isConnected,
      error,
    }),
    [
      workspaces,
      archivedWorkspaces,
      workspaceRecordsById,
      isLoading,
      isArchivedLoading,
      isConnected,
      error,
    ]
  );
}

type RemoteHostWorkspaceStream = UseWorkspacesResult;

const combinedStreamCache = new WeakMap<
  ReadonlyMap<string, RemoteHostWorkspaceStream>,
  {
    key: string;
    results: RemoteHostWorkspaceStream[];
    result: UseWorkspacesResult;
  }
>();

export function combineRemoteWorkspaceStreams(
  streams: ReadonlyMap<string, RemoteHostWorkspaceStream>,
  onlineHostIds: readonly string[]
): UseWorkspacesResult {
  const results = onlineHostIds.flatMap((hostId) => {
    const result = streams.get(hostId);
    return result ? [result] : [];
  });
  const key = JSON.stringify(onlineHostIds);
  const cached = combinedStreamCache.get(streams);
  if (
    cached?.key === key &&
    cached.results.length === results.length &&
    results.every((result, i) => result === cached.results[i])
  ) {
    return cached.result;
  }
  const workspaceRecordsById = Object.assign(
    {},
    ...results.map((result) => result.workspaceRecordsById)
  );

  const result = {
    workspaces: results.flatMap((result) => result.workspaces),
    archivedWorkspaces: results.flatMap((result) => result.archivedWorkspaces),
    workspaceRecordsById,
    isLoading:
      onlineHostIds.length > 0 &&
      (results.length < onlineHostIds.length ||
        results.some((result) => result.isLoading)),
    isArchivedLoading:
      onlineHostIds.length > 0 &&
      (results.length < onlineHostIds.length ||
        results.some((result) => result.isArchivedLoading)),
    isConnected:
      results.length > 0 && results.every((result) => result.isConnected),
    error: results.find((result) => result.error)?.error ?? null,
  };
  combinedStreamCache.set(streams, { key, results, result });
  return result;
}

const RemoteWorkspaceStreamsContext = createContext<
  ReadonlyMap<string, RemoteHostWorkspaceStream> | undefined
>(undefined);

function RemoteHostWorkspaceStreamSource({
  hostId,
  archiveEnabled,
  onUpdate,
  onRemove,
}: {
  hostId: string;
  archiveEnabled: boolean;
  onUpdate: (hostId: string, result: RemoteHostWorkspaceStream) => void;
  onRemove: (hostId: string) => void;
}) {
  const result = useHostWorkspaces(hostId, true, archiveEnabled);

  useEffect(() => {
    onUpdate(hostId, result);
  }, [hostId, onUpdate, result]);

  useEffect(
    () => () => {
      onRemove(hostId);
    },
    [hostId, onRemove]
  );

  return null;
}

export function resolveOnlineWorkspaceStreamHostIds(
  hosts: ReadonlyArray<{ id: string; status: string }>,
  enabled: boolean
): string[] {
  return enabled
    ? hosts.filter((host) => host.status === 'online').map((host) => host.id)
    : [];
}

function useOnlineWorkspaceStreamHostIds(
  hosts: ReadonlyArray<{ id: string; status: string }>,
  enabled: boolean
): string[] {
  // Names and freshly allocated host objects do not change stream membership.
  const key = JSON.stringify(
    resolveOnlineWorkspaceStreamHostIds(hosts, enabled)
  );
  return useMemo(() => JSON.parse(key) as string[], [key]);
}

export function UnifiedWorkspaceStreamsProvider({
  children,
  enabled = true,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  const runtime = useAppRuntime();
  const { hosts } = useWorkspaceHostOptions();
  const onlineHostIds = useOnlineWorkspaceStreamHostIds(hosts, enabled);
  const [streams, setStreams] = useState<
    Map<string, RemoteHostWorkspaceStream>
  >(() => new Map());

  const handleUpdate = useCallback(
    (hostId: string, result: RemoteHostWorkspaceStream) => {
      setStreams((current) => {
        if (current.get(hostId) === result) return current;
        const next = new Map(current);
        next.set(hostId, result);
        return next;
      });
    },
    []
  );
  const handleRemove = useCallback((hostId: string) => {
    setStreams((current) => {
      if (!current.has(hostId)) return current;
      const next = new Map(current);
      next.delete(hostId);
      return next;
    });
  }, []);

  // Archives wait for every online host's active list so they never compete
  // with the first paint. Once open they stay open; a host that comes online
  // later still waits for its own active list.
  const [archivesOpen, setArchivesOpen] = useState(false);
  const activeListsReady =
    onlineHostIds.length > 0 &&
    onlineHostIds.every((hostId) => streams.get(hostId)?.isLoading === false);
  useEffect(() => {
    if (activeListsReady) setArchivesOpen(true);
  }, [activeListsReady]);

  if (runtime !== 'remote') {
    return children;
  }

  return createElement(
    RemoteWorkspaceStreamsContext.Provider,
    { value: streams },
    ...onlineHostIds.map((hostId) =>
      createElement(RemoteHostWorkspaceStreamSource, {
        key: hostId,
        hostId,
        archiveEnabled: archivesOpen,
        onUpdate: handleUpdate,
        onRemove: handleRemove,
      })
    ),
    children
  );
}

/**
 * Host ids to hydrate as lightweight snapshots alongside the route host's live
 * `current` stream. The route host is excluded because it already owns
 * `current`. When the route points at a remote host, the local machine
 * (`null`) is added so its workspaces stay visible in the unified "All hosts"
 * list instead of vanishing behind the remote host's stream.
 */
export function resolveSnapshotHostIds(
  onlineRemoteHostIds: readonly string[],
  currentHostId: string | null
): (string | null)[] {
  const ids: (string | null)[] = onlineRemoteHostIds.filter(
    (hostId) => hostId !== currentHostId
  );
  if (currentHostId !== null) {
    ids.push(null);
  }
  return ids;
}

const unifiedSnapshotKey = (
  hostId: string | null,
  list: 'active' | 'archived'
) => ['unified-workspaces', hostId, list] as const;

async function fetchHostWorkspaceSnapshot(
  hostId: string | null,
  archived: boolean
): Promise<SidebarWorkspace[]> {
  const [records, summaries] = await Promise.all([
    workspacesApi.getAllWorkspaces(hostId, archived),
    fetchWorkspaceSummaries(hostId, { archived, includeLatestPrompt: false }),
  ]);
  return records.map((workspace) =>
    toSnapshotSidebarWorkspace(workspace, summaries.get(workspace.id), hostId)
  );
}

export async function fetchActiveHostWorkspaceSnapshot(
  queryClient: QueryClient,
  hostId: string | null
): Promise<SidebarWorkspace[]> {
  const previous = queryClient.getQueryData<SidebarWorkspace[]>(
    unifiedSnapshotKey(hostId, 'active')
  );
  const next = await fetchHostWorkspaceSnapshot(hostId, false);
  // (Un)archiving elsewhere moves ids in or out of the active set; that is
  // the cue to refresh the slow archived snapshot.
  const previousIds = new Set(previous?.map((workspace) => workspace.id));
  if (
    previous &&
    (previous.length !== next.length ||
      next.some((workspace) => !previousIds.has(workspace.id)))
  ) {
    void queryClient.invalidateQueries({
      queryKey: unifiedSnapshotKey(hostId, 'archived'),
    });
  }
  return next;
}

function combineHostWorkspaceSnapshots(
  queries: { data: SidebarWorkspace[] | undefined }[]
) {
  return {
    loaded: queries.map((query) => query.data !== undefined),
    workspaces: queries.flatMap((query) => query.data ?? []),
  };
}

/**
 * Unified local + remote workspace list. The route's current host keeps its
 * live WebSocket stream; other online hosts are refreshed as lightweight
 * snapshots. Both local and remote web consume this hook through the shared
 * WorkspaceProvider, including their mobile workspace lists.
 */
export function useUnifiedWorkspaces(enabled = true): UseWorkspacesResult {
  const runtime = useAppRuntime();
  const remoteStreams = useContext(RemoteWorkspaceStreamsContext);
  const {
    workspaces,
    archivedWorkspaces,
    workspaceRecordsById,
    isLoading,
    isArchivedLoading,
    isConnected,
    error,
  } = useWorkspaces(enabled && runtime !== 'remote');
  const currentHostId = useHostId();
  const { hosts } = useWorkspaceHostOptions();
  const onlineHostIds = useOnlineWorkspaceStreamHostIds(hosts, enabled);
  const snapshotHostIds = useMemo<(string | null)[]>(() => {
    if (!enabled || runtime !== 'local') return [];
    return resolveSnapshotHostIds(onlineHostIds, currentHostId);
  }, [enabled, onlineHostIds, currentHostId, runtime]);
  const queryClient = useQueryClient();
  // Same order as the live streams: a host's archive snapshot waits for its
  // active one, then refreshes slowly.
  const activeSnapshots = useQueries({
    queries: snapshotHostIds.map((hostId) => ({
      queryKey: unifiedSnapshotKey(hostId, 'active'),
      queryFn: () => fetchActiveHostWorkspaceSnapshot(queryClient, hostId),
      staleTime: 15_000,
      refetchInterval: 15_000,
    })),
    combine: combineHostWorkspaceSnapshots,
  });
  const archivedSnapshots = useQueries({
    queries: snapshotHostIds.map((hostId, i) => ({
      queryKey: unifiedSnapshotKey(hostId, 'archived'),
      queryFn: () => fetchHostWorkspaceSnapshot(hostId, true),
      enabled: activeSnapshots.loaded[i],
      staleTime: ARCHIVED_SUMMARIES_REFRESH_MS,
      refetchInterval: ARCHIVED_SUMMARIES_REFRESH_MS,
    })),
    combine: combineHostWorkspaceSnapshots,
  });

  return useMemo(() => {
    if (!enabled) return EMPTY_UNIFIED_WORKSPACES;

    if (runtime === 'remote') {
      return combineRemoteWorkspaceStreams(
        remoteStreams ?? new Map(),
        onlineHostIds
      );
    }

    return {
      workspaces: [...workspaces, ...activeSnapshots.workspaces],
      archivedWorkspaces: [
        ...archivedWorkspaces,
        ...archivedSnapshots.workspaces,
      ],
      workspaceRecordsById,
      isLoading,
      isArchivedLoading,
      isConnected,
      error,
    };
  }, [
    workspaces,
    archivedWorkspaces,
    workspaceRecordsById,
    isLoading,
    isArchivedLoading,
    isConnected,
    error,
    enabled,
    activeSnapshots,
    archivedSnapshots,
    runtime,
    remoteStreams,
    onlineHostIds,
  ]);
}
