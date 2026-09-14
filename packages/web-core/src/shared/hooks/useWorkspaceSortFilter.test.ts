import { expect, it, vi } from 'vitest';
import { createWorkspaceSorter } from './useWorkspaceSortFilter';
import type { Workspace } from './useWorkspaces';
import type {
  WorkspaceSortBy,
  WorkspaceSortOrder,
} from '../stores/useUiPreferencesStore';

function workspace(id: number): Workspace {
  return {
    id: String(id),
    name: `Workspace ${id % 3}`,
    branch: 'branch',
    description: '',
    hostId: null,
    isPinned: false,
    createdAt: new Date(id * 1000).toISOString(),
    updatedAt: '',
    latestProcessStartedAt: new Date(((id * 163) % 1000) * 1000).toISOString(),
    latestProcessCompletedAt: new Date(
      ((id * 163) % 1000) * 1000 + 100
    ).toISOString(),
  };
}

// Preserve the previous comparator as the oracle, including nulls and ties.
function fullSort(
  rows: Workspace[],
  by: WorkspaceSortBy,
  order: WorkspaceSortOrder
) {
  const timestamp = (row: Workspace) => {
    const parse = (value?: string) => {
      const result = value ? Date.parse(value) : NaN;
      return Number.isNaN(result) ? null : result;
    };
    if (by === 'created_at') return parse(row.createdAt);
    const started = parse(row.latestProcessStartedAt);
    const completed = parse(row.latestProcessCompletedAt);
    if (started === null) return completed;
    if (completed === null) return started;
    return Math.max(started, completed);
  };
  return [...rows].sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    const aTime = timestamp(a);
    const bTime = timestamp(b);
    if (aTime === null && bTime === null) return a.name.localeCompare(b.name);
    if (aTime === null) return -1;
    if (bTime === null) return 1;
    if (aTime === bTime) return a.name.localeCompare(b.name);
    return order === 'asc' ? aTime - bTime : bTime - aTime;
  });
}

it('preserves full sorting across dates, pinning, names, filtering, hosts and order changes', () => {
  const sort = createWorkspaceSorter();
  let rows = Array.from({ length: 18 }, (_, i) => workspace(i));
  rows[1] = { ...rows[0], hostId: 'another-host' };
  rows[2] = {
    ...rows[2],
    createdAt: 'invalid',
    latestProcessStartedAt: undefined,
    latestProcessCompletedAt: undefined,
  };
  rows[3] = { ...rows[3], latestProcessCompletedAt: 'invalid' };
  rows[4] = { ...rows[4], latestProcessStartedAt: undefined };
  for (const by of ['updated_at', 'created_at'] as const) {
    for (const order of ['asc', 'desc'] as const) {
      for (let i = 0; i < 40; i++) {
        const index = i % rows.length;
        rows = rows.map((row, n) =>
          n !== index
            ? row
            : {
                ...row,
                name: `Name ${i % 5}`,
                isPinned: i % 3 === 0,
                latestProcessCompletedAt: new Date(i * 500).toISOString(),
              }
        );
        if (i % 5 === 0) rows.reverse();
        const filtered = i % 2 ? rows : rows.filter((_, n) => n % 2);
        expect(sort(filtered, by, order)).toEqual(
          fullSort(filtered, by, order)
        );
      }
    }
  }
  expect(sort([], 'updated_at', 'desc')).toEqual([]);
});

it('avoids sorting and timestamp parsing for a status-only patch in either list', () => {
  const activeSort = createWorkspaceSorter();
  const archivedSort = createWorkspaceSorter();
  const rows = Array.from({ length: 1000 }, (_, i) => workspace(i));
  const archived = [workspace(1001)];
  const parse = vi.spyOn(Date, 'parse');
  const sorting = vi.spyOn(Array.prototype, 'sort');
  try {
    const expected = fullSort(rows, 'updated_at', 'desc');
    const beforeParses = parse.mock.calls.length;
    parse.mockClear();
    const initial = activeSort(rows, 'updated_at', 'desc');
    const initialParses = parse.mock.calls.length;
    archivedSort(archived, 'updated_at', 'desc');
    const patched = rows.map((row, i) =>
      i === 0 ? { ...row, isRunning: true } : row
    );
    parse.mockClear();
    sorting.mockClear();
    const next = activeSort(patched, 'updated_at', 'desc');
    archivedSort(archived, 'updated_at', 'desc');
    const patchParses = parse.mock.calls.length;
    const patchSorts = sorting.mock.calls.length;
    expect(initial).toEqual(expected);
    expect(patchParses).toBe(0);
    expect(patchSorts).toBe(0);
    expect(next.map((row) => row.id)).toEqual(initial.map((row) => row.id));
    expect(next.find((row) => row.id === '0')?.isRunning).toBe(true);
    expect(
      next.filter((row) => row.id !== '0').every((row) => initial.includes(row))
    ).toBe(true);
    const latest = patched.map((row, i) =>
      i === 0 ? { ...row, latestProcessStartedAt: '2030-01-01T00:00:00Z' } : row
    );
    parse.mockClear();
    expect(activeSort(latest, 'updated_at', 'desc')[0].id).toBe('0');
    expect(parse).toHaveBeenCalledTimes(2);
    console.info('SKC-4776 sidebar', {
      rows: 1000,
      beforeParses,
      initialParses,
      patchParses,
      patchSorts,
    });
  } finally {
    parse.mockRestore();
    sorting.mockRestore();
  }
});
