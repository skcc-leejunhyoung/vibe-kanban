import { describe, expect, it } from 'vitest';
import { branchStatusKeys } from './useBranchStatus';
import { prCommentsKeys } from './usePrComments';
import { workspaceDevServerKeys } from './useWorkspaceDevServers';
import { workspaceCreateDefaultsKeys } from './useWorkspaceCreateDefaults';

describe('host-scoped workspace query keys', () => {
  it('separates matching workspace data across hosts', () => {
    expect(branchStatusKeys.byWorkspace('workspace-1', 'host-1')).not.toEqual(
      branchStatusKeys.byWorkspace('workspace-1', 'host-2')
    );
    expect(
      prCommentsKeys.byWorkspace('workspace-1', 'repo-1', 42, 'host-1')
    ).not.toEqual(
      prCommentsKeys.byWorkspace('workspace-1', 'repo-1', 42, 'host-2')
    );
    expect(
      workspaceDevServerKeys.byWorkspace('workspace-1', 'host-1')
    ).not.toEqual(workspaceDevServerKeys.byWorkspace('workspace-1', 'host-2'));
    expect(
      workspaceCreateDefaultsKeys.byWorkspace('workspace-1', 'host-1')
    ).not.toEqual(
      workspaceCreateDefaultsKeys.byWorkspace('workspace-1', 'host-2')
    );
  });
});
