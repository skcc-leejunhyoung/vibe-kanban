import { describe, expect, it } from 'vitest';
import { resolveDestinationHostId } from './appNavigation';

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
