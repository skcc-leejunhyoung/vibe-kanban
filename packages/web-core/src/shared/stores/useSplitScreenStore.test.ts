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
  getDefaultSplitPresetLayout,
  getSplitPresetLayoutOptions,
  getSplitScreenUserId,
  resizeSplitPaneUrls,
  shouldRenderSplitScreenFrames,
  SPLIT_PRESETS,
  useSplitScreenStore,
} = await import('./useSplitScreenStore');
const {
  getSplitPresetHotkeyOptions,
  sameOriginRelativeUrl,
  shouldFocusRequestedPane,
} = await import('@/shared/components/SplitScreenSurface');

const makePreset = (preset: SplitPreset): SplitPresetState => ({
  panes: Array.from({ length: preset }, (_, index) => ({
    id: `preset-${preset}-pane-${index + 1}`,
    url: null,
  })),
  activePaneId: `preset-${preset}-pane-1`,
  layout: getDefaultSplitPresetLayout(preset),
  focusHistory: [`preset-${preset}-pane-1`],
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

  it('keeps the currently open panes on the left when expanding', () => {
    const store = useSplitScreenStore.getState();
    store.setPreset(2, '/workspaces/a');
    useSplitScreenStore
      .getState()
      .setPaneUrl('preset-2-pane-2', '/workspaces/b');
    useSplitScreenStore.getState().setPreset(4, '/workspaces/current');

    expect(
      useSplitScreenStore.getState().presets[4].panes.map((pane) => pane.url)
    ).toEqual([
      '/workspaces/a',
      '/workspaces/b',
      '/workspaces/current',
      '/workspaces/current',
    ]);
  });

  it('keeps the leftmost panes when shrinking', () => {
    useSplitScreenStore.getState().setPreset(4, '/workspaces/a');
    useSplitScreenStore
      .getState()
      .setPaneUrl('preset-4-pane-2', '/workspaces/b');
    useSplitScreenStore
      .getState()
      .setPaneUrl('preset-4-pane-3', '/workspaces/c');
    useSplitScreenStore.getState().setPreset(2, '/workspaces/current');

    const preset = useSplitScreenStore.getState().presets[2];
    expect(preset.panes.map((pane) => pane.url)).toEqual([
      '/workspaces/a',
      '/workspaces/b',
    ]);
    expect(preset.activePaneId).toBe(preset.panes[0].id);
  });

  it('removes panes from the bottom right and appends new panes there', () => {
    const sixPanes = makePreset(6).panes.map((pane, index) => ({
      ...pane,
      url: `/workspaces/${index + 1}`,
    }));
    const fourPanes = resizeSplitPaneUrls(
      sixPanes,
      makePreset(4).panes,
      '/workspaces/new'
    );

    expect(fourPanes.map((pane) => pane.url)).toEqual([
      '/workspaces/1',
      '/workspaces/2',
      '/workspaces/3',
      '/workspaces/4',
    ]);

    const expandedPanes = resizeSplitPaneUrls(
      fourPanes,
      makePreset(6).panes,
      '/workspaces/new'
    );
    expect(expandedPanes.map((pane) => pane.url)).toEqual([
      '/workspaces/1',
      '/workspaces/2',
      '/workspaces/3',
      '/workspaces/4',
      '/workspaces/new',
      '/workspaces/new',
    ]);
  });

  it('keeps top-left pane order across a shrink and re-expansion', () => {
    useSplitScreenStore.getState().setMaxPanes(9);
    useSplitScreenStore.getState().setPreset(6, '/workspaces/1');
    for (let index = 0; index < 6; index += 1) {
      useSplitScreenStore
        .getState()
        .setPaneUrl(`preset-6-pane-${index + 1}`, `/workspaces/${index + 1}`);
    }

    useSplitScreenStore.getState().setPreset(4, '/workspaces/current');
    expect(
      useSplitScreenStore.getState().presets[4].panes.map((pane) => pane.url)
    ).toEqual([
      '/workspaces/1',
      '/workspaces/2',
      '/workspaces/3',
      '/workspaces/4',
    ]);

    useSplitScreenStore.getState().setPreset(6, '/workspaces/new');
    expect(
      useSplitScreenStore.getState().presets[6].panes.map((pane) => pane.url)
    ).toEqual([
      '/workspaces/1',
      '/workspaces/2',
      '/workspaces/3',
      '/workspaces/4',
      '/workspaces/new',
      '/workspaces/new',
    ]);
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

  it('opens a new window instead of adding a pane from a single-pane layout', () => {
    expect(
      useSplitScreenStore.getState().openPane('/workspaces/b', '/workspaces/a')
    ).toBe('overflow');
    expect(useSplitScreenStore.getState().preset).toBe(1);
  });

  it('reuses the most recently focused pane other than the source pane', () => {
    const store = useSplitScreenStore.getState();
    store.setPreset(3, '/workspaces/a');
    useSplitScreenStore.getState().setActivePane('preset-3-pane-3');
    useSplitScreenStore.getState().setActivePane('preset-3-pane-2');
    useSplitScreenStore.getState().setActivePane('preset-3-pane-1');

    expect(
      useSplitScreenStore
        .getState()
        .openPane('/issues/new', '/workspaces/a', 'preset-3-pane-1')
    ).toBe('pane');

    const state = useSplitScreenStore.getState();
    expect(state.preset).toBe(3);
    expect(state.presets[3].activePaneId).toBe('preset-3-pane-2');
    expect(state.presets[3].panes.map((pane) => pane.url)).toEqual([
      '/workspaces/a',
      '/issues/new',
      '/workspaces/a',
    ]);
  });

  it('supports presets up to nine panes', () => {
    useSplitScreenStore.getState().setMaxPanes(9);
    useSplitScreenStore.getState().setPreset(9, '/workspaces/a');
    expect(useSplitScreenStore.getState().presets[9].panes).toHaveLength(9);
  });

  it('offers row and column layouts that include every pane', () => {
    expect(getSplitPresetLayoutOptions(5)).toEqual([
      { rows: 1, columns: 5 },
      { rows: 2, columns: 3 },
      { rows: 3, columns: 2 },
      { rows: 4, columns: 2 },
      { rows: 5, columns: 1 },
    ]);
  });

  it('stores a layout independently for each preset and resets its sizes', () => {
    useSplitScreenStore.getState().setPreset(4, '/workspaces/a');
    useSplitScreenStore.getState().setHorizontalSizes([40, 60], 0);
    useSplitScreenStore.getState().setVerticalSizes([45, 55]);
    useSplitScreenStore.getState().setPresetLayout(4, { rows: 1, columns: 4 });

    const state = useSplitScreenStore.getState();
    expect(state.presets[4].layout).toEqual({ rows: 1, columns: 4 });
    expect(state.presets[4].horizontalSizes).toBeUndefined();
    expect(state.presets[4].verticalSizes).toBeUndefined();
    expect(state.presets[3].layout).toEqual({ rows: 1, columns: 3 });
  });

  it('ignores layouts that cannot describe the selected preset', () => {
    useSplitScreenStore.getState().setPresetLayout(4, { rows: 2, columns: 3 });

    expect(useSplitScreenStore.getState().presets[4].layout).toEqual({
      rows: 2,
      columns: 2,
    });
  });
});

describe('split pane navigation', () => {
  it('keeps preset shortcuts active while editing form fields', () => {
    expect(getSplitPresetHotkeyOptions('mod+alt+shift+2')).toMatchObject({
      enabled: true,
      enableOnContentEditable: true,
      enableOnFormTags: true,
      preventDefault: true,
    });
  });

  it('accepts focus completion only from the requested iframe', () => {
    expect(
      shouldFocusRequestedPane(
        'preset-2-pane-1',
        'preset-2-pane-1',
        'preset-2-pane-1'
      )
    ).toBe(true);
    expect(
      shouldFocusRequestedPane(
        'preset-3-pane-1',
        'preset-2-pane-1',
        'preset-2-pane-1'
      )
    ).toBe(false);
    expect(
      shouldFocusRequestedPane(
        'preset-2-pane-1',
        'preset-2-pane-1',
        'preset-2-pane-2'
      )
    ).toBe(false);
  });

  it('accepts same-origin navigation commands and strips embed metadata', () => {
    expect(
      sameOriginRelativeUrl(
        'https://vibe.local/workspaces/a?vk_split_embed=1&x=1#logs',
        'https://vibe.local'
      )
    ).toBe('/workspaces/a?x=1#logs');
  });

  it('rejects cross-origin navigation commands', () => {
    expect(
      sameOriginRelativeUrl(
        'https://malicious.example/workspaces/a',
        'https://vibe.local'
      )
    ).toBeNull();
  });
});
