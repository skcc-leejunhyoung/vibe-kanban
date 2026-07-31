import { describe, expect, it } from 'vitest';

import { resolveGithubIssueAutomationHostId } from './githubIssueAutomationHost';

describe('GitHub issue automation host resolution', () => {
  const hosts = [
    { id: 'offline-host', status: 'offline' },
    { id: 'online-host', status: 'online' },
  ];

  it('keeps the route host when one is explicitly selected', () => {
    expect(
      resolveGithubIssueAutomationHostId('remote', 'route-host', hosts)
    ).toBe('route-host');
  });

  it('uses the first online host for a remote project route without a host', () => {
    expect(resolveGithubIssueAutomationHostId('remote', null, hosts)).toBe(
      'online-host'
    );
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
