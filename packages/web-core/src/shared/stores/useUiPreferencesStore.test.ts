import { beforeEach, describe, expect, it } from 'vitest';
import { useUiPreferencesStore } from './useUiPreferencesStore';

describe('right sidebar preference', () => {
  beforeEach(() => {
    useUiPreferencesStore.setState({
      isRightSidebarVisible: true,
      workspacePanelStates: {},
    });
  });

  it('uses the last workspace toggle as the default for new workspaces', () => {
    useUiPreferencesStore.getState().toggleRightSidebar('workspace-1');

    const state = useUiPreferencesStore.getState();
    expect(
      state.workspacePanelStates['workspace-1'].isRightSidebarVisible
    ).toBe(false);
    expect(state.isRightSidebarVisible).toBe(false);
  });
});
