import { create } from 'zustand';

export const ALL_WORKSPACE_HOSTS_ID = 'all';

interface WorkspaceHostSelectionState {
  selectedHostId: string;
  selectHost: (hostId: string) => void;
}

/**
 * User-controlled host filter for the unified workspace list.
 *
 * This intentionally lives outside route components so it survives the
 * unmount/remount that happens when the standalone list route
 * (`/workspaces`) and a workspace-detail route
 * (`/hosts/:hostId/workspaces/:workspaceId`) swap their sidebar instance.
 *
 * It is ONLY changed by the user (the sidebar picker, or an explicit host
 * click in the app bar / home). It is deliberately NOT synced from the route's
 * hostId: opening a workspace on another host adds that host to the URL for API
 * routing, but must not reset an "All hosts" selection — that is exactly what
 * makes the multi-host list a single unified surface rather than a per-host
 * page dressed up to look unified.
 */
export const useWorkspaceHostSelectionStore =
  create<WorkspaceHostSelectionState>((set) => ({
    selectedHostId: ALL_WORKSPACE_HOSTS_ID,
    selectHost: (selectedHostId) => set({ selectedHostId }),
  }));
