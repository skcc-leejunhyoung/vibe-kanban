import { describe, expect, it, vi } from 'vitest';

vi.stubGlobal('window', {
  location: { search: '' },
  name: '',
  sessionStorage: {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  },
});

const { getAppBarVisibilityStorageName } = await import(
  './useAppBarVisibilityStore'
);

describe('app bar visibility storage', () => {
  it('uses the shared top-level window key outside a split pane', () => {
    expect(getAppBarVisibilityStorageName('', '')).toBe(
      'vk-app-bar-visibility-v1'
    );
    expect(getAppBarVisibilityStorageName('?vk_split_pane=pane-1', '')).toBe(
      'vk-app-bar-visibility-v1'
    );
  });

  it('isolates each embedded split pane by query pane id', () => {
    expect(
      getAppBarVisibilityStorageName(
        '?vk_split_embed=1&vk_split_pane=preset-2-pane-1',
        ''
      )
    ).toBe('vk-app-bar-visibility-v1:preset-2-pane-1');
    expect(
      getAppBarVisibilityStorageName(
        '?vk_split_embed=1&vk_split_pane=preset-2-pane-2',
        ''
      )
    ).toBe('vk-app-bar-visibility-v1:preset-2-pane-2');
  });

  it('keeps the pane key after navigation through window.name', () => {
    expect(
      getAppBarVisibilityStorageName('', 'vk-split-pane:preset-3-pane-2')
    ).toBe('vk-app-bar-visibility-v1:preset-3-pane-2');
  });
});
