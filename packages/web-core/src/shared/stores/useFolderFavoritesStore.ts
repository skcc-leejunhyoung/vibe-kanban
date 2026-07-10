import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface FolderFavorite {
  /** Absolute folder path — the stable identity of a favorite. */
  path: string;
  /** Display label (repo display name / folder name) shown on the chip. */
  name: string;
}

type State = {
  favorites: FolderFavorite[];
  addFavorite: (favorite: FolderFavorite) => void;
  removeFavorite: (path: string) => void;
  isFavorite: (path: string) => boolean;
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
          if (state.favorites.some((f) => f.path === favorite.path)) {
            return state;
          }
          return { favorites: [...state.favorites, favorite] };
        }),
      removeFavorite: (path) =>
        set((state) => ({
          favorites: state.favorites.filter((f) => f.path !== path),
        })),
      isFavorite: (path) => get().favorites.some((f) => f.path === path),
    }),
    {
      name: 'quick-chat-folder-favorites',
      partialize: (state) => ({ favorites: state.favorites }),
    }
  )
);
