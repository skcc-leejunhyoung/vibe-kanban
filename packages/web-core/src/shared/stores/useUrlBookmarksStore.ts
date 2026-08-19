import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type State = {
  bookmarks: string[];
  addBookmark: (url: string) => void;
  removeBookmark: (url: string) => void;
};

export function normalizeBookmarkUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export const useUrlBookmarksStore = create<State>()(
  persist(
    (set) => ({
      bookmarks: [],
      addBookmark: (url) =>
        set((state) => {
          const normalizedUrl = normalizeBookmarkUrl(url);
          return !normalizedUrl || state.bookmarks.includes(normalizedUrl)
            ? state
            : { bookmarks: [...state.bookmarks, normalizedUrl] };
        }),
      removeBookmark: (url) =>
        set((state) => ({
          bookmarks: state.bookmarks.filter((bookmark) => bookmark !== url),
        })),
    }),
    { name: 'url-bookmarks' }
  )
);
