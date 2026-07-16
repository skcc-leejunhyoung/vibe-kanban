import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearWsSnapshots,
  getWsSnapshot,
  saveWsSnapshot,
} from './wsSnapshotCache';

describe('wsSnapshotCache', () => {
  beforeEach(() => {
    clearWsSnapshots();
  });

  it('returns undefined for unknown or undefined endpoints', () => {
    expect(getWsSnapshot('/api/none')).toBeUndefined();
    expect(getWsSnapshot(undefined)).toBeUndefined();
  });

  it('round-trips a snapshot by exact endpoint', () => {
    const snapshot = { workspaces: { a: 1 } };
    saveWsSnapshot('/api/x', snapshot);
    expect(getWsSnapshot('/api/x')).toBe(snapshot);
    expect(getWsSnapshot('/api/other')).toBeUndefined();
  });

  it('overwrites the previous snapshot for the same endpoint', () => {
    saveWsSnapshot('/api/x', { v: 1 });
    saveWsSnapshot('/api/x', { v: 2 });
    expect(getWsSnapshot('/api/x')).toEqual({ v: 2 });
  });

  it('evicts the least recently saved endpoint beyond the cap', () => {
    for (let i = 0; i < 16; i++) {
      saveWsSnapshot(`/api/${i}`, { i });
    }
    // Re-save /api/0 so it is no longer the oldest.
    saveWsSnapshot('/api/0', { i: 0 });
    saveWsSnapshot('/api/16', { i: 16 });
    expect(getWsSnapshot('/api/0')).toEqual({ i: 0 });
    expect(getWsSnapshot('/api/1')).toBeUndefined();
    expect(getWsSnapshot('/api/16')).toEqual({ i: 16 });
  });

  it('reads do not protect an entry from eviction', () => {
    for (let i = 0; i < 16; i++) {
      saveWsSnapshot(`/api/${i}`, { i });
    }
    expect(getWsSnapshot('/api/0')).toEqual({ i: 0 });
    saveWsSnapshot('/api/16', { i: 16 });
    expect(getWsSnapshot('/api/0')).toBeUndefined();
  });
});
