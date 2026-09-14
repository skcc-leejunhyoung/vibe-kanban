import { describe, expect, it } from 'vitest';
import type { WorkspaceWithStatus } from 'shared/types';
import {
  combineRemoteWorkspaceStreams,
  getHostWorkspaceKey,
  materializeHostWorkspaceStream,
  resolveOnlineWorkspaceStreamHostIds,
  resolveSnapshotHostIds,
  type SidebarWorkspace,
  type UseWorkspacesResult,
} from './useWorkspaces';

describe('resolveOnlineWorkspaceStreamHostIds', () => {
  const hosts = [
    { id: 'host-a', status: 'online' },
    { id: 'host-b', status: 'offline' },
  ];

  it('returns no host endpoints when PR-only mode disables streams', () => {
    expect(resolveOnlineWorkspaceStreamHostIds(hosts, false)).toEqual([]);
  });

  it('returns only online hosts when a workspace pane needs streams', () => {
    expect(resolveOnlineWorkspaceStreamHostIds(hosts, true)).toEqual([
      'host-a',
    ]);
  });
});

function sidebarWorkspace(id: string, hostId: string): SidebarWorkspace {
  return {
    id,
    name: id,
    branch: 'develop',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    description: '',
    hostId,
  };
}

function hostResult(
  hostId: string,
  activeIds: string[],
  archivedIds: string[] = []
): UseWorkspacesResult {
  const workspaces = activeIds.map((id) => sidebarWorkspace(id, hostId));
  const archivedWorkspaces = archivedIds.map((id) => ({
    ...sidebarWorkspace(id, hostId),
    isArchived: true,
  }));
  const workspaceRecordsById = Object.fromEntries(
    [...activeIds, ...archivedIds].map((id) => [
      getHostWorkspaceKey(id, hostId),
      { id } as WorkspaceWithStatus,
    ])
  );

  return {
    workspaces,
    archivedWorkspaces,
    workspaceRecordsById,
    isLoading: false,
    isConnected: true,
    error: null,
  };
}

describe('combineRemoteWorkspaceStreams', () => {
  it('combines each online host stream exactly once', () => {
    const result = combineRemoteWorkspaceStreams(
      new Map([
        ['host-a', hostResult('host-a', ['a-1'], ['a-2'])],
        ['host-b', hostResult('host-b', ['b-1'])],
      ]),
      ['host-a', 'host-b']
    );

    expect(result.workspaces.map(({ id, hostId }) => [id, hostId])).toEqual([
      ['a-1', 'host-a'],
      ['b-1', 'host-b'],
    ]);
    expect(
      result.archivedWorkspaces.map(({ id, hostId }) => [id, hostId])
    ).toEqual([['a-2', 'host-a']]);
    expect(Object.keys(result.workspaceRecordsById)).toEqual([
      'host-a:a-1',
      'host-a:a-2',
      'host-b:b-1',
    ]);
  });

  it('keeps identical workspace IDs isolated by host', () => {
    const result = combineRemoteWorkspaceStreams(
      new Map([
        ['host-a', hostResult('host-a', ['same-id'])],
        ['host-b', hostResult('host-b', ['same-id'])],
      ]),
      ['host-a', 'host-b']
    );

    expect(Object.keys(result.workspaceRecordsById)).toEqual([
      'host-a:same-id',
      'host-b:same-id',
    ]);
  });

  it('waits for every online host stream to finish its initial snapshot', () => {
    const loadingHost = {
      ...hostResult('host-b', []),
      isLoading: true,
      isConnected: false,
    };
    const result = combineRemoteWorkspaceStreams(
      new Map([
        ['host-a', hostResult('host-a', ['a-1'])],
        ['host-b', loadingHost],
      ]),
      ['host-a', 'host-b']
    );

    expect(result.isLoading).toBe(true);
    expect(result.isConnected).toBe(false);
  });

  it('does not stay loading when there are no online hosts', () => {
    const result = combineRemoteWorkspaceStreams(new Map(), []);

    expect(result.isLoading).toBe(false);
    expect(result.isConnected).toBe(false);
    expect(result.workspaces).toEqual([]);
  });

  it('stays loading until every online host has registered its stream', () => {
    const result = combineRemoteWorkspaceStreams(
      new Map([['host-a', hostResult('host-a', ['a-1'])]]),
      ['host-a', 'host-b']
    );

    expect(result.isLoading).toBe(true);
  });
});

describe('resolveSnapshotHostIds', () => {
  it('snapshots every online remote host when the route is on the local machine', () => {
    // /workspaces route: local machine owns the live `current` stream.
    expect(resolveSnapshotHostIds(['i9', 'other'], null)).toEqual([
      'i9',
      'other',
    ]);
  });

  it('adds the local machine as a snapshot when the route is on a remote host', () => {
    // /hosts/i9/... route: i9 owns `current`, so it is excluded and the local
    // machine (null) must be pulled in so its workspaces stay visible.
    expect(resolveSnapshotHostIds(['i9'], 'i9')).toEqual([null]);
  });

  it('excludes the route host but keeps other remote hosts and the local machine', () => {
    expect(resolveSnapshotHostIds(['i9', 'other'], 'i9')).toEqual([
      'other',
      null,
    ]);
  });
});

describe('materializeHostWorkspaceStream', () => {
  it('splits one unfiltered host stream into active and archived lists', () => {
    const base = {
      name: 'Workspace',
      branch: 'develop',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      pinned: false,
      is_running: false,
    };
    const result = materializeHostWorkspaceStream(
      {
        active: {
          ...base,
          id: 'active',
          archived: false,
        } as WorkspaceWithStatus,
        archived: {
          ...base,
          id: 'archived',
          archived: true,
        } as WorkspaceWithStatus,
      },
      new Map(),
      new Map(),
      'host-a'
    );

    expect(result.workspaces.map((workspace) => workspace.id)).toEqual([
      'active',
    ]);
    expect(result.archivedWorkspaces.map((workspace) => workspace.id)).toEqual([
      'archived',
    ]);
    expect(
      [...result.workspaces, ...result.archivedWorkspaces].every(
        (workspace) => workspace.hostId === 'host-a'
      )
    ).toBe(true);
  });
});

describe('sidebar reference and ordering cache', () => {
  it('preserves unchanged rows across status/summary patches, sorting ties, pinning and host changes', async () => {
    const { createSidebarWorkspaceList, toSidebarWorkspace } = await import(
      './useWorkspaces'
    );
    const select = createSidebarWorkspaceList();
    const record = (id: string, createdAt: string, pinned = false) =>
      ({
        id,
        name: id,
        branch: id,
        created_at: createdAt,
        updated_at: createdAt,
        pinned,
        archived: false,
        is_running: false,
      }) as WorkspaceWithStatus;
    const records = {
      a: record('a', '2026-09-01T00:00:00Z'),
      b: record('b', '2026-09-02T00:00:00Z'),
      c: record('c', '2026-09-02T00:00:00Z'),
    };
    const summaries = new Map();
    const original = select(records, summaries, null);
    expect(original.map((row) => row.id)).toEqual(['b', 'c', 'a']);
    const patched = select(
      { ...records, a: { ...records.a, is_running: true } },
      summaries,
      null
    );
    expect(patched[0]).toBe(original[0]);
    expect(patched[1]).toBe(original[1]);
    expect(patched[2]).not.toBe(original[2]);
    const pinned = select(
      { ...records, a: { ...records.a, pinned: true } },
      summaries,
      null
    );
    expect(pinned.map((row) => row.id)).toEqual(['a', 'b', 'c']);
    const reordered = select(
      { c: records.c, b: records.b, a: records.a },
      summaries,
      null
    );
    expect(reordered.map((row) => row.id)).toEqual(['c', 'b', 'a']);
    const remote = select(records, summaries, 'host-b');
    expect(remote.every((row) => row.hostId === 'host-b')).toBe(true);
    expect(remote[0]).not.toBe(original[0]);
    const summary = {
      files_changed: 3,
    } as import('shared/types').WorkspaceSummary;
    const withSummary = toSidebarWorkspace(records.a, summary, 'host-b');
    expect(toSidebarWorkspace(records.a, summary, 'host-b')).toBe(withSummary);
    expect(
      toSidebarWorkspace(records.a, { ...summary, files_changed: 4 }, 'host-b')
        .filesChanged
    ).toBe(4);
    expect(select({}, summaries, null)).toEqual([]);
  });

  it('uses the same reference cache for remote active and archived rows', async () => {
    const { createSidebarWorkspaceList } = await import('./useWorkspaces');
    const select = createSidebarWorkspaceList();
    const a = {
      id: 'a',
      created_at: '2026-09-01T00:00:00Z',
      pinned: false,
      archived: false,
    } as WorkspaceWithStatus;
    const b = { ...a, id: 'b', archived: true };
    const first = materializeHostWorkspaceStream(
      { a, b },
      new Map(),
      new Map(),
      'host',
      select
    );
    const next = materializeHostWorkspaceStream(
      { a: { ...a, is_running: true }, b },
      new Map(),
      new Map(),
      'host',
      select
    );
    expect(next.archivedWorkspaces[0]).toBe(first.archivedWorkspaces[0]);
    expect(next.workspaces[0].isRunning).toBe(true);
    expect(next.workspaceRecordsById['host:b']).toBe(b);
  });
});
