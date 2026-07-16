import { describe, expect, it } from 'vitest';
import type { WorkspaceWithStatus } from 'shared/types';
import {
  combineRemoteWorkspaceStreams,
  materializeHostWorkspaceStream,
  type SidebarWorkspace,
  type UseWorkspacesResult,
} from './useWorkspaces';

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
      id,
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
      'a-1',
      'a-2',
      'b-1',
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
