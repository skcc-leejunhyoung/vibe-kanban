import { describe, expect, it } from 'vitest';
import { resolveWorkspaceHostPresentation } from './workspaceHostPresentation';

describe('resolveWorkspaceHostPresentation', () => {
  it('uses the local nickname and reports this machine online', () => {
    expect(
      resolveWorkspaceHostPresentation(null, 'My Mac', [], 'This machine')
    ).toEqual({ name: 'My Mac', status: 'online' });
  });

  it('uses registered remote host metadata when no nickname is configured', () => {
    expect(
      resolveWorkspaceHostPresentation(
        'host-id',
        null,
        [{ id: 'host-id', name: 'Office Mac', status: 'offline' }],
        'This machine'
      )
    ).toEqual({ name: 'Office Mac', status: 'offline' });
  });

  it('marks an unknown remote host as unpaired', () => {
    expect(
      resolveWorkspaceHostPresentation('unknown-host', null, [], 'This machine')
    ).toEqual({ name: 'unknown-host', status: 'unpaired' });
  });
});
