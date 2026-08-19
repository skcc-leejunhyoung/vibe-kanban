import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type UrlBookmark = {
  name: string;
  url: string;
};

type State = {
  bookmarks: UrlBookmark[];
  addBookmark: (url: string, name: string) => void;
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

export function migrateBookmarks(value: unknown): UrlBookmark[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((bookmark) => {
    const stored = bookmark as Partial<UrlBookmark>;
    const url = normalizeBookmarkUrl(
      typeof bookmark === 'string' ? bookmark : (stored?.url ?? '')
    );
    if (!url) return [];
    const name = typeof stored?.name === 'string' ? stored.name.trim() : '';
    return [{ name: name || url, url }];
  });
}

export const useUrlBookmarksStore = create<State>()(
  persist(
    (set) => ({
      bookmarks: [],
      addBookmark: (url, name) =>
        set((state) => {
          const normalizedUrl = normalizeBookmarkUrl(url);
          return !normalizedUrl ||
            state.bookmarks.some((bookmark) => bookmark.url === normalizedUrl)
            ? state
            : {
                bookmarks: [
                  ...state.bookmarks,
                  { name: name.trim() || normalizedUrl, url: normalizedUrl },
                ],
              };
        }),
      removeBookmark: (url) =>
        set((state) => ({
          bookmarks: state.bookmarks.filter((bookmark) => bookmark.url !== url),
        })),
    }),
    {
      name: 'url-bookmarks',
      version: 1,
      migrate: (persisted) => {
        const state = persisted as Partial<State>;
        return { ...state, bookmarks: migrateBookmarks(state.bookmarks) };
      },
    }
  )
);
