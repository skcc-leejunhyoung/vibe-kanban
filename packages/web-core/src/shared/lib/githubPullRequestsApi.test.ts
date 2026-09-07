import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureAuthRuntime } from '@/shared/lib/auth/runtime';
import {
  getGitHubPullRequest,
  getGitHubPullRequestComments,
  isGitHubAuthenticationError,
  listGitHubPullRequests,
  listGitHubRepositories,
  listPullRequestIssueMappingsBatch,
  setGitHubReviewThreadResolved,
  syncTrackedGitHubPullRequests,
} from './remoteApi';
import { setLocalApiTransport } from './localApiTransport';

describe('GitHub pull request API', () => {
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

  it('routes URL-based reads and mutations to the server stack, not a host', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ number: 42 }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ comments: [] }), { status: 200 })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const url = 'https://github.com/acme/widgets/pull/42';
    await listGitHubRepositories();
    await listGitHubPullRequests('acme/widgets', true, true);
    await getGitHubPullRequest(url);
    await getGitHubPullRequestComments(url);
    await setGitHubReviewThreadResolved(url, 'PRRT_thread', true);
    await syncTrackedGitHubPullRequests();

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/v1/github/repositories',
      '/v1/github/pull-requests?repository=acme%2Fwidgets&involves_me=true&refresh=true',
      `/v1/github/pull-requests/detail?url=${encodeURIComponent(url)}`,
      `/v1/github/pull-requests/comments?url=${encodeURIComponent(url)}`,
      '/v1/github/pull-requests/review-thread',
      '/v1/github/pull-requests/tracked/sync',
    ]);
    expect(JSON.parse(fetchMock.mock.calls[4][1].body)).toEqual({
      url,
      thread_id: 'PRRT_thread',
      resolved: true,
    });
  });

  it('deduplicates and chunks pull request mapping requests', async () => {
    const urls = Array.from(
      { length: 251 },
      (_, index) => `https://github.com/acme/widgets/pull/${index + 1}`
    );
    fetchMock.mockImplementation(async (_path, init) => {
      const payload = JSON.parse(init.body) as { urls: string[] };
      return new Response(
        JSON.stringify({
          mappings: payload.urls.map((url) => ({
            url,
            pull_request_issues: [],
          })),
        }),
        { status: 200 }
      );
    });

    const result = await listPullRequestIssueMappingsBatch([...urls, urls[0]!]);

    expect(Object.keys(result)).toHaveLength(251);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).urls.length)
    ).toEqual([250, 1]);
  });

  it('preserves the server error code used by the reconnect UI', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'GitHub authentication is required',
          code: 'github_auth_required',
        }),
        { status: 424 }
      )
    );

    const error = await listGitHubRepositories().catch((reason) => reason);

    expect(error).toMatchObject({
      status: 424,
      code: 'github_auth_required',
    });
    expect(isGitHubAuthenticationError(error)).toBe(true);
  });

  it.each([
    [403, 'github_forbidden'],
    [429, 'github_rate_limited'],
  ])(
    'keeps status %i distinct for the Pull Requests UI',
    async (status, code) => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ error: code, code }), { status })
      );

      const error = await listGitHubRepositories().catch((reason) => reason);

      expect(error).toMatchObject({ status, code });
    }
  );
});
