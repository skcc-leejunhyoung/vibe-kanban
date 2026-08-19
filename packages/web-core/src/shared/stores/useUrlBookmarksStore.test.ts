import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
});

const { migrateBookmarks, normalizeBookmarkUrl, useUrlBookmarksStore } =
  await import('./useUrlBookmarksStore');

beforeEach(() => useUrlBookmarksStore.setState({ bookmarksByUser: {} }));

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

    addBookmark('user-1', 'https://example.com', 'Example');
    addBookmark('user-1', 'https://example.com/', 'Duplicate');
    addBookmark('user-1', 'javascript:alert(1)', 'Unsafe');
    expect(useUrlBookmarksStore.getState().bookmarksByUser['user-1']).toEqual([
      { name: 'Example', url: 'https://example.com/' },
    ]);

    removeBookmark('user-1', 'https://example.com/');
    expect(useUrlBookmarksStore.getState().bookmarksByUser['user-1']).toEqual(
      []
    );
  });

  it('keeps each user bookmarks isolated', () => {
    const { addBookmark } = useUrlBookmarksStore.getState();

    addBookmark('user-1', 'https://one.example', 'One');
    addBookmark('user-2', 'https://two.example', 'Two');

    expect(useUrlBookmarksStore.getState().bookmarksByUser).toEqual({
      'user-1': [{ name: 'One', url: 'https://one.example/' }],
      'user-2': [{ name: 'Two', url: 'https://two.example/' }],
    });
  });
});
