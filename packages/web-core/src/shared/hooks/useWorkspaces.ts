import { useCallback, useMemo } from 'react';
import { useQuery, useQueries, keepPreviousData } from '@tanstack/react-query';
import { useJsonPatchWsStream } from '@/shared/hooks/useJsonPatchWsStream';
import { workspaceSummaryKeys } from '@/shared/hooks/workspaceSummaryKeys';
import { makeLocalApiRequest } from '@/shared/lib/localApiTransport';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { useWorkspaceHostOptions } from '@/shared/hooks/useWorkspaceHostOptions';
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
  hostId: string | null
): Promise<Map<string, WorkspaceSummary>> {
  try {
    const basePath = hostId ? `/api/host/${hostId}` : '/api';
    const response = await makeLocalApiRequest(
      `${basePath}/workspaces/summaries`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived }),
      }
    );

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

export function useWorkspaces(): UseWorkspacesResult {
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
  } = useJsonPatchWsStream<WorkspacesState>(activeEndpoint, true, initialData, {
    keepSnapshotForEndpoint: true,
  });

  const {
    data: archivedData,
    isConnected: archivedIsConnected,
    isInitialized: archivedIsInitialized,
    error: archivedError,
  } = useJsonPatchWsStream<WorkspacesState>(
    archivedEndpoint,
    true,
    initialData,
    { keepSnapshotForEndpoint: true }
  );

  // Wait for both streams to be initialized before fetching summaries
  // Fetch summaries for active workspaces
  const { data: activeSummaries = new Map<string, WorkspaceSummary>() } =
    useQuery({
      queryKey: workspaceSummaryKeys.byArchived(false, hostId),
      queryFn: () => fetchWorkspaceSummariesByArchived(false, hostId),
      enabled: activeIsInitialized,
      staleTime: 1000,
      refetchInterval: 15000,
      refetchOnWindowFocus: false,
      refetchOnMount: 'always',
      placeholderData: keepPreviousData,
    });

  // Fetch summaries for archived workspaces
  const { data: archivedSummaries = new Map<string, WorkspaceSummary>() } =
    useQuery({
      queryKey: workspaceSummaryKeys.byArchived(true, hostId),
      queryFn: () => fetchWorkspaceSummariesByArchived(true, hostId),
      enabled: archivedIsInitialized,
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
      byId[ws.id] = ws;
    }
    for (const ws of Object.values(activeData?.workspaces ?? {})) {
      byId[ws.id] = ws;
    }
    return byId;
  }, [activeData, archivedData]);

  // isLoading is true when we have nothing to show for a stream yet — neither
  // its initial replay nor a cached snapshot from a previous connection.
  const isLoading =
    (!activeIsInitialized && !activeData) ||
    (!archivedIsInitialized && !archivedData);

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

async function fetchHostWorkspaceSnapshot(
  hostId: string
): Promise<HostWorkspaceSnapshot> {
  const [records, activeSummaries, archivedSummaries] = await Promise.all([
    workspacesApi.getAllWorkspaces(hostId),
    fetchWorkspaceSummariesByArchived(false, hostId),
    fetchWorkspaceSummariesByArchived(true, hostId),
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
  const current = useWorkspaces();
  const currentHostId = useHostId();
  const { hosts } = useWorkspaceHostOptions();
  const otherOnlineHosts = useMemo(
    () =>
      hosts.filter(
        (host) => host.status === 'online' && host.id !== currentHostId
      ),
    [hosts, currentHostId]
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
    const remoteActive = snapshots.flatMap((query) => query.data?.active ?? []);
    const remoteArchived = snapshots.flatMap(
      (query) => query.data?.archived ?? []
    );
    return {
      ...current,
      workspaces: [...current.workspaces, ...remoteActive],
      archivedWorkspaces: [...current.archivedWorkspaces, ...remoteArchived],
    };
  }, [current, snapshots]);
}
