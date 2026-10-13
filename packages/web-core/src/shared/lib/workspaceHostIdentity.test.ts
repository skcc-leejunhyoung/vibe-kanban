import { describe, expect, it } from 'vitest';
import {
  findRemoteWorkspaceByLocalIdentity,
  foldSelfHostWorkspaces,
} from './workspaceHostIdentity';

const workspaces = [
  { id: 'cloud-a', local_workspace_id: 'workspace-a', host_id: 'host-a' },
  { id: 'cloud-b', local_workspace_id: 'workspace-b', host_id: 'host-b' },
];

describe('findRemoteWorkspaceByLocalIdentity', () => {
  it('uses the globally unique local id for the current local machine', () => {
    expect(
      findRemoteWorkspaceByLocalIdentity(workspaces, 'workspace-a', null)?.id
    ).toBe('cloud-a');
  });

  it('keeps remote routes strictly scoped to their owner host', () => {
    expect(
      findRemoteWorkspaceByLocalIdentity(workspaces, 'workspace-a', 'host-b')
    ).toBeUndefined();
    expect(
      findRemoteWorkspaceByLocalIdentity(workspaces, 'workspace-a', 'host-a')
        ?.id
    ).toBe('cloud-a');
  });
});

describe('foldSelfHostWorkspaces', () => {
  const rows = [
    { id: 'a', host_id: 'self-host' },
    { id: 'b', host_id: 'other-host' },
    { id: 'c', host_id: null },
  ];

  it('folds rows owned by this machine to the local host and keeps the rest', () => {
    expect(foldSelfHostWorkspaces(rows, 'self-host')).toEqual([
      { id: 'a', host_id: null },
      { id: 'b', host_id: 'other-host' },
      { id: 'c', host_id: null },
    ]);
  });

  it('returns the same array when the self id is unknown or absent', () => {
    expect(foldSelfHostWorkspaces(rows, null)).toBe(rows);
    expect(foldSelfHostWorkspaces(rows, 'nobody')).toBe(rows);
  });
});
