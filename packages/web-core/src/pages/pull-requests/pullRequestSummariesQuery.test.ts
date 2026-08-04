import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/lib/api', () => ({
  repoApi: {
    listPullRequestSummaries: vi.fn(),
  },
}));

import { repoApi } from '@/shared/lib/api';
import {
  pullRequestSummariesQueryKey,
  pullRequestSummariesQueryOptions,
} from './pullRequestSummariesQuery';

describe('pullRequestSummariesQueryOptions', () => {
  beforeEach(() => {
    vi.mocked(repoApi.listPullRequestSummaries).mockReset();
  });

  it('uses the same cache key for page and background prefetches', () => {
    expect(pullRequestSummariesQueryKey('repo-1', true)).toEqual([
      'pull-request-summaries',
      'repo-1',
      true,
    ]);
  });

  it('loads the configured repository without forcing a refresh', async () => {
    vi.mocked(repoApi.listPullRequestSummaries).mockResolvedValue({
      success: true,
      data: [],
    });

    await pullRequestSummariesQueryOptions('repo-1', false).queryFn();

    expect(repoApi.listPullRequestSummaries).toHaveBeenCalledWith(
      'repo-1',
      false
    );
  });
});
