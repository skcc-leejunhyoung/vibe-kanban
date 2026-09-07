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

  it('ships collapsed on every surface', () => {
    // Read the pristine initial state: both local and remote web must open a
    // workspace with the git sidebar closed so the chat gets the width.
    expect(useUiPreferencesStore.getInitialState().isRightSidebarVisible).toBe(
      false
    );
  });

  it('toggles against the current default, not a hardcoded one', () => {
    // Starting collapsed, the first toggle must *open* the sidebar — if the
    // reducer assumed "visible" it would write false and the press would look
    // dead.
    useUiPreferencesStore.setState({ isRightSidebarVisible: false });

    useUiPreferencesStore.getState().toggleRightSidebar('workspace-1');

    expect(
      useUiPreferencesStore.getState().workspacePanelStates['workspace-1']
        .isRightSidebarVisible
    ).toBe(true);
  });
});

describe('preview refresh key', () => {
  beforeEach(() => {
    useUiPreferencesStore.setState({ previewRefreshKeys: {} });
  });

  it('bumps only the targeted workspace so sibling panes do not reload', () => {
    useUiPreferencesStore.getState().triggerPreviewRefresh('workspace-1');
    useUiPreferencesStore.getState().triggerPreviewRefresh('workspace-1');

    const { previewRefreshKeys } = useUiPreferencesStore.getState();
    expect(previewRefreshKeys['workspace-1']).toBe(2);
    expect(previewRefreshKeys['workspace-2']).toBeUndefined();
  });

  it('is a no-op when no workspace resolves', () => {
    useUiPreferencesStore.getState().triggerPreviewRefresh(undefined);

    expect(useUiPreferencesStore.getState().previewRefreshKeys).toEqual({});
  });
});
