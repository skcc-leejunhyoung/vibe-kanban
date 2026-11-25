import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scratch, UpdateScratch } from 'shared/types';
import { installDomlessReact } from '@/shared/lib/electric/electricTestKit';
import {
  PERSIST_KEYS,
  useUiPreferencesStore,
} from '@/shared/stores/useUiPreferencesStore';
import {
  storeToScratchData,
  useUiPreferencesScratch,
} from './useUiPreferencesScratch';

// Two synthetic accounts sharing one browser tab on the remote web.
const env = vi.hoisted(() => ({
  userId: 'account-one' as string | null,
  loading: false,
  blobs: {} as Record<string, unknown>,
  saves: [] as { owner: string | null; update: unknown }[],
}));
vi.mock('@/shared/hooks/useAppRuntime', () => ({
  useAppRuntime: () => 'remote',
}));
vi.mock('@/shared/hooks/auth/useAuth', () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: env.userId }),
}));
vi.mock('@/shared/hooks/useScratch', () => ({
  useScratch: () => {
    const owner = env.userId;
    return {
      scratch: owner && !env.loading ? (env.blobs[owner] ?? null) : null,
      isLoading: env.loading,
      isConnected: true,
      error: null,
      updateScratch: async (update: UpdateScratch) => {
        env.saves.push({ owner, update });
      },
      deleteScratch: async () => {},
    };
  },
}));

const blob = (isLeftSidebarVisible: boolean): Scratch =>
  ({
    id: 'preferences',
    payload: {
      type: 'UI_PREFERENCES',
      data: storeToScratchData({
        ...useUiPreferencesStore.getState(),
        isLeftSidebarVisible,
      }),
    },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }) as unknown as Scratch;
const savedData = (update: unknown) =>
  (update as { payload: { data: Record<string, unknown> } }).payload.data;
const sidebarVisible = () =>
  useUiPreferencesStore.getState().isLeftSidebarVisible;
const wait = (ms: number) =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

function Probe() {
  useUiPreferencesScratch();
  return null;
}

let dom: ReturnType<typeof installDomlessReact>;
beforeEach(() => {
  dom = installDomlessReact();
  useUiPreferencesStore.setState(useUiPreferencesStore.getInitialState(), true);
  env.userId = 'account-one';
  env.loading = false;
  env.saves = [];
  env.blobs = { 'account-one': blob(false), 'account-two': blob(true) };
});
afterEach(async () => {
  await dom.unmount();
  vi.unstubAllGlobals();
});

it('flushes the latest provider grouping preference on pagehide without waiting for the debounce', async () => {
  await dom.render(<Probe />);
  const key = PERSIST_KEYS.modelSelectorGroupByProvider;
  const { setExpanded } = useUiPreferencesStore.getState();
  act(() => {
    setExpanded(key, true);
    setExpanded(key, false);
  });
  expect(env.saves).toHaveLength(0);

  act(() => {
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('pagehide'));
  });
  expect(env.saves).toHaveLength(1);
  expect(env.saves[0].owner).toBe('account-one');
  expect(savedData(env.saves[0].update).expanded).toMatchObject({
    [key]: false,
  });
});

describe('UI preferences when another account takes over the tab', () => {
  it("loads the new account's preferences instead of saving the old ones", async () => {
    await dom.render(<Probe />);
    await wait(150);
    expect(sidebarVisible()).toBe(false);

    // A change made just before the switch is still waiting in the debounce.
    act(() => useUiPreferencesStore.setState({ isDrawerListVisible: false }));
    env.userId = 'account-two';
    env.loading = true;
    await dom.render(<Probe />);
    env.loading = false;
    await dom.render(<Probe />);
    act(() => window.dispatchEvent(new Event('pagehide')));

    expect(sidebarVisible()).toBe(true);
    // Neither a scheduled save nor pagehide should carry it to account two.
    expect(env.saves).toHaveLength(0);

    // Account two's own changes are saved again.
    act(() => useUiPreferencesStore.setState({ isLeftSidebarVisible: false }));
    await wait(700);
    const last = env.saves[env.saves.length - 1];
    expect(last.owner).toBe('account-two');
    expect(savedData(last.update).is_left_sidebar_visible).toBe(false);
  });

  it('starts an account that has nothing stored from defaults', async () => {
    delete env.blobs['account-two'];
    const defaults = useUiPreferencesStore.getInitialState();
    await dom.render(<Probe />);
    await wait(150);
    // Account one hid the sidebar (its stored value).
    expect(sidebarVisible()).toBe(false);

    env.userId = 'account-two';
    env.loading = true;
    await dom.render(<Probe />);
    env.loading = false;
    await dom.render(<Probe />);
    await wait(700);
    expect(sidebarVisible()).toBe(defaults.isLeftSidebarVisible);

    // What account two saves next is its own, not account one's leftovers.
    act(() => useUiPreferencesStore.setState({ isDrawerListVisible: false }));
    await wait(700);
    const last = env.saves[env.saves.length - 1];
    expect(last.owner).toBe('account-two');
    expect(savedData(last.update).is_left_sidebar_visible).toBe(
      defaults.isLeftSidebarVisible
    );
  });
});
