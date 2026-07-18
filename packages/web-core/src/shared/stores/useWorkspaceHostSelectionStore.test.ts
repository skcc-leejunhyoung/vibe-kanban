import { beforeEach, describe, expect, it } from 'vitest';
import {
  ALL_WORKSPACE_HOSTS_ID,
  useWorkspaceHostSelectionStore,
} from './useWorkspaceHostSelectionStore';

describe('workspace host selection', () => {
  beforeEach(() => {
    useWorkspaceHostSelectionStore.setState({
      selectedHostId: ALL_WORKSPACE_HOSTS_ID,
      activeUserId: null,
    });
  });

  it('survives navigation component remounts', () => {
    useWorkspaceHostSelectionStore.getState().selectHost('host-b');

    expect(useWorkspaceHostSelectionStore.getState().selectedHostId).toBe(
      'host-b'
    );
  });

  it('resets when the authenticated user changes or signs out', () => {
    const store = useWorkspaceHostSelectionStore.getState();
    store.syncUser('user-a');
    store.selectHost('host-a');

    store.syncUser('user-a');
    expect(useWorkspaceHostSelectionStore.getState().selectedHostId).toBe(
      'host-a'
    );

    store.syncUser('user-b');
    expect(useWorkspaceHostSelectionStore.getState().selectedHostId).toBe(
      ALL_WORKSPACE_HOSTS_ID
    );

    useWorkspaceHostSelectionStore.getState().selectHost('host-b');
    useWorkspaceHostSelectionStore.getState().syncUser(null);
    expect(useWorkspaceHostSelectionStore.getState().selectedHostId).toBe(
      ALL_WORKSPACE_HOSTS_ID
    );
  });
});
