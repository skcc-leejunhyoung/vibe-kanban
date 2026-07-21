interface ActiveWorkspaceTarget {
  id: string;
  name?: string | null;
  hostId?: string | null;
}

interface RemoteWorkspaceTarget {
  id: string;
  local_workspace_id: string | null;
  host_id: string | null;
  name: string | null;
  archived: boolean;
}

export interface WorkspaceNavigationTarget {
  id: string;
  localWorkspaceId: string;
  hostId: string | null;
  name: string | null | undefined;
}

export function resolveWorkspaceNavigationTargets(
  activeWorkspaces: ActiveWorkspaceTarget[],
  remoteWorkspaces: RemoteWorkspaceTarget[]
): WorkspaceNavigationTarget[] {
  const candidates: WorkspaceNavigationTarget[] = [
    ...activeWorkspaces.map((workspace) => ({
      id: `${workspace.hostId ?? 'local'}:${workspace.id}`,
      localWorkspaceId: workspace.id,
      hostId: workspace.hostId ?? null,
      name: workspace.name,
    })),
    ...remoteWorkspaces
      .filter((workspace) => !workspace.archived)
      .map((workspace) => ({
        id: `${workspace.host_id ?? 'local'}:${workspace.local_workspace_id ?? workspace.id}`,
        localWorkspaceId: workspace.local_workspace_id ?? workspace.id,
        hostId: workspace.host_id,
        name: workspace.name,
      })),
  ];

  const seenLocalWorkspaceIds = new Set<string>();
  return candidates.filter((workspace) => {
    if (seenLocalWorkspaceIds.has(workspace.localWorkspaceId)) return false;
    seenLocalWorkspaceIds.add(workspace.localWorkspaceId);
    return true;
  });
}
