import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureAuthRuntime } from '@/shared/lib/auth/runtime';
import { deleteGitHubCredential, getGitHubCredentialStatus } from './remoteApi';
import { setLocalApiTransport } from './localApiTransport';

describe('GitHub credential API', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    configureAuthRuntime({
      getToken: async () => 'session-token',
      triggerRefresh: async () => null,
      registerShape: () => () => {},
      getCurrentUser: async () => ({ user_id: 'user-1' }),
    });
    vi.stubGlobal('__APP_VERSION__', 'test');
    vi.stubGlobal('fetch', fetchMock);
    setLocalApiTransport(null);
  });

  afterEach(() => {
    setLocalApiTransport(null);
    vi.unstubAllGlobals();
  });

  it('reads and removes the account credential on the server stack', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            source: 'host_gh',
            login: 'octocat',
            scopes: ['repo', 'read:org'],
            updated_at: null,
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const status = await getGitHubCredentialStatus();
    await deleteGitHubCredential();

    expect(status.source).toBe('host_gh');
    expect(
      fetchMock.mock.calls.map(([path, init]) => [path, init?.method ?? 'GET'])
    ).toEqual([
      ['/v1/github/credentials', 'GET'],
      ['/v1/github/credentials', 'DELETE'],
    ]);
  });
});
