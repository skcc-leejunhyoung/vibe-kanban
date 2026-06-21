import { useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import { workspacesApi } from '@/shared/lib/api';
import { useAppRuntime } from '@/shared/hooks/useAppRuntime';
import { UserContext } from '@/shared/hooks/useUserContext';

/**
 * Resolve the project id a workspace belongs to.
 *
 * - Local runtime: queries the host API (`GET /api/workspaces/{id}/project`),
 *   resolving the local project id via the workspace's linked task.
 * - Remote runtime: the route `workspaceId` is a *local* workspace id, so a
 *   host-relay round-trip to that endpoint is fragile (depends on host
 *   connectivity/version and races against react-query). Instead we resolve
 *   the *remote* project id directly from the already-synced ElectricSQL
 *   workspace rows (matched on `local_workspace_id`). This keeps preview
 *   shortcuts keyed by the cloud project id — synchronously and stably —
 *   and independent from the local web's per-project buckets.
 *
 * Returns `null` for workspaces that aren't linked to a project
 * (e.g. draft/standalone workspaces) or while the lookup is in flight.
 */
export function useWorkspaceProjectId(
  workspaceId: string | undefined
): string | null {
  const runtime = useAppRuntime();
  const isRemote = runtime === 'remote';

  // Remote: resolve from synced workspace rows. The route param is a local
  // workspace id, while remote rows carry it as `local_workspace_id`.
  // `useContext` (rather than `useUserContext`) tolerates a missing provider
  // so this hook stays safe outside the remote UserProvider tree.
  const userContext = useContext(UserContext);
  const remoteProjectId =
    isRemote && workspaceId
      ? (userContext?.workspaces.find(
          (workspace) => workspace.local_workspace_id === workspaceId
        )?.project_id ?? null)
      : null;

  // Local: resolve via the host API. Disabled on remote so we don't issue a
  // pointless host-relay request.
  const { data } = useQuery({
    queryKey: ['workspace-project-id', workspaceId],
    queryFn: () => workspacesApi.getProjectId(workspaceId as string),
    enabled: !!workspaceId && !isRemote,
    staleTime: 5 * 60 * 1000,
  });

  return isRemote ? remoteProjectId : (data ?? null);
}
