import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from 'shared/types';
import { useConfigPreferenceSync } from './useConfigPreferenceSync';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';

vi.hoisted(() => {
  const items = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
});

const savedFilters = {
  repositories: ['example/repo'],
  status: 'open',
  author: 'all',
  draft: 'ready',
  updated: 'all',
  involvesMe: true,
};
const config = {
  keyboard_shortcuts: { 'command-bar': 'mod+shift+p' },
  pull_request_default_filters: savedFilters,
} as unknown as Config;

const save = vi.fn(async (_updates: Partial<Config>) => true);
let root: Root;

function Probe({ config }: { config: Config | null }) {
  useConfigPreferenceSync(config, save);
  return null;
}

beforeEach(() => {
  save.mockClear();
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const document = Object.assign(new EventTarget(), {
    nodeType: 9,
    activeElement: null,
  });
  vi.stubGlobal('document', document);
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      document,
      HTMLIFrameElement: class {},
    })
  );
  root = createRoot(
    Object.assign(new EventTarget(), {
      nodeType: 1,
      tagName: 'DIV',
      ownerDocument: document,
    }) as unknown as HTMLElement
  );
  // The app mounts while the config is still loading.
  act(() => root.render(<Probe config={null} />));
  act(() => root.render(<Probe config={config} />));
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('loading the config after mount', () => {
  it('applies it without saving the stores’ previous values back', () => {
    act(() => vi.advanceTimersByTime(1000));
    expect(useUiPreferencesStore.getState().pullRequestDefaultFilters).toEqual(
      savedFilters
    );
    expect(save).not.toHaveBeenCalled();
  });

  it('still saves a change made afterwards', () => {
    const changed = { ...savedFilters, status: 'all' as const };
    act(() =>
      useUiPreferencesStore.getState().setPullRequestDefaultFilters(changed)
    );
    act(() => vi.advanceTimersByTime(1000));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({
      pull_request_default_filters: changed,
    });
  });
});
