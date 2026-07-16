import { beforeEach, describe, expect, it } from 'vitest';
import {
  ALL_WORKSPACE_HOSTS_ID,
  useWorkspaceHostSelectionStore,
} from './useWorkspaceHostSelectionStore';

describe('workspace host selection', () => {
  beforeEach(() => {
    useWorkspaceHostSelectionStore.setState({
      selectedHostId: ALL_WORKSPACE_HOSTS_ID,
    });
  });

  it('survives navigation component remounts', () => {
    useWorkspaceHostSelectionStore.getState().selectHost('host-b');

    expect(useWorkspaceHostSelectionStore.getState().selectedHostId).toBe(
      'host-b'
    );
  });
});
