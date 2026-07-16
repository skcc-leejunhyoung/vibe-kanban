import { describe, expect, it } from 'vitest';
import {
  applyNavigationTransition,
  resolveDestinationHostId,
} from './appNavigation';

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
