import { useEffect } from 'react';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import {
  ALL_WORKSPACE_HOSTS_ID,
  useWorkspaceHostSelectionStore,
} from '@/shared/stores/useWorkspaceHostSelectionStore';
import { useWorkspacePanesStore } from '@/shared/stores/useWorkspacePanesStore';

/**
 * Whether what the previous account left on screen has to go.
 *
 * On the local app being signed out is a normal state, and a sign-in can
 * lapse on its own, so neither counts: only a DIFFERENT account taking over
 * does. `previousAccountId` is `null` while no account has owned the layout.
 */
export function isAccountTakeover(
  previousAccountId: string | null,
  accountId: string
): boolean {
  return previousAccountId !== null && previousAccountId !== accountId;
}

/**
 * Local web: the pane layout and the workspace host filter can point at hosts
 * of the signed-in cloud account. When another account signs in they are
 * cleared, as the remote web does; drafts stay, they belong to this machine.
 *
 * The owner is recorded with the layout itself (the panes store persists it),
 * so a layout that was never owned is adopted as it is.
 */
export function useLocalAccountLayoutOwner(): void {
  const { isLoaded, isSignedIn, userId } = useAuth();

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !userId) return;
    const panes = useWorkspacePanesStore.getState();
    if (panes.activeUserId === userId) return;
    if (!isAccountTakeover(panes.activeUserId, userId)) {
      useWorkspacePanesStore.setState({ activeUserId: userId });
      return;
    }
    // Clears the panes and records the new owner. The grid adds its first
    // pane only when it mounts, and here it is already on screen: without a
    // pane of its own it would stay blank until a reload.
    panes.syncUser(userId);
    useWorkspacePanesStore.getState().ensurePane();
    useWorkspaceHostSelectionStore
      .getState()
      .selectHost(ALL_WORKSPACE_HOSTS_ID);
  }, [isLoaded, isSignedIn, userId]);
}
