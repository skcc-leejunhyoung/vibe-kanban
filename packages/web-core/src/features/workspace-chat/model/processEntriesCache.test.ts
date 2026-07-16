import { beforeEach, describe, expect, it } from 'vitest';
import type { PatchType } from 'shared/types';

import {
  clearProcessEntriesCache,
  getCachedProcessEntries,
  processEntriesCacheStats,
  setCachedProcessEntries,
} from './processEntriesCache';

function entries(marker: string, size = 8): PatchType[] {
  return [
    { type: 'STDOUT', content: marker.repeat(size) } as unknown as PatchType,
  ];
}

describe('processEntriesCache', () => {
  beforeEach(() => {
    clearProcessEntriesCache();
  });

  it('round-trips entries by host and process id', () => {
    const value = entries('a');
    setCachedProcessEntries(null, 'p1', value);
    expect(getCachedProcessEntries(null, 'p1')).toBe(value);
    expect(getCachedProcessEntries(null, 'p2')).toBeUndefined();
  });

  it('scopes entries by host id', () => {
    const local = entries('a');
    const remote = entries('b');
    setCachedProcessEntries(null, 'p1', local);
    setCachedProcessEntries('host-a', 'p1', remote);
    expect(getCachedProcessEntries(null, 'p1')).toBe(local);
    expect(getCachedProcessEntries('host-a', 'p1')).toBe(remote);
    expect(getCachedProcessEntries('host-b', 'p1')).toBeUndefined();
  });

  it('replaces existing entries and keeps byte accounting consistent', () => {
    setCachedProcessEntries(null, 'p1', entries('a', 100));
    const { bytes: before } = processEntriesCacheStats();
    setCachedProcessEntries(null, 'p1', entries('b', 10));
    const { size, bytes } = processEntriesCacheStats();
    expect(size).toBe(1);
    expect(bytes).toBeLessThan(before);
    expect(getCachedProcessEntries(null, 'p1')?.[0]).toMatchObject({
      type: 'STDOUT',
    });
  });

  it('skips entries that exceed the per-process byte limit and remembers the rejection', () => {
    // > 4MB serialized
    const huge = entries('x', 5 * 1024 * 1024);
    setCachedProcessEntries(null, 'p1', huge);
    expect(getCachedProcessEntries(null, 'p1')).toBeUndefined();
    expect(processEntriesCacheStats().size).toBe(0);

    // A later (identical) attempt is rejected without re-measuring; even a
    // small payload stays uncacheable for that id — the id is known-bad.
    setCachedProcessEntries(null, 'p1', entries('y'));
    expect(getCachedProcessEntries(null, 'p1')).toBeUndefined();
  });

  it('evicts least recently used processes when over the total budget', () => {
    // ~3MB each: 10 of them (~30MB) fit under the 32MB budget; the 11th
    // pushes past it and must evict exactly the least recently used entry.
    const big = 3 * 1024 * 1024;
    for (let i = 0; i < 10; i++) {
      setCachedProcessEntries(null, `p${i}`, entries('x', big));
    }
    // Touch p0 so p1 becomes the LRU victim.
    expect(getCachedProcessEntries(null, 'p0')).toBeDefined();
    setCachedProcessEntries(null, 'p10', entries('x', big));
    expect(getCachedProcessEntries(null, 'p1')).toBeUndefined();
    expect(getCachedProcessEntries(null, 'p0')).toBeDefined();
    expect(getCachedProcessEntries(null, 'p10')).toBeDefined();
  });
});
