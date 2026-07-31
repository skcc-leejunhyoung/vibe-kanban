import { describe, expect, it } from 'vitest';
import { formatDateShortWithTime } from '@/shared/lib/date';
import type { SidebarWorkspace } from '@/shared/hooks/useWorkspaces';
import type { Workspace as RemoteWorkspace } from 'shared/remote-types';
import {
  buildLinkedWorkspaceSelectionItems,
  findLinkedWorkspaceSummary,
  type LinkedWorkspace,
} from './selectLinkedWorkspace';

function makeRemoteWorkspace(
  overrides: Partial<RemoteWorkspace> = {}
): LinkedWorkspace {
  return {
    id: 'remote-workspace',
    project_id: 'project',
    owner_user_id: 'user',
    host_id: 'host-a',
    issue_id: 'issue',
    local_workspace_id: 'local-workspace',
    name: 'Review workspace',
    archived: false,
    pinned: false,
    created_at: '2026-07-20T00:00:00Z',
    updated_at: '2026-07-21T00:00:00Z',
    ...overrides,
  };
}

function makeWorkspaceSummary(
  overrides: Partial<SidebarWorkspace> = {}
): SidebarWorkspace {
  return {
    id: 'local-workspace',
    name: 'Review workspace',
    branch: 'feature/review',
    createdAt: '2026-07-20T00:00:00Z',
    updatedAt: '2026-07-22T00:00:00Z',
    description: '',
    hostId: 'host-a',
    ...overrides,
  };
}

describe('linked workspace selection', () => {
  it('matches the workspace summary on the same host', () => {
    const workspace = makeRemoteWorkspace();
    const otherHost = makeWorkspaceSummary({
      hostId: 'host-b',
      isArchived: true,
    });
    const sameHost = makeWorkspaceSummary({
      hostId: 'host-a',
      isArchived: false,
    });

    expect(findLinkedWorkspaceSummary(workspace, [otherHost, sameHost])).toBe(
      sameHost
    );
  });

  it('includes the caller prefix and local status activity', () => {
    const latestActivity = '2026-07-23T02:34:00Z';
    const workspace = makeRemoteWorkspace();
    const [item] = buildLinkedWorkspaceSelectionItems({
      workspaces: [workspace],
      workspaceSummaries: [
        makeWorkspaceSummary({
          latestProcessStartedAt: latestActivity,
          isArchived: false,
        }),
      ],
      getDescriptionPrefix: () => 'VK-123',
    });

    expect(item.action.description).toBe(
      `VK-123 · Active · ${formatDateShortWithTime(latestActivity)}`
    );
  });

  it('falls back to remote archived metadata without a local summary', () => {
    const updatedAt = '2026-07-24T03:45:00Z';
    const [item] = buildLinkedWorkspaceSelectionItems({
      workspaces: [
        makeRemoteWorkspace({
          archived: true,
          updated_at: updatedAt,
        }),
      ],
      workspaceSummaries: [],
    });

    expect(item.action.description).toBe(
      `Archived · ${formatDateShortWithTime(updatedAt)}`
    );
  });
});
