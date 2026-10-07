import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { PullRequestDetail } from 'shared/types';
import { issuePrsApi } from '@/shared/lib/api';
import { prInfoResultQueryOptions } from './LinkPrByUrlDialog';

vi.mock('@/shared/lib/api', () => ({
  issuePrsApi: { getPrInfo: vi.fn() },
}));

const url = 'https://github.com/owner/repo/pull/1';
const detail = { number: 1n, url, title: 'PR' } as PullRequestDetail;

describe('prInfoResultQueryOptions', () => {
  it('does not read the bare PullRequestDetail LinkPrToIssueDialog caches', async () => {
    vi.mocked(issuePrsApi.getPrInfo).mockResolvedValue({
      success: true,
      data: detail,
    });
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: 5 * 60_000 } },
    });
    // LinkPrToIssueDialog's local-runtime cache entry for the same URL.
    client.setQueryData(['pr-info', url, 'local'], detail);

    const result = await client.fetchQuery(prInfoResultQueryOptions(url, null));

    expect(result).toEqual({ success: true, data: detail });
    expect(issuePrsApi.getPrInfo).toHaveBeenCalledWith(url, null);
    expect(client.getQueryData(['pr-info', url, 'local'])).toBe(detail);
  });
});
