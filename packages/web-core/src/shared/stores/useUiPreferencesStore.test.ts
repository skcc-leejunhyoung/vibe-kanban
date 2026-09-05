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

  it('is a no-op when no workspace resolves', () => {
    // Remote web routes some invocations through a provider that supplies a
    // null currentWorkspaceId; that must not fall back to a global toggle,
    // which would flip every pane still following the default.
    useUiPreferencesStore.getState().toggleRightSidebar(undefined);

    const state = useUiPreferencesStore.getState();
    expect(state.isRightSidebarVisible).toBe(true);
    expect(state.workspacePanelStates).toEqual({});
  });
});
