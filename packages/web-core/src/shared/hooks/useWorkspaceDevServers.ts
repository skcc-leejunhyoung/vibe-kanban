import { useQuery } from '@tanstack/react-query';
import { workspacesApi } from '@/shared/lib/api';
import type { ExecutionProcess } from 'shared/types';

const EMPTY: ExecutionProcess[] = [];

/**
 * Dev server processes for a workspace across all of its sessions.
 *
 * Dev servers are conceptually workspace-scoped (the backend starts/stops them
 * per workspace), so the preview must keep showing the running dev server even
 * when the user switches between sessions within the same workspace. The
 * per-session execution-process stream cannot satisfy this, so we query the
 * workspace-level endpoint and poll for status changes.
 */
export function useWorkspaceDevServers(
  workspaceId: string | undefined
): ExecutionProcess[] {
  const { data } = useQuery({
    queryKey: ['workspaceDevServers', workspaceId],
    queryFn: () => workspacesApi.getDevServers(workspaceId as string),
    enabled: !!workspaceId,
    refetchInterval: 2500,
  });

  return data ?? EMPTY;
}
