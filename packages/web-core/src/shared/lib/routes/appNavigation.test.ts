import { describe, expect, it } from 'vitest';
import {
  applyNavigationTransition,
  buildWorkspacePath,
  collapseSelfHostId,
  resolveDestinationHostId,
  resolveLocalHostId,
} from './appNavigation';

describe('buildWorkspacePath', () => {
  it('builds a local workspace path', () => {
    expect(buildWorkspacePath('workspace/id')).toBe(
      '/workspaces/workspace%2Fid'
    );
  });

  it('builds a host-scoped workspace path', () => {
    expect(buildWorkspacePath('workspace/id', 'host/id')).toBe(
      '/hosts/host%2Fid/workspaces/workspace%2Fid'
    );
  });
});

describe('applyNavigationTransition', () => {
  it('keeps the destination host when no host override is provided', () => {
    expect(
      applyNavigationTransition({ kind: 'workspaces', hostId: 'current-host' })
    ).toEqual({ kind: 'workspaces', hostId: 'current-host' });
  });

  it('switches workspace navigation to the selected remote host', () => {
    expect(
      applyNavigationTransition(
        { kind: 'workspace', workspaceId: 'workspace' },
        { hostId: 'next-host' }
      )
    ).toEqual({
      kind: 'workspace',
      workspaceId: 'workspace',
      hostId: 'next-host',
    });
  });

  it('switches workspace navigation to the local machine', () => {
    expect(
      applyNavigationTransition(
        { kind: 'workspaces', hostId: 'current-host' },
        { hostId: null }
      )
    ).toEqual({ kind: 'workspaces', hostId: null });
  });

  it('switches pull request navigation to the selected host', () => {
    expect(
      applyNavigationTransition(
        { kind: 'pull-requests', hostId: 'current-host' },
        { hostId: 'next-host' }
      )
    ).toEqual({ kind: 'pull-requests', hostId: 'next-host' });
  });

  it('does not add a host to destinations that are not host scoped', () => {
    expect(
      applyNavigationTransition(
        { kind: 'project', projectId: 'project' },
        { hostId: 'next-host' }
      )
    ).toEqual({ kind: 'project', projectId: 'project' });
  });
});

describe('resolveDestinationHostId', () => {
  it('keeps the current host when no host override is provided', () => {
    expect(
      resolveDestinationHostId(
        { kind: 'workspace', workspaceId: 'workspace' },
        'current-host'
      )
    ).toBe('current-host');
  });

  it('switches from a remote host to the explicitly selected local machine', () => {
    expect(
      resolveDestinationHostId(
        { kind: 'workspace', workspaceId: 'workspace', hostId: null },
        'current-host'
      )
    ).toBeNull();
  });

  it('switches to an explicitly selected remote host', () => {
    expect(
      resolveDestinationHostId(
        { kind: 'workspace', workspaceId: 'workspace', hostId: 'next-host' },
        'current-host'
      )
    ).toBe('next-host');
  });
});

describe('collapseSelfHostId', () => {
  it("collapses this machine's own cloud host id to the local host", () => {
    // A self-host deep link must be served directly, never relay-proxied to us.
    expect(collapseSelfHostId('self-host', 'self-host')).toBeNull();
  });

  it('leaves a genuine remote host id untouched', () => {
    expect(collapseSelfHostId('remote-host', 'self-host')).toBe('remote-host');
  });

  it('leaves the local host (null) untouched', () => {
    expect(collapseSelfHostId(null, 'self-host')).toBeNull();
  });

  it('does not collapse anything while the self host id is unknown', () => {
    expect(collapseSelfHostId('remote-host', null)).toBe('remote-host');
  });
});

describe('resolveLocalHostId', () => {
  it('waits before routing a host-scoped request while self is unknown', () => {
    expect(resolveLocalHostId('route-host', null, true)).toBeUndefined();
  });

  it('does not delay direct local requests', () => {
    expect(resolveLocalHostId(null, null, true)).toBeNull();
  });
});
