import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMachineClient } from './machineClient';
import { setLocalApiTransport } from './localApiTransport';

describe('machine GitHub credential sync', () => {
  const request = vi.fn();

  beforeEach(() => {
    request.mockReset();
    request.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            source: 'host_gh',
            login: 'octocat',
            scopes: [],
            updated_at: null,
          },
        }),
        { status: 200 }
      )
    );
    setLocalApiTransport({
      request,
      openWebSocket: () => {
        throw new Error('unused');
      },
    });
  });

  afterEach(() => setLocalApiTransport(null));

  it('targets the selected machine, so remote web can sync a host through the relay', async () => {
    const client = createMachineClient('remote', {
      kind: 'remote',
      id: 'host-1',
      apiHostId: 'host-1',
      label: 'i9-mbp',
    });

    const status = await client.syncGitHubHostCredential();

    expect(status.login).toBe('octocat');
    const [path, init] = request.mock.calls[0]!;
    expect(path).toBe('/api/auth/github-credential/sync');
    expect(init.method).toBe('POST');
    expect(init.relayHostId).toBe('host-1');
  });
});
