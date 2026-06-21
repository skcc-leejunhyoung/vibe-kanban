import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * User overrides for keyboard shortcuts, persisted to localStorage.
 *
 * Keyed by binding id:
 *  - sequential bindings use their registry `id` (e.g. 'seq-workspace-archive')
 *  - the command bar uses COMMAND_BAR_BINDING_ID ('command-bar')
 *
 * Values are stored in react-hotkeys-hook syntax:
 *  - sequences:  'w>a'
 *  - modifier combos: 'mod+k'
 *
 * Absence of an entry means "use the registry default". This store is the
 * single source of truth for overrides; the registry exposes pure resolvers
 * that take `overrides` as an argument so it never imports this store
 * (avoids an import cycle).
 */
type State = {
  overrides: Record<string, string>;
  setOverride: (id: string, keys: string) => void;
  resetOverride: (id: string) => void;
  resetAll: () => void;
};

export const useKeyboardShortcutsStore = create<State>()(
  persist(
    (set) => ({
      overrides: {},
      setOverride: (id, keys) =>
        set((s) => ({ overrides: { ...s.overrides, [id]: keys } })),
      resetOverride: (id) =>
        set((s) => {
          if (!(id in s.overrides)) return s;
          const next = { ...s.overrides };
          delete next[id];
          return { overrides: next };
        }),
      resetAll: () => set({ overrides: {} }),
    }),
    { name: 'vk-keyboard-shortcuts' }
  )
);
