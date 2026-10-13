export interface RemoteWorkspaceIdentity {
  local_workspace_id: string | null;
  host_id: string | null;
}

/**
 * Match a cloud workspace to a local workspace route.
 *
 * A null route host means "this machine" in the local app. The cloud database
 * keeps local_workspace_id globally unique, so the local route can safely fall
 * back to that id without turning the current machine into a self-relay route.
 * Remote routes always carry a concrete host id and remain strictly scoped.
 */
export function matchesRemoteWorkspaceIdentity(
  workspace: RemoteWorkspaceIdentity,
  localWorkspaceId: string,
  routeHostId: string | null
): boolean {
  return (
    workspace.local_workspace_id === localWorkspaceId &&
    (routeHostId === null || workspace.host_id === routeHostId)
  );
}

export function findRemoteWorkspaceByLocalIdentity<
  T extends RemoteWorkspaceIdentity,
>(
  workspaces: readonly T[],
  localWorkspaceId: string,
  routeHostId: string | null
): T | undefined {
  return workspaces.find((workspace) =>
    matchesRemoteWorkspaceIdentity(workspace, localWorkspaceId, routeHostId)
  );
}

/**
 * Cloud workspace rows carry the owner's cloud host id even for this machine,
 * while the app addresses this machine as `null`. Fold the self id once where
 * rows enter the app so every consumer (navigation, host→workspace keys,
 * dedupe) sees one identity. Returns the same array when nothing changes.
 */
export function foldSelfHostWorkspaces<T extends { host_id: string | null }>(
  workspaces: T[],
  selfHostId: string | null
): T[] {
  if (!selfHostId || !workspaces.some((w) => w.host_id === selfHostId)) {
    return workspaces;
  }
  return workspaces.map((w) =>
    w.host_id === selfHostId ? { ...w, host_id: null } : w
  );
}
