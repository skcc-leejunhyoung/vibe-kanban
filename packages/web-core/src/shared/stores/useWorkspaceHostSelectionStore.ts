import { create } from 'zustand';

export const ALL_WORKSPACE_HOSTS_ID = 'all';

interface WorkspaceHostSelectionState {
  selectedHostId: string;
  selectHost: (hostId: string) => void;
}

/**
 * App-wide host scope for the unified workspace surface.
 *
 * This intentionally lives outside route components: opening a workspace adds
 * its owner host to the URL for API routing, but must not recreate the list as
 * an unrelated "all hosts" page. Project workspace routes use the same state,
 * so moving between the board and workspace views preserves one host scope.
 */
export const useWorkspaceHostSelectionStore =
  create<WorkspaceHostSelectionState>((set) => ({
    selectedHostId: ALL_WORKSPACE_HOSTS_ID,
    selectHost: (selectedHostId) => set({ selectedHostId }),
  }));
