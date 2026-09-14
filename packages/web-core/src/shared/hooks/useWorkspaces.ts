import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useQuery, useQueries, keepPreviousData } from '@tanstack/react-query';
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
  isLoading: boolean;
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

// Fetch active and archived summaries together; consumers still look up by id.
export async function fetchWorkspaceSummaries(
  hostId: string | null,
  includeLatestPrompt = true
): Promise<Map<string, WorkspaceSummary>> {
  try {
    const response = await makeLocalApiRequest('/api/workspaces/summaries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        archived: null,
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
  const hostId = useHostId();

  // Two separate WebSocket connections: one for active, one for archived
  // No limit param - we fetch all and slice on frontend so backfill works when archiving
  const apiBasePath = hostId ? `/api/host/${hostId}` : '/api';
  const activeEndpoint = `${apiBasePath}/workspaces/streams/ws?archived=false`;
  const archivedEndpoint = `${apiBasePath}/workspaces/streams/ws?archived=true`;

  const initialData = useCallback(
    (): WorkspacesState => ({ workspaces: {} }),
    []
  );

  const {
    data: activeData,
    isConnected: activeIsConnected,
    isInitialized: activeIsInitialized,
    error: activeError,
  } = useJsonPatchWsStream<WorkspacesState>(
    activeEndpoint,
    enabled,
    initialData,
    {
      keepSnapshotForEndpoint: true,
    }
  );

  const {
    data: archivedData,
    isConnected: archivedIsConnected,
    isInitialized: archivedIsInitialized,
    error: archivedError,
  } = useJsonPatchWsStream<WorkspacesState>(
    archivedEndpoint,
    enabled,
    initialData,
    { keepSnapshotForEndpoint: true }
  );

  // Either stream can start the shared summary poll.
  const { data: activeSummaries = EMPTY_WORKSPACE_SUMMARIES } = useQuery({
    queryKey: workspaceSummaryKeys.byHost(hostId),
    queryFn: () => fetchWorkspaceSummaries(hostId),
    enabled: enabled && (activeIsInitialized || archivedIsInitialized),
    staleTime: 1000,
    refetchInterval: 15000,
    refetchOnWindowFocus: false,
    refetchOnMount: 'always',
    placeholderData: keepPreviousData,
  });

  const archivedSummaries = activeSummaries;

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

  // isLoading is true when we have nothing to show for a stream yet — neither
  // its initial replay nor a cached snapshot from a previous connection.
  const isLoading =
    enabled &&
    ((!activeIsInitialized && !activeData) ||
      (!archivedIsInitialized && !archivedData));

  // Combined connection status
  const isConnected = activeIsConnected && archivedIsConnected;

  // Combined error (show first error if any)
  const error = activeError || archivedError;

  return {
    workspaces,
    archivedWorkspaces,
    workspaceRecordsById,
    isLoading,
    isConnected,
    error,
  };
}

type HostWorkspaceSnapshot = {
  active: SidebarWorkspace[];
  archived: SidebarWorkspace[];
};

type RemoteHostWorkspaceStream = UseWorkspacesResult;

export function materializeHostWorkspaceStream(
  recordsById: Record<string, WorkspaceWithStatus>,
  activeSummaries: ReadonlyMap<string, WorkspaceSummary>,
  archivedSummaries: ReadonlyMap<string, WorkspaceSummary>,
  hostId: string,
  selectWorkspaces = createSidebarWorkspaceList()
): Pick<
  UseWorkspacesResult,
  'workspaces' | 'archivedWorkspaces' | 'workspaceRecordsById'
> {
  const summaries = new Map<string, WorkspaceSummary>();
  // Active and archived streams can briefly contain the same id during an
  // archive transition; select the summary using the authoritative raw row.
  for (const workspace of Object.values(recordsById)) {
    const summary = (
      workspace.archived ? archivedSummaries : activeSummaries
    ).get(workspace.id);
    if (summary) summaries.set(workspace.id, summary);
  }
  const records = selectWorkspaces(recordsById, summaries, hostId);
  const workspaces: SidebarWorkspace[] = [];
  const archivedWorkspaces: SidebarWorkspace[] = [];
  const workspaceRecordsById: Record<string, WorkspaceWithStatus> = {};

  for (const workspace of records) {
    workspaceRecordsById[getHostWorkspaceKey(workspace.id, hostId)] =
      recordsById[workspace.id];
    (workspace.isArchived ? archivedWorkspaces : workspaces).push(workspace);
  }

  return { workspaces, archivedWorkspaces, workspaceRecordsById };
}

export function combineRemoteWorkspaceStreams(
  streams: ReadonlyMap<string, RemoteHostWorkspaceStream>,
  onlineHostIds: readonly string[]
): UseWorkspacesResult {
  const results = onlineHostIds.flatMap((hostId) => {
    const result = streams.get(hostId);
    return result ? [result] : [];
  });
  const workspaceRecordsById = Object.assign(
    {},
    ...results.map((result) => result.workspaceRecordsById)
  );

  return {
    workspaces: results.flatMap((result) => result.workspaces),
    archivedWorkspaces: results.flatMap((result) => result.archivedWorkspaces),
    workspaceRecordsById,
    isLoading:
      onlineHostIds.length > 0 &&
      (results.length < onlineHostIds.length ||
        results.some((result) => result.isLoading)),
    isConnected:
      results.length > 0 && results.every((result) => result.isConnected),
    error: results.find((result) => result.error)?.error ?? null,
  };
}

const RemoteWorkspaceStreamsContext = createContext<
  ReadonlyMap<string, RemoteHostWorkspaceStream> | undefined
>(undefined);

function useRemoteHostWorkspaceStream(
  hostId: string
): RemoteHostWorkspaceStream {
  const [selectWorkspaces] = useState(createSidebarWorkspaceList);
  const endpoint = `/api/host/${hostId}/workspaces/streams/ws`;
  const initialData = useCallback(
    (): WorkspacesState => ({ workspaces: {} }),
    []
  );
  const { data, isConnected, isInitialized, error } =
    useJsonPatchWsStream<WorkspacesState>(endpoint, true, initialData, {
      keepSnapshotForEndpoint: true,
      targetHostId: hostId,
    });

  const { data: activeSummaries = EMPTY_WORKSPACE_SUMMARIES } = useQuery({
    queryKey: workspaceSummaryKeys.byHost(hostId),
    queryFn: () => fetchWorkspaceSummaries(hostId),
    enabled: isInitialized,
    staleTime: 1000,
    refetchInterval: 15_000,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  });
  const archivedSummaries = activeSummaries;

  return useMemo(() => {
    const materialized = materializeHostWorkspaceStream(
      data?.workspaces ?? {},
      activeSummaries,
      archivedSummaries,
      hostId,
      selectWorkspaces
    );

    return {
      ...materialized,
      isLoading: !isInitialized && !data,
      isConnected,
      error,
    };
  }, [
    data,
    activeSummaries,
    archivedSummaries,
    hostId,
    selectWorkspaces,
    isInitialized,
    isConnected,
    error,
  ]);
}

function RemoteHostWorkspaceStreamSource({
  hostId,
  onUpdate,
  onRemove,
}: {
  hostId: string;
  onUpdate: (hostId: string, result: RemoteHostWorkspaceStream) => void;
  onRemove: (hostId: string) => void;
}) {
  const result = useRemoteHostWorkspaceStream(hostId);

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

export function UnifiedWorkspaceStreamsProvider({
  children,
  enabled = true,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  const runtime = useAppRuntime();
  const { hosts } = useWorkspaceHostOptions();
  const onlineHostIds = useMemo(
    () => resolveOnlineWorkspaceStreamHostIds(hosts, enabled),
    [enabled, hosts]
  );
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

async function fetchHostWorkspaceSnapshot(
  hostId: string | null
): Promise<HostWorkspaceSnapshot> {
  const [records, summaries] = await Promise.all([
    workspacesApi.getAllWorkspaces(hostId),
    fetchWorkspaceSummaries(hostId, false),
  ]);

  const active: SidebarWorkspace[] = [];
  const archived: SidebarWorkspace[] = [];
  for (const workspace of records) {
    const item = toSnapshotSidebarWorkspace(
      workspace,
      summaries.get(workspace.id),
      hostId
    );
    (workspace.archived ? archived : active).push(item);
  }
  return { active, archived };
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
  const current = useWorkspaces(enabled && runtime !== 'remote');
  const currentHostId = useHostId();
  const { hosts } = useWorkspaceHostOptions();
  const snapshotHostIds = useMemo<(string | null)[]>(() => {
    if (!enabled || runtime !== 'local') return [];
    const onlineRemoteHostIds = hosts
      .filter((host) => host.status === 'online')
      .map((host) => host.id);
    return resolveSnapshotHostIds(onlineRemoteHostIds, currentHostId);
  }, [enabled, hosts, currentHostId, runtime]);
  const snapshots = useQueries({
    queries: snapshotHostIds.map((hostId) => ({
      queryKey: ['unified-workspaces', hostId],
      queryFn: () => fetchHostWorkspaceSnapshot(hostId),
      staleTime: 15_000,
      refetchInterval: 15_000,
    })),
  });

  return useMemo(() => {
    if (!enabled) return EMPTY_UNIFIED_WORKSPACES;

    if (runtime === 'remote') {
      return combineRemoteWorkspaceStreams(
        remoteStreams ?? new Map(),
        resolveOnlineWorkspaceStreamHostIds(hosts, true)
      );
    }

    const remoteActive = snapshots.flatMap((query) => query.data?.active ?? []);
    const remoteArchived = snapshots.flatMap(
      (query) => query.data?.archived ?? []
    );
    return {
      ...current,
      workspaces: [...current.workspaces, ...remoteActive],
      archivedWorkspaces: [...current.archivedWorkspaces, ...remoteArchived],
    };
  }, [current, enabled, snapshots, runtime, remoteStreams, hosts]);
}
