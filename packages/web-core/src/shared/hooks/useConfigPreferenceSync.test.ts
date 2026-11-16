import { describe, expect, it } from 'vitest';
import {
  mayPromoteLocalPreferences,
  readFolderFavorites,
} from './useConfigPreferenceSync';

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

describe('promoting browser-local preferences into a config', () => {
  it('keeps the one-time promotion for a single-owner config', () => {
    expect(mayPromoteLocalPreferences(null, undefined)).toBe(true);
    expect(mayPromoteLocalPreferences('user-a', undefined)).toBe(true);
  });

  it('promotes for the account the browser values belong to', () => {
    expect(mayPromoteLocalPreferences(null, 'user-a')).toBe(true);
    expect(mayPromoteLocalPreferences('user-a', 'user-a')).toBe(true);
  });

  it("never promotes one account's leftovers into another account", () => {
    expect(mayPromoteLocalPreferences('user-a', 'user-b')).toBe(false);
  });
});
