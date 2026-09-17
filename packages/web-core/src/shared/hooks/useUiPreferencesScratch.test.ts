import { describe, expect, it } from 'vitest';
import {
  scratchDataToStore,
  storeToScratchData,
} from './useUiPreferencesScratch';
import {
  useUiPreferencesStore,
  type WorkspacePanelState,
} from '@/shared/stores/useUiPreferencesStore';

function roundTrip(
  workspacePanelStates: Record<string, WorkspacePanelState>
): Record<string, WorkspacePanelState> {
  const data = storeToScratchData({
    ...useUiPreferencesStore.getState(),
    workspacePanelStates,
  });
  return scratchDataToStore(data).workspacePanelStates;
}

describe('workspace panel state round-trip', () => {
  const base = { rightMainPanelMode: null, isLeftMainPanelVisible: true };

  it('preserves the right-sidebar override as a tri-state', () => {
    const restored = roundTrip({
      opened: { ...base, isRightSidebarVisible: true },
      closed: { ...base, isRightSidebarVisible: false },
      untouched: { ...base },
    });

    expect(restored.opened.isRightSidebarVisible).toBe(true);
    expect(restored.closed.isRightSidebarVisible).toBe(false);
    // Never toggled: must stay unset so the workspace keeps following the
    // runtime default rather than being pinned to whatever it looked like.
    expect(restored.untouched.isRightSidebarVisible).toBeUndefined();
  });
});

describe('context bar visibility round-trip', () => {
  it('defaults to visible when the server payload predates the flag', () => {
    const data = storeToScratchData(useUiPreferencesStore.getState());
    delete (data as { is_context_bar_visible?: boolean | null })
      .is_context_bar_visible;

    expect(scratchDataToStore(data).isContextBarVisible).toBe(true);
  });

  it('preserves an explicit hide', () => {
    const data = storeToScratchData({
      ...useUiPreferencesStore.getState(),
      isContextBarVisible: false,
    });

    expect(scratchDataToStore(data).isContextBarVisible).toBe(false);
  });
});
