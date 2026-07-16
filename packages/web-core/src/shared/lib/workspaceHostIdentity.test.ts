import { describe, expect, it } from 'vitest';
import { findRemoteWorkspaceByLocalIdentity } from './workspaceHostIdentity';

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
