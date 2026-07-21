import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SplitPreset, SplitPresetState } from './useSplitScreenStore';

const storedValues = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storedValues.get(key) ?? null,
  setItem: (key: string, value: string) => storedValues.set(key, value),
  removeItem: (key: string) => storedValues.delete(key),
});

const {
  getAdjacentSplitPaneId,
  getSplitScreenUserId,
  shouldRenderSplitScreenFrames,
  SPLIT_PRESETS,
  useSplitScreenStore,
} = await import('./useSplitScreenStore');

const makePreset = (preset: SplitPreset): SplitPresetState => ({
  panes: Array.from({ length: preset }, (_, index) => ({
    id: `preset-${preset}-pane-${index + 1}`,
    url: null,
  })),
  activePaneId: `preset-${preset}-pane-1`,
});

describe('split screen presets', () => {
  beforeEach(() => {
    storedValues.clear();
    useSplitScreenStore.setState({
      activeUserId: null,
      preset: 1,
      maxPanes: 4,
      presets: Object.fromEntries(
        SPLIT_PRESETS.map((preset) => [preset, makePreset(preset)])
      ) as ReturnType<typeof useSplitScreenStore.getState>['presets'],
    });
  });

  it('keeps the normal single-pane app in the parent document', () => {
    expect(shouldRenderSplitScreenFrames(1)).toBe(false);
    expect(shouldRenderSplitScreenFrames(2)).toBe(true);
    expect(shouldRenderSplitScreenFrames(3)).toBe(true);
    expect(shouldRenderSplitScreenFrames(4)).toBe(true);
    expect(shouldRenderSplitScreenFrames(9)).toBe(true);
  });

  it('waits for authentication before selecting the persisted user scope', () => {
    expect(
      getSplitScreenUserId({
        isLoaded: false,
        isSignedIn: false,
        userId: null,
      })
    ).toBeUndefined();
    expect(
      getSplitScreenUserId({
        isLoaded: true,
        isSignedIn: true,
        userId: 'user-a',
      })
    ).toBe('user-a');
    expect(
      getSplitScreenUserId({
        isLoaded: true,
        isSignedIn: false,
        userId: null,
      })
    ).toBeNull();
  });

  it('isolates saved layouts when the authenticated user changes', () => {
    useSplitScreenStore.getState().syncUser('user-a');
    useSplitScreenStore.getState().setPreset(2, '/workspaces/a');
    useSplitScreenStore.getState().syncUser('user-b');

    const state = useSplitScreenStore.getState();
    expect(state.activeUserId).toBe('user-b');
    expect(state.preset).toBe(1);
    expect(state.presets[2].panes.every((pane) => pane.url === null)).toBe(
      true
    );
  });

  it('cycles pane focus forward and backward with wrapping', () => {
    const panes = makePreset(3).panes;

    expect(getAdjacentSplitPaneId(panes, panes[0].id, 'next')).toBe(
      panes[1].id
    );
    expect(getAdjacentSplitPaneId(panes, panes[0].id, 'previous')).toBe(
      panes[2].id
    );
    expect(getAdjacentSplitPaneId(panes, panes[2].id, 'next')).toBe(
      panes[0].id
    );
  });

  it('seeds a new preset from the current page', () => {
    useSplitScreenStore.getState().setPreset(3, '/workspaces/current');

    const state = useSplitScreenStore.getState();
    expect(state.preset).toBe(3);
    expect(state.presets[3].panes.map((pane) => pane.url)).toEqual([
      '/workspaces/current',
      '/workspaces/current',
      '/workspaces/current',
    ]);
  });

  it('keeps each preset page assignment independent', () => {
    const store = useSplitScreenStore.getState();
    store.setPreset(2, '/workspaces/a');
    useSplitScreenStore
      .getState()
      .setPaneUrl('preset-2-pane-2', '/workspaces/b');
    useSplitScreenStore.getState().setPreset(1, '/workspaces/a');
    useSplitScreenStore.getState().setPreset(2, '/workspaces/other');

    expect(
      useSplitScreenStore.getState().presets[2].panes.map((pane) => pane.url)
    ).toEqual(['/workspaces/a', '/workspaces/b']);
  });

  it('focuses the first pane whenever a preset is selected', () => {
    useSplitScreenStore.getState().setPreset(2, '/workspaces/a');
    useSplitScreenStore.getState().setActivePane('preset-2-pane-2');
    useSplitScreenStore.getState().setPreset(1, '/workspaces/a');
    useSplitScreenStore.getState().setPreset(2, '/workspaces/a');

    const preset = useSplitScreenStore.getState().presets[2];
    expect(preset.activePaneId).toBe(preset.panes[0].id);
  });

  it('moves panes without losing their page state', () => {
    useSplitScreenStore.getState().setPreset(2, '/workspaces/a');
    useSplitScreenStore
      .getState()
      .setPaneUrl('preset-2-pane-2', '/workspaces/b');
    useSplitScreenStore
      .getState()
      .movePane('preset-2-pane-1', 'preset-2-pane-2');

    expect(
      useSplitScreenStore.getState().presets[2].panes.map((pane) => pane.url)
    ).toEqual(['/workspaces/b', '/workspaces/a']);
  });

  it('collapses to the selected pane before opening it in the window', () => {
    useSplitScreenStore.getState().setPreset(2, '/workspaces/a');
    useSplitScreenStore.getState().openPaneInWindow('/workspaces/b');

    const state = useSplitScreenStore.getState();
    expect(state.preset).toBe(1);
    expect(state.presets[1].panes[0].url).toBe('/workspaces/b');
    expect(state.presets[1].activePaneId).toBe(state.presets[1].panes[0].id);
  });

  it('stores both rows of the four-pane layout independently', () => {
    useSplitScreenStore.getState().setPreset(4, '/workspaces/a');
    useSplitScreenStore.getState().setHorizontalSizes([40, 60], 0);
    useSplitScreenStore.getState().setHorizontalSizes([30, 70], 2);
    useSplitScreenStore.getState().setVerticalSizes([45, 55]);

    expect(useSplitScreenStore.getState().presets[4].horizontalSizes).toEqual([
      40, 60, 30, 70,
    ]);
    expect(useSplitScreenStore.getState().presets[4].verticalSizes).toEqual([
      45, 55,
    ]);
  });

  it('opens the next pane until the configured maximum', () => {
    expect(
      useSplitScreenStore.getState().openPane('/workspaces/b', '/workspaces/a')
    ).toBe('pane');
    expect(useSplitScreenStore.getState().preset).toBe(2);
    expect(
      useSplitScreenStore.getState().presets[2].panes.map((pane) => pane.url)
    ).toEqual(['/workspaces/a', '/workspaces/b']);

    useSplitScreenStore.getState().setMaxPanes(2);
    expect(
      useSplitScreenStore.getState().openPane('/workspaces/c', '/workspaces/a')
    ).toBe('overflow');
  });

  it('supports presets up to nine panes', () => {
    useSplitScreenStore.getState().setMaxPanes(9);
    useSplitScreenStore.getState().setPreset(9, '/workspaces/a');
    expect(useSplitScreenStore.getState().presets[9].panes).toHaveLength(9);
  });
});
