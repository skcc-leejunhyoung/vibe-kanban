import { useContext, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { workspacesApi } from '@/shared/lib/api';
import type { ExecutionProcess } from 'shared/types';
import { devServerStreamSignature } from '@/shared/lib/devServerUtils';
import { getHostRequestScopeQueryKey } from '@/shared/lib/hostRequestScope';
import { ExecutionProcessesContext } from '@/shared/hooks/useExecutionProcessesContext';
import { useHostId } from '@/shared/providers/HostIdProvider';

const EMPTY: ExecutionProcess[] = [];

/**
 * Backup reconcile only. Status changes for the session in view arrive on the
 * execution-process stream; this catches a dev server started (or died) under
 * a different session of the same workspace, which that stream never sees.
 */
const DEV_SERVER_BACKUP_POLL_MS = 30_000;

export const workspaceDevServerKeys = {
  byWorkspace: (
    workspaceId: string | undefined,
    hostId: string | null = null
  ) =>
    [
      'workspaceDevServers',
      workspaceId,
      getHostRequestScopeQueryKey(hostId),
    ] as const,
};

/**
 * Dev server processes for a workspace across all of its sessions.
 *
 * Dev servers are conceptually workspace-scoped (the backend starts/stops them
 * per workspace), so the preview must keep showing the running dev server even
 * when the user switches between sessions within the same workspace. The
 * per-session execution-process stream cannot satisfy that on its own, so the
 * workspace-level endpoint stays the source of truth — but it is refetched off
 * that stream's dev-server transitions instead of polled every 2.5s.
 */
export function useWorkspaceDevServers(
  workspaceId: string | undefined
): ExecutionProcess[] {
  const hostId = useHostId();
  const { data, refetch } = useQuery({
    queryKey: workspaceDevServerKeys.byWorkspace(workspaceId, hostId),
    queryFn: () => workspacesApi.getDevServers(workspaceId as string, hostId),
    enabled: !!workspaceId,
    refetchInterval: DEV_SERVER_BACKUP_POLL_MS,
  });

  // Not the throwing accessor: the preview panes mount inside the provider,
  // but this hook must stay usable without one (then only the backup poll runs).
  const executionProcesses = useContext(
    ExecutionProcessesContext
  )?.executionProcessesAll;
  const signature = devServerStreamSignature(executionProcesses);
  const lastSeenRef = useRef({ workspaceId, signature });
  useEffect(() => {
    const previous = lastSeenRef.current;
    lastSeenRef.current = { workspaceId, signature };
    // A workspace switch already refetches through the new query key.
    if (previous.workspaceId !== workspaceId) return;
    if (!workspaceId || previous.signature === signature) return;
    void refetch();
  }, [signature, workspaceId, refetch]);

  return data ?? EMPTY;
}
