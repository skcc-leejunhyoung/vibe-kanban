import { useEffect, useRef } from 'react';
import type { Config } from 'shared/types';
import { useDiffViewStore } from '@/shared/stores/useDiffViewStore';
import { useKeyboardShortcutsStore } from '@/shared/stores/useKeyboardShortcutsStore';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import {
  DEFAULT_THEME_VARIANT,
  persistStoredPresets,
  sanitizeStoredPresets,
  type ThemePreset,
} from '@/shared/lib/themePresets';

/**
 * Syncs device-local UI preferences (keyboard shortcut overrides, theme
 * variant/presets, diff-view settings) with the backend config so they persist
 * server-side and surface on other devices after a reload.
 *
 * Model: the backend config is the source of truth; each store keeps its
 * localStorage cache (for pre-paint / FOUC) as a mirror. On first load we
 * either hydrate the store from config, or — when config is still empty but the
 * device already has a local value — promote that local value into config once,
 * so pre-existing settings are never lost by the migration. Subsequent store
 * changes flush back to config (debounced).
 *
 * Wiring lives in the local + remote `UserSystemProvider`s, which pass their
 * already-resolved `config` + `updateAndSaveConfig` (so this never needs the
 * `useUserSystem` context, which isn't available inside the provider itself).
 */

const FLUSH_DELAY_MS = 600;

type DiffViewPrefs = {
  mode: 'unified' | 'split';
  ignoreWhitespace: boolean;
  wrapText: boolean;
};

const DEFAULT_DIFF_VIEW: DiffViewPrefs = {
  mode: 'unified',
  ignoreWhitespace: true,
  wrapText: false,
};

function shallowEqualStringRecord(
  a: Record<string, string>,
  b: Record<string, string>
): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  return ak.every((k) => a[k] === b[k]);
}

function presetsEqual(a: ThemePreset[], b: ThemePreset[]): boolean {
  // Presets are small and always built from the same field order, so a stable
  // JSON compare is sufficient for echo detection.
  return JSON.stringify(a) === JSON.stringify(b);
}

function diffEqual(a: DiffViewPrefs, b: DiffViewPrefs): boolean {
  return (
    a.mode === b.mode &&
    a.ignoreWhitespace === b.ignoreWhitespace &&
    a.wrapText === b.wrapText
  );
}

function readDiffView(raw: unknown): DiffViewPrefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  return {
    mode: o.mode === 'split' ? 'split' : 'unified',
    ignoreWhitespace: o.ignoreWhitespace !== false,
    wrapText: o.wrapText === true,
  };
}

type SyncedPreferenceParams<T> = {
  enabled: boolean;
  /** Value extracted from config, or undefined while config is unresolved. */
  configValue: T | undefined;
  isDefault: (v: T) => boolean;
  readStore: () => T;
  /** Apply a value into the store (and its localStorage cache). */
  applyToStore: (v: T) => void;
  /** Subscribe to store changes; returns an unsubscribe fn. */
  subscribe: (listener: () => void) => () => void;
  equal: (a: T, b: T) => boolean;
  toConfig: (v: T) => Partial<Config>;
  save: (updates: Partial<Config>) => Promise<boolean>;
};

function useSyncedPreference<T>({
  enabled,
  configValue,
  isDefault,
  readStore,
  applyToStore,
  subscribe,
  equal,
  toConfig,
  save,
}: SyncedPreferenceParams<T>): void {
  const seededRef = useRef(false);
  const lastSyncedRef = useRef<T | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep `save` fresh: it closes over `config`, so a stale copy would PUT an
  // outdated config object and clobber other fields.
  const saveRef = useRef(save);
  saveRef.current = save;

  // Seed-or-hydrate, exactly once, when config first becomes available.
  useEffect(() => {
    if (!enabled || configValue === undefined || seededRef.current) return;
    seededRef.current = true;

    const local = readStore();
    if (isDefault(configValue) && !isDefault(local)) {
      // One-time promotion of pre-existing local settings into config.
      lastSyncedRef.current = local;
      void saveRef.current(toConfig(local));
    } else {
      lastSyncedRef.current = configValue;
      applyToStore(configValue);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, configValue]);

  // Flush store changes back to config (debounced), after seeding.
  useEffect(() => {
    const flush = () => {
      if (!seededRef.current) return;
      const cur = readStore();
      if (lastSyncedRef.current !== null && equal(cur, lastSyncedRef.current)) {
        return;
      }
      lastSyncedRef.current = cur;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        void saveRef.current(toConfig(cur));
      }, FLUSH_DELAY_MS);
    };
    const unsub = subscribe(flush);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function useConfigPreferenceSync(
  config: Config | null,
  save: (updates: Partial<Config>) => Promise<boolean>
): void {
  const enabled = config != null;

  // 1. Keyboard shortcut overrides
  useSyncedPreference<Record<string, string>>({
    enabled,
    configValue: config?.keyboard_shortcuts as
      | Record<string, string>
      | undefined,
    isDefault: (v) => Object.keys(v).length === 0,
    readStore: () => useKeyboardShortcutsStore.getState().overrides,
    applyToStore: (v) => useKeyboardShortcutsStore.setState({ overrides: v }),
    subscribe: (cb) => useKeyboardShortcutsStore.subscribe(cb),
    equal: shallowEqualStringRecord,
    toConfig: (v) => ({ keyboard_shortcuts: v }),
    save,
  });

  // 2. Theme variant ("skin")
  useSyncedPreference<string>({
    enabled,
    configValue: config?.theme_variant,
    isDefault: (v) => !v || v === DEFAULT_THEME_VARIANT,
    readStore: () => useUiPreferencesStore.getState().themeVariant,
    // setThemeVariant also updates the localStorage cache used pre-paint.
    applyToStore: (v) => useUiPreferencesStore.getState().setThemeVariant(v),
    subscribe: (cb) => useUiPreferencesStore.subscribe(cb),
    equal: (a, b) => a === b,
    toConfig: (v) => ({ theme_variant: v }),
    save,
  });

  // 3. Custom theme presets (user-added + built-in overrides)
  useSyncedPreference<ThemePreset[]>({
    enabled,
    configValue: config
      ? sanitizeStoredPresets(config.theme_presets)
      : undefined,
    isDefault: (v) => v.length === 0,
    readStore: () => useUiPreferencesStore.getState().customThemePresets,
    applyToStore: (v) => {
      persistStoredPresets(v);
      useUiPreferencesStore.setState({ customThemePresets: v });
    },
    subscribe: (cb) => useUiPreferencesStore.subscribe(cb),
    equal: presetsEqual,
    toConfig: (v) => ({
      theme_presets: v as unknown as Config['theme_presets'],
    }),
    save,
  });

  // 4. Diff view preferences
  useSyncedPreference<DiffViewPrefs>({
    enabled,
    configValue: config ? readDiffView(config.diff_view) : undefined,
    isDefault: (v) => diffEqual(v, DEFAULT_DIFF_VIEW),
    readStore: () => {
      const s = useDiffViewStore.getState();
      return {
        mode: s.mode,
        ignoreWhitespace: s.ignoreWhitespace,
        wrapText: s.wrapText,
      };
    },
    applyToStore: (v) =>
      useDiffViewStore.setState({
        mode: v.mode,
        ignoreWhitespace: v.ignoreWhitespace,
        wrapText: v.wrapText,
      }),
    subscribe: (cb) => useDiffViewStore.subscribe(cb),
    equal: diffEqual,
    toConfig: (v) => ({ diff_view: v as unknown as Config['diff_view'] }),
    save,
  });
}
