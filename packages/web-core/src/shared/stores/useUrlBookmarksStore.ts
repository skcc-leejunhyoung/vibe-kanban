import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type UrlBookmark = {
  name: string;
  url: string;
};

type State = {
  bookmarksByUser: Record<string, UrlBookmark[]>;
  addBookmark: (userId: string | null, url: string, name: string) => void;
  removeBookmark: (userId: string | null, url: string) => void;
};

const LOCAL_USER_KEY = 'local';

export function bookmarkUserKey(userId: string | null): string {
  return userId ?? LOCAL_USER_KEY;
}

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
      bookmarksByUser: {},
      addBookmark: (userId, url, name) =>
        set((state) => {
          const normalizedUrl = normalizeBookmarkUrl(url);
          const key = bookmarkUserKey(userId);
          const bookmarks = state.bookmarksByUser[key] ?? [];
          return !normalizedUrl ||
            bookmarks.some((bookmark) => bookmark.url === normalizedUrl)
            ? state
            : {
                bookmarksByUser: {
                  ...state.bookmarksByUser,
                  [key]: [
                    ...bookmarks,
                    { name: name.trim() || normalizedUrl, url: normalizedUrl },
                  ],
                },
              };
        }),
      removeBookmark: (userId, url) =>
        set((state) => {
          const key = bookmarkUserKey(userId);
          return {
            bookmarksByUser: {
              ...state.bookmarksByUser,
              [key]: (state.bookmarksByUser[key] ?? []).filter(
                (bookmark) => bookmark.url !== url
              ),
            },
          };
        }),
    }),
    {
      name: 'url-bookmarks',
      version: 2,
      migrate: (persisted) => {
        const state = persisted as Partial<State> & { bookmarks?: unknown };
        return {
          ...state,
          bookmarksByUser: state.bookmarksByUser ?? {
            [LOCAL_USER_KEY]: migrateBookmarks(state.bookmarks),
          },
        };
      },
    }
  )
);
