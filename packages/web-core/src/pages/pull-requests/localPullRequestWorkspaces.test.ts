import { describe, expect, it } from 'vitest';
import type { SidebarWorkspace } from '@/shared/hooks/useWorkspaces';
import { findLocalPullRequestWorkspaces } from './localPullRequestWorkspaces';

function makeWorkspace(
  id: string,
  prUrl?: string,
  hostId: string | null = null
): SidebarWorkspace {
  return {
    id,
    name: id,
    branch: 'main',
    createdAt: '2026-08-13T00:00:00Z',
    updatedAt: '2026-08-13T00:00:00Z',
    description: '',
    prUrl,
    hostId,
  };
}

describe('findLocalPullRequestWorkspaces', () => {
  it('finds PR-linked Quick Chat workspaces on every loaded host', () => {
    const workspaces = [
      makeWorkspace('quick-chat', 'https://github.com/acme/repo/pull/42/'),
      makeWorkspace(
        'remote-quick-chat',
        'https://github.com/ACME/repo/pull/42',
        'host-b'
      ),
      makeWorkspace('other', 'https://github.com/acme/repo/pull/43'),
    ];

    expect(
      findLocalPullRequestWorkspaces(
        'https://github.com/acme/repo/pull/42',
        workspaces
      ).map(({ id }) => id)
    ).toEqual(['quick-chat', 'remote-quick-chat']);
  });
});
