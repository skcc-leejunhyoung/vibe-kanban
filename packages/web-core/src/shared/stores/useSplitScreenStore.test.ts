import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SplitPreset, SplitPresetState } from './useSplitScreenStore';

const storedValues = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storedValues.get(key) ?? null,
  setItem: (key: string, value: string) => storedValues.set(key, value),
  removeItem: (key: string) => storedValues.delete(key),
});

const { getAdjacentSplitPaneId, useSplitScreenStore } = await import(
  './useSplitScreenStore'
);

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
      presets: {
        1: makePreset(1),
        2: makePreset(2),
        3: makePreset(3),
        4: makePreset(4),
      },
    });
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
});
