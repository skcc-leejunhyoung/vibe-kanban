import { useMemo } from 'react';
import { useUserContext } from '@/shared/hooks/useUserContext';

/** Maps local workspace IDs to their persisted owner host. */
export function useWorkspaceHostMap(): Map<string, string> {
  const { workspaces } = useUserContext();

  return useMemo(() => {
    const result = new Map<string, string>();
    for (const workspace of workspaces) {
      if (workspace.local_workspace_id && workspace.host_id) {
        result.set(workspace.local_workspace_id, workspace.host_id);
      }
    }
    return result;
  }, [workspaces]);
}
