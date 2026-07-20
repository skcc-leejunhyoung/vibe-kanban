import { describe, expect, it } from 'vitest';
import { BaseCodingAgent } from 'shared/types';
import { agentsApi } from './api';

describe('agent discovery stream scope', () => {
  it('uses a different stream identity for local and remote hosts', () => {
    const local = agentsApi.getDiscoveredOptionsStreamUrl(
      BaseCodingAgent.CODEX,
      { hostScopeKey: 'local' }
    );
    const i9 = agentsApi.getDiscoveredOptionsStreamUrl(BaseCodingAgent.CODEX, {
      hostScopeKey: 'i9-host',
    });

    expect(local).not.toBe(i9);
    expect(local).toContain('_host_scope=local');
    expect(i9).toContain('_host_scope=i9-host');
  });
});
