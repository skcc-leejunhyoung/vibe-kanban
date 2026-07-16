import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface FolderFavorite {
  /** Absolute folder path — the stable identity of a favorite. */
  path: string;
  /** Display label (repo display name / folder name) shown on the chip. */
  name: string;
  /** Host whose filesystem owns this path. `null` is this machine. */
  hostId?: string | null;
}

type State = {
  favorites: FolderFavorite[];
  addFavorite: (favorite: FolderFavorite) => void;
  removeFavorite: (path: string, hostId?: string | null) => void;
  isFavorite: (path: string, hostId?: string | null) => boolean;
};

/**
 * Client-side list of "favorite" folders for Quick chat. Persisted to
 * localStorage (per-origin), mirroring the other web-core preference stores.
 * Keeps quick chat friction-free: pin the folders you launch agents in most
 * and one click reselects them, no folder picker round-trip.
 */
export const useFolderFavoritesStore = create<State>()(
  persist(
    (set, get) => ({
      favorites: [],
      addFavorite: (favorite) =>
        set((state) => {
          if (
            state.favorites.some(
              (f) =>
                f.path === favorite.path &&
                (f.hostId ?? null) === (favorite.hostId ?? null)
            )
          ) {
            return state;
          }
          return { favorites: [...state.favorites, favorite] };
        }),
      removeFavorite: (path, hostId = null) =>
        set((state) => ({
          favorites: state.favorites.filter(
            (f) => f.path !== path || (f.hostId ?? null) !== (hostId ?? null)
          ),
        })),
      isFavorite: (path, hostId = null) =>
        get().favorites.some(
          (f) => f.path === path && (f.hostId ?? null) === (hostId ?? null)
        ),
    }),
    {
      name: 'quick-chat-folder-favorites',
      partialize: (state) => ({ favorites: state.favorites }),
    }
  )
);
