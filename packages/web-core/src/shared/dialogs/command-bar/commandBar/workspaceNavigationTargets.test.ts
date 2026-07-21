import { describe, expect, it } from 'vitest';
import { resolveWorkspaceNavigationTargets } from './workspaceNavigationTargets';

describe('resolveWorkspaceNavigationTargets', () => {
  it('deduplicates the cloud mirror of a directly loaded workspace', () => {
    const result = resolveWorkspaceNavigationTargets(
      [{ id: 'local-id', name: 'Same workspace', hostId: null }],
      [
        {
          id: 'cloud-id',
          local_workspace_id: 'local-id',
          host_id: 'self-host',
          name: 'Same workspace',
          archived: false,
        },
      ]
    );

    expect(result).toEqual([
      {
        id: 'local:local-id',
        localWorkspaceId: 'local-id',
        hostId: null,
        name: 'Same workspace',
      },
    ]);
  });

  it('excludes archived cloud workspaces while retaining remote active ones', () => {
    const result = resolveWorkspaceNavigationTargets(
      [],
      [
        {
          id: 'active-cloud-id',
          local_workspace_id: 'active-local-id',
          host_id: 'remote-host',
          name: 'Active remote',
          archived: false,
        },
        {
          id: 'archived-cloud-id',
          local_workspace_id: 'archived-local-id',
          host_id: 'remote-host',
          name: 'Archived remote',
          archived: true,
        },
      ]
    );

    expect(result.map((workspace) => workspace.name)).toEqual([
      'Active remote',
    ]);
  });
});
