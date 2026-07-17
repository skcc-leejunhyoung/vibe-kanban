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

// State shape from the WebSocket stream
type WorkspacesState = {
  workspaces: Record<string, WorkspaceWithStatus>;
};

// Transform WorkspaceWithStatus to SidebarWorkspace, optionally merging summary data
function toSidebarWorkspace(
  ws: WorkspaceWithStatus,
  summary?: WorkspaceSummary,
  hostId: string | null = null
): SidebarWorkspace {
  return {
    id: ws.id,
    name: ws.name ?? ws.branch, // Use name if available, fallback to branch
    branch: ws.branch,
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
    latestPrompt: summary?.latest_prompt ?? undefined,
    hostId,
  };
}

function toSnapshotSidebarWorkspace(
  ws: WorkspaceRecord,
  summary: WorkspaceSummary | undefined,
  hostId: string
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

// Fetch workspace summaries from the API by archived status
export async function fetchWorkspaceSummariesByArchived(
  archived: boolean,
  hostId: string | null,
  includeLatestPrompt = true
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

  // Wait for both streams to be initialized before fetching summaries
  // Fetch summaries for active workspaces
  const { data: activeSummaries = EMPTY_WORKSPACE_SUMMARIES } = useQuery({
    queryKey: workspaceSummaryKeys.byArchived(false, hostId),
    queryFn: () => fetchWorkspaceSummariesByArchived(false, hostId),
    enabled: enabled && activeIsInitialized,
    staleTime: 1000,
    refetchInterval: 15000,
    refetchOnWindowFocus: false,
    refetchOnMount: 'always',
    placeholderData: keepPreviousData,
  });

  // Fetch summaries for archived workspaces
  const { data: archivedSummaries = EMPTY_WORKSPACE_SUMMARIES } = useQuery({
    queryKey: workspaceSummaryKeys.byArchived(true, hostId),
    queryFn: () => fetchWorkspaceSummariesByArchived(true, hostId),
    enabled: enabled && archivedIsInitialized,
    staleTime: 1000,
    refetchInterval: 15000,
    refetchOnWindowFocus: false,
    refetchOnMount: 'always',
    placeholderData: keepPreviousData,
  });

  const workspaces = useMemo(() => {
    if (!activeData?.workspaces) return [];
    return Object.values(activeData.workspaces)
      .sort((a, b) => {
        // First sort by pinned (pinned first)
        if (a.pinned !== b.pinned) {
          return a.pinned ? -1 : 1;
        }
        // Then by created_at (newest first)
        return (
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
      })
      .map((ws) => toSidebarWorkspace(ws, activeSummaries.get(ws.id), hostId));
  }, [activeData, activeSummaries, hostId]);

  const archivedWorkspaces = useMemo(() => {
    if (!archivedData?.workspaces) return [];
    return Object.values(archivedData.workspaces)
      .sort((a, b) => {
        // First sort by pinned (pinned first)
        if (a.pinned !== b.pinned) {
          return a.pinned ? -1 : 1;
        }
        // Then by created_at (newest first)
        return (
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
      })
      .map((ws) =>
        toSidebarWorkspace(ws, archivedSummaries.get(ws.id), hostId)
      );
  }, [archivedData, archivedSummaries, hostId]);

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
  hostId: string
): Pick<
  UseWorkspacesResult,
  'workspaces' | 'archivedWorkspaces' | 'workspaceRecordsById'
> {
  const records = Object.values(recordsById).sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
  const workspaces: SidebarWorkspace[] = [];
  const archivedWorkspaces: SidebarWorkspace[] = [];
  const workspaceRecordsById: Record<string, WorkspaceWithStatus> = {};

  for (const workspace of records) {
    workspaceRecordsById[getHostWorkspaceKey(workspace.id, hostId)] = workspace;
    const summaries = workspace.archived ? archivedSummaries : activeSummaries;
    const item = toSidebarWorkspace(
      workspace,
      summaries.get(workspace.id),
      hostId
    );
    (workspace.archived ? archivedWorkspaces : workspaces).push(item);
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
    queryKey: workspaceSummaryKeys.byArchived(false, hostId),
    queryFn: () => fetchWorkspaceSummariesByArchived(false, hostId),
    enabled: isInitialized,
    staleTime: 1000,
    refetchInterval: 15_000,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  });
  const { data: archivedSummaries = EMPTY_WORKSPACE_SUMMARIES } = useQuery({
    queryKey: workspaceSummaryKeys.byArchived(true, hostId),
    queryFn: () => fetchWorkspaceSummariesByArchived(true, hostId),
    enabled: isInitialized,
    staleTime: 1000,
    refetchInterval: 15_000,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  });

  return useMemo(() => {
    const materialized = materializeHostWorkspaceStream(
      data?.workspaces ?? {},
      activeSummaries,
      archivedSummaries,
      hostId
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

export function UnifiedWorkspaceStreamsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const runtime = useAppRuntime();
  const { hosts } = useWorkspaceHostOptions();
  const onlineHostIds = useMemo(
    () =>
      hosts.filter((host) => host.status === 'online').map((host) => host.id),
    [hosts]
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

async function fetchHostWorkspaceSnapshot(
  hostId: string
): Promise<HostWorkspaceSnapshot> {
  const [records, activeSummaries, archivedSummaries] = await Promise.all([
    workspacesApi.getAllWorkspaces(hostId),
    fetchWorkspaceSummariesByArchived(false, hostId, false),
    fetchWorkspaceSummariesByArchived(true, hostId, false),
  ]);

  const active: SidebarWorkspace[] = [];
  const archived: SidebarWorkspace[] = [];
  for (const workspace of records) {
    const summaries = workspace.archived ? archivedSummaries : activeSummaries;
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
export function useUnifiedWorkspaces(): UseWorkspacesResult {
  const runtime = useAppRuntime();
  const remoteStreams = useContext(RemoteWorkspaceStreamsContext);
  const current = useWorkspaces(runtime !== 'remote');
  const currentHostId = useHostId();
  const { hosts } = useWorkspaceHostOptions();
  const otherOnlineHosts = useMemo(
    () =>
      runtime === 'local'
        ? hosts.filter(
            (host) => host.status === 'online' && host.id !== currentHostId
          )
        : [],
    [hosts, currentHostId, runtime]
  );
  const snapshots = useQueries({
    queries: otherOnlineHosts.map((host) => ({
      queryKey: ['unified-workspaces', host.id],
      queryFn: () => fetchHostWorkspaceSnapshot(host.id),
      staleTime: 15_000,
      refetchInterval: 15_000,
    })),
  });

  return useMemo(() => {
    if (runtime === 'remote') {
      return combineRemoteWorkspaceStreams(
        remoteStreams ?? new Map(),
        hosts.filter((host) => host.status === 'online').map((host) => host.id)
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
  }, [current, snapshots, runtime, remoteStreams, hosts]);
}
