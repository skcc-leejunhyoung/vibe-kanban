import { useMemo, useRef } from 'react';

export function groupBy<T>(
  rows: readonly T[],
  keysOf: (row: T) => string | null | string[]
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const keys = keysOf(row);
    if (keys === null) continue;
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const group = map.get(key);
      if (group) group.push(row);
      else map.set(key, [row]);
    }
  }
  return map;
}

/**
 * Keeps a group's previous array when its members are unchanged (by `isSame`,
 * identity by default), so a change to one key's rows doesn't hand every
 * other key a new array. Consumers can then memoize on a single group.
 *
 * Reads the previous result during render; the React Compiler skips such
 * hooks, which is fine because they are memoized by hand.
 */
export function useStableGroups<T>(
  groups: Map<string, T[]>,
  isSame: (before: T, after: T) => boolean = Object.is
): Map<string, T[]> {
  const previous = useRef<Map<string, T[]>>(new Map());
  return useMemo(() => {
    const before = previous.current;
    for (const [key, group] of groups) {
      const prior = before.get(key);
      if (
        prior &&
        prior.length === group.length &&
        prior.every((row, index) => isSame(row, group[index]))
      ) {
        groups.set(key, prior);
      }
    }
    previous.current = groups;
    return groups;
  }, [groups, isSame]);
}

/** `groupBy` memoized on `rows`, with per-key array identity kept stable. */
export function useGroupedBy<T>(
  rows: readonly T[],
  keysOf: (row: T) => string | null | string[]
): Map<string, T[]> {
  return useStableGroups(useMemo(() => groupBy(rows, keysOf), [rows, keysOf]));
}
