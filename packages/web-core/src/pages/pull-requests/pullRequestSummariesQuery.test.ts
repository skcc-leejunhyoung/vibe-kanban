import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubPullRequestSummary } from 'shared/remote-types';

vi.mock('@/shared/lib/remoteApi', () => ({
  listGitHubPullRequests: vi.fn(),
}));

import { listGitHubPullRequests } from '@/shared/lib/remoteApi';
import { clearLocalUserQueryCache } from '@/shared/providers/auth/LocalAuthProvider';
import {
  pullRequestSummariesQueryKey,
  pullRequestSummariesQueryOptions,
  refreshPullRequestSummaries,
  storeRefreshedPullRequestSummaries,
  summarizePullRequestQueryErrors,
} from './pullRequestSummariesQuery';

describe('pullRequestSummariesQueryOptions', () => {
  beforeEach(() => {
    vi.mocked(listGitHubPullRequests).mockReset();
  });

  it('scopes the shared page and prefetch cache key to the signed-in user', () => {
    expect(pullRequestSummariesQueryKey('user-a', 'acme/repo-1', true)).toEqual(
      ['pull-request-summaries', 'user-a', 'acme/repo-1', true]
    );
  });

  it('loads the configured repository without forcing a refresh', async () => {
    vi.mocked(listGitHubPullRequests).mockResolvedValue([]);

    await pullRequestSummariesQueryOptions(
      'user-a',
      'acme/repo-1',
      false
    ).queryFn();

    expect(listGitHubPullRequests).toHaveBeenCalledWith(
      'acme/repo-1',
      false,
      false
    );
  });
});

describe('refreshPullRequestSummaries', () => {
  it('keeps successful repository refreshes when a sibling fails', async () => {
    vi.mocked(listGitHubPullRequests).mockImplementation(async (repository) => {
      if (repository === 'acme/broken') throw new Error('rate limited');
      return [];
    });

    const results = await refreshPullRequestSummaries(
      ['acme/working', 'acme/broken'],
      false
    );

    expect(results[0]).toEqual({
      repository: 'acme/working',
      success: true,
      result: { summaries: [] },
    });
    expect(results[1]).toMatchObject({
      repository: 'acme/broken',
      success: false,
    });
    expect(listGitHubPullRequests).toHaveBeenCalledWith(
      'acme/working',
      false,
      true
    );
  });
});

describe('storeRefreshedPullRequestSummaries', () => {
  it('keeps a refresh that finishes after an account switch away from the next account', () => {
    const queryClient = new QueryClient();
    const privatePr = {
      number: 42n,
      url: 'https://github.com/acme/private/pull/42',
      title: 'Account A private PR',
    } as GitHubPullRequestSummary;
    const results = [
      {
        repository: 'acme/private',
        success: true,
        result: { summaries: [privatePr] },
      },
      { repository: 'acme/broken', success: false, error: new Error('x') },
    ] as const;

    // Account B signed in while A's refresh was still in flight, so the auth
    // provider already dropped every account-scoped query.
    clearLocalUserQueryCache(queryClient);
    storeRefreshedPullRequestSummaries(queryClient, 'user-a', true, [
      ...results,
    ]);

    expect(
      queryClient.getQueryData(
        pullRequestSummariesQueryKey('user-b', 'acme/private', true)
      )
    ).toBeUndefined();
    expect(
      queryClient.getQueryData(
        pullRequestSummariesQueryKey('user-a', 'acme/private', true)
      )
    ).toEqual({ summaries: [privatePr] });
    expect(
      queryClient.getQueryData(
        pullRequestSummariesQueryKey('user-a', 'acme/broken', true)
      )
    ).toBeUndefined();
  });
});

describe('summarizePullRequestQueryErrors', () => {
  it('surfaces a partial repository failure without hiding successful lists', () => {
    expect(
      summarizePullRequestQueryErrors([
        { isError: false, isSuccess: true, error: null },
        {
          isError: true,
          isSuccess: false,
          error: new Error('rate limited'),
        },
      ])
    ).toEqual({
      allFailed: false,
      partiallyFailed: true,
      message: 'rate limited',
    });
  });

  it('does not report a partial result while the remaining repository is pending', () => {
    expect(
      summarizePullRequestQueryErrors([
        {
          isError: true,
          isSuccess: false,
          error: new Error('rate limited'),
        },
        { isError: false, isSuccess: false, error: null },
      ])
    ).toEqual({
      allFailed: false,
      partiallyFailed: false,
      message: 'rate limited',
    });
  });
});
