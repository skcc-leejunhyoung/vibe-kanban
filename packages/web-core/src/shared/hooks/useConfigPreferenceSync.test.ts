import { describe, expect, it } from 'vitest';
import { readFolderFavorites } from './useConfigPreferenceSync';

describe('readFolderFavorites', () => {
  it('preserves the host identity for remote favorites', () => {
    expect(
      readFolderFavorites([
        { path: '/repo/local', name: 'local' },
        { path: '/repo/remote', name: 'remote', hostId: 'host-1' },
        { path: '/repo/current', name: 'current', hostId: null },
      ])
    ).toEqual([
      { path: '/repo/local', name: 'local' },
      { path: '/repo/remote', name: 'remote', hostId: 'host-1' },
      { path: '/repo/current', name: 'current', hostId: null },
    ]);
  });

  it('rejects favorites with an invalid host identity', () => {
    expect(
      readFolderFavorites([
        { path: '/repo/valid', name: 'valid', hostId: 'host-1' },
        { path: '/repo/invalid', name: 'invalid', hostId: 123 },
      ])
    ).toEqual([{ path: '/repo/valid', name: 'valid', hostId: 'host-1' }]);
  });
});
