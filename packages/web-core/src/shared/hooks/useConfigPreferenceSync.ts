import { useEffect, useRef } from 'react';
import type { Config } from 'shared/types';
import { useDiffViewStore } from '@/shared/stores/useDiffViewStore';
import {
  useFolderFavoritesStore,
  type FolderFavorite,
} from '@/shared/stores/useFolderFavoritesStore';
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
 * IMPORTANT — single batched save: `updateAndSaveConfig` PUTs the *whole*
 * config (`{ ...config, ...updates }`) and the backend replaces it wholesale,
 * so two concurrent saves would last-write-win and drop each other's fields.
 * That is exactly what happens when several preferences change inside one debounce
 * window — or when multiple preferences promote together on the v8→v9 migration's
 * first load (e.g. a user with both a custom theme variant and presets). To avoid
 * it we collect every pending preference change into a single `updates` object and
 * issue exactly one save: promotions are coalesced into one call, and runtime
 * flushes share one pending buffer + one debounce timer.
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

function favoritesEqual(a: FolderFavorite[], b: FolderFavorite[]): boolean {
  // Favorites are a small ordered list of plain {path, name} pairs, so a stable
  // JSON compare is sufficient for echo detection.
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Coerce opaque config JSON into a clean, well-formed favorites list. */
export function readFolderFavorites(raw: unknown): FolderFavorite[] {
  if (!Array.isArray(raw)) return [];
  const out: FolderFavorite[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as { path?: unknown }).path === 'string' &&
      typeof (item as { name?: unknown }).name === 'string'
    ) {
      const fav = item as FolderFavorite;
      const hostId = fav.hostId;
      if (
        hostId !== undefined &&
        hostId !== null &&
        typeof hostId !== 'string'
      ) {
        continue;
      }
      out.push({
        path: fav.path,
        name: fav.name,
        ...(hostId !== undefined ? { hostId } : {}),
      });
    }
  }
  return out;
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

/**
 * A single synced preference. Generic in its value type internally, but stored
 * type-erased in {@link PREF_SPECS} so the sync engine can treat them uniformly
 * (collecting heterogeneous changes into one `Partial<Config>`).
 */
type PrefSpec = {
  /** Read the (default-aware) value out of a resolved config. */
  getConfigValue: (config: Config) => unknown;
  isDefault: (v: unknown) => boolean;
  readStore: () => unknown;
  /** Apply a value into the store (and its localStorage cache). */
  applyToStore: (v: unknown) => void;
  /** Subscribe to store changes; returns an unsubscribe fn. */
  subscribe: (listener: () => void) => () => void;
  equal: (a: unknown, b: unknown) => boolean;
  toConfig: (v: unknown) => Partial<Config>;
};

function pref<T>(spec: {
  getConfigValue: (config: Config) => T;
  isDefault: (v: T) => boolean;
  readStore: () => T;
  applyToStore: (v: T) => void;
  subscribe: (listener: () => void) => () => void;
  equal: (a: T, b: T) => boolean;
  toConfig: (v: T) => Partial<Config>;
}): PrefSpec {
  return spec as unknown as PrefSpec;
}

// Store accessors are module-level singletons, so the spec list is a stable
// constant — `getConfigValue` takes the config as an argument rather than
// closing over it.
const PREF_SPECS: PrefSpec[] = [
  // 1. Keyboard shortcut overrides
  pref<Record<string, string>>({
    getConfigValue: (c) =>
      (c.keyboard_shortcuts as Record<string, string> | undefined) ?? {},
    isDefault: (v) => Object.keys(v).length === 0,
    readStore: () => useKeyboardShortcutsStore.getState().overrides,
    applyToStore: (v) => useKeyboardShortcutsStore.setState({ overrides: v }),
    subscribe: (cb) => useKeyboardShortcutsStore.subscribe(cb),
    equal: shallowEqualStringRecord,
    toConfig: (v) => ({ keyboard_shortcuts: v }),
  }),
  // 2. Theme variant ("skin")
  pref<string>({
    getConfigValue: (c) => c.theme_variant,
    isDefault: (v) => !v || v === DEFAULT_THEME_VARIANT,
    readStore: () => useUiPreferencesStore.getState().themeVariant,
    // setThemeVariant also updates the localStorage cache used pre-paint.
    applyToStore: (v) => useUiPreferencesStore.getState().setThemeVariant(v),
    subscribe: (cb) => useUiPreferencesStore.subscribe(cb),
    equal: (a, b) => a === b,
    toConfig: (v) => ({ theme_variant: v }),
  }),
  // 3. Custom theme presets (user-added + built-in overrides)
  pref<ThemePreset[]>({
    getConfigValue: (c) => sanitizeStoredPresets(c.theme_presets),
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
  }),
  // 4. Diff view preferences
  pref<DiffViewPrefs>({
    getConfigValue: (c) => readDiffView(c.diff_view),
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
  }),
  // 5. Quick-chat folder favorites
  pref<FolderFavorite[]>({
    getConfigValue: (c) => readFolderFavorites(c.quick_chat_favorites),
    isDefault: (v) => v.length === 0,
    readStore: () => useFolderFavoritesStore.getState().favorites,
    applyToStore: (v) => useFolderFavoritesStore.setState({ favorites: v }),
    subscribe: (cb) => useFolderFavoritesStore.subscribe(cb),
    equal: favoritesEqual,
    toConfig: (v) => ({
      quick_chat_favorites: v as unknown as Config['quick_chat_favorites'],
    }),
  }),
];

export function useConfigPreferenceSync(
  config: Config | null,
  save: (updates: Partial<Config>) => Promise<boolean>
): void {
  const enabled = config != null;

  const seededRef = useRef(false);
  // Last value synced to/from config, per spec (index-aligned with PREF_SPECS).
  // Seeded to non-null on first load; used for echo detection on flush.
  const lastSyncedRef = useRef<unknown[]>(PREF_SPECS.map(() => null));
  // Coalesced updates awaiting the next debounced save.
  const pendingRef = useRef<Partial<Config>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep `save` fresh: it closes over `config`, so a stale copy would PUT an
  // outdated config object and clobber other fields.
  const saveRef = useRef(save);
  saveRef.current = save;

  // Seed-or-hydrate, exactly once, when config first becomes available. All
  // promotions are coalesced into a single save so they can't clobber each
  // other (see the single-batched-save note above).
  useEffect(() => {
    if (!enabled || config == null || seededRef.current) return;
    seededRef.current = true;

    const promote: Partial<Config> = {};
    let hasPromote = false;
    PREF_SPECS.forEach((spec, i) => {
      const configValue = spec.getConfigValue(config);
      const local = spec.readStore();
      if (spec.isDefault(configValue) && !spec.isDefault(local)) {
        // One-time promotion of pre-existing local settings into config.
        Object.assign(promote, spec.toConfig(local));
        lastSyncedRef.current[i] = local;
        hasPromote = true;
      } else {
        lastSyncedRef.current[i] = configValue;
        spec.applyToStore(configValue);
      }
    });
    if (hasPromote) void saveRef.current(promote);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, config]);

  // Flush store changes back to config. Every changed preference funnels into
  // one pending buffer + one debounce timer → exactly one save per window.
  useEffect(() => {
    const flush = () => {
      if (!seededRef.current) return;
      let changed = false;
      PREF_SPECS.forEach((spec, i) => {
        const cur = spec.readStore();
        const last = lastSyncedRef.current[i];
        if (last != null && spec.equal(cur, last)) return;
        lastSyncedRef.current[i] = cur;
        Object.assign(pendingRef.current, spec.toConfig(cur));
        changed = true;
      });
      if (!changed) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        const updates = pendingRef.current;
        pendingRef.current = {};
        void saveRef.current(updates);
      }, FLUSH_DELAY_MS);
    };
    const unsubs = PREF_SPECS.map((spec) => spec.subscribe(flush));
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      unsubs.forEach((unsub) => unsub());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
