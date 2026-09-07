import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/lib/remoteApi', () => ({
  listGitHubPullRequests: vi.fn(),
}));

import { listGitHubPullRequests } from '@/shared/lib/remoteApi';
import {
  pullRequestSummariesQueryKey,
  pullRequestSummariesQueryOptions,
  refreshPullRequestSummaries,
  summarizePullRequestQueryErrors,
} from './pullRequestSummariesQuery';

describe('pullRequestSummariesQueryOptions', () => {
  beforeEach(() => {
    vi.mocked(listGitHubPullRequests).mockReset();
  });

  it('uses the same cache key for page and background prefetches', () => {
    expect(pullRequestSummariesQueryKey('acme/repo-1', true)).toEqual([
      'pull-request-summaries',
      'acme/repo-1',
      true,
    ]);
  });

  it('loads the configured repository without forcing a refresh', async () => {
    vi.mocked(listGitHubPullRequests).mockResolvedValue([]);

    await pullRequestSummariesQueryOptions('acme/repo-1', false).queryFn();

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
