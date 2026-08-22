import { useQuery } from '@tanstack/react-query';
import { workspacesApi } from '@/shared/lib/api';
import type { WorkspaceWithSession } from '@/shared/types/attempt';
import { useHostId } from '@/shared/providers/HostIdProvider';

export function useWorkspace(workspaceId?: string) {
  const hostId = useHostId();
  return useQuery({
    queryKey: ['workspace', hostId, workspaceId],
    queryFn: () => workspacesApi.get(workspaceId!, hostId),
    enabled: !!workspaceId,
  });
}

/**
 * Hook for components that need executor field (e.g., for capability checks).
 * Fetches workspace with executor from latest session.
 */
export function useWorkspaceWithSession(workspaceId?: string) {
  const hostId = useHostId();
  return useQuery<WorkspaceWithSession>({
    queryKey: ['workspaceWithSession', hostId, workspaceId],
    queryFn: () => workspacesApi.getWithSession(workspaceId!, hostId),
    enabled: !!workspaceId,
  });
}
