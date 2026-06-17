import { useQuery } from '@tanstack/react-query';
import { workspacesApi } from '@/shared/lib/api';

/**
 * Resolve the project id a workspace belongs to (via its linked task).
 * Returns `null` for workspaces that aren't linked to a project
 * (e.g. draft/standalone workspaces) or while the lookup is in flight.
 */
export function useWorkspaceProjectId(
  workspaceId: string | undefined
): string | null {
  const { data } = useQuery({
    queryKey: ['workspace-project-id', workspaceId],
    queryFn: () => workspacesApi.getProjectId(workspaceId as string),
    enabled: !!workspaceId,
    staleTime: 5 * 60 * 1000,
  });

  return data ?? null;
}
