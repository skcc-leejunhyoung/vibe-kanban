import { describe, expect, it } from 'vitest';

import { resolveGithubIssueAutomationHostId } from './githubIssueAutomationHost';

describe('GitHub issue automation host resolution', () => {
  const hosts = [
    { id: 'offline-host', status: 'offline' },
    { id: 'online-host', status: 'online' },
  ];

  it('keeps the route host when one is explicitly selected', () => {
    expect(
      resolveGithubIssueAutomationHostId('remote', 'online-host', hosts)
    ).toBe('online-host');
  });

  it('requires an explicit selection for a remote project route without a host', () => {
    expect(
      resolveGithubIssueAutomationHostId('remote', null, hosts)
    ).toBeNull();
  });

  it('does not preselect an offline route host', () => {
    expect(
      resolveGithubIssueAutomationHostId('remote', 'offline-host', hosts)
    ).toBeNull();
  });

  it('keeps local requests on the current machine', () => {
    expect(resolveGithubIssueAutomationHostId('local', null, hosts)).toBeNull();
  });

  it('returns no target when remote automation has no online host', () => {
    expect(
      resolveGithubIssueAutomationHostId('remote', null, [
        { id: 'offline-host', status: 'offline' },
      ])
    ).toBeNull();
  });
});
