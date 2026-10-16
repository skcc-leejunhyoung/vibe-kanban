import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  saveRemoteAccessDraft,
  takeRemoteAccessDraft,
} from './remoteAccessDraft';
const mock = vi.hoisted(() => ({ server: 'https://central.test' }));
vi.mock('@/shared/lib/remoteApi', () => ({
  getRemoteApiUrl: () => mock.server,
}));
let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  mock.server = 'https://central.test';
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('remote settings reauthentication return', () => {
  it('restores the host and unsubmitted target exactly once without restoring consent', () => {
    saveRemoteAccessDraft('alice', 'host', 'target');
    expect(takeRemoteAccessDraft('alice')).toEqual({
      hostId: 'host',
      accountId: 'target',
    });
    expect(takeRemoteAccessDraft('alice')).toBeNull();
    expect([...storage.values()]).toEqual([]);
  });
  it('does not expose a previous account draft after switching accounts', () => {
    saveRemoteAccessDraft('alice', 'host', 'target');
    expect(takeRemoteAccessDraft('bob')).toBeNull();
    expect(takeRemoteAccessDraft('alice')).toBeNull();
  });
  it('cannot carry a draft between different central servers', () => {
    saveRemoteAccessDraft('alice', 'host', 'target');
    mock.server = 'https://other.test';
    expect(takeRemoteAccessDraft('alice')).toBeNull();
  });
  it('expires after ten minutes instead of reopening an old sharing form', () => {
    vi.useFakeTimers();
    saveRemoteAccessDraft('alice', 'host', 'target');
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    expect(takeRemoteAccessDraft('alice')).toBeNull();
  });
  it('ignores malformed data and unavailable browser storage', () => {
    saveRemoteAccessDraft('alice', 'host', 'target');
    storage.set([...storage.keys()][0], '{broken');
    expect(takeRemoteAccessDraft('alice')).toBeNull();
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(() =>
      saveRemoteAccessDraft('alice', 'host', 'target')
    ).not.toThrow();
    expect(takeRemoteAccessDraft('alice')).toBeNull();
  });
});
