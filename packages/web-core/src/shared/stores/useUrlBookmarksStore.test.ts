import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
});

const { normalizeBookmarkUrl, useUrlBookmarksStore } = await import(
  './useUrlBookmarksStore'
);

beforeEach(() => useUrlBookmarksStore.setState({ bookmarks: [] }));

describe('URL bookmarks', () => {
  it('accepts only absolute HTTP URLs', () => {
    expect(normalizeBookmarkUrl(' https://example.com/path ')).toBe(
      'https://example.com/path'
    );
    expect(normalizeBookmarkUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeBookmarkUrl('example.com')).toBeNull();
  });

  it('adds each URL once and removes it', () => {
    const { addBookmark, removeBookmark } = useUrlBookmarksStore.getState();

    addBookmark('https://example.com');
    addBookmark('https://example.com/');
    addBookmark('javascript:alert(1)');
    expect(useUrlBookmarksStore.getState().bookmarks).toEqual([
      'https://example.com/',
    ]);

    removeBookmark('https://example.com/');
    expect(useUrlBookmarksStore.getState().bookmarks).toEqual([]);
  });
});
