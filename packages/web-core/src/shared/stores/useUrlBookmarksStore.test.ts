import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
});

const { migrateBookmarks, normalizeBookmarkUrl, useUrlBookmarksStore } =
  await import('./useUrlBookmarksStore');

beforeEach(() => useUrlBookmarksStore.setState({ bookmarks: [] }));

describe('URL bookmarks', () => {
  it('accepts only absolute HTTP URLs', () => {
    expect(normalizeBookmarkUrl(' https://example.com/path ')).toBe(
      'https://example.com/path'
    );
    expect(normalizeBookmarkUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeBookmarkUrl('example.com')).toBeNull();
  });

  it('migrates URL-only bookmarks without losing them', () => {
    expect(
      migrateBookmarks(['https://example.com', 'javascript:alert(1)'])
    ).toEqual([{ name: 'https://example.com/', url: 'https://example.com/' }]);
  });

  it('adds each URL once and removes it', () => {
    const { addBookmark, removeBookmark } = useUrlBookmarksStore.getState();

    addBookmark('https://example.com', 'Example');
    addBookmark('https://example.com/', 'Duplicate');
    addBookmark('javascript:alert(1)', 'Unsafe');
    expect(useUrlBookmarksStore.getState().bookmarks).toEqual([
      { name: 'Example', url: 'https://example.com/' },
    ]);

    removeBookmark('https://example.com/');
    expect(useUrlBookmarksStore.getState().bookmarks).toEqual([]);
  });
});
