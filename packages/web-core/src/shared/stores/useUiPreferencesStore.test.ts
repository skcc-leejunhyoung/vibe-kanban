import { beforeEach, describe, expect, it } from 'vitest';
import { useUiPreferencesStore } from './useUiPreferencesStore';

describe('right sidebar preference', () => {
  beforeEach(() => {
    useUiPreferencesStore.setState({
      isRightSidebarVisible: true,
      workspacePanelStates: {},
    });
  });

  it('toggles only the targeted workspace, leaving the global flag intact', () => {
    useUiPreferencesStore.getState().toggleRightSidebar('workspace-1');

    const state = useUiPreferencesStore.getState();
    expect(
      state.workspacePanelStates['workspace-1'].isRightSidebarVisible
    ).toBe(false);
    // Global stays put so sibling panes without an override don't follow along.
    expect(state.isRightSidebarVisible).toBe(true);
    expect(
      state.workspacePanelStates['workspace-2']?.isRightSidebarVisible
    ).toBeUndefined();
  });
});
